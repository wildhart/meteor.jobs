import _TypedJob from "./TypedJob";

export const TypedJob = _TypedJob;
export type JobOrId = string | false | null | {_id: string};

const settings: Jobs.Config = {
	startupDelay: 1 * 1000, // default 1 second
	maxWait: 5 * 60 * 1000, // specify how long the server could be inactive before another server takes on the master role  (default=5 min)
	log: console.log,
	autoStart: true,
	requeueOnTakeover: false, // requeue jobs left 'executing' whenever this server takes control of the queue (see README "Crash recovery")
	maxExecutionTime: 0, // (ms) requeue jobs which have been 'executing' longer than this, checked on every ping; 0 = off
};

function log(...args: any) {
	typeof settings.log == 'function' && settings.log(...args);
}

// used by Jobs.run/replicate/reschedule and by the Queue retry path; kept off the Jobs namespace so it is not exposed to apps
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
		await Jobs.createIndexes();
		Meteor.setTimeout(() => init(), settings.startupDelay);
	})

	export async function init() {
		_serverId = (typeof settings.setServerId == 'string' && settings.setServerId)
			|| (typeof settings.setServerId == 'function' && settings.setServerId())
			|| Random.id();

		await collection.find({_id: DOMINATOR_ID}).observeAsync({
			changed: (newPing) => _observer(newPing),
		});

		lastPing = await collection.findOneAsync();
		const lastPingIsOld = lastPing && lastPing.date && lastPing.date.valueOf() < Date.now() - settings.maxWait;
		log('Jobs', 'startup', _serverId, JSON.stringify(lastPing), 'isOld='+lastPingIsOld);

		// need !lastPing.serverId on following line in case Jobs.start() or Jobs.stop() updates pausedJobs before
		if (!lastPing || !lastPing.serverId) {
			// fresh installation, no one is in control yet.
			await _takeControl('no ping');
		} else if (lastPing.serverId == _serverId) {
			// we were in control but have restarted - resume control
			await _takeControl('restarted');
		} else if (lastPingIsOld) {
			// other server lost control - take over
			await _takeControl('lastPingIsOld ' + JSON.stringify(lastPing));
		} else {
			// another server is recently in control, set a timer to check the ping...
			_observer(lastPing);
		}
	}

	export async function start(jobNames?: string[] | string) {
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

	export async function stop(jobNames?: string[] | string) {
		const update: Mongo.Modifier<Document> = {}
		if (!jobNames || jobNames == '*') {
			update.$set = {pausedJobs: ['*']}; // stop all jobs
		} else {
			update.$addToSet = {pausedJobs: typeof jobNames == 'string' ? jobNames : {$each: jobNames}};
		}

		await collection.upsertAsync({_id: DOMINATOR_ID}, update);
		log('Jobs', 'stopJobs', jobNames, update);
	}

	function _observer(newPing: Document) {
		log('Jobs', 'dominator.observer', newPing);
		if (lastPing && lastPing.serverId == _serverId && newPing.serverId != _serverId) {
			// we were in control but another server has taken control
			_relinquishControl();
		}
		const oldPausedJobs = lastPing && lastPing.pausedJobs || [];
		lastPing = newPing;
		if ((lastPing.pausedJobs || []).join() != oldPausedJobs.join()) {
			// the list of paused jobs has changed - update the query for the job observer
			// needs dominator.lastPing.pausedJobs to be up-to-date so do lastPing = newPing above
			Queue.restart();
		}
		if (_takeControlTimeout) {
			Meteor.clearTimeout(_takeControlTimeout);
			_takeControlTimeout = null;
		}
		if (lastPing.serverId != _serverId) {
			// we're not in control, set a timer to take control in the future...
			_takeControlTimeout = Meteor.setTimeout(() => {
				// if this timeout isn't cleared then the dominator hasn't been updated recently so we should take control.
				_takeControl('lastPingIsOld ' + JSON.stringify(lastPing));
			}, settings.maxWait);
		}
	}

	async function _takeControl(reason: string) {
		log('Jobs', 'takeControl', reason);
		await _ping();
		if (settings.requeueOnTakeover) {
			// only the server in control executes jobs, so anything still 'executing' now was normally
			// started by a server which has since died or restarted. Opt-in: it makes execution at-least-once.
			await Jobs.requeueExecuting();
		}
		await Queue.start();
	}

	function _relinquishControl() {
		log('Jobs', 'relinquishControl');
		if (_pingInterval) {
			Meteor.clearInterval(_pingInterval);
			_pingInterval = null;
		}
		Queue.stop();
	}

	async function _ping() {
		if (!_pingInterval) {
			_pingInterval = Meteor.setInterval(() =>_ping(), settings.maxWait * 0.8);
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
		if (settings.maxExecutionTime > 0) {
			await Jobs.requeueExecuting(new Date(Date.now() - settings.maxExecutionTime));
		}
	}
}

/********************************* Public API *********************/

export namespace Jobs {

	export interface Config {
		startupDelay: number,
		maxWait: number,
		log: typeof console.log | boolean;
		autoStart: boolean;
		setServerId?: string | Function;
		defaultCompletion?: 'success' | 'remove';
		requeueOnTakeover: boolean;
		maxExecutionTime: number;
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
		jobId: string;
		retries: number;
		retryIn: any;
		callback?: Function;
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
		attempts?: number,
		retries?: number,
		retryIn?: any,
		startedAt?: Date,
	}

	export interface JobThisType {
		document: JobDocument;
		replicate(config: Partial<JobConfig>): Promise<string | null | false>;
		reschedule(config: Partial<JobConfig>): Promise<void>;
		remove(): Promise<boolean>;
		success(): Promise<void>;
		failure(): Promise<void>;
	}

    export type JobFunction<TArgs extends any[]> = (this: JobThisType, ...args: TArgs) => void;
	export type JobFunctions = Record<string, JobFunction<any>>;
	export type RegisterFn = (jobFunctions: JobFunctions) => void;

	export const jobs: JobFunctions = {};

	export const collection = new Mongo.Collection<JobDocument>("jobs_data");

	// Create index - will be called from startup
	export async function createIndexes() {
		await collection.createIndexAsync({name: 1, due: 1, state: 1});
		// for requeueExecuting(), which otherwise scans the whole collection on every ping when maxExecutionTime is set.
		// Partial, so it only holds the (few) executing jobs.
		await collection.createIndexAsync({state: 1, startedAt: 1}, {partialFilterExpression: {state: 'executing'}});
	}

	export function configure(config: Partial<Config>) {
		check(config, {
			maxWait: Match.Maybe(Number),
			setServerId: Match.Maybe(Match.OneOf(String, Function)),
			log: Match.Maybe(Match.OneOf(undefined, null, Boolean, Function)),
			autoStart: Match.Maybe(Boolean),
			defaultCompletion: Match.Maybe(Match.Where((val => /^(success|remove)$/.test(val)))),
			startupDelay: Match.Maybe(Number),
			requeueOnTakeover: Match.Maybe(Boolean),
			maxExecutionTime: Match.Maybe(Number),
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

	const configItems: Array<keyof JobConfig> = ['in', 'on', 'priority', 'date', 'callback', 'singular', 'unique', 'awaitAsync', 'jobId', 'retries', 'retryIn']

	const isConfig = (input: any) => !!(input && typeof input == 'object' && configItems.some(i => typeof input[i] != 'undefined'));

	export async function run(name: string, ...args: any) {
		check(name, String);
		log('Jobs', 'Jobs.run', name, args.length && args[0]);

		var config = args.length && args.pop() as Partial<JobConfig> || null;
		if (config && !isConfig(config)) {
			args.push(config);
			config = null;
		}
		if (config?.jobId !== undefined) {
			// validate before the unique/singular queries below so a bad id fails fast
			check(config.jobId, Match.Where((id: any) => typeof id == 'string' && id.length > 0));
		}
		if (config?.retries !== undefined) {
			check(config.retries, Match.Where((n: any) => Number.isInteger(n) && n >= 0));
			check(config.retryIn, Match.Maybe(Object));
		}
		var error;
		if (config?.unique) { // If a job is marked as unique, it will only be scheduled if no other job exists with the same arguments
			if (await count(name, ...args)) error = "Unique job already exists";
		}
		if (config?.singular) { // If a job is marked as singular, it will only be scheduled if no other job is PENDING with the same arguments
			if (await countPending(name, ...args)) error = 'Singular job already exists';
		}
		if (error) {
			log('Jobs', '  ' + error);
			if (typeof config?.callback =='function') {
				config.callback(error, null);
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
			retries: config?.retries || undefined,
			retryIn: config?.retries && config.retryIn || undefined,
		};
		if (config?.jobId !== undefined) {
			// caller-chosen id, so a job can be enqueued idempotently and looked up without a query
			jobDoc._id = config.jobId;
		}
		let jobId: string | undefined;
		try {
			jobId = await collection.insertAsync(jobDoc);
		} catch (e: any) {
			if (config?.jobId && isDuplicateKeyError(e)) {
				error = 'Job with this id already exists';
				log('Jobs', '  ' + error, config.jobId);
				if (typeof config?.callback == 'function') {
					config.callback(error, null);
				}
				return false;
			}
			throw e;
		}
		if (jobId) {
			jobDoc._id = jobId;
		} else {
			error = true;
		}

		if (typeof config?.callback == 'function') {
			config.callback(error, jobId && jobDoc);
		}
		return error ? false : jobDoc as JobDocument;
	}

	export interface ExecuteOptions {
		// resolve only once the job function has finished, including async job functions
		awaitCompletion?: boolean;
	}

	// how a job was resolved, or 'executing' for an async job which is still running (no awaitCompletion)
	export type ExecuteResult = 'success' | 'failure' | 'reschedule' | 'remove' | 'executing';

	export async function execute(jobOrId: JobOrId, options?: ExecuteOptions): Promise<ExecuteResult | false> {
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
			return false;
		}
		if (job.state != 'pending') {
			console.warn('Jobs', 'Jobs.execute', 'JOB IS NOT PENDING', job);
			return false;
		}

		return await Queue.executeJob(job, options);
	}

	export async function replicate(jobOrId: JobOrId, config: Partial<JobConfig>) {
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
		delete job.attempts; // the copy keeps `retries`/`retryIn` but starts its own run cycle
		delete job.startedAt;
		job.due = date;
		job.state = 'pending';
		const newJobId = await collection.insertAsync(job);
		log('Jobs', '    Jobs.replicate', jobId, config);
		return newJobId;
	}

	export async function reschedule(jobOrId: JobOrId, config: Partial<JobConfig>) {
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
		// a reschedule starts a new run cycle, so the job gets its full `retries` again (see Queue.executeJob)
		const count = await collection.updateAsync({_id: jobId}, {$set: set, $unset: {attempts: ''}});
		log('Jobs', '    Jobs.reschedule', jobId, config, date, count);
		if (typeof config.callback == 'function') {
			config.callback(count==0, count);
		}
	}

	export async function remove(jobOrId: JobOrId) {
		if (!jobOrId) {
			return false;
		}
		const jobId = typeof jobOrId == 'string' ? jobOrId : jobOrId._id;
		var count = await collection.removeAsync({_id: jobId});
		log('Jobs', '    Jobs.remove', jobId, count);
		return count > 0;
	}

	export async function clear(state?: '*' | JobStatus | JobStatus[], jobName?: string, ...args: any[]) {
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
		callback?.(null, count);

		return count;
	}

	export async function findOne(jobName: string, ...args: any[]) {
		check(jobName, String);
		const query: Mongo.Query<JobDocument> = {
			name: jobName,
		};
		args.forEach((arg, index) => query["arguments." + index] = arg);
		return await collection.findOneAsync(query);
	}

	export async function count(jobName: string, ...args: any[]) {
		check(jobName, String);
		const query: Mongo.Query<JobDocument> = {
			name: jobName,
		};
		args.forEach((arg, index) => query["arguments." + index] = arg);
		const count = await collection.find(query).countAsync();
		return count;
	};

	export async function countPending(jobName: string, ...args: any[]) {
		check(jobName, String);
		const query: Mongo.Query<JobDocument>  = {
			name: jobName,
			state: 'pending',
		};
		args.forEach((arg, index) => query["arguments." + index] = arg);
		const count = await collection.find(query).countAsync();
		return count;
	}

	export const start = Dominator.start;
	export const stop = Dominator.stop;

	function isDuplicateKeyError(e: any) {
		return e?.code == 11000 || /duplicate key/i.test(e?.message || '');
	}

	/**
	 * Return 'executing' jobs to 'pending' so they run again. Called automatically when a server takes
	 * control of the queue if `requeueOnTakeover` is set (the previous server died or restarted mid-job)
	 * and, when `maxExecutionTime` is configured, on every ping for jobs started before `olderThan`.
	 * Jobs are rerun from scratch, so job functions should be safe to run more than once.
	 * A job with `retries` which has already used all its attempts (it crashed the server on its last
	 * allowed run) is marked 'failure' instead, so a job which keeps crashing the server does not loop forever.
	 */
	export async function requeueExecuting(olderThan?: Date) {
		const query: Mongo.Query<JobDocument> = {state: 'executing'};
		if (olderThan) {
			query.startedAt = {$lte: olderThan};
		}
		const failed = await collection.updateAsync({
			...query,
			retries: {$exists: true},
			$expr: {$gt: ['$attempts', '$retries']},
		} as any, {
			$set: {state: 'failure'},
			$unset: {startedAt: ''},
		}, {multi: true});
		if (failed) {
			log('Jobs', 'requeueExecuting', 'marked failed, no attempts left:', failed);
		}
		const count = await collection.updateAsync(query, {
			$set: {state: 'pending'},
			$unset: {startedAt: ''},
		}, {multi: true});
		if (count) {
			log('Jobs', 'requeueExecuting', count, olderThan || 'all');
		}
		return count;
	}
}

/********************************* Queue *********************/

namespace Queue {

	const PAUSED = 'paused';

	var _handle: Meteor.LiveQueryHandle | typeof PAUSED | null = null;
	var _timeout: number | null = null;
	var _executing = false;
	var _awaitAsyncJobs = new Set<string>();

	export async function start() {
		if (_handle && _handle != PAUSED) {
			stop(); // this also clears any existing job timeout
		}
		const pausedJobs = (Dominator.lastPing || {}).pausedJobs || [];
		log('Jobs', 'queue.start paused:', pausedJobs);

		// don't bother creating an observer if all jobs are paused
		_handle = pausedJobs[0]=='*' ? PAUSED : await Jobs.collection.find({
			state: "pending",
			name: {$nin: pausedJobs},
		}, {
			limit: 1,
			sort: {due: 1},
			fields: {name: 1, due: 1},
		}).observeAsync({
			changed: (job) => _observer('changed', job),
			added: (job) => _observer('added', job),
		});
		// this will automatically call the observer which will set the timer for the next job.
	}

	export function stop() {
		if (_handle && _handle != PAUSED) {
			_handle.stop();
		}
		_handle = null;
		_observer('stop');
	}

	export function restart() {
		// this is called by Jobs.start() and Jobs.stop() when the list of pausedJobs changes
		// only restart the queue if we're already watching it (maybe jobs were started/paused inside _executeJobs())
		if (_handle) {
			start();
		}
	}

	// cap timeout limit to 24 hours to avoid Node.js limit https://github.com/wildhart/meteor.jobs/issues/5
	const MAX_TIMEOUT_MS = 24 *3600 * 1000;

	function _observer(type: string, nextJob?: Jobs.JobDocument) {
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
				_executeJobs()
			}, msTillNextJob) : null;
		}
	}

	async function _executeJobs() {
		// protect against observer/timeout race condition
		if (_executing) {
			console.warn('already executing!');
			return;
		}
		_executing = true;

		try {
			log('Jobs', 'executeJobs', 'paused:', Dominator.lastPing?.pausedJobs);

			// ignore job queue changes while executing jobs. Will restart observer with .start() at end
			stop();

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
					const lastPing = await Dominator.collection.findOneAsync({}, {fields: {pausedJobs: 1}});
					const pausedJobs = lastPing?.pausedJobs || [];
					job = await Jobs.collection.findOneAsync({
						state: "pending",
						due: {$lte: new Date()},
						name: {$nin: doneJobs.concat(pausedJobs, Array.from(_awaitAsyncJobs))}, // give other job types a chance...
						_id: {$ne: lastJobId}, // protect against stale reads of the job we just executed
					}, {sort: {due: 1, priority: -1}});
					if (job) {
						lastJobId = job._id;
						await executeJob(job);
						doneJobs.push(job.name); // don't do this job type again until we've tried other jobs.
					}
				} while ((Dominator.lastPing?.pausedJobs || []).indexOf('*') == -1 && job);
			} while ((Dominator.lastPing?.pausedJobs || []).indexOf('*') == -1 && doneJobs.length);
		} catch(e) {
			console.warn('Jobs', 'executeJobs ERROR');
			console.warn(e);
		}

		_executing = false;
		await start();
	}

	export async function executeJob(job: Jobs.JobDocument, {awaitCompletion = false}: Jobs.ExecuteOptions = {}): Promise<Jobs.ExecuteResult> {
		log('Jobs', '  ' + job.name);

		if (typeof Jobs.jobs[job.name] == 'undefined') {
			console.warn('Jobs', 'job does not exist:', job.name);
			await setJobState(job._id, 'failure');
			return 'failure';
		}

		let action: Jobs.ExecuteResult | null = null;

		const self: Jobs.JobThisType = {
			document: job,
			replicate: async function(config) {
				return await Jobs.replicate(job._id, config);
			},
			reschedule: async function(config) {
				action = 'reschedule';
				await Jobs.reschedule(job._id, config);
			},
			remove: async function() {
				action = 'remove';
				return await Jobs.remove(job._id);
			},
			success: async function() {
				action = 'success';
				return await setJobState(job._id, action);
			},
			failure: async function() {
				action = 'failure';
				return await setJobState(job._id, action);
			},
		};

		// apply defaultCompletion if the job did not resolve itself, and report how the job was resolved
		async function completed(): Promise<Jobs.ExecuteResult> {
			if (!action) {
				if (settings.defaultCompletion == 'success') {
					action = 'success';
					await setJobState(job._id, action);
				} else if (settings.defaultCompletion == 'remove') {
					action = 'remove';
					await Jobs.remove(job._id);
				} else {
					console.warn('Jobs', "Job was not resolved with success, failure, reschedule or remove. Consider using the 'defaultCompletion' option.", job);
					action = 'failure';
					await setJobState(job._id, action);
				}
			}
			return action;
		}

		// retry a job whose function threw (or rejected) if it has retries left, otherwise mark it failed
		async function failed() {
			if (action == 'reschedule') {
				return;
			}
			const attempts = job.attempts || 0;
			if (job.retries && attempts <= job.retries) {
				log('Jobs', '    retrying', job.name, 'attempt', attempts, 'of', job.retries + 1);
				action = 'reschedule';
				// not Jobs.reschedule(): that resets `attempts`, because a reschedule by the job or the app starts a new run cycle
				const due = getDateFromConfig({in: job.retryIn || {}});
				await Jobs.collection.updateAsync({_id: job._id}, {$set: {state: 'pending', due}});
			} else {
				await self.failure();
			}
		}

		// set for an async job function: settles once it has finished and its state is resolved;
		// the queue does not wait for it (async jobs run concurrently) but Jobs.execute can.
		let completion: Promise<Jobs.ExecuteResult> | null = null;

		try {
			// `attempts` counts the runs of the current scheduling of the job (reset by Jobs.reschedule)
			await Jobs.collection.updateAsync({_id: job._id}, {$set: {state: 'executing', startedAt: new Date()}, $inc: {attempts: 1}});
			job.attempts = (job.attempts || 0) + 1;
			const res: any = Jobs.jobs[job.name].apply(self, job.arguments);
			if (res?.then) {
				if (job.awaitAsync) {
					_awaitAsyncJobs.add(job.name);
				}
				completion = res.then(async () => {
					log('Jobs', '    Done async job', job.name, 'result:', action);
					_awaitAsyncJobs.delete(job.name);
					return await completed();
				}).catch(async (e: any) => {
					console.warn('Jobs', '    Error in async job', job);
					console.warn(e);
					_awaitAsyncJobs.delete(job.name);
					await failed();
					return action ?? 'failure';
				});
			} else {
				log('Jobs', '    Done job', job.name, 'result:', action);
			}
		} catch(e) {
			console.warn('Jobs', 'Error in job', job);
			console.warn(e);
			await failed();
		}

		return !completion ? await completed()
			: awaitCompletion ? await completion
			: 'executing';
	}

	async function setJobState(jobId: string, state: Jobs.JobStatus) {
		const count = await Jobs.collection.updateAsync({_id: jobId}, {$set: {state: state}});
		log('Jobs', 'setJobState', jobId, state, count);
	}

};
