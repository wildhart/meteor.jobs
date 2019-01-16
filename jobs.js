const jobs = {};
const settings = {
	startupDelay: 1 * 1000, // default 1 second
	maxWait: 5 * 60 * 1000, // specify how long the server could be inactive before another server takes on the master role  (default=5 min)
	log: console.log,
	autoStart: true,
};
const dominatorId = "dominatorId";

const Jobs = {
	collection: new Mongo.Collection("jobs_data"),
	dominatorCollection: new Mongo.Collection("jobs_dominator_3"),
};

Jobs.collection._ensureIndex({name: 1, due: 1, state: 1});
// we don't need an index on job_dominator_3 because now it only contains one shared document.

Jobs.configure = function(config) {
	check(config, {
		maxWait: Match.Maybe(Number),
		setServerId: Match.Maybe(Match.OneOf(String, Function)),
		log: Match.Maybe(Match.OneOf(undefined, null, Boolean, Function)),
		autoStart: Match.Maybe(Boolean),
	});
	Object.assign(settings, config);
	if (settings.log === true) settings.log = console.log;
	settings.log && settings.log('Jobs', 'Jobs.configure', Object.keys(config));
};

Jobs.register = function(newJobs) {
	check(newJobs, Object);
	Object.assign(jobs, newJobs);
	settings.log && settings.log('Jobs', 'Jobs.register', Object.keys(jobs).length, Object.keys(newJobs).join(', '));
};

Jobs.run = function(name, ...args) {
	check(name, String);
	settings.log && settings.log('Jobs', 'Jobs.run', name, ...args);

	var config = args.length && args.pop();
	if (config && !isConfig(config)) {
		args.push(config);
		config = false;
	}
	var error;
	if (config && config.unique) { // If a job is marked as unique, it will only be scheduled if no other job exists with the same arguments
		if (Jobs.count(name, ...args)) error = "Unique job already exists";
	}
	if (config && config.singular) { // If a job is marked as singular, it will only be scheduled if no other job is PENDING with the same arguments
		if (Jobs.countPending(name, ...args)) error = 'Singular job already exists';
	}
	if (error) {
		settings.log && settings.log('Jobs', '  '+error);
		if (config && typeof config.callback =='function') config.callback(error, null);
		return false;
	}
	const jobDoc = {
		name: name,
		arguments: args,
		state: 'pending',
		due: config && getDateFromConfig(config) || new Date(),
		priority: config && config.priority || 0,
		created: new Date(),
	};
	const jobId = Jobs.collection.insert(jobDoc);
	if (jobId) {
		jobDoc._id = jobId;
	} else {
		error = true;
	}

	if (config && typeof config.callback=='function') config.callback(error, jobId && jobDoc);
	return jobDoc;
};

Jobs.execute = function(jobId) {
	check(jobId, String);
	settings.log && settings.log('Jobs', 'Jobs.execute', jobId);
	const job = Jobs.collection.findOne(jobId);
	if (!job) return console.warn('Jobs', 'Jobs.execute', 'JOB NOT FOUND', jobId);
	if (job.state != 'pending') return console.warn('Jobs', 'Jobs.execute', 'JOB IS NOT PENDING', job)

	executeJob(job);
}

Jobs.replicate = function(jobId, config) {
	check(jobId, String);
	const date = getDateFromConfig(config);
	const job = Jobs.collection.findOne(jobId);
	if (!job) return console.warn('Jobs', '    Jobs.replicate', 'JOB NOT FOUND', jobId);

	delete job._id;
	job.due = date;
	job.state = 'pending';
	const newJobId = Jobs.collection.insert(job);
	settings.log && settings.log('Jobs', '    Jobs.replicate', jobId, config);
	return newJobId;
};

Jobs.reschedule = function(jobId, config) {
	check(jobId, String);
	const date = getDateFromConfig(config);
	var set = {due: date};
	if (config.priority) set.priority = config.priority;
	const count = Jobs.collection.update({_id: jobId, state: 'pending'}, {$set: set});
	settings.log && settings.log('Jobs', '    Jobs.reschedule', jobId, config, date, count);
	if (typeof config.callback == 'function') config.callback(count==0, count);
};

Jobs.remove = function(jobId) {
	var count = Jobs.collection.remove({_id: jobId});
	settings.log && settings.log('Jobs', '    Jobs.remove', jobId, count);
	return count>0;
};

Jobs.clear = function(state, jobName, ...args) {
	const query = {};

	if (state === "*") query.state = {$exists: true};
	else if (typeof state === "string") query.state = state;
	else if (typeof state === "object" && state) query.state = {$in: state}; // && state to allow state=null for default
	else query.state = {$in: ["success", "failure"]};

	if (typeof jobName === "string") query.name = jobName;
	else if (typeof jobName === "object") query.name = {$in: jobName};

	const callback = args.length && typeof args[args.length-1]=='function' ? args.pop() : false;
	for (var a=0; a<args.length; a++) query["arguments."+a] = args[a];

	const count = Jobs.collection.remove(query);
	settings.log && settings.log('Jobs', 'Jobs.clear', count, query);
	if (typeof callback == 'function') callback(null, count);
	return count;
};

Jobs.findOne = function(jobName, ...args) {
	check(jobName, String);
	const query = {name: jobName};
	for (var a=0; a<args.length; a++) query["arguments."+a] = args[a];
	return Jobs.collection.findOne(query);
};

Jobs.count = function(jobName, ...args) {
	check(jobName, String);
	const query = {name: jobName};
	for (var a=0; a<args.length; a++) query["arguments."+a] = args[a];
	const count = Jobs.collection.find(query).count();
	return count;
};

Jobs.countPending = function(jobName, ...args) {
	check(jobName, String);
	const query = {
		name: jobName,
		state: 'pending',
	};
	for (var a=0; a<args.length; a++) query["arguments."+a] = args[a];
	const count = Jobs.collection.find(query).count();
	return count;
};

Jobs.start = function(jobNames) {
	const update = {};
	if (!jobNames || jobNames=='*') update.$set = {pausedJobs: []}; // clear the pausedJobs list, start all jobs
	else update.$pullAll = {pausedJobs: typeof jobNames=='string' ? [jobNames] : jobNames};

	Jobs.dominatorCollection.upsert({_id: dominatorId}, update);
	settings.log && settings.log('Jobs', 'startJobs', jobNames, update);
}

Jobs.stop = function(jobNames) {
	const update = {};
	if (!jobNames || jobNames=='*') update.$set = {pausedJobs: ['*']}; // stop all jobs
	else update.$addToSet = {pausedJobs: typeof jobNames=='string' ? jobNames : {$each: jobNames}};

	Jobs.dominatorCollection.upsert({_id: dominatorId}, update);
	settings.log && settings.log('Jobs', 'stopJobs', jobNames, update);
}

export { Jobs }

/********************************* Controller *********************/

Meteor.startup(function() {
	settings.log && settings.log('Jobs', 'Meteor.startup');
	Jobs.dominatorCollection.remove({_id: {$ne: dominatorId}});
	Meteor.setTimeout(()=>dominator.start(), settings.startupDelay);
})

const dominator = {
	lastPing: null,
	_serverId: null,
	_pingInterval: null,
	_takeControlTimeout: null,
	start() {
		this._serverId = (typeof settings.setServerId == 'string' && settings.setServerId)
			|| (typeof settings.setServerId == 'function' && settings.setServerId())
			|| Random.id();

		Jobs.dominatorCollection.find({_id: dominatorId}).observe({
			changed: (newPing) => this._observer(newPing),
		});

		this.lastPing = Jobs.dominatorCollection.findOne();
		const lastPingIsOld = this.lastPing && this.lastPing.date && this.lastPing.date.valueOf() < new Date().valueOf() - settings.maxWait;
		settings.log && settings.log('Jobs', 'startup', this._serverId, JSON.stringify(this.lastPing), 'isOld='+lastPingIsOld);

		// need !this.lastPing._serverId on following line in case Jobs.start() or Jobs.stop() updates pausedJobs before
		if (!this.lastPing || !this.lastPing._serverId) this._takeControl('no ping')								// fresh installation, no one is in control yet.
		else if (this.lastPing._serverId == this._serverId) this._takeControl('restarted')							// we were in control but have restarted - resume control
		else if (lastPingIsOld) this._takeControl('lastPingIsOld '+this.lastPing._serverId+' '+this.lastPing.date);	// other server lost control - take over
		else this._observer(this.lastPing);																	// another server is recently in control, set a timer to check the ping...
	},
	_observer(newPing) {
		settings.log && settings.log('Jobs', 'dominator.observer', newPing);
		if (this.lastPing && this.lastPing._serverId==this._serverId && newPing._serverId!=this._serverId) {
			// we were in control but another server has taken control
			this._relinquishControl();
		}
		const oldPausedJobs = this.lastPing && this.lastPing.pausedJobs || [];
		this.lastPing = newPing;
		if ((this.lastPing.pausedJobs||[]).join() != oldPausedJobs.join()) {
			// the list of paused jobs has changed - update the query for the job observer
			// needs dominator.lastPing.pausedJobs to be up-to-date so do this.lastPing = newPing above
			jobObserver.restart();
		}
		if (this._takeControlTimeout) {
			Meteor.clearTimeout(this._takeControlTimeout);
			this._takeControlTimeout = null;
		}
		if (this.lastPing._serverId != this._serverId) {
			// we're not in control, set a timer to take control in the future...
			this._takeControlTimeout = Meteor.setTimeout(() => {
				// if this timeout isn't cleared then the dominator hasn't been updated recently so we should take control.
				this._takeControl('lastPingIsOld '+this.lastPing._serverId+' '+this.lastPing.date);
			}, settings.maxWait);
		}
	},
	_takeControl(reason) {
		settings.log && settings.log('Jobs', 'takeControl', reason);
		this._ping();
		jobObserver.start();
	},
	_relinquishControl() {
		settings.log && settings.log('Jobs', 'relinquishControl');
		Meteor.clearInterval(this._pingInterval);
		this._pingInterval = null;
		jobObserver.stop();
	},
	_ping() {
		if (!this._pingInterval) this._pingInterval = Meteor.setInterval(()=>this._ping(), settings.maxWait*0.8);
		const newPing = {
			_serverId: this._serverId,
			pausedJobs: this.lastPing ? (this.lastPing.pausedJobs || []) : (settings.autoStart ? [] : ['*']),
			date: new Date(),
		};
		if (!this.lastPing) this.lastPing = newPing;
		Jobs.dominatorCollection.upsert({_id: dominatorId}, newPing);
		settings.log && settings.log('Jobs', 'ping', newPing.date, 'paused:', newPing.pausedJobs);
	},
};

const jobObserver = {
	_handle: null,
	_timeout: null,
	start() {
		if (this._handle && this._handle!='paused') this.stop(); // this also clears any existing job timeout
		const pausedJobs = (dominator.lastPing||{}).pausedJobs || [];
		console.log('Jobs', 'jobObserver.start paused:', pausedJobs);
		
		// don't bother creating an observer if all jobs are paused
		this._handle = pausedJobs[0]=='*' ? 'paused' : Jobs.collection.find({
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
	},
	stop() {
		if (this._handle && this._handle!='paused') this._handle.stop();
		this._handle = null;
		this._observer('stop', null);
	},
	restart() {
		// this is called by Jobs.start() and Jobs.stop() when the list of pausedJobs changes
		// only restart the queue if we're already watching it (maybe jobs were started/paused inside _executeJobs())
		if (this._handle) this.start();
	},
	_observer(type, nextJob) {
		console.log('Jobs', 'jobsObserver.observer', type, nextJob, nextJob && ((nextJob.due - new Date())/(60*60*1000)).toFixed(2)+'h');
		if (this._timeout) Meteor.clearTimeout(this._timeout);
		this._timeout = nextJob ? Meteor.setTimeout(()=>this._executeJobs(), nextJob.due - new Date()) : null;
	},
	_executeJobs() {
		settings.log && settings.log('Jobs', 'executeJobs', 'paused:', dominator.lastPing.pausedJobs);
		this.stop(); // ignore job queue changes while executing jobs. Will restart observer with .start() at end
		try {
			// need to prevent 1000s of the same job type from hogging the job queue and delaying other jobs
			// after running a job, add its job.name to doneJobs, then find the next job excluding those in doneJobs
			// if no other jobs can be found then clear doneJobs to allow the same job to run again.
			var job, doneJobs;
			do {
				doneJobs = [];
				do {
					// findOne() is actually async but is wrapped in a Fiber, so we don't need to worry about blocking the server
					// always use the live version of dominator.lastPing.pausedJobs in case jobs are paused/restarted while executing
					job = Jobs.collection.findOne({
						state: "pending",
						due: {$lte: new Date()},
						name: {$nin: doneJobs.concat(dominator.lastPing.pausedJobs)}, // give other job types a chance...
					}, {sort: {due: 1, priority: -1}});
					if (job) {
						executeJob(job);
						doneJobs.push(job.name); // don't do this job type again until we've tried other jobs.
					}
				} while (job);
			} while (doneJobs.length);
		} catch(e) {
			console.warn('Jobs', 'executeJobs ERROR');
			console.warn(e);
		}
		this.start();
	}
};

function executeJob(job) {
	settings.log && settings.log('Jobs', '  '+job.name);
	if (typeof jobs[job.name]=='undefined') {
		console.warn('Jobs', 'job does not exist:', job.name);
		setJobState(job._id, 'failed');
		return;
	}
	let action = null;
	const self = {
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
			Jobs.remove(job._id);
		},
		success: function() {
			action = 'success';
			setJobState(job._id, action);
		},
		failure: function() {
			action = 'failure';
			setJobState(job._id, action);
		},
	};

	try {
		jobs[job.name].apply(self, job.arguments);
		console.log('Jobs', '    Done job', job.name, 'result='+action);
	} catch(e) {
		console.warn('Jobs', 'Error in job', job);
		console.warn(e);
		setJobState(job._id, 'failure');
		action = 'failed'
	}

	if (!action) {
		console.warn('Jobs', 'Job was not resolved with success, failure, reschedule or remove', job);
		setJobState(job._id, 'failure');
	}
}

function setJobState(jobId, state) {
	const count = Jobs.collection.update({_id: jobId}, {$set: {state: state}});
	settings.log && settings.log('Jobs', 'setJobState', jobId, state, count);
}

function getDateFromConfig(config) {
	// https://github.com/msavin/SteveJobs..meteor.jobs.scheduler.queue.background.tasks/blob/031fdf5051b2f2581a47f64ab5b54ffbb6893cf8/package/server/imports/utilities/helpers/date.js
	check(config, Match.ObjectIncluding({
		date: Match.Maybe(Date),
		in: Match.Maybe(Object),
		on: Match.Maybe(Object),
	}));

	var currentDate = config.date || new Date();

	Object.keys(config).forEach(function(key1) {
		if (["in","on"].indexOf(key1) > -1) {
			Object.keys(config[key1]).forEach(function(key2) {
				try {
					const newNumber = Number(config[key1][key2]);
					if (isNaN(newNumber)) {
						console.warn('Jobs', "invalid type was input: " + key1 + "." + key2, newNumber)
					} else {
						// convert month(s) => months (etc), and day(s) => date and year(s) => fullYear
						let fn = (key2+"s").replace('ss', 's').replace('days','date').replace('years','fullYear');
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

function isConfig(input) {
	return !!(typeof input=='object' && (input.in || input.on || input.priority || input.date || input.data || input.callback || input.singular || input.unique));
}
