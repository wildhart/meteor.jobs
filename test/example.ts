import { Jobs } from '../jobs';

// Jobs.configure
Jobs.configure({
    // (milliseconds) specify how long the server could be inactive before another server
    // takes on the master role (default = 5min)
    // maxWait: Number,
    maxWait: 0,

    // (milliseconds) specify how long after server startup the package should start running
    // startupDelay: Number,
    startupDelay: 0,

    // determine how to set the serverId - see below. (default = random string)
    // setServerId: String || Function,
    setServerId: '',
    // setServerId: () => {},

    // determine if/how to log the package outputs (default = console.log)
    // log: Boolean || Function,
    log: true,
    // log: () => {},

    // specify if all job queues should start automatically on first launch (default = true)...
    //  ... after server relaunch the list of paused queues is restored from the database.
    // autoStart: Boolean,
    autoStart: true,

    // whether to mark successful just as successful, or remove them,
    // otherwise you have to resolve every job with this.success() or this.remove()
    // defaultCompletion: 'success' | 'remove',
    // defaultCompletion: 'remove',
    // defaultCompletion: 'remove',
});

// Jobs.register
Jobs.register({
	sendEmail: function (to, content) {
		// var send = Magic.sendEmail(to, content);
        var send = true;
		if (send) {
			this.success();
		} else {
			this.reschedule({in: {minutes: 5}});
		}
	},
	sendReminder: function (userId, content) {
		// var doc = Reminders.insert({
		// 	to: userId,
		// 	content: content
		// })
        var doc = true;

		if (doc) {
			this.remove();
		} else {
			this.reschedule({in: {minutes: 5}});
		}
	}
})

// Jobs.run
var jobDoc = Jobs.run("sendReminder", "jony@apple.com", "The future is here!", {
    in: {
        days: 3,
    },
    on: {
        hour: 9,
        minute: 42
    },
    priority: 9999999999,
    singular: true
});

// Jobs.execute
const executeId = '';
Jobs.execute(executeId)

// Jobs.reschedule
const rescheduleId = '';
Jobs.reschedule(rescheduleId, {
	in: {
		minutes: 5
	},
	priority: 9999999
});

// Jobs.replicate
const replicateId = '';
var jobId = Jobs.replicate(replicateId, {
	in: {
		minutes: 5
	}
})

// Jobs.start
// Start all the queues
Jobs.start()

// Start just one queue
Jobs.start("sendReminder")

// Start multiple queues
Jobs.start(["sendReminder", "sendEmail"])

// Jobs.stop
// Stop all the queues
Jobs.stop()

// Stop just one queue
Jobs.stop("sendReminder")

// Stop multiple queues
Jobs.stop(["sendReminder", "sendEmail"])

// Jobs.clear
// var count = Jobs.clear(state, jobName, ...arguments, callback);
// e.g:
var count = Jobs.clear(); 		// remove all completed jobs (success or failure)
var count = Jobs.clear('*');	// remove all jobs
// var count = Jobs.clear('failure', 'sendEmail', 'jony@apple.com', function(err, count)  {console.log(err, count)});
var count = Jobs.clear('failure', 'sendEmail', 'jony@apple.com', () => {});

// Jobs.remove
const removeId = '';
var success = Jobs.remove(removeId);

// Jobs.jobs
var jobNames = Object.keys(Jobs.jobs);  // ['sendEmail', 'sendReminder']
var nJobTypes = jobNames.length;        // 2

// Jobs.collection
Jobs.collection
