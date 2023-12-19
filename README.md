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

## Meteor 2.8 / 3.0 Async Compatibility

**BREAKING CHANGE:** This version is only compatible with Async Mongo methods and therefore requires Meteor 2.8+.  The old synchronous Mongo methods were deprecated since Meteor 2.8 and are removed in Meteor 3.0

* To upgrade from earlier versions of this package, replace all calls to our old `...method()` sync methods with the new `await ...methodAsync()` async methods.
* To use our legacy synchronous version, install with `meteor add wildhart:jobs@1.0.18` (you can copy typescript definition from this [tagged commit](https://github.com/wildhart/meteor.jobs/tree/v1.0.18))

## Quick Start

First, install the package, and import:

```bash
meteor add wildhart:jobs
```

```javascript
import { Jobs } from 'meteor/wildhart:jobs'
```

Then, write your background jobs like you would write your methods:

```javascript
Jobs.register({
    "sendReminder": async function (to, message) {
        var call = HTTP.put("http://www.magic.com/sendEmail", {
            to: to,
            message: message
        });

        if (call.statusCode === 200) {
            await this.successAsync(call.result);
        } else {
            await this.rescheduleAsync({in: {minutes: 5}});
        }
    }
});
```

Finally, schedule a background job like you would call a method:

```javascript
await Jobs.runAsync("sendReminder", "jon@example.com", "The future is here!");
```

The function above will schedule the job to run immediately, however, you can delay it by passing in a special **configuration object** at the end:

```javascript
await Jobs.runAsync("sendReminder", "jon@example.com", "The future is here!", {
    in: {
        days: 3,
    },
    on: {
        hour: 9,
        minute: 42
    },
});
```
The configuration object supports `date`, `in`, `on`, and `priority`, all of which are completely optional, see [Jobs.runAsync](#jobsrun).

## New Strongly Typed API

With version 1.0.18 we introduced a more convenient and strongly typed wrapper Class around our traditional API.
You can still use the old API, and even upgrade to this new version with no additional work, then you are free to gradually
update your code to the new API.

** Don't forget to copy our new `wildhart-jobs.d.ts` into your project's `@types` folder.

Benefits of the new API:
* All job parameters are strongly typed, so in code which schedules a job you will get IDE warnings if the types are incorrect.
* No more scheduling jobs by string name, so no risk of typos.

With the new API, the above code would be replaced with:
```typescript
import { TypedJob } from "meteor/wildhart:jobs";

export const sendReminderJob = new TypedJob('sendReminders', async function(to: string, message: string) {
	...
});
```
Note that when defining the job, that's only only place you need to refer to the job with a string name.

When scheduling the job, you can reference the class instance directly:
```typescript
import { sendReminderJob } from './reminders';

await sendReminderJob.withArgs('jon@example.com", The future is here!').runAsync({
    in: {
        days: 3,
    },
    on: {
        hour: 9,
        minute: 42
    },
});
```

Almost all of the traditional API can be replaced with this new API:
```typescript
// as example above
await sendReminderJob.withArgs(...).runAsync(configObject);
// equivalent to await Jobs.clearAsync('*', 'sendReminder', '*', ...args);
await sendReminderJob.clearAsync('*', ...args);
// NEW API equivalent to await Jobs.collection.clearAsync({...query, name: 'sendReminderJob');
await sendReminderJob.clearQueryAsync(query);

// same as await Jobs.removeAsync(....), but without having to import "Jobs"
const scheduledJob: JobDocument | false = await myJob.withArgs(...).runAsync(...);
await sendReminderJob.removeAsync(scheduledJob);
// or
await sendReminderJob.removeAsync(scheduledJob._id);

// equivalent to await Jobs.startAsync('sendReminders');
await sendReminderJob.startAsync();
// equivalent to await Jobs.stopAsync('sendReminders');
await sendReminderJob.stopAsync();
// equivalent to await Jobs.countAsync('sendReminders', 'jon@example.com');
await sendReminderJob.countAsync('jon@example.com');
// equivalent to await Jobs.findOneAsync('sendReminders', 'jon@example.com');
await sendReminderJob.findOneAsync('jon@example.com');
// this is new API equivalent to await Jobs.updateAsync({query, ..name: 'sendReminderJob'}, options);
await sendReminderJob.updateAsync(query, options);

// if you need to query the Jobs collection directly, the original name of the job can be obtained:
sendReminderJob.name; // == 'sendReminders'
```

Further details of these methods are as per the traditional API below.

One big caveat of the new API is that to run a job you have to import the code from the
file where the job was defined, which by definition should be exposed on the server side only.
Therefore, in shared client/server code (e.g. a Meteor Method) if you are used to doing:
```javascript
if (Meteor.isServer) {
	await Jobs.runAsync('sendEmail', 'jon@example.com', 'hello', {in: {days: 1}});
}
```
You have to be careful not to import the server-side code into the front-end, so instead use `import().then()`:
```javascript
if (Meteor.isServer) {
	import('../../server/reminderJobs').then(async ({sendEmailJob}) => {
		await sendEmailJob.withArgs(...).runAsync(...);
	});
}
```

## Traditional API Documentation

`Jobs.register` and `Jobs.run` are all you need to get started, but that's only the beginning of what the package can do. To explore the rest of the functionality, jump into the documentation:

 - [Jobs.configure](#jobsconfigure)
 - [Jobs.register](#jobsregister)
 - [Jobs.runAsync](#jobsrunasync)
 - [Jobs.executeAsync](#jobsexecuteasync)
 - [Jobs.rescheduleAsync](#jobsrescheduleasync)
 - [Jobs.replicateAsync](#jobsreplicateasync)
 - [Jobs.startAsync](#jobsstartasync)
 - [Jobs.stopAsync](#jobsstopasync)
 - [Jobs.clearAsync](#jobsclearasync)
 - [Jobs.removeAsync](#jobsremoveasync)
 - [Jobs.jobs](#jobsjobs)
 - [Jobs.collection](#jobscollection)
 - [Repeating Jobs](#repeating-jobs)
 - [Async Jobs/Promises](#async-jobs)
 - [Bulk Operations](#bulk-operations)
 - [Version History](#version-history)

### Jobs.configure

`Jobs.configure` allows you to configure how the package should work. You can configure one option or all of them. Defaults are shown in the code below:

```javascript
Jobs.configure({
    // (milliseconds) specify how long the server could be inactive before another server
    // takes on the master role (default = 5min)
    maxWait: Number,

    // (milliseconds) specify how long after server startup the package should start running
    startupDelay: Number,

    // determine how to set the serverId - see below. (default = random string)
    setServerId: String || Function,

    // determine if/how to log the package outputs (default = console.log)
    log: Boolean || Function,

    // specify if all job queues should start automatically on first launch (default = true)...
    //  ... after server relaunch the list of paused queues is restored from the database.
    autoStart: Boolean,

    // whether to mark successful just as successful, or remove them,
    // otherwise you have to resolve every job with this.success() or this.remove()
    defaultCompletion: 'success' | 'remove',
})
```
`setServerId` - In a **multi-server deployment**, jobs are only executed on one server.  Each server should have a unique ID so that it knows if it is control of the job queue or not. You can provide a function which returns a serverId from somewhere (e.g. from an environment variable) or just use the default of a random string.  In a **single-server deployment** set this to a static string so that the server knows that it is always in control and can take control more quickly after a reboot.

### Jobs.register

`Jobs.register` allows you to register a function for a job.

```typescript
Jobs.register({
	sendEmail: async function (to, content) {
		var send = await Magic.sendEmail(to, content);
		if (send) {
			await this.successAsync();
		} else {
			await this.rescheduleAsync({in: {minutes: 5}});
		}
	},
	sendReminder: async function (userId, content) {
		var doc = await Reminders.insertAsync({
			to: userId,
			content: content
		})

		if (doc) {
			await this.removeAsync();
		} else {
			await this.rescheduleAsync({in: {minutes: 5}});
		}
	}
});

// or NEW API:
const sendEmail = new TypedJob('sendEmail', async function(to: string, content: EmailDoc) {
	...
});
const sendReminder = new TypedJob('sendReminder', async function(to: string, content: ReminderContent) {
	...
});
```

Each job is bound with a set of functions to give you maximum control over how the job runs:
 - `this.document` - access the job document
 - `this.successAsync()` - tell the queue the job is completed
 - `this.failureAsync()` - tell the queue the job failed
 - `this.rescheduleAsync(config)` - tell the queue to schedule the job for a future date
 - `this.removeAsync()` - remove the job from the queue
 - `this.replicateAsync(config)` - create a copy of the job with a different due date provided by `config` (returns the new jobId)

Each job must be resolved with success, failure, reschedule, and/or remove.

See [Repeating Jobs](#repeating-jobs) and [Async Jobs/Promises](#async-jobs)

### Jobs.runAsync

`Jobs.runAsync` allows you to schedule a job to run. You call it just like you would call a method, by specifying the job name and its arguments. At the end, you can pass in a special configuration object. Otherwise, it will be scheduled to run immediately.

```javascript
var jobDoc = await Jobs.runAsync("sendReminder", "jon@example.com", "The future is here!", {
    in: {
        days: 3,
    },
    on: {
        hour: 9,
        minute: 42
    },
    singular: true
});

// or NEW API:
await sendReminderJob.withArgs("jon@example.com", "The future is here!").runAsync(...);
```
`Jobs.runASync` returns a `jobDoc`.

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
- **`date`** - Date
	- Provide your own date. This stacks with the `in` and `on` operator, and will be applied before they perform their operations.
* **`unique`** - Boolean
	- If a job is marked as unique, it will only be scheduled if no other job exists with the same arguments
* **`singular`** - Boolean
	- If a job is marked as singular, it will only be scheduled if no other job is **pending** with the same arguments
* **`awaitAsync`** - Boolean
	- If an [async job](#asyncjobs) with run with `awaitAsync: true` is running, then no other job of the same name will start until the running job has completed.
- **`callback`** - Function
	- Run a callback function after scheduling the job

### Jobs.executeAsync

`Jobs.executeAsync` allows you to run a job ahead of its due date. It can only work on jobs that have not been resolved.

```javascript
await Jobs.executeAsync(doc) // or (doc._id)
// or NEW API
await sendReminderJob.executeAsync(doc); // or (doc._id)
```

### Jobs.rescheduleAsync

`Jobs.rescheduleAsync` allows you to reschedule a job. It can only work on jobs that have not been resolved.

```javascript
await Jobs.rescheduleAsync(job, { // or (job._id)
	in: {
		minutes: 5
	},
});
// or NEW API
await sendReminderJob.rescheduleAsync(job, {...}); // or (job._id, {...});
```

The configuration is passed in as the second argument, and it supports the same inputs as `Jobs.run`.

### Jobs.replicateAsync

`Jobs.replicateAsync` allows you to replicate a job.

```javascript
var jobId = await Jobs.replicateAsync(job, { // or (job._id, {...
	in: {
		minutes: 5
	}
})
// or NEW API
await sendReminderJob.replicateAsync(job, {...}); // or (job._id, {...});
```

`Jobs.replicateAsync` returns a `jobId`.

### Jobs.startAsync

`Jobs.startAsync` allows you start all the queues. This runs automatically unless `autoStart` is set to `false`. If you call the function with no arguments, it will start all the queues. If you pass in a String, it will start a queue with that name. If you pass in an Array, it will start all the queues named in the array.

```javascript
// Start all the queues
await Jobs.startAsync()

// Start just one queue
await Jobs.startAsync("sendReminder")
// or NEW API
await sendReminderJob.startAsync();

// Start multiple queues
await Jobs.startAsync(["sendReminder", "sendEmail"])
```
Unlike msavin:sjobs, this function can be called on any server and whichever server is currently in control of the job queue will be notified.


### Jobs.stopAsync

`Jobs.stopAsync` allows you stop all the queues. If you call the function with no arguments, it will stop all the queues. If you pass in a String, it will stop a queue with that name. If you pass in an Array, it will stop all the queues named in the array.

```javascript
// Stop all the queues
await Jobs.stopAsync()

// Stop just one queue
await Jobs.stopAsync("sendReminder")
// or NEW API
await sendReminderJob.stopAsync();

// Stop multiple queues
await Jobs.stopAsync(["sendReminder", "sendEmail"])
```
Unlike msavin:sjobs, this function can be called on any server and whichever server is currently in control of the job queue will be notified.

If you need to stop all jobs via mongo use:
```js
mongo> db.jobs_dominator_3.update({_id:"dominatorId"}, {$set: {pausedJobs: ['*']}});
```
The in-control server should observe the change and stop instantly. Use `{$unset: {pausedJobs: 1}}` or `{$set: {pausedJobs: []}}` to start all the queues again.

### Jobs.clearAsync

`Jobs.clearAsync` allows you to clear all or some of the jobs in your database.
```javascript
var count = await Jobs.clearAsync(state, jobName, ...arguments, callback);
e.g:
count = await Jobs.clearAsync();    // remove all completed jobs (success or failure)
count = await Jobs.clearAsync('*'); // remove all jobs
count = await Jobs.clearAsync('failure', 'sendEmail', 'jon@example.com', function(err, count) {console.log(err, count)});
// or NEW API
count = await sendEmailJob.clearAsync('failure', 'jon@example.com', ...);
```
Parameters:
* `state` for selecting a job state (either `pending`, `success`, `failure`, or `*` to select all of them), or omit to all except `pending` jobs.
* `jobName` to only remove jobs with a specific name.
* provide `arguments` to match jobs only with the same arguments.
* `callback` to provide a callback function with `error` and `result` parameters, where `result` is the number of jobs removed.

### Jobs.removeAsync

`Jobs.removeAsync` allows you to remove a job from the collection.

```javascript
var success = await Jobs.removeAsync(doc); // or (doc._id)
// or NEW API
await sendEmailJob.removeAsync(doc); // or (doc._id)
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

Repeating jobs can be created by using `this.rescheduleAsync()` in the job function, e.g.:
```javascript
Jobs.register({
	async processMonthlyPayments() {
		await this.rescheduleAsync({in: {months: 1}});
		await processPayments();
	},
});

await Jobs.runAsync('processMonthlyPayments', {singular: true});
```

Since this package doesn't keep a job history (compared with msavin:sjobs), you can use `this.rescheduleAsync()` indefinitely without polluting the jobs database, instead of having to use `this.replicateAsync()` followed by `this.removeAsync()`.

## Async Jobs

The job function can use `async/await` or return a promise:
```javascript
Jobs.register({
	async asyncJob(...args) {
		await new Promise(resolve => Meteor.setTimeout(() => resolve(0), 4000));
		await this.removeAsync();
	},
	promiseJob(...args) {
		return new Promise(resolve => Meteor.setTimeout(async () => {
			await this.remove();
			resolve(0);
		}, 8000));
	},
});
```
This defers the error message `'Job was not resolved with success, failure, reschedule or remove'` until the promise resolves.  Note that:
* While jobs are executing their status is set to `'executing'`.
* Other jobs of the same type will still run when scheduled while asynchronous jobs are executing, unless the running job was configured with `awaitSync: true`, in which case the pending job will wait until the previous job of that name has completed.
* Asynchronous code may need to be wrapped in [`Meteor.bindEnvironment()`](https://guide.meteor.com/using-npm-packages.html#bind-environment).

## Bulk Operations

The job queue intelligently prevents lots of a single job dominating the job queue, so feel free to use this package to safely schedule bulk operations, e.g, sending 1000s of emails. Although it may take some time to send all of these emails, any other jobs which are scheduled to run while they are being sent will still be run on time.  Run each operation as its own job (e.g, 1000 separate `"sendSingleEmail"` jobs rather than a single `"send1000Emails"` job.  The job queue will run all 1000 `"sendSingleEmail"` jobs in sequence, but after each job it will check if any other jobs need to run first.

------

## API Differences From msavin:sjobs
If any of these differences make this package unsuitable for you, please let me know and I'll consider fixing.

- Since v2.0 of this package, most methods have been renamed from `...method()` to `...methodAsync()` and are asynchronous.
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
- In a [job function](#jobsregister), `this.successAsync()` and `this.failureAsync()` to not take a `result` parameter - this package doesn't keep a job history
- [singular](#jobsrun) jobs only check for `pending` jobs of the same name, so they can be run again even if a previous job failed.
- `Jobs.startAsync()` and `Jobs.stopAsync()` can be called on any server and whichever server is in control of the job queue will be notified.
- `Jobs.cancel()` doesn't exist. Just remove it with [Jobs.removeAsync()](#jobsremove) - I don't see the point in keeping old jobs lying around.
- [Jobs.clearAsync()](#jobsclear) can take additional `argument` parameters to only delete jobs matching those arguments.
- [Jobs.jobs](#jobsjobs) doesn't exist in msavin:sjobs

------

## Version History

#### 2.0.0 (2023-12-20)
- **BREAKING CHANGE** New asynchronous API for Meteor 3.0 compatibility/

#### 1.0.18 (2023-08-19)
- Added new [strongly-typed API](#new-strongly-typed-api).

#### 1.0.16 (2021-11-04)
- Added `awaitAsync: true` option for [async jobs](#asyncjobs). Fixes [#14](/issues/14).

#### 1.0.13 (2021-08-23)
- Fixed not accepting `startUpDelay` in `Jobs.Configure`. Fixes [#13](/issues/13).

#### 1.0.12 (2021-03-30)
- Removed typescript verison constraint.

#### 1.0.10 (2021-02-17)
- Added the `'defaultCompletion'` [Jobs.configure](#jobsconfigure) option. Suggested in [#10](/issues/10).

#### 1.0.10 (2021-02-17)
- Better support for [Async Jobs/Promises](#async-jobs). Fixes [#7](/issues/5).
- While jobs are executing their status is set to `'executing'`.

#### 1.0.9 (2020-09-25)
- Capped timeout to 24 hours to avoid node limit. Fixes [#5](/issues/7).

#### 1.0.8 (2019-09-27)
- Fix bug when using months to set the job time.
- Add return values to this.remove() etc within job.
- Fix observer/timeout race condition executing same job twice

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
