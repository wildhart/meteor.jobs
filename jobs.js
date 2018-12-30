const jobs = {};
const settings = {
	startupDelay: 1 * 1000, // default 1 second
	maxWait: 5 * 60 * 1000, // specify how long the server could be inactive before another server takes on the master role  (default=5 min)
	log: console.log,
};

const Jobs = {
	collection: new Mongo.Collection("jobs_data"),
	dominatorCollection: new Mongo.Collection("jobs_dominator_3"),
};

Jobs.collection._ensureIndex({name: 1, due: 1, state: 1});
Jobs.dominatorCollection._ensureIndex({serverId: 1}, {unique: 1});

Jobs.configure = function(config) {
	check(config, {
		maxWait: Match.Maybe(Number),
		setServerId: Match.Maybe(Match.OneOf(String, Function)),
		log: Match.Maybe(Match.OneOf(undefined, null, Boolean, Function)),
	});
	Object.assign(settings, config);
	if (settings.log===true) settings.log = console.log;
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
	var error, jobDoc;
	if (config && config.unique) { // If a job is marked as unique, it will only be scheduled if no other job exists with the same arguments
		if (Jobs.count(name, ...args)) error = "Unique job already exists";
	}
	if (config && config.singular) { // If a job is marked as singular, it will only be scheduled if no other job is PENDING with the same arguments
		if (Jobs.countPending(name, ...args)) error = 'Singular job already exists';
	}
	if (error) {
		settings.log && settings.log('Jobs', '  '+error);
		if (config && typeof config.callback =='function') config.callback(error, JobDoc);
		return jobDoc;
	}
	jobDoc = {
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
		jobDoc._simulant = true;
		findNextJob();
	} else {
		error = true;
	}

	if (config && typeof config.callback =='function') config.callback(error, jobDoc);
	return jobDoc;
};

Jobs.execute = function(jobId) {
	check(jobId, String);
	settings.log && settings.log('Jobs', 'Jobs.execute', jobId);
	const job = Jobs.collection.findOne(jobId);
	if (!job) return console.warn('Jobs', 'Jobs.execute', 'JOB NOT FOUND', jobId);
	if (job.state!='pending') return console.warn('Jobs', 'Jobs.execute', 'JOB IS NOT PENDING', job)

	executeJobs([job]); // use executeJobs() instead of executeJob() because executeJobs() also sets the executing flag and re-scans for next job afterwards
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
	if (newJobId) findNextJob();
	return newJobId;
};

Jobs.reschedule = function(jobId, config) {
	check(jobId, String);
	const date = getDateFromConfig(config);
	var set = {due: date};
	if (config.priority) set.priority = config.priority;
	const count = Jobs.collection.update({_id: jobId, state: 'pending'}, {$set: set});
	settings.log && settings.log('Jobs', '    Jobs.reschedule', jobId, config, date, count);
	if (typeof config.callback =='function') config.callback(count==0, count);
	if (count) findNextJob();
};

Jobs.remove = function(jobId) {
	var count = Jobs.collection.remove({_id: jobId});
	settings.log && settings.log('Jobs', '    Jobs.remove', jobId, count);
	if (count) findNextJob();
	return count>0;
};

Jobs.clear = function(state, jobName, ...args) {
	const query = {};

	if (state==="*") query.state = {$exists: true};
	else if (typeof state==="string") query.state = state;
	else if (typeof state==="object" && state) query.state = {$in: state}; // && state to allow state=null for default
	else query.state = {$in: ["success", "failure"]};

	if (typeof jobName === "string") query.name = jobName;
	else if (typeof jobName === "object") query.name = {$in: jobName};

	const callback = args.length && typeof args[args.length-1]=='function' ? args.pop() : false;
	for (var a=0; a<args.length; a++) query["arguments."+a]=args[a];

	const count = Jobs.collection.remove(query);
	settings.log && settings.log('Jobs', 'Jobs.clear', count, query);
	if (count) findNextJob();
	if (typeof callback=='function') callback(null, count);
	return count;
};

Jobs.findOne = function(jobName, ...args) {
	check(jobName, String);
	const query = {name: jobName};
	for (var a=0; a<args.length; a++) query["arguments."+a]=args[a];
	return Jobs.collection.findOne(query);
};

Jobs.count = function(jobName, ...args) {
	check(jobName, String);
	const query = {name: jobName};
	for (var a=0; a<args.length; a++) query["arguments."+a]=args[a];
	const count = Jobs.collection.find(query).count();
	return count;
};

Jobs.countPending = function(jobName, ...args) {
	check(jobName, String);
	const query = {
		name: jobName,
		state: 'pending',
	};
	for (var a=0; a<args.length; a++) query["arguments."+a]=args[a];
	const count = Jobs.collection.find(query).count();
	return count;
};

Jobs.findNext = function() {
	findNextJob();
}

export { Jobs }

/********************************* Controller *********************/

let serverId = null;
let jobTimeout = null;		// handle of the timeout for the next due job
let pingInterval = null;	// handle for the timeout for pinging the server (only when we are in control)
let inControl = false;		// when this server/host is in control of the jobs queue
let executing = false;		// true when executing job(s) (so that lots of rescheduling, etc, doesn't results in lots of calls to findNextJob)

Meteor.startup(function() {
	settings.log && settings.log('Jobs', 'startup');
	Meteor.setTimeout(checkControl, settings.startupDelay);
})

function checkControl() {
	serverId = serverId
		|| (typeof settings.setServerId == 'string' && settings.setServerId)
		|| (typeof settings.setServerId == 'function' && settings.setServerId())
		|| Random.id();

	const lastPing = Jobs.dominatorCollection.findOne({}, {sort: {lastPing: -1}});
	const lastPingIsOld = lastPing && lastPing.lastPing.valueOf() < new Date().valueOf() - settings.maxWait;

	settings.log && settings.log('Jobs', 'checkControl', serverId, JSON.stringify(lastPing), 'isOld='+lastPingIsOld);

	if (inControl) {
		if (!lastPing) takeControl('no ping but already in control?');	// shouldn't happen unless dominator database is manually wiped
		else if (lastPing.serverId!=serverId && !lastPingIsOld) relinquishControl();
	} else {
		if (!lastPing) takeControl('no ping')															// fresh installation, no one is in control yet.
		else if (lastPing.serverId == serverId) takeControl('restarted')								// we were in control but have restarted - resume control
		else if (lastPingIsOld) takeControl('lastPingIsOld '+lastPing.serverId+' '+lastPing.lastPing)	// other server lost control - take over
		// else leave other server in control
	}
	if (!inControl) Meteor.setTimeout(checkControl, settings.maxWait); // if inControl then we will be regularly pinging and running jobs which automatically checks control
	return inControl;
}

function relinquishControl() {
	settings.log && settings.log('Jobs', 'relinquishControl');
	inControl = false;
	if (pingInterval) pingInterval = Meteor.clearInterval(pingInterval) && false;
	if (jobTimeout) jobTimeout = Meteor.clearTimeout(jobTimeout) && false;
	Meteor.setTimeout(checkControl, settings.maxWait);
}

function takeControl(reason) {
	settings.log && settings.log('Jobs', 'takeControl', reason);
	inControl = true;
	if (!pingInterval) pingInterval = Meteor.setInterval(ping, settings.maxWait/2);
	ping(true /* manual ping */);
	Jobs.dominatorCollection.remove({serverId: {$ne: serverId}}); // keep pruning the dominator collection
	findNextJob();
}

function ping(manual=false) { // manual will be undefined/false when called from setInterval
	if (!manual && !checkControl()) return false; // don't check control if this was a manual ping because that only happens when we've only just taken control
	const date = new Date();
	settings.log && settings.log('Jobs', 'ping', date);
	Jobs.dominatorCollection.upsert({serverId: serverId}, {
		serverId: serverId,
		lastPing: date,
	});
}

function findNextJob() {
	if (executing) return; // if already executing a list of jobs then finding the next job will be done once at the end
	if (!inControl && serverId) {
		// this function is called whenever a job is rescheduled, added, removed, etc, which could be done on any of our servers.
		// if we're not in control then we can't easily tell the controlling server to re-check the job queue, so just take control ourselves
		takeControl('finding next job');
		return; // takeControl() will come back here to find the next job anyway.
	}
	const nextJob = Jobs.collection.findOne({state: "pending"}, {sort: {due: 1}, fields: {name: 1, due: 1}});
	settings.log && settings.log('Jobs', 'findNextJob', nextJob, nextJob && ((nextJob.due - new Date())/(60*60*1000)).toFixed(2)+'h');
	if (jobTimeout) jobTimeout = Meteor.clearTimeout(jobTimeout) && false;
	if (nextJob) jobTimeout = Meteor.setTimeout(executeJobs, nextJob.due - new Date());
}

function executeJobs(jobsArray=null) { // Jobs.execute() calls this function with [job] as a parameter
	settings.log && settings.log('Jobs', 'executeJobs', jobsArray);
	executing = true; // so that rescheduling, removing, etc, within the jobs doesn't result in lots of calls to findNextJob() (which is done once at the end of this function)
	try {
		(jobsArray || Jobs.collection.find({state: "pending", due: {$lte: new Date()}}, {sort: {due: 1, priority: -1}})).forEach(job => {
			if (inControl && !checkControl()) console.warn('Jobs', 'LOST CONTROL WHILE EXECUTING JOBS'); // should never happen
			if (inControl || jobsArray) executeJob(job); // allow Jobs.execute() to run a job even on a server which isn't in control, otherwise leave execution to server in control
		});
	} catch(e) {
		console.warn('Jobs', 'executeJobs ERROR');
		console.warn(e);
	}
	executing = false;
	findNextJob();
}

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
						let fn = (key2+"s").replace('ss', 's').replace('days','date').replace('years','fullYear');
						fn = fn.charAt(0).toUpperCase() + fn.slice(1);
						currentDate['set'+fn](newNumber + (key1=='in' ? currentDate['get'+fn]() : 0));
						// this is shorthand for:
						//		if key1=='in' currentDate.setMonth(newNumber + currentDate.getMonth())
						//		if key1=='in' currentDate.setMonth(newNumber)
						// where set<Month> & get<Month> are defined by key2
					}
				} catch (e) {
					console.warn('Jobs', "invalid argument was ignored: " + key1 + "." + key2, newNumber, fn);
					console.log(e);
				}
			});
		}
	});
	// settings.log && settings.log('Jobs', 'getDateFromConfig', config, currentDate);
	return currentDate;
}

function isConfig(input) {
	return !!(typeof input=='object' && (input.in || input.on || input.priority || input.date || input.data || input.callback || input.singular || input.unique));
}
