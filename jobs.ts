
export namespace Jobs {

	const dominatorId = "dominatorId";

	// cap timeout limit to 24 hours to avoid Node.js limit https://github.com/wildhart/meteor.jobs/issues/5
	const MAX_TIMEOUT_MS = 24 *3600 * 1000;

	export interface Config {
		startupDelay: number,
		maxWait: number,
		log: typeof console.log | boolean;
		autoStart: boolean;
		setServerId?: string | Function;
	}

	export interface JobConfig {
		priority: number;
		due: Date;
		state: string;
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

	const settings: Config = {
		startupDelay: 1 * 1000, // default 1 second
		maxWait: 5 * 60 * 1000, // specify how long the server could be inactive before another server takes on the master role  (default=5 min)
		log: console.log,
		autoStart: true,
	};

	function log(...args: any) {
		typeof settings.log == 'function' && settings.log(...args);
	}

	function isConfig(input: any) {
		return !!(typeof input=='object' && (input.in || input.on || input.priority || input.date || input.data || input.callback || input.singular || input.unique));
	}

	export const collection = new Mongo.Collection<JobDocument>("jobs_data");
	collection._ensureIndex({name: 1, due: 1, state: 1});

	export function configure(config: Partial<Config>) {
		check(config, {
			maxWait: Match.Maybe(Number),
			setServerId: Match.Maybe(Match.OneOf(String, Function)),
			log: Match.Maybe(Match.OneOf(undefined, null, Boolean, Function)),
			autoStart: Match.Maybe(Boolean),
		});
		Object.assign(settings, config);
		if (settings.log === true) settings.log = console.log;
		log('Jobs', 'Jobs.configure', Object.keys(config));
	}

	export function register(newJobs: JobFunctions) {
		check(newJobs, Object);
		Object.assign(jobs, newJobs);
		// log('Jobs', 'Jobs.register', Object.keys(jobs).length, Object.keys(newJobs).join(', '));
	}

	export function run(name: string, ...args: any) {
		check(name, String);
		log('Jobs', 'Jobs.run', name, args.length && args[0]);

		var config = args.length && args.pop();
		if (config && !isConfig(config)) {
			args.push(config);
			config = false;
		}
		var error;
		if (config && config.unique) { // If a job is marked as unique, it will only be scheduled if no other job exists with the same arguments
			if (count(name, ...args)) error = "Unique job already exists";
		}
		if (config && config.singular) { // If a job is marked as singular, it will only be scheduled if no other job is PENDING with the same arguments
			if (countPending(name, ...args)) error = 'Singular job already exists';
		}
		if (error) {
			log('Jobs', '  '+error);
			if (config && typeof config.callback =='function') config.callback(error, null);
			return false;
		}
		const jobDoc: Mongo.OptionalId<JobDocument> = {
			name: name,
			arguments: args,
			state: 'pending',
			due: config && getDateFromConfig(config) || new Date(),
			priority: config && config.priority || 0,
			created: new Date(),
		};
		const jobId = collection.insert(jobDoc);
		if (jobId) {
			jobDoc._id = jobId;
		} else {
			error = true;
		}

		if (config && typeof config.callback=='function') config.callback(error, jobId && jobDoc);
		return error ? false : jobDoc as JobDocument;
	}

	export function execute(jobId: string) {
		check(jobId, String);
		log('Jobs', 'Jobs.execute', jobId);
		const job = collection.findOne(jobId);
		if (!job) return console.warn('Jobs', 'Jobs.execute', 'JOB NOT FOUND', jobId);
		if (job.state != 'pending') return console.warn('Jobs', 'Jobs.execute', 'JOB IS NOT PENDING', job)

		executeJob(job);
	}

	export function replicate(jobId: string, config: Partial<JobConfig>) {
		check(jobId, String);
		const date = getDateFromConfig(config);
		const job = collection.findOne(jobId);
		if (!job) return console.warn('Jobs', '    Jobs.replicate', 'JOB NOT FOUND', jobId), null;

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
		if (config.priority) set.priority = config.priority;
		const count = collection.update({_id: jobId}, {$set: set});
		log('Jobs', '    Jobs.reschedule', jobId, config, date, count);
		if (typeof config.callback == 'function') config.callback(count==0, count);
	}

	export function remove(jobId: string) {
		var count = collection.remove({_id: jobId});
		log('Jobs', '    Jobs.remove', jobId, count);
		return count > 0;
	}

	export function clear(state: '*' | JobStatus | JobStatus[], jobName: string, ...args: any) {
		const query: Mongo.Query<JobDocument> = {}

		if (state === "*") query.state = {$exists: true};
		else if (typeof state === "string") query.state = state as JobStatus;
		else if (Array.isArray(state)) query.state = {$in: state};
		else query.state = {$in: ["success", "failure"]};

		if (typeof jobName === "string") query.name = jobName;
		else if (typeof jobName === "object") query.name = {$in: jobName};

		const callback = args.length && typeof args[args.length-1]=='function' ? args.pop() : false;
		for (var a=0; a<args.length; a++) query["arguments."+a] = args[a];

		const count = collection.remove(query);
		log('Jobs', 'Jobs.clear', count, query);
		if (typeof callback == 'function') callback(null, count);
		return count;
	}

	export function findOne(jobName: string, ...args: any) {
		check(jobName, String);
		const query: Mongo.Query<JobDocument> = {name: jobName};
		for (var a=0; a<args.length; a++) query["arguments."+a] = args[a];
		return collection.findOne(query);
	}

	export function count(jobName: string, ...args: any) {
		check(jobName, String);
		const query: Mongo.Query<JobDocument> = {name: jobName};
		for (var a=0; a<args.length; a++) query["arguments."+a] = args[a];
		const count = collection.find(query).count();
		return count;
	};

	export function countPending(jobName: string, ...args: any) {
		check(jobName, String);
		const query: Mongo.Query<JobDocument>  = {
			name: jobName,
			state: 'pending',
		};
		for (var a=0; a<args.length; a++) query["arguments."+a] = args[a];
		const count = collection.find(query).count();
		return count;
	}

	export function start(jobNames: string[] | string) {
		const update: Mongo.Modifier<DominatorDocument> = {}
		if (!jobNames || jobNames=='*') update.$set = {pausedJobs: []}; // clear the pausedJobs list, start all jobs
		else update.$pullAll = {pausedJobs: typeof jobNames=='string' ? [jobNames] : jobNames};

		dominatorCollection.upsert({_id: dominatorId}, update);
		log('Jobs', 'startJobs', jobNames, update);
	}

	export function stop(jobNames: string[] | string) {
		const update: Mongo.Modifier<DominatorDocument> = {}
		if (!jobNames || jobNames=='*') update.$set = {pausedJobs: ['*']}; // stop all jobs
		else update.$addToSet = {pausedJobs: typeof jobNames=='string' ? jobNames : {$each: jobNames}};

		dominatorCollection.upsert({_id: dominatorId}, update);
		log('Jobs', 'stopJobs', jobNames, update);
	}

	/********************************* Controller *********************/

	interface DominatorDocument {
		_id?: string,
		serverId?: string,
		pausedJobs: string[],
		date?: Date,
	}

	const dominatorCollection = new Mongo.Collection<DominatorDocument>("jobs_dominator_3");
	// we don't need an index on job_dominator_3 because now it only contains one shared document.

	Meteor.startup(function() {
		log('Jobs', 'Meteor.startup, startupDelay:', (settings.startupDelay/1000)+'s...');
		dominatorCollection.remove({_id: {$ne: dominatorId}});
		Meteor.setTimeout(() => dominator.start(), settings.startupDelay);
	})

	const dominator = new class {

		lastPing: DominatorDocument = null;
		serverId: string = null;
		_pingInterval: number =  null;
		_takeControlTimeout: number = null;

		start() {
			this.serverId = (typeof settings.setServerId == 'string' && settings.setServerId)
				|| (typeof settings.setServerId == 'function' && settings.setServerId())
				|| Random.id();

			dominatorCollection.find({_id: dominatorId}).observe({
				changed: (newPing) => this._observer(newPing),
			});

			this.lastPing = dominatorCollection.findOne();
			const lastPingIsOld = this.lastPing && this.lastPing.date && this.lastPing.date.valueOf() < Date.now() - settings.maxWait;
			log('Jobs', 'startup', this.serverId, JSON.stringify(this.lastPing), 'isOld='+lastPingIsOld);

			// need !this.lastPing.serverId on following line in case Jobs.start() or Jobs.stop() updates pausedJobs before
			if (!this.lastPing || !this.lastPing.serverId) this._takeControl('no ping')					// fresh installation, no one is in control yet.
			else if (this.lastPing.serverId == this.serverId) this._takeControl('restarted')			// we were in control but have restarted - resume control
			else if (lastPingIsOld) this._takeControl('lastPingIsOld '+JSON.stringify(this.lastPing));	// other server lost control - take over
			else this._observer(this.lastPing);															// another server is recently in control, set a timer to check the ping...
		}

		private _observer(newPing: DominatorDocument) {
			log('Jobs', 'dominator.observer', newPing);
			if (this.lastPing && this.lastPing.serverId==this.serverId && newPing.serverId!=this.serverId) {
				// we were in control but another server has taken control
				this._relinquishControl();
			}
			const oldPausedJobs = this.lastPing && this.lastPing.pausedJobs || [];
			this.lastPing = newPing;
			if ((this.lastPing.pausedJobs||[]).join() != oldPausedJobs.join()) {
				// the list of paused jobs has changed - update the query for the job observer
				// needs dominator.lastPing.pausedJobs to be up-to-date so do this.lastPing = newPing above
				queue.restart();
			}
			if (this._takeControlTimeout) {
				Meteor.clearTimeout(this._takeControlTimeout);
				this._takeControlTimeout = null;
			}
			if (this.lastPing.serverId != this.serverId) {
				// we're not in control, set a timer to take control in the future...
				this._takeControlTimeout = Meteor.setTimeout(() => {
					// if this timeout isn't cleared then the dominator hasn't been updated recently so we should take control.
					this._takeControl('lastPingIsOld '+JSON.stringify(this.lastPing));
				}, settings.maxWait);
			}
		}

		private _takeControl(reason: string) {
			log('Jobs', 'takeControl', reason);
			this._ping();
			queue.start();
		}

		private _relinquishControl() {
			log('Jobs', 'relinquishControl');
			Meteor.clearInterval(this._pingInterval);
			this._pingInterval = null;
			queue.stop();
		}

		private _ping() {
			if (!this._pingInterval) this._pingInterval = Meteor.setInterval(()=>this._ping(), settings.maxWait*0.8);
			const newPing = {
				serverId: this.serverId,
				pausedJobs: this.lastPing ? (this.lastPing.pausedJobs || []) : (settings.autoStart ? [] : ['*']),
				date: new Date(),
			};
			if (!this.lastPing) this.lastPing = newPing;
			dominatorCollection.upsert({_id: dominatorId}, newPing);
			log('Jobs', 'ping', newPing.date, 'paused:', newPing.pausedJobs);
		}
	}

	const PAUSED = 'paused';

	const queue = new class {

		_handle: Meteor.LiveQueryHandle | typeof PAUSED = null;
		_timeout: number = null;
		_executing = false;

		start() {
			if (this._handle && this._handle != PAUSED) this.stop(); // this also clears any existing job timeout
			const pausedJobs = (dominator.lastPing||{}).pausedJobs || [];
			log('Jobs', 'queue.start paused:', pausedJobs);

			// don't bother creating an observer if all jobs are paused
			this._handle = pausedJobs[0]=='*' ? PAUSED : collection.find({
				state: "pending",
				name: {$nin: pausedJobs},
			}, {
				limit: 1,
				sort: {due: 1},
				fields: {name: 1, due: 1},
			}).observe({
				changed: (job) => this._observer('changed', job),
				added: (job) => this._observer('added', job),
			});
			// this will automatically call the observer which will set the timer for the next job.
		}

		stop() {
			if (this._handle && this._handle != PAUSED) this._handle.stop();
			this._handle = null;
			this._observer('stop', null);
		}

		restart() {
			// this is called by Jobs.start() and Jobs.stop() when the list of pausedJobs changes
			// only restart the queue if we're already watching it (maybe jobs were started/paused inside _executeJobs())
			if (this._handle) this.start();
		}

		private _observer(type: string, nextJob: JobDocument) {
			log('Jobs', 'queue.observer', type, nextJob, nextJob && ((nextJob.due.valueOf() - Date.now())/(60*60*1000)).toFixed(2)+'h');
			if (this._timeout) Meteor.clearTimeout(this._timeout);

			// cap timeout limit to 24 hours to avoid Node.js limit https://github.com/wildhart/meteor.jobs/issues/5
			let msTillNextJob = nextJob && (nextJob.due.valueOf() - Date.now());
			if (msTillNextJob > MAX_TIMEOUT_MS) msTillNextJob = MAX_TIMEOUT_MS;

			this._timeout = nextJob && !this._executing ? Meteor.setTimeout(()=> {
				this._timeout = null;
				this._executeJobs()
			}, msTillNextJob) : null;
		}

		private _executeJobs() {
			if (this._executing) return console.warn('already executing!');
			this._executing = true; // protect against observer/timeout race condition
			try {
				log('Jobs', 'executeJobs', 'paused:', dominator.lastPing.pausedJobs);

				// ignore job queue changes while executing jobs. Will restart observer with .start() at end
				this.stop();

				// need to prevent 1000s of the same job type from hogging the job queue and delaying other jobs
				// after running a job, add its job.name to doneJobs, then find the next job excluding those in doneJobs
				// if no other jobs can be found then clear doneJobs to allow the same job to run again.
				let job: JobDocument;
				let doneJobs: string[];

				// protect against stale read
				let lastJobId = 'not null';

				do {
					doneJobs = [];
					do {
						// findOne() is actually async but is wrapped in a Fiber, so we don't need to worry about blocking the server
						// always use the live version of dominator.lastPing.pausedJobs in case jobs are paused/restarted while executing
						const lastPing = dominatorCollection.findOne({}, {fields: {pausedJobs: 1}});
						job = collection.findOne({
							state: "pending",
							due: {$lte: new Date()},
							name: {$nin: doneJobs.concat(lastPing.pausedJobs)}, // give other job types a chance...
							_id: {$ne: lastJobId}, // protect against stale reads of the job we just executed
						}, {sort: {due: 1, priority: -1}});
						if (job) {
							lastJobId = job._id;
							executeJob(job);
							doneJobs.push(job.name); // don't do this job type again until we've tried other jobs.
						}
					} while (dominator.lastPing.pausedJobs.indexOf('*')==-1 && job);
				} while (dominator.lastPing.pausedJobs.indexOf('*')==-1 && doneJobs.length);
			} catch(e) {
				console.warn('Jobs', 'executeJobs ERROR');
				console.warn(e);
			}
			this._executing = false;
			this.start();
		}
	};

	function executeJob(job: JobDocument) {
		log('Jobs', '  '+job.name);
		if (typeof jobs[job.name]=='undefined') {
			console.warn('Jobs', 'job does not exist:', job.name);
			setJobState(job._id, 'failure');
			return;
		}
		let action: JobStatus | 'reschedule' | 'remove' = null;
		const self: JobThisType = {
			document: job,
			replicate: function(config) {
				return replicate(job._id, config);
			},
			reschedule: function(config) {
				action = 'reschedule';
				reschedule(job._id, config);
			},
			remove: function() {
				action = 'remove';
				return remove(job._id);
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

		let isAsync = false;

		try {
			setJobState(job._id, 'executing');
			const res = jobs[job.name].apply(self, job.arguments);
			if (res?.then) {
				isAsync = true;
				res.then(() => {
					log('Jobs', '    Done async job', job.name, 'result='+action);
					if (!action) {
						console.warn('Jobs', 'Async Job was not resolved with success, failure, reschedule or remove', job);
						setJobState(job._id, 'failure');
					}
				});
			} else {
				log('Jobs', '    Done job', job.name, 'result='+action);
			}
		} catch(e) {
			console.warn('Jobs', 'Error in job', job);
			console.warn(e);
			if (action != 'reschedule') self.failure();
		}

		if (!isAsync && !action) {
			console.warn('Jobs', 'Job was not resolved with success, failure, reschedule or remove', job);
			setJobState(job._id, 'failure');
		}
	}

	function setJobState(jobId: string, state: JobStatus) {
		const count = Jobs.collection.update({_id: jobId}, {$set: {state: state}});
		log('Jobs', 'setJobState', jobId, state, count);
	}

	function getDateFromConfig(config: Partial<JobConfig>) {
		// https://github.com/msavin/SteveJobs..meteor.jobs.scheduler.queue.background.tasks/blob/031fdf5051b2f2581a47f64ab5b54ffbb6893cf8/package/server/imports/utilities/helpers/date.js
		check(config, Match.ObjectIncluding({
			date: Match.Maybe(Date),
			in: Match.Maybe(Object),
			on: Match.Maybe(Object),
		}));

		let currentDate = config.date || new Date();
		let newNumber, fn;

		Object.keys(config).forEach(function(key1) {
			if (["in","on"].indexOf(key1) > -1) {
				Object.keys(config[key1]).forEach(function(key2) {
					try {
						newNumber = Number(config[key1][key2]);
						if (isNaN(newNumber)) {
							console.warn('Jobs', "invalid type was input: " + key1 + "." + key2, newNumber)
						} else {
							// convert month(s) => months (etc), and day(s) => date and year(s) => fullYear
							fn = (key2+"s").replace('ss', 's').replace('days','date').replace('years','fullYear').replace('months','month');
							// convert months => Months
							fn = fn.charAt(0).toUpperCase() + fn.slice(1);
							// if key1=='in' currentDate.setMonth(newNumber + currentDate.getMonth())
							// if key1=='on' currentDate.setMonth(newNumber)
							currentDate['set'+fn](newNumber + (key1=='in' ? currentDate['get'+fn]() : 0));
						}
					} catch (e) {
						console.warn('Jobs', "invalid argument was ignored: " + key1 + "." + key2, newNumber, fn);
						console.log(e);
					}
				});
			}
		});
		return currentDate;
	}

};