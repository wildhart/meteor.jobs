
import { check, Match } from 'meteor/check';
import { Meteor } from 'meteor/meteor';
import { Mongo } from 'meteor/mongo';
import { Random } from 'meteor/random';

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
		serverId?: string,
		pausedJobs: string[],
		date?: Date,
	}

	// we don't need an index on job_dominator_3 because now it only contains one shared document.
	export const collection = new Mongo.Collection<Document>("jobs_dominator_3");
	// @ts-ignore
	export let lastPing: Readonly<Document> = null;
	const DOMINATOR_ID = "dominatorId";
	// @ts-ignore
	let _serverId: string = null;
	// @ts-ignore
	let _pingInterval: number =  null;
	// @ts-ignore
	let _takeControlTimeout: number = null;

	Meteor.startup(() => {
		log('Jobs', `Meteor.startup, startupDelay: ${settings.startupDelay / 1000}s...`);
		collection.remove({_id: {$ne: DOMINATOR_ID}});
		Meteor.setTimeout(() => init(), settings.startupDelay);
	})

	export function init() {
		_serverId = (typeof settings.setServerId == 'string' && settings.setServerId)
			|| (typeof settings.setServerId == 'function' && settings.setServerId())
			|| Random.id();

		collection.find({_id: DOMINATOR_ID}).observe({
			changed: (newPing) => _observer(newPing),
		});

		// @ts-ignore
		lastPing = collection.findOne();
		const lastPingIsOld = lastPing && lastPing.date && lastPing.date.valueOf() < Date.now() - settings.maxWait;
		log('Jobs', 'startup', _serverId, JSON.stringify(lastPing), 'isOld='+lastPingIsOld);

		// need !lastPing.serverId on following line in case Jobs.start() or Jobs.stop() updates pausedJobs before
		if (!lastPing || !lastPing.serverId) {
			// fresh installation, no one is in control yet.
			_takeControl('no ping');
		} else if (lastPing.serverId == _serverId) {
			// we were in control but have restarted - resume control
			_takeControl('restarted');
		} else if (lastPingIsOld) {
			// other server lost control - take over
			_takeControl('lastPingIsOld ' + JSON.stringify(lastPing));
		} else {
			// another server is recently in control, set a timer to check the ping...
			_observer(lastPing);
		}
	}

	export function start(jobNames: string[] | string) {
		const update: Mongo.Modifier<Document> = {}
		if (!jobNames || jobNames == '*') {
			// clear the pausedJobs list, start all jobs
			update.$set = {pausedJobs: []};
		} else {
			update.$pullAll = {pausedJobs: typeof jobNames == 'string' ? [jobNames] : jobNames};
		}

		collection.upsert({_id: DOMINATOR_ID}, update);
		log('Jobs', 'startJobs', jobNames, update);
	}

	export function stop(jobNames: string[] | string) {
		const update: Mongo.Modifier<Document> = {}
		if (!jobNames || jobNames == '*') {
			update.$set = {pausedJobs: ['*']}; // stop all jobs
		} else {
			update.$addToSet = {pausedJobs: typeof jobNames == 'string' ? jobNames : {$each: jobNames}};
		}

		collection.upsert({_id: DOMINATOR_ID}, update);
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
			// @ts-ignore
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

	function _takeControl(reason: string) {
		log('Jobs', 'takeControl', reason);
		_ping();
		Queue.start();
	}

	function _relinquishControl() {
		log('Jobs', 'relinquishControl');
		Meteor.clearInterval(_pingInterval);
		// @ts-ignore
		_pingInterval = null;
		Queue.stop();
	}

	function _ping() {
		if (!_pingInterval) {
			_pingInterval = Meteor.setInterval(() =>_ping(), settings.maxWait * 0.8);
		}
		const newPing = {
			serverId: _serverId,
			pausedJobs: lastPing ? (lastPing.pausedJobs || []) : (settings.autoStart ? [] : ['*']),
			date: new Date(),
		};
		if (!lastPing) {
			lastPing = newPing;
		}
		collection.upsert({_id: DOMINATOR_ID}, newPing);
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
		setServerId?: string | Function;
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
	}

	export interface JobThisType {
		document: JobDocument;
		replicate(config: Partial<JobConfig>): string | null;
		reschedule(config: Partial<JobConfig>): void;
		remove(): boolean;
		success(): void;
		failure(): void;
	}

	export type JobFunction = (this: JobThisType, ...args: any[]) => void;
	export type JobFunctions = Record<string, JobFunction>;
	export type RegisterFn = (jobFunctions: JobFunctions) => void;

	export const jobs: JobFunctions = {};

	export const collection = new Mongo.Collection<JobDocument>("jobs_data");

	collection._ensureIndex({name: 1, due: 1, state: 1});

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

	export function run(name: string, ...args: any) {
		check(name, String);
		log('Jobs', 'Jobs.run', name, args.length && args[0]);

		var config = args.length && args.pop() as Partial<JobConfig> || null;
		if (config && !isConfig(config)) {
			args.push(config);
			config = null;
		}
		var error;
		if (config?.unique) { // If a job is marked as unique, it will only be scheduled if no other job exists with the same arguments
			if (count(name, ...args)) error = "Unique job already exists";
		}
		if (config?.singular) { // If a job is marked as singular, it will only be scheduled if no other job is PENDING with the same arguments
			if (countPending(name, ...args)) error = 'Singular job already exists';
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
		};
		const jobId = collection.insert(jobDoc);
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

	export function execute(jobId: string) {
		check(jobId, String);
		log('Jobs', 'Jobs.execute', jobId);
		const job = collection.findOne(jobId);
		if (!job) {
			console.warn('Jobs', 'Jobs.execute', 'JOB NOT FOUND', jobId);
			return;
		}
		if (job.state != 'pending') {
			console.warn('Jobs', 'Jobs.execute', 'JOB IS NOT PENDING', job);
			return;
		}

		Queue.executeJob(job);
	}

	export function replicate(jobId: string, config: Partial<JobConfig>) {
		check(jobId, String);
		const date = getDateFromConfig(config);
		const job = collection.findOne(jobId);
		if (!job) {
			console.warn('Jobs', '    Jobs.replicate', 'JOB NOT FOUND', jobId);
			return null;
		}

		// @ts-ignore
		delete job._id;
		job.due = date;
		job.state = 'pending';
		const newJobId = collection.insert(job);
		log('Jobs', '    Jobs.replicate', jobId, config);
		return newJobId;
	}

	export function reschedule(jobId: string, config: Partial<JobConfig>) {
		check(jobId, String);
		const date = getDateFromConfig(config);
		var set: Partial<JobDocument> = {due: date, state: 'pending'};
		if (config.priority) {
			set.priority = config.priority;
		}
		const count = collection.update({_id: jobId}, {$set: set});
		log('Jobs', '    Jobs.reschedule', jobId, config, date, count);
		if (typeof config.callback == 'function') {
			config.callback(count==0, count);
		}
	}

	export function remove(jobId: string) {
		var count = collection.remove({_id: jobId});
		log('Jobs', '    Jobs.remove', jobId, count);
		return count > 0;
	}

	export function clear(state: '*' | JobStatus | JobStatus[], jobName: string, ...args: any[]) {
		const query: Mongo.Query<JobDocument> = {
			state: state === "*" ? {$exists: true}
				: typeof state === "string" ? state as JobStatus
				: Array.isArray(state) ? {$in: state}
				: {$in: ["success", "failure"]}
		};

		if (typeof jobName === "string") {
			query.name = jobName;
		} else if (typeof jobName === "object") {
			query.name = {$in: jobName};
		}

		const callback = args.length && typeof args[args.length - 1] == 'function' ? args.pop() : null;
		args.forEach((arg, index) => query["arguments." + index] = arg);

		const count = collection.remove(query);
		log('Jobs', 'Jobs.clear', count, query);
		callback?.(null, count);

		return count;
	}

	export function findOne(jobName: string, ...args: any[]) {
		check(jobName, String);
		const query: Mongo.Query<JobDocument> = {
			name: jobName,
		};
		args.forEach((arg, index) => query["arguments." + index] = arg);
		return collection.findOne(query);
	}

	export function count(jobName: string, ...args: any[]) {
		check(jobName, String);
		const query: Mongo.Query<JobDocument> = {
			name: jobName,
		};
		args.forEach((arg, index) => query["arguments." + index] = arg);
		const count = collection.find(query).count();
		return count;
	};

	export function countPending(jobName: string, ...args: any[]) {
		check(jobName, String);
		const query: Mongo.Query<JobDocument>  = {
			name: jobName,
			state: 'pending',
		};
		args.forEach((arg, index) => query["arguments." + index] = arg);
		const count = collection.find(query).count();
		return count;
	}

	export const start = Dominator.start;
	export const stop = Dominator.stop;

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
				// @ts-ignore
				Object.keys(config[key1]).forEach(key2 => {
					try {
						// @ts-ignore
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
							// @ts-ignore
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

	// @ts-ignore
	var _handle: Meteor.LiveQueryHandle | typeof PAUSED = null;
	// @ts-ignore
	var _timeout: number = null;
	var _executing = false;
	var _awaitAsyncJobs = new Set<string>();

	export function start() {
		if (_handle && _handle != PAUSED) {
			stop(); // this also clears any existing job timeout
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
			changed: (job) => _observer('changed', job),
			added: (job) => _observer('added', job),
		});
		// this will automatically call the observer which will set the timer for the next job.
	}

	export function stop() {
		if (_handle && _handle != PAUSED) {
			_handle.stop();
		}
		// @ts-ignore
		_handle = null;
		// @ts-ignore
		_observer('stop', null);
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

	function _observer(type: string, nextJob: Jobs.JobDocument) {
		log('Jobs', 'queue.observer', type, nextJob, nextJob && ((nextJob.due.valueOf() - Date.now())/(60*60*1000)).toFixed(2)+'h');
		if (_timeout) {
			Meteor.clearTimeout(_timeout);
		}

		// cap timeout limit to 24 hours to avoid Node.js limit https://github.com/wildhart/meteor.jobs/issues/5
		let msTillNextJob = Math.min(MAX_TIMEOUT_MS, nextJob && (nextJob.due.valueOf() - Date.now()));

		// @ts-ignore
		_timeout = nextJob && !_executing ? Meteor.setTimeout(()=> {
			// @ts-ignore
			_timeout = null;
			_executeJobs()
		}, msTillNextJob) : null;
	}

	function _executeJobs() {
		// protect against observer/timeout race condition
		if (_executing) {
			console.warn('already executing!');
			return;
		}
		_executing = true; 

		try {
			log('Jobs', 'executeJobs', 'paused:', Dominator.lastPing.pausedJobs);

			// ignore job queue changes while executing jobs. Will restart observer with .start() at end
			stop();

			// need to prevent 1000s of the same job type from hogging the job queue and delaying other jobs
			// after running a job, add its job.name to doneJobs, then find the next job excluding those in doneJobs
			// if no other jobs can be found then clear doneJobs to allow the same job to run again.
			let job: Jobs.JobDocument;
			let doneJobs: string[];

			// protect against stale read
			let lastJobId = 'not null';

			do {
				doneJobs = [];
				do {
					// always use the live version of dominator.lastPing.pausedJobs in case jobs are paused/restarted while executing
					const lastPing = Dominator.collection.findOne({}, {fields: {pausedJobs: 1}});
					// @ts-ignore
					job = Jobs.collection.findOne({
						state: "pending",
						due: {$lte: new Date()},
						// @ts-ignore
						name: {$nin: doneJobs.concat(lastPing.pausedJobs, Array.from(_awaitAsyncJobs))}, // give other job types a chance...
						_id: {$ne: lastJobId}, // protect against stale reads of the job we just executed
					}, {sort: {due: 1, priority: -1}});
					if (job) {
						lastJobId = job._id;
						executeJob(job);
						doneJobs.push(job.name); // don't do this job type again until we've tried other jobs.
					}
				} while (Dominator.lastPing.pausedJobs.indexOf('*') == -1 && job);
			} while (Dominator.lastPing.pausedJobs.indexOf('*') == -1 && doneJobs.length);
		} catch(e) {
			console.warn('Jobs', 'executeJobs ERROR');
			console.warn(e);
		}

		_executing = false;
		start();
	}

	export function executeJob(job: Jobs.JobDocument) {
		log('Jobs', '  ' + job.name);

		if (typeof Jobs.jobs[job.name] == 'undefined') {
			console.warn('Jobs', 'job does not exist:', job.name);
			setJobState(job._id, 'failure');
			return;
		}

		// @ts-ignore
		let action: Jobs.JobStatus | 'reschedule' | 'remove' = null;

		const self: Jobs.JobThisType = {
			document: job,
			replicate: function(config) {
				return Jobs.replicate(job._id, config);
			},
			reschedule: function(config) {
				action = 'reschedule';
				Jobs.reschedule(job._id, config);
			},
			remove: function() {
				action = 'remove';
				return Jobs.remove(job._id);
			},
			success: function() {
				action = 'success';
				return setJobState(job._id, action);
			},
			failure: function() {
				action = 'failure';
				return setJobState(job._id, action);
			},
		};

		function completed() {
			if (!action) {
				if (settings.defaultCompletion == 'success') {
					setJobState(job._id, 'success');
				} else if (settings.defaultCompletion == 'remove') {
					Jobs.remove(job._id);
				} else {
					console.warn('Jobs', "Job was not resolved with success, failure, reschedule or remove. Consider using the 'defaultCompletion' option.", job);
					setJobState(job._id, 'failure');
				}
			}
		}

		let isAsync = false;

		try {
			setJobState(job._id, 'executing');
			const res = Jobs.jobs[job.name].apply(self, job.arguments);
			// @ts-ignore
			if (res?.then) {
				isAsync = true
				if (job.awaitAsync) {
					_awaitAsyncJobs.add(job.name);
				}
				// @ts-ignore
				res.then(() => {
					log('Jobs', '    Done async job', job.name, 'result:', action);
					_awaitAsyncJobs.delete(job.name);
					completed();
				// @ts-ignore
				}).catch(e => {
					console.warn('Jobs', '    Error in async job', job);
					console.warn(e);
					_awaitAsyncJobs.delete(job.name);
					if (action != 'reschedule') {
						self.failure();
					}
				});
			} else {
				log('Jobs', '    Done job', job.name, 'result:', action);
			}
		} catch(e) {
			console.warn('Jobs', 'Error in job', job);
			console.warn(e);
			if (action != 'reschedule') {
				self.failure();
			}
		}

		if (!isAsync) {
			completed();
		}
	}

	function setJobState(jobId: string, state: Jobs.JobStatus) {
		const count = Jobs.collection.update({_id: jobId}, {$set: {state: state}});
		log('Jobs', 'setJobState', jobId, state, count);
	}

};

