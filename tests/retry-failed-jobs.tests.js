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
	// a repeating job: reschedules itself `repeats` times, throws on run number `failOn`, then succeeds
	'test.repeating': async function (key, repeats, failOn) {
		runs[key] = (runs[key] || 0) + 1;
		if (runs[key] === failOn) throw new Error(`repeating ${runs[key]}`);
		if (runs[key] <= repeats) await this.reschedule({ in: { milliseconds: 10 } });
		else await this.success();
	},
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

	it('gives a repeating job its full retries on every run (attempts reset by this.reschedule)', async () => {
		// runs 1 and 2 reschedule, run 3 throws, run 4 (the retry) succeeds; retries: 1 only works if attempts was reset
		const job = await Jobs.run('test.repeating', 'rep', 2, 3, { retries: 1 });
		const settled = await drive(job._id);
		assert.strictEqual(settled.state, 'success');
		assert.strictEqual(runs.rep, 4);
		assert.strictEqual(settled.attempts, 2);
	});

	it('Jobs.reschedule starts a new run cycle', async () => {
		const job = await Jobs.run('test.flaky', 'rs', 10, { retries: 1 });
		const settled = await drive(job._id);
		assert.strictEqual(settled.state, 'failure');
		assert.strictEqual(settled.attempts, 2);
		await Jobs.reschedule(job._id, { in: { hours: 1 } });
		const rescheduled = await doc(job._id);
		assert.strictEqual(rescheduled.state, 'pending');
		assert.strictEqual(rescheduled.attempts, undefined);
	});

	it('replicate copies retries and retryIn but not attempts', async () => {
		const job = await Jobs.run('test.flaky', 'rp', 10, { retries: 1, retryIn: { milliseconds: 20 } });
		const settled = await drive(job._id);
		assert.strictEqual(settled.attempts, 2);
		const copyId = await Jobs.replicate(job._id, { in: { hours: 1 } });
		const copy = await doc(copyId);
		assert.strictEqual(copy.state, 'pending');
		assert.strictEqual(copy.retries, 1);
		assert.deepStrictEqual(copy.retryIn, { milliseconds: 20 });
		assert.strictEqual(copy.attempts, undefined);
	});

	it('rejects retries which are not a non-negative integer, before the unique/singular queries', async () => {
		await assert.rejects(Jobs.run('test.flaky', 'v1', 1, { retries: -1 }), /Match error/);
		await assert.rejects(Jobs.run('test.flaky', 'v2', 1, { retries: 1.5 }), /Match error/);
		await assert.rejects(Jobs.run('test.flaky', 'v3', 1, { retries: 1, retryIn: 'soon' }), /Match error/);
		const none = await Jobs.run('test.flaky', 'v4', 1, { retries: 0 });
		assert.strictEqual(none.retries, undefined);
	});
});
