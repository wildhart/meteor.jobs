import { Jobs } from 'meteor/wildhart:jobs';
import assert from 'assert';
import { doc, waitFor, waitForDominator, resetJobs } from './helpers';

const runs = {};

Jobs.register({
	// fails until it has run `failUntil` times, then succeeds
	'test.flaky': async function (key, failUntil) {
		runs[key] = (runs[key] || 0) + 1;
		if (runs[key] < failUntil) throw new Error(`flaky ${runs[key]}`);
		await this.success();
	},
	'test.flakySync': function (key, failUntil) {
		runs[key] = (runs[key] || 0) + 1;
		if (runs[key] < failUntil) throw new Error(`flaky ${runs[key]}`);
		this.success();
	},
	'test.givesUp': async function () { await this.failure(); },
});

// Execute the job whenever it is pending and due, until it reaches a final state.
async function drive(id) {
	return waitFor(async () => {
		const job = await doc(id);
		if (job.state === 'success' || job.state === 'failure') return job;
		if (job.state === 'pending' && job.due <= new Date()) await Jobs.execute(id);
		return null;
	}, 5000, `job ${id} to settle`);
}

describe('retries', function () {
	this.timeout(10000);
	before(waitForDominator);
	beforeEach(async () => { for (const k of Object.keys(runs)) delete runs[k]; await resetJobs(); });

	it('stores retries and retryIn on the job document', async () => {
		const job = await Jobs.run('test.flaky', 'k0', 1, { retries: 2, retryIn: { seconds: 30 } });
		assert.strictEqual(job.retries, 2);
		assert.deepStrictEqual(job.retryIn, { seconds: 30 });
		const plain = await Jobs.run('test.flaky', 'k0b', 1);
		assert.strictEqual(plain.retries, undefined);
	});

	it('reruns a rejecting async job until it succeeds', async () => {
		const job = await Jobs.run('test.flaky', 'k1', 3, { retries: 2, retryIn: { milliseconds: 20 } });
		const settled = await drive(job._id);
		assert.strictEqual(settled.state, 'success');
		assert.strictEqual(settled.attempts, 3);
		assert.strictEqual(runs.k1, 3);
	});

	it('reruns a throwing sync job as well', async () => {
		const job = await Jobs.run('test.flakySync', 's1', 2, { retries: 1 });
		const settled = await drive(job._id);
		assert.strictEqual(settled.state, 'success');
		assert.strictEqual(settled.attempts, 2);
	});

	it('waits retryIn before the next attempt', async () => {
		const job = await Jobs.run('test.flaky', 'k2', 2, { retries: 1, retryIn: { seconds: 30 } });
		await Jobs.execute(job._id);
		await waitFor(async () => (await doc(job._id)).state === 'pending', 2000, 'retry scheduled');
		const rescheduled = await doc(job._id);
		assert.ok(rescheduled.due.valueOf() > Date.now() + 25000, `due ${rescheduled.due.toISOString()}`);
		assert.strictEqual(rescheduled.attempts, 1);
	});

	it('marks the job failed once the retries are used up', async () => {
		const job = await Jobs.run('test.flaky', 'k3', 10, { retries: 1 });
		const settled = await drive(job._id);
		assert.strictEqual(settled.state, 'failure');
		assert.strictEqual(settled.attempts, 2);
		assert.strictEqual(runs.k3, 2);
	});

	it('does not retry without the option', async () => {
		const job = await Jobs.run('test.flaky', 'k4', 10);
		const settled = await drive(job._id);
		assert.strictEqual(settled.state, 'failure');
		assert.strictEqual(settled.attempts, 1);
	});

	it('does not retry an explicit this.failure()', async () => {
		const job = await Jobs.run('test.givesUp', { retries: 3 });
		const settled = await drive(job._id);
		assert.strictEqual(settled.state, 'failure');
		assert.strictEqual(settled.attempts, 1);
	});
});
