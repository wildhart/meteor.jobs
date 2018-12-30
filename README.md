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

The configuration object supports `date`, `in`, `on`, and `priority`, all of which are completely optional.

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
 - [Jobs.collection](#jobscollection)
 - [Jobs.findNext](#jobsfindNext)
 - [A note about Multi-server environments](#a-note-about-multi-server-environments)
 - [Repeating Jobs](#repeating-jobs)

### Jobs.configure

`Jobs.configure` allows you to configure how the package should work. You can figure one option or all of them. Defaults are shown in the code below:

```javascript
Jobs.configure({
	maxWait: Number,                  // (milliseconds) specify how long the server could be inactive before another server takes on the master role (default = 5min)
	startupDelay: Number,             // (milliseconds) specify how long after server startup the package should start running
	setServerId: String || Function,  // determine how to set the serverId - see below. (default = random string)
	log: Boolean || Function,         // determine if/how to log the package outputs (defalt = console.log)
})
```
`setServerId` - In a **multi-server deployment**, jobs are only executed on one server.  Each server should have a unique ID so that it knows if it is control of the job queue or not. You can provide a function which returns a serverId from somewhere, or provide a static string (e.g. from an environment variable).  In a **single-server deployment** set this to a static string so that the server knows that it is always in control.

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

### Jobs.collection

`Jobs.collection` allows you to access the MongoDB collection where the jobs are stored. Ideally, you should not require interaction with the database directly.

**WARNING** - since this package sets a single timer based on the next due job (instead of `msavin:sjobs` which continuously polls all the job queues), any manual changes to the jobs database will not automatically re-check the job queue to set a timer for the next job. If this could be a problem, call [Jobs.findNext()](#JobsfindNext) to schedule the next job.

### Jobs.findNext

This tells the server to re-scan the job queue and set the timer for the next due job. Use this if you manually make changes to the jobs database:

```javascript
// delete all scheduled emails to @apple.com addresses (can't do this via the standard API because a regex is an object which Jobs.clear would interpret as a callback)
var count = Jobs.collection.remove({
	jobName: 'sendEmail',
	"arguments.0": /@apple.com$/i
});
if (count) Jobs.findNext();
```
## A note about Multi-server environments

In a multi-server environment, only one server is in control of the jobs queue at any time. Which server is currently in control is determined by the `jobs_dominator_3` database.

When any of your servers make changes to the job queue, that server will take control of the job queue and schedule the timer for the next due job. This is quicker and easier than somehow telling whichever server is in control that the job queue has changed.

This means that whenever your servers call `Jobs.run`, `Jobs.execute`, `Jobs.reschedule`, `Jobs.replicate`, `Jobs.clear`, `Jobs.remove` or `Jobs.findNext`, control of the job queue might switch servers.


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

Since this package doesn't keeps a job history (compared with msavin:sjobs), you can use `this.reschedule()` indefinitely without polluting the jobs database, instead of having to use `this.replicate()` followed by `this.remove()`.

------

## API Differences From msavin:sjobs
If any of these differences make this package unsuitable for you, please let me know and I'll consider fixing.

- This package doesn't keep a job history.
- `failed` jobs are not retried.
- The Job configuration object doesn't support the `data` attribute - I never found any use for this.
- The following [Jobs.configure()](#jobsconfigure) options are not available:
 - `autoStart` - in this package the job queue is always running - I didn't see the point of it not running.
 - `interval` - this package doesn't regularly query the job queue for due jobs, instead it intelligently sets a timer for the next job.
 - `getDate`
 - `disableDevelopmentMode`
 - `remoteCollection`
- The following [Jobs.configure()](#jobsconfigure) options have additional options:
 - `setServerId` can be a `String` as as well as a `Function`
 - `log` can be a `Boolean` as well as a `Function`
- In a [job function](#jobsregister), `this.set()` and `this.get()` are not provided - I never found any use for this.
- In a [job function](#jobsregister), `this.success()` and `this.failure()` to not take a `result` parameter - this package doesn't keep a job history
- [singular](#jobsrun) jobs only check for `pending` jobs of the same name, so they can be run again even if a previous job failed.
- `Jobs.start()` and `Jobs.stop()` don't exist - I don't see the point of the job queue not running but let me know if you need these.
- `Jobs.cancel()` doesn't exist. Just remove it with [Jobs.remove()](#jobsremove) - I don't see the point in keeping old jobs lying around.
- [Jobs.clear()](#jobsclear) can take additional `argument` parameters to only delete jobs matching those arguments.
- [Jobs.findNext()](#jobsfindnext) is provided.
