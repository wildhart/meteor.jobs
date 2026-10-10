import { Jobs } from 'meteor/wildhart:jobs-fibers';
import assert from 'assert';

// Tests drive jobs with Jobs.execute() unless they start the queue themselves.
Jobs.configure({ log: false, autoStart: false, startupDelay: 100, maxWait: 2000 });

export const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

// the package API is synchronous (Fibers); Meteor's Promise runs continuations inside a Fiber, so these
// can be called after an `await` in the tests
export const doc = (id) => Jobs.collection.findOne(id);

// Poll until `predicate` returns a truthy value (returned), or fail after `timeoutMs`.
export async function waitFor(predicate, timeoutMs = 3000, what = 'condition') {
	const until = Date.now() + timeoutMs;
	for (;;) {
		const value = await predicate();
		if (value) return value;
		assert.ok(Date.now() < until, `timed out waiting for ${what}`);
		await sleep(25);
	}
}

export const dominatorCollection = () => Jobs.collection.rawDatabase().collection('jobs_dominator_3');

export const dominator = () => dominatorCollection().findOne({ _id: 'dominatorId' });

// The package elects itself on startup (after startupDelay); wait so tests never race the first ping.
export const waitForDominator = () => waitFor(async () => {
	const ping = await dominator();
	return ping && ping.serverId && ping.date;
}, 5000, 'dominator startup');

export function resetJobs() {
	Jobs.clear('*');
}
