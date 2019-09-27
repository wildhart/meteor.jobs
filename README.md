# Meteor Jobs
(inspired heavily by [msavin:sjobs](https://github.com/msavin/SteveJobs..meteor.jobs.scheduler.queue.background.tasks))

Run scheduled tasks with the simple jobs queue made just for Meteor. With tight MongoDB integration and fibers-based timing functions, this package is quick, reliable and effortless to use.

 - Jobs run on one server at a time
 - Jobs run predictably and consecutively
 - Job timers are super-efficient
 - Jobs are stored in MongoDB
 - No third party dependencies

It can run hundreds of jobs in seconds with minimal CPU impact, making it a reasonable choice for many applications. To get started, check out the **[quick start guide](#quick-start)** and the **[full API documentation](#api-documentation)** below.

## Coming from msavin:jobs?

This package has an API inspired by [msavin:sjobs](https://github.com/msavin/SteveJobs..meteor.jobs.scheduler.queue.background.tasks) and in some cases can be a drop-in replacement.  If you're coming from msavin:jobs read about the potentially breaking **[API differences](#api-differences-from-msavinsjobs)**. If any of these differences make this package unsuitable for you, please let me know and I'll consider fixing.

The main difference in this package compared to `msavin:jobs` is that this package doesn't continuously poll the job queue. Instead, it intelligently sets a single timer for the next due job.  This means that most of the time this package is doing absolutely nothing, compared to `msavin:jobs` [which can use significant CPU even when idle](https://github.com/msavin/SteveJobs..meteor.jobs.scheduler.queue.background.tasks/issues/63). It also means that jobs are executed closer to their due date, instead of potentially late due to the polling interval.

Unfortunately I found the job queue system in `msavin:jobs` too fundamentally built-in to modify and create a PR, so it was easier to write my own package.

## Quick Start

First, install the package, and import if necessary:

```bash
meteor add wildhart:jobs
```

```javascript
import { Jobs } from 'meteor/wildhart:jobs'
```

Then, write your background jobs like you would write your methods:

```javascript
Jobs.register({
    "sendReminder": function (to, message) {
        var call = HTTP.put("http://www.magic.com/sendEmail", {
            to: to,
            message: message
        });

        if (call.statusCode === 200) {
            this.success(call.result);
        } else {
            this.reschedule({in: {minutes: 5}});
        }
    }
});
```

Finally, schedule a background job like you would call a method:

```javascript
Jobs.run("sendReminder", "jony@apple.com", "The future is here!");
```

One more thing: the function above will schedule the job to run on the moment that the function was called, however, you can delay it by passing in a special **configuration object** at the end:

```javascript
Jobs.run("sendReminder", "jony@apple.com", "The future is here!", {
    in: {
        days: 3,
    },
    on: {
        hour: 9,
        minute: 42
    },
    priority: 9999999999
});
```

The configuration object supports `date`, `in`, `on`, and `priority`, all of which are completely optional, see [Jobs.run](#jobsrun).

## API Documentation

`Jobs.register` and `Jobs.run` are all you need to get started, but that's only the beginning of what the package can do. To explore the rest of the functionality, jump into the documentation:

 - [Jobs.configure](#jobsconfigure)
 - [Jobs.register](#jobsregister)
 - [Jobs.run](#jobsrun)
 - [Jobs.execute](#jobsexecute)
 - [Jobs.reschedule](#jobsreschedule)
 - [Jobs.replicate](#jobsreplicate)
 - [Jobs.start](#jobsstart)
 - [Jobs.stop](#jobsstop)
 - [Jobs.get](#jobsget)
 - [Jobs.cancel](#jobscancel)
 - [Jobs.clear](#jobsclear)
 - [Jobs.remove](#jobsremove)
 - [Jobs.jobs](#jobsjobs)
 - [Jobs.collection](#jobscollection)
 - [Repeating Jobs](#repeating-jobs)
 - [Bulk Operations](#bulk-operations)
 - [Version History](#version-history)

### Jobs.configure

`Jobs.configure` allows you to configure how the package should work. You can configure one option or all of them. Defaults are shown in the code below:

```javascript
Jobs.configure({
	maxWait: Number,                  // (milliseconds) specify how long the server could be inactive before another server takes on the master role (default = 5min)
	startupDelay: Number,             // (milliseconds) specify how long after server startup the package should start running
	setServerId: String || Function,  // determine how to set the serverId - see below. (default = random string)
	log: Boolean || Function,         // determine if/how to log the package outputs (defalt = console.log)
	autoStart: Boolean,               // specify if all job queues should start automatically on first launch (default = true)...
	                                  //  ... after server relaunch the list of paused queues is restored from the database.
})
```
`setServerId` - In a **multi-server deployment**, jobs are only executed on one server.  Each server should have a unique ID so that it knows if it is control of the job queue or not. You can provide a function which returns a serverId from somewhere (e.g. from an environment variable) or just use the default of a random string.  In a **single-server deployment** set this to a static string so that the server knows that it is always in control and can take control more quickly after a reboot.

### Jobs.register

`Jobs.register` allows you to register a function for a job.

```javascript
Jobs.register({
	sendEmail: function (to, content) {
		var send = Magic.sendEmail(to, content);
		if (send) {
			this.success();
		} else {
			this.reschedule({in: {minutes: 5}});
		}
	},
	sendReminder: function (userId, content) {
		var doc = Reminders.insert({
			to: userId,
			content: content
		})

		if (doc) {
			this.remove();
		} else {
			this.reschedule({in: {minutes: 5}});
		}
	}
})
```

Each job is bound with a set of functions to give you maximum control over how the job runs:
 - `this.document` - access the job document
 - `this.success()` - tell the queue the job is completed
 - `this.failure()` - tell the queue the job failed
 - `this.reschedule(config)` - tell the queue to schedule the job for a future date (returns the new jobId)
 - `this.remove()` - remove the job from the queue
 - `this.replicate(config)` - create a copy of the job with a different due date provided by `config`

Each job must be resolved with success, failure, reschedule, and/or remove.

See [Repeating Jobs](#repeating-jobs)

### Jobs.run

`Jobs.run` allows you to schedule a job to run. You call it just like you would call a method, by specifying the job name and its arguments. At the end, you can pass in a special configuration object. Otherwise, it will be scheduled to run as soon as possible.

```javascript
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
```
`Jobs.run` returns a `jobDoc`.

The configuration object supports the following inputs:

- **`in`** - Object
	- The `in` parameter will schedule the job at a later time, using the current time and your inputs to calculate the due time.
- **`on`** - Object
	- The `on` parameter override the current time with your inputs.
- **`in` and `on`** - Object
	- The supported fields for in and on can be used in singular and/or plural versions:
		- millisecond, second, minute, hour, day, month, and year
		- milliseconds, seconds, minutes, hours, days, months, and years
	- The date object will be updated in the order that is specified. This means that if it is year 2017, and you set `in` one year, but `on` 2019, the year 2019 will be the final result. However, if you set `on` 2019 and `in` one year, then the year 2020 will be the final result.
- **`priority`** - Number
	- The default priority for each job is 0
	- If you set it to a positive integer, it will run ahead of other jobs.
	- If you set it to a negative integer, it will only run after all the zero or positive jobs have completed.
- **`date`** - Function
	- Provide your own date. This stacks with the `in` and `on` operator, and will be applied before they perform their operations.
* **`unique`** - Boolean
	- If a job is marked as unique, it will only be scheduled if no other job exists with the same arguments
* **`singular`** - Boolean
	- If a job is marked as singular, it will only be scheduled if no other job is **pending** with the same arguments
- **`callback`** - Function
	- Run a callback function after scheduling the job

### Jobs.execute

`Jobs.execute` allows you to run a job ahead of its due date. It can only work on jobs that have not been resolved.

```javascript
Jobs.execute(docId)
```

### Jobs.reschedule

`Jobs.reschedule` allows you to reschedule a job. It can only work on jobs that have not been resolved.

```javascript
Jobs.reschedule(jobId, {
	in: {
		minutes: 5
	},
	priority: 9999999
});
```

The configuration is passed in as the second argument, and it supports the same inputs as `Jobs.run`.

### Jobs.replicate

`Jobs.replicate` allows you to replicate a job.

```javascript
var jobId = Jobs.replicate(jobId, {
	in: {
		minutes: 5
	}
})
```

`Jobs.replicate` returns a `jobId`.

### Jobs.start

`Jobs.start` allows you start all the queues. This runs automatically unless `autoStart` is set to `false`. If you call the function with no arguments, it will start all the queues. If you pass in a String, it will start a queue with that name. If you pass in an Array, it will start all the queues named in the array.

```javascript
// Start all the queues
Jobs.start()

// Start just one queue
Jobs.start("sendReminder")

// Start multiple queues
Jobs.start(["sendReminder", "sendEmail"])
```
Unlike msavin:sjobs, this function can be called on any server and whichever server is currently in control of the job queue will be notified.


### Jobs.stop

`Jobs.stop` allows you stop all the queues. If you call the function with no arguments, it will stop all the queues. If you pass in a String, it will stop a queue with that name. If you pass in an Array, it will stop all the queues named in the array.

```javascript
// Stop all the queues
Jobs.stop()

// Stop just one queue
Jobs.stop("sendReminder")

// Stop multiple queues
Jobs.stop(["sendReminder", "sendEmail"])
```
Unlike msavin:sjobs, this function can be called on any server and whichever server is currently in control of the job queue will be notified.

If you need to stop all jobs via mongo use:
```js
mongo> db.jobs_dominator_3.update({_id:"dominatorId"}, {$set: {pausedJobs: ['*']}});
```
The in-control server should observe the change and stop instantly. Use `{$unset: {pausedJobs: 1}}` or `{$set: {pausedJobs: []}}` to start all the queues again.

### Jobs.get

`Jobs.get` allows you to get a job document by its document id.

```javascript
var jobDocument = Jobs.get(jobId);
```

A job document looks like this:

```javascript
{
	_id: 'BqjPbF9NGxY4YdnGn',
	name: 'sendEmail',
	created: '2018-05-18T09:48:48.355Z',
	state: 'success',
	due: '2018-05-18T09:48:48.355Z',
	priority: 0,
	arguments: ['jony@apple.com', 'Hello again'],
}
```

### Jobs.clear

`Jobs.clear` allows you to clear all or some of the jobs in your database.
```javascript
var count = Jobs.clear(state, jobName, ...arguments, callback);
e.g:
count = Jobs.clear(); 		// remove all completed jobs (success or failure)
count = Jobs.clear('*');	// remove all jobs
count = Jobs.clear('failed', 'sendEmail', 'jony@apple.com', function(err, count) {console.log(err, count)});
```
Parameters:
* `state` for selecting a job state (either `pending`, `success`, `failure`, or `*` to select all of them), or omit to all except `pending` jobs.
* `jobName` to only remove jobs with a specific name.
* provide `arguments` to match jobs only with the same arguments.
* `callback` to provide a callback function with `error` and `result` parameters, where `result` is the number of jobs removed.

### Jobs.remove

`Jobs.remove` allows you to remove a job from the collection.

```javascript
var success = Jobs.remove(docId);
```

### Jobs.jobs

`Jobs.jobs` gives access to an object of defined job functions:
```js
var jobNames = Object.keys(Jobs.jobs);  // ['sendEmail', 'sendReminder']
var nJobTypes = jobNames.length;        // 2
```

### Jobs.collection

`Jobs.collection` allows you to access the MongoDB collection where the jobs are stored. Ideally, you should not require interaction with the database directly.

## Repeating jobs

Repeating jobs can be created by using `this.reschedule()` in the job function, e.g.:
```javascript
Jobs.register({
	processMonthlyPayments() {
		this.reschedule({in: {months: 1}});
		processPayments();
	},
});

Jobs.run('processMonthlyPayments', {singular: true});
```

Since this package doesn't keep a job history (compared with msavin:sjobs), you can use `this.reschedule()` indefinitely without polluting the jobs database, instead of having to use `this.replicate()` followed by `this.remove()`.

## Bulk Operations

The job queue intelligently prevents lots of a single job dominating the job queue, so feel free to use this package to safely schedule bulk operations, e.g, sending 1000s of emails. Although it may take some time to send all of these emails, any other jobs which are scheduled to run while they are being sent will still be run on time.  Run each operation as its own job (e.g, 1000 separate `"sendSingleEmail"` jobs rather than a single `"send1000Emails"` job.  The job queue will run all 1000 `"sendSingleEmail"` jobs in sequence, but after each job it will check if any other jobs need to run first.

------

## API Differences From msavin:sjobs
If any of these differences make this package unsuitable for you, please let me know and I'll consider fixing.

- This package doesn't keep a job history.
- `failed` jobs are not retried, unless they have already been rescheduled.
- The Job configuration object doesn't support the `data` attribute - I never found any use for this.
- The following [Jobs.configure()](#jobsconfigure) options are not available or different:
  - `interval` - this package doesn't regularly query the job queue for due jobs, instead it intelligently sets a timer for the next job.
  - `getDate`
  - `disableDevelopmentMode`
  - `remoteCollection`
  - `autoStart` - only relevant on first launch. On relaunch the list of paused queues is restored from the database.
- The following [Jobs.configure()](#jobsconfigure) options have additional options:
  - `setServerId` can be a `String` as as well as a `Function`
  - `log` can be a `Boolean` as well as a `Function`
- In a [job function](#jobsregister), `this.set()` and `this.get()` are not provided - I never found any use for this.
- In a [job function](#jobsregister), `this.success()` and `this.failure()` to not take a `result` parameter - this package doesn't keep a job history
- [singular](#jobsrun) jobs only check for `pending` jobs of the same name, so they can be run again even if a previous job failed.
- `Jobs.start()` and `Jobs.stop()` can be called on any server and whichever server is in control of the job queue will be notified.
- `Jobs.cancel()` doesn't exist. Just remove it with [Jobs.remove()](#jobsremove) - I don't see the point in keeping old jobs lying around.
- [Jobs.clear()](#jobsclear) can take additional `argument` parameters to only delete jobs matching those arguments.
- [Jobs.jobs](#jobsjobs) doesn't exist in msavin:sjobs

------

## Version History

#### 1.0.7 (2019-09-27)
- Fix bug when using months to set the job time.
- Add return values to this.remove() etc within job.

#### 1.0.5 (2019-09-02)
- Prevent console.logging done jobs.

#### 1.0.4 (2019-07-27)
- Allow job queue to be paused while in executing loop.

#### 1.0.3 (2019-04-16)
- Fix bug when logging observer.

#### 1.0.1 (2019-03-07)
- Jobs which result in an error but have already been rescheduled will still run again at the rescheduled time.
- Access to the list of defined job types with [Jobs.jobs](#jobsjobs).

#### 0.0.3 (2019-01-17)
- Can [start](#jobsstart)/[stop](#jobsstop) the job queue.

#### 0.0.2 (2019-01-16)
- Prevent a single job type from dominating the job queue (e.g. [bulk email sending](#bulk-operations)).

#### 0.0.1 (2018-12-31)
- First release.
