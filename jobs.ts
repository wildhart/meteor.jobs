import _TypedJob from "./TypedJob";

export const TypedJob = _TypedJob;
export type JobOrId = string | false | null | {_id: string};

const settings: Jobs.Config = {
	startupDelay: 1 * 1000, // default 1 second
	maxWait: 5 * 60 * 1000, // specify how long the server could be inactive before another server takes on the master role  (default=5 min)
	log: console.log,
	autoStart: true,
};

function log(...args: any) {
	typeof settings.log == 'function' && settings.log(...args);
}

/********************************* Dominator *********************/

namespace Dominator {

	interface Document {
		_id?: string,
		serverId?: string | null,
		pausedJobs: string[],
		date?: Date,
	}

	// we don't need an index on job_dominator_3 because now it only contains one shared document.
	export const collection = new Mongo.Collection<Document>("jobs_dominator_3");
	export let lastPing: Readonly<Document> | undefined;
	const DOMINATOR_ID = "dominatorId";
	let _serverId: string | undefined | null = null;
	let _pingInterval: number | null =  null;
	let _takeControlTimeout: number | null = null;

	Meteor.startup(async () => {
		log('Jobs', `Meteor.startup, startupDelay: ${settings.startupDelay / 1000}s...`);
		await collection.removeAsync({_id: {$ne: DOMINATOR_ID}});
		Meteor.setTimeout(() => initAsync(), settings.startupDelay);
	})

	export async function initAsync() {
		_serverId = (typeof settings.setServerId == 'string' && settings.setServerId)
			|| (typeof settings.setServerId == 'function' && settings.setServerId())
			|| Random.id();

		collection.find({_id: DOMINATOR_ID}).observe({
			changed: (newPing) => _observerSync(newPing),
		});

		lastPing = await collection.findOneAsync();
		const lastPingIsOld = lastPing && lastPing.date && lastPing.date.valueOf() < Date.now() - settings.maxWait;
		log('Jobs', 'startup', _serverId, JSON.stringify(lastPing), 'isOld='+lastPingIsOld);

		// need !lastPing.serverId on following line in case Jobs.start() or Jobs.stop() updates pausedJobs before
		if (!lastPing || !lastPing.serverId) {
			// fresh installation, no one is in control yet.
			await _takeControlAsync('no ping');
		} else if (lastPing.serverId == _serverId) {
			// we were in control but have restarted - resume control
			await _takeControlAsync('restarted');
		} else if (lastPingIsOld) {
			// other server lost control - take over
			await _takeControlAsync('lastPingIsOld ' + JSON.stringify(lastPing));
		} else {
			// another server is recently in control, set a timer to check the ping...
			_observerSync(lastPing);
		}
	}

	export async function startAsync(jobNames?: string[] | string) {
		const update: Mongo.Modifier<Document> = {}
		if (!jobNames || jobNames == '*') {
			// clear the pausedJobs list, start all jobs
			update.$set = {pausedJobs: []};
		} else {
			update.$pullAll = {pausedJobs: typeof jobNames == 'string' ? [jobNames] : jobNames};
		}

		await collection.upsertAsync({_id: DOMINATOR_ID}, update);
		log('Jobs', 'startJobs', jobNames, update);
	}

	export async function stopAsync(jobNames?: string[] | string) {
		const update: Mongo.Modifier<Document> = {}
		if (!jobNames || jobNames == '*') {
			update.$set = {pausedJobs: ['*']}; // stop all jobs
		} else {
			update.$addToSet = {pausedJobs: typeof jobNames == 'string' ? jobNames : {$each: jobNames}};
		}

		await collection.upsertAsync({_id: DOMINATOR_ID}, update);
		log('Jobs', 'stopJobs', jobNames, update);
	}

	function _observerSync(newPing: Document) {
		log('Jobs', 'dominator.observer', newPing);
		if (lastPing && lastPing.serverId == _serverId && newPing.serverId != _serverId) {
			// we were in control but another server has taken control
			_relinquishControlSync();
		}
		const oldPausedJobs = lastPing && lastPing.pausedJobs || [];
		lastPing = newPing;
		if ((lastPing.pausedJobs || []).join() != oldPausedJobs.join()) {
			// the list of paused jobs has changed - update the query for the job observer
			// needs dominator.lastPing.pausedJobs to be up-to-date so do lastPing = newPing above
			Queue.restartSync();
		}
		if (_takeControlTimeout) {
			Meteor.clearTimeout(_takeControlTimeout);
			_takeControlTimeout = null;
		}
		if (lastPing.serverId != _serverId) {
			// we're not in control, set a timer to take control in the future...
			_takeControlTimeout = Meteor.setTimeout(() => {
				// if this timeout isn't cleared then the dominator hasn't been updated recently so we should take control.
				_takeControlAsync('lastPingIsOld ' + JSON.stringify(lastPing));
			}, settings.maxWait);
		}
	}

	async function _takeControlAsync(reason: string) {
		log('Jobs', 'takeControl', reason);
		await _pingAsync();
		Queue.startSync();
	}

	function _relinquishControlSync() {
		log('Jobs', 'relinquishControl');
		if (_pingInterval) {
			Meteor.clearInterval(_pingInterval);
			_pingInterval = null;
		}
		Queue.stopSync();
	}

	async function _pingAsync() {
		if (!_pingInterval) {
			_pingInterval = Meteor.setInterval(() =>_pingAsync(), settings.maxWait * 0.8);
		}
		const newPing: Document = {
			serverId: _serverId,
			pausedJobs: lastPing ? (lastPing.pausedJobs || []) : (settings.autoStart ? [] : ['*']),
			date: new Date(),
		};
		if (!lastPing) {
			lastPing = newPing;
		}
		await collection.upsertAsync({_id: DOMINATOR_ID}, newPing);
		log('Jobs', 'ping', newPing.date, 'paused:', newPing.pausedJobs);
	}
}

/********************************* Public API *********************/

export namespace Jobs {

	export interface Config {
		startupDelay: number,
		maxWait: number,
		log: typeof console.log | boolean;
		autoStart: boolean;
		setServerId?: string | (() => string);
		defaultCompletion?: 'success' | 'remove';
	}

	export interface JobConfig {
		in: any;
		on: any;
		priority: number;
		date: Date;
		state: string;
		awaitAsync: boolean;
		unique: boolean;
		singular: boolean;
		callback?: (err: string | null, res: any) => void | Promise<void>;
	}

	export type JobStatus = "pending" | "success" | "failure" | "executing";

	export interface JobDocument {
		_id: string,
		name: string,
		state: JobStatus,
		arguments: any[],
		due: Date,
		priority: number,
		created: Date,
		awaitAsync?: boolean,
	}

	export interface JobThisType {
		document: JobDocument;
		replicateAsync(config: Partial<JobConfig>): Promise<string | null | false>;
		rescheduleAsync(config: Partial<JobConfig>): Promise<boolean>;
		removeAsync(): Promise<boolean>;
		successAsync(): Promise<void>;
		failureAsync(): Promise<void>;
	}

    export type JobFunction<TArgs extends any[]> = (this: JobThisType, ...args: TArgs) => void | Promise<void>;
	export type JobFunctions = Record<string, JobFunction<any>>;
	export type RegisterFn = (jobFunctions: JobFunctions) => void;

	export const jobs: JobFunctions = {};

	export const collection = new Mongo.Collection<JobDocument>("jobs_data");

	collection.createIndexAsync({name: 1, due: 1, state: 1}).catch(err => console.error(err));

	export function configure(config: Partial<Config>) {
		check(config, {
			maxWait: Match.Maybe(Number),
			setServerId: Match.Maybe(Match.OneOf(String, Function)),
			log: Match.Maybe(Match.OneOf(undefined, null, Boolean, Function)),
			autoStart: Match.Maybe(Boolean),
			defaultCompletion: Match.Maybe(Match.Where((val => /^(success|remove)$/.test(val)))),
			startupDelay: Match.Maybe(Number),
		});
		Object.assign(settings, config);
		if (settings.log === true) {
			settings.log = console.log;
		}
		log('Jobs', 'Jobs.configure', Object.keys(config));
	}

	export function register(newJobs: JobFunctions) {
		check(newJobs, Object);
		Object.assign(jobs, newJobs);
		// log('Jobs', 'Jobs.register', Object.keys(jobs).length, Object.keys(newJobs).join(', '));
	}

	const configItems: Array<keyof JobConfig> = ['in', 'on', 'priority', 'date', 'callback', 'singular', 'unique', 'awaitAsync']

	const isConfig = (input: any) => !!(input && typeof input == 'object' && configItems.some(i => typeof input[i] != 'undefined'));

	export async function runAsync(name: string, ...args: any) {
		check(name, String);
		log('Jobs', 'Jobs.run', name, args.length && args[0]);

		var config: Partial<JobConfig> | null = args.length && args.pop() || null;
		if (config && !isConfig(config)) {
			args.push(config);
			config = null;
		}
		var error: string | null = null;
		if (config?.unique) { // If a job is marked as unique, it will only be scheduled if no other job exists with the same arguments
			if (await countAsync(name, ...args)) error = "Unique job already exists";
		}
		if (config?.singular) { // If a job is marked as singular, it will only be scheduled if no other job is PENDING with the same arguments
			if (await countPendingAsync(name, ...args)) error = 'Singular job already exists';
		}
		if (error) {
			log('Jobs', '  ' + error);
			if (typeof config?.callback =='function') {
				await config.callback(error, null);
			}
			return false;
		}
		const jobDoc: Mongo.OptionalId<JobDocument> = {
			name: name,
			arguments: args,
			state: 'pending',
			due: config && getDateFromConfig(config) || new Date(),
			priority: config?.priority || 0,
			created: new Date(),
			awaitAsync: config?.awaitAsync || undefined,
		};
		const jobId = await collection.insertAsync(jobDoc);
		if (jobId) {
			jobDoc._id = jobId;
		} else {
			error = "Couldn't insert job";
		}

		if (typeof config?.callback == 'function') {
			await config.callback(error, jobId && jobDoc);
		}
		return error ? false : jobDoc as JobDocument;
	}

	export async function executeAsync(jobOrId: JobOrId) {
		if (!jobOrId) {
			console.warn('Jobs', '    Jobs.execute', 'JOB NOT FOUND', jobOrId);
			return false;
		}
		const jobId = typeof jobOrId == 'string' ? jobOrId : jobOrId._id;
		check(jobId, String);
		log('Jobs', 'Jobs.execute', jobId);
		const job = await collection.findOneAsync(jobId);
		if (!job) {
			console.warn('Jobs', 'Jobs.execute', 'JOB NOT FOUND', jobId);
			return;
		}
		if (job.state != 'pending') {
			console.warn('Jobs', 'Jobs.execute', 'JOB IS NOT PENDING', job);
			return;
		}

		await Queue.executeJobAsync(job);
	}

	export async function replicateAsync(jobOrId: JobOrId, config: Partial<JobConfig>) {
		if (!jobOrId) {
			console.warn('Jobs', '    Jobs.replicate', 'JOB NOT FOUND', jobOrId);
			return false;
		}
		const jobId = typeof jobOrId == 'string' ? jobOrId : jobOrId._id;
		check(jobId, String);
		const date = getDateFromConfig(config);
		const job = await collection.findOneAsync(jobId);
		if (!job) {
			console.warn('Jobs', '    Jobs.replicate', 'JOB NOT FOUND', jobId);
			return null;
		}

		delete (job as any)._id;
		job.due = date;
		job.state = 'pending';
		const newJobId = await collection.insertAsync(job);
		log('Jobs', '    Jobs.replicate', jobId, config);
		return newJobId;
	}

	export async function rescheduleAsync(jobOrId: JobOrId, config: Partial<JobConfig>) {
		if (!jobOrId) {
			console.warn('Jobs', '    Jobs.reschedule', 'JOB NOT FOUND', jobOrId);
			return false;
		}
		const jobId = typeof jobOrId == 'string' ? jobOrId : jobOrId._id;
		check(jobId, String);
		const date = getDateFromConfig(config);
		var set: Partial<JobDocument> = {due: date, state: 'pending'};
		if (config.priority) {
			set.priority = config.priority;
		}
		const count = await collection.updateAsync({_id: jobId}, {$set: set});
		log('Jobs', '    Jobs.reschedule', jobId, config, date, count);
		if (typeof config.callback == 'function') {
			await config.callback(count==0 ? 'No jobs updated' : null, count);
		}
		return true;
	}

	export async function removeAsync(jobOrId: JobOrId) {
		if (!jobOrId) {
			return false;
		}
		const jobId = typeof jobOrId == 'string' ? jobOrId : jobOrId._id;
		var count = await collection.removeAsync({_id: jobId});
		log('Jobs', '    Jobs.remove', jobId, count);
		return count > 0;
	}

	export async function clearAsync(state?: '*' | JobStatus | JobStatus[], jobName?: string, ...args: any[]) {
		const query: Mongo.Query<JobDocument> = {
			state: state === "*" ? {$exists: true}
				: typeof state === "string" ? state as JobStatus
				: Array.isArray(state) ? {$in: state}
				: {$in: ["success", "failure"]}
		};

		if (typeof jobName === "string") {
			query.name = jobName;
		} else if (jobName && typeof jobName === "object") {
			query.name = {$in: jobName};
		}

		const callback = args.length && typeof args[args.length - 1] == 'function' ? args.pop() : null;
		args.forEach((arg, index) => query["arguments." + index] = arg);

		const count = await collection.removeAsync(query);
		log('Jobs', 'Jobs.clear', count, query);
		await callback?.(null, count);

		return count;
	}

	export async function findOneAsync(jobName: string, ...args: any[]) {
		check(jobName, String);
		const query: Mongo.Query<JobDocument> = {
			name: jobName,
		};
		args.forEach((arg, index) => query["arguments." + index] = arg);
		return await collection.findOneAsync(query);
	}

	export async function countAsync(jobName: string, ...args: any[]) {
		check(jobName, String);
		const query: Mongo.Query<JobDocument> = {
			name: jobName,
		};
		args.forEach((arg, index) => query["arguments." + index] = arg);
		const count = await collection.find(query).countAsync();
		return count;
	};

	export async function countPendingAsync(jobName: string, ...args: any[]) {
		check(jobName, String);
		const query: Mongo.Query<JobDocument>  = {
			name: jobName,
			state: 'pending',
		};
		args.forEach((arg, index) => query["arguments." + index] = arg);
		const count = await collection.find(query).countAsync();
		return count;
	}

	export const startAsync = Dominator.startAsync;
	export const stopAsync = Dominator.stopAsync;

	function getDateFromConfig(config: Partial<Jobs.JobConfig>) {
		// https://github.com/msavin/SteveJobs..meteor.jobs.scheduler.queue.background.tasks/blob/031fdf5051b2f2581a47f64ab5b54ffbb6893cf8/package/server/imports/utilities/helpers/date.js
		check(config, Match.ObjectIncluding({
			date: Match.Maybe(Date),
			in: Match.Maybe(Object),
			on: Match.Maybe(Object),
		}));

		let currentDate = config.date || new Date();
		let newNumber: number;
		let fn: string;

		Object.keys(config).forEach(key1 => {
			if (["in", "on"].indexOf(key1) > -1) {
				Object.keys(config[key1]).forEach(key2 => {
					try {
						newNumber = Number(config[key1][key2]);
						if (isNaN(newNumber)) {
							console.warn('Jobs', `invalid type was input: {key1}.{key2}`, newNumber)
						} else {
							// convert month(s) => months (etc), and day(s) => date and year(s) => fullYear
							fn = (key2 + "s").replace('ss', 's').replace('days','date').replace('years','fullYear').replace('months','month');
							// convert months => Months
							fn = fn.charAt(0).toUpperCase() + fn.slice(1);
							// if key1=='in' currentDate.setMonth(newNumber + currentDate.getMonth())
							// if key1=='on' currentDate.setMonth(newNumber)
							currentDate['set' + fn](newNumber + (key1 == 'in' ? currentDate['get' + fn]() : 0));
						}
					} catch (e) {
						console.warn('Jobs', `invalid argument was ignored: {key1}.{key2}`, newNumber, fn);
						console.log(e);
					}
				});
			}
		});
		return currentDate;
	}
}

/********************************* Queue *********************/

namespace Queue {

	const PAUSED = 'paused';

	var _handle: Meteor.LiveQueryHandle | typeof PAUSED | null = null;
	var _timeout: number | null = null;
	var _executing = false;
	var _awaitAsyncJobs = new Set<string>();

	export function startSync() {
		if (_handle && _handle != PAUSED) {
			stopSync(); // this also clears any existing job timeout
		}
		const pausedJobs = (Dominator.lastPing || {}).pausedJobs || [];
		log('Jobs', 'queue.start paused:', pausedJobs);

		// don't bother creating an observer if all jobs are paused
		_handle = pausedJobs[0]=='*' ? PAUSED : Jobs.collection.find({
			state: "pending",
			name: {$nin: pausedJobs},
		}, {
			limit: 1,
			sort: {due: 1},
			fields: {name: 1, due: 1},
		}).observe({
			changed: (job) => _observerSync('changed', job),
			added: (job) => _observerSync('added', job),
		});
		// this will automatically call the observer which will set the timer for the next job.
	}

	export function stopSync() {
		if (_handle && _handle != PAUSED) {
			_handle.stop();
		}
		_handle = null;
		_observerSync('stop');
	}

	export function restartSync() {
		// this is called by Jobs.start() and Jobs.stop() when the list of pausedJobs changes
		// only restart the queue if we're already watching it (maybe jobs were started/paused inside _executeJobs())
		if (_handle) {
			startSync();
		}
	}

	// cap timeout limit to 24 hours to avoid Node.js limit https://github.com/wildhart/meteor.jobs/issues/5
	const MAX_TIMEOUT_MS = 24 *3600 * 1000;

	function _observerSync(type: string, nextJob?: Jobs.JobDocument) {
		log('Jobs', 'queue.observer', type, nextJob, nextJob && ((nextJob.due.valueOf() - Date.now())/(60*60*1000)).toFixed(2)+'h');
		if (_timeout) {
			Meteor.clearTimeout(_timeout);
			_timeout = null;
		}

		if (nextJob) {
			// cap timeout limit to 24 hours to avoid Node.js limit https://github.com/wildhart/meteor.jobs/issues/5
			let msTillNextJob = Math.min(MAX_TIMEOUT_MS, (nextJob.due.valueOf() - Date.now()) );

			_timeout = nextJob && !_executing ? Meteor.setTimeout(()=> {
				_timeout = null;
				_executeJobsAsync()
			}, msTillNextJob) : null;
		}
	}

	async function _executeJobsAsync() {
		// protect against observer/timeout race condition
		if (_executing) {
			console.warn('already executing!');
			return;
		}
		_executing = true;

		try {
			log('Jobs', 'executeJobs', 'paused:', Dominator.lastPing?.pausedJobs);

			// ignore job queue changes while executing jobs. Will restart observer with .start() at end
			stopSync();

			// need to prevent 1000s of the same job type from hogging the job queue and delaying other jobs
			// after running a job, add its job.name to doneJobs, then find the next job excluding those in doneJobs
			// if no other jobs can be found then clear doneJobs to allow the same job to run again.
			let job: Jobs.JobDocument | undefined;
			let doneJobs: string[];

			// protect against stale read
			let lastJobId = 'not null';

			do {
				doneJobs = [];
				do {
					// always use the live version of dominator.lastPing.pausedJobs in case jobs are paused/restarted while executing
					const lastPing = (await Dominator.collection.findOneAsync({}, {fields: {pausedJobs: 1}}))!;
					job = await Jobs.collection.findOneAsync({
						state: "pending",
						due: {$lte: new Date()},
						name: {$nin: doneJobs.concat(lastPing.pausedJobs, Array.from(_awaitAsyncJobs))}, // give other job types a chance...
						_id: {$ne: lastJobId}, // protect against stale reads of the job we just executed
					}, {sort: {due: 1, priority: -1}});
					if (job) {
						lastJobId = job._id;
						await executeJobAsync(job);
						doneJobs.push(job.name); // don't do this job type again until we've tried other jobs.
					}
				} while (Dominator.lastPing!.pausedJobs.indexOf('*') == -1 && job);
			} while (Dominator.lastPing!.pausedJobs.indexOf('*') == -1 && doneJobs.length);
		} catch(e) {
			console.warn('Jobs', 'executeJobs ERROR');
			console.warn(e);
		}

		_executing = false;
		startSync();
	}

	export async function executeJobAsync(job: Jobs.JobDocument) {
		log('Jobs', '  ' + job.name);

		if (typeof Jobs.jobs[job.name] == 'undefined') {
			console.warn('Jobs', 'job does not exist:', job.name);
			await setJobStateAsync(job._id, 'failure');
			return;
		}

		let action: Jobs.JobStatus | 'reschedule' | 'remove' | null = null;

		const self: Jobs.JobThisType = {
			document: job,
			replicateAsync: async function(config) {
				return await Jobs.replicateAsync(job._id, config);
			},
			rescheduleAsync: async function(config) {
				action = 'reschedule';
				return await Jobs.rescheduleAsync(job._id, config);
			},
			removeAsync: async function() {
				action = 'remove';
				return await Jobs.removeAsync(job._id);
			},
			successAsync: async function() {
				action = 'success';
				return await setJobStateAsync(job._id, action);
			},
			failureAsync: async function() {
				action = 'failure';
				return await setJobStateAsync(job._id, action);
			},
		};

		async function completedAsync() {
			if (!action) {
				if (settings.defaultCompletion == 'success') {
					await setJobStateAsync(job._id, 'success');
				} else if (settings.defaultCompletion == 'remove') {
					await Jobs.removeAsync(job._id);
				} else {
					console.warn('Jobs', "Job was not resolved with success, failure, reschedule or remove. Consider using the 'defaultCompletion' option.", job);
					await setJobStateAsync(job._id, 'failure');
				}
			}
		}

		let isAsync = false;

		try {
			await setJobStateAsync(job._id, 'executing');
			const res = Jobs.jobs[job.name].apply(self, job.arguments);
			if (res?.then) {
				isAsync = true
				if (job.awaitAsync) {
					_awaitAsyncJobs.add(job.name);
				}
				res.then(async () => {
					log('Jobs', '    Done async job', job.name, 'result:', action);
					_awaitAsyncJobs.delete(job.name);
					await completedAsync();
				}).catch(async (e) => {
					console.warn('Jobs', '    Error in async job', job, e);
					console.warn(e);
					_awaitAsyncJobs.delete(job.name);
					if (action != 'reschedule') {
						await self.failureAsync();
					}
				});
			} else {
				log('Jobs', '    Done job', job.name, 'result:', action);
			}
		} catch(e) {
			console.warn('Jobs', 'Error in job', job);
			console.warn(e);
			if (action != 'reschedule') {
				await self.failureAsync();
			}
		}

		if (!isAsync) {
			await completedAsync();
		}
	}

	async function setJobStateAsync(jobId: string, state: Jobs.JobStatus) {
		const count = await Jobs.collection.updateAsync({_id: jobId}, {$set: {state: state}});
		log('Jobs', 'setJobState', jobId, state, count);
	}

};
