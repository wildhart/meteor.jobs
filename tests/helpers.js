import { Jobs } from 'meteor/wildhart:jobs';
import assert from 'assert';

// Tests drive jobs with Jobs.execute() unless they start the queue themselves.
Jobs.configure({ log: false, autoStart: false, startupDelay: 100, maxWait: 2000 });

export const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

export const doc = (id) => Jobs.collection.findOneAsync(id);

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

export const dominator = () => Jobs.collection.rawDatabase().collection('jobs_dominator_3').findOne({ _id: 'dominatorId' });

// The package elects itself on startup (after startupDelay); wait so tests never race the first ping.
export const waitForDominator = () => waitFor(async () => {
	const ping = await dominator();
	return ping && ping.serverId && ping.date;
}, 5000, 'dominator startup');

export async function resetJobs() {
	await Jobs.clear('*');
}
