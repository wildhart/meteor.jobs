import { Jobs, TypedJob } from 'meteor/wildhart:jobs';
import assert from 'assert';
import { sleep, doc, waitFor, waitForDominator, resetJobs } from './helpers';

const finished = new Set();

Jobs.register({
	'test.slow': async function (key) { await sleep(200); finished.add(key); await this.success(); },
	'test.slowReject': async function () { await sleep(50); throw new Error('boom'); },
	'test.slowReschedule': async function () { await sleep(50); await this.reschedule({ in: { hours: 1 } }); },
	'test.slowRemove': async function () { await sleep(50); await this.remove(); },
	'test.quick': function (key) { finished.add(key); this.success(); },
	'test.unresolved': function () {},
});

describe('Jobs.execute with awaitCompletion', function () {
	this.timeout(10000);
	before(waitForDominator);
	beforeEach(async () => { finished.clear(); await resetJobs(); });

	it('resolves only after an async job function has finished, with its result', async () => {
		const job = await Jobs.run('test.slow', 'a');
		const result = await Jobs.execute(job._id, { awaitCompletion: true });
		assert.strictEqual(result, 'success');
		assert.ok(finished.has('a'));
		assert.strictEqual((await doc(job._id)).state, 'success');
	});

	it('keeps resolving early without the option, reporting the job as executing', async () => {
		const job = await Jobs.run('test.slow', 'b');
		const result = await Jobs.execute(job._id);
		assert.strictEqual(result, 'executing');
		assert.ok(!finished.has('b'));
		assert.strictEqual((await doc(job._id)).state, 'executing');
		await waitFor(async () => (await doc(job._id)).state === 'success', 2000, 'success');
	});

	it('resolves after a rejecting job has been marked failed', async () => {
		const job = await Jobs.run('test.slowReject');
		const result = await Jobs.execute(job._id, { awaitCompletion: true });
		assert.strictEqual(result, 'failure');
		assert.strictEqual((await doc(job._id)).state, 'failure');
	});

	it('resolves after a job that reschedules itself is pending again', async () => {
		const job = await Jobs.run('test.slowReschedule');
		const result = await Jobs.execute(job._id, { awaitCompletion: true });
		assert.strictEqual(result, 'reschedule');
		const stored = await doc(job._id);
		assert.strictEqual(stored.state, 'pending');
		assert.ok(stored.due.valueOf() > Date.now() + 59 * 60 * 1000);
	});

	it('resolves after a job that removes itself is gone', async () => {
		const job = await Jobs.run('test.slowRemove');
		const result = await Jobs.execute(job._id, { awaitCompletion: true });
		assert.strictEqual(result, 'remove');
		assert.strictEqual(await doc(job._id), undefined);
	});

	it('accepts the option for sync jobs, whose function has always finished on return', async () => {
		const job = await Jobs.run('test.quick', 'q');
		const result = await Jobs.execute(job._id, { awaitCompletion: true });
		assert.strictEqual(result, 'success');
		assert.ok(finished.has('q'));
		// a sync job's un-awaited this.success() write lands a moment later
		await waitFor(async () => (await doc(job._id)).state === 'success', 2000, 'success');
	});

	it('reports the resolution applied when the job did not resolve itself', async () => {
		// no defaultCompletion configured in the test harness: an unresolved job is marked failed
		const job = await Jobs.run('test.unresolved');
		assert.strictEqual(await Jobs.execute(job._id), 'failure');
		assert.strictEqual((await doc(job._id)).state, 'failure');
	});

	it('reports the resolution applied by defaultCompletion, which null returns to the default', async () => {
		Jobs.configure({ defaultCompletion: 'remove' });
		try {
			const removed = await Jobs.run('test.unresolved');
			assert.strictEqual(await Jobs.execute(removed._id), 'remove');
			assert.strictEqual(await doc(removed._id), undefined);
		} finally {
			Jobs.configure({ defaultCompletion: null });
		}
		const job = await Jobs.run('test.unresolved');
		assert.strictEqual(await Jobs.execute(job._id), 'failure');
	});

	it('resolves to false for a missing or non-pending job', async () => {
		assert.strictEqual(await Jobs.execute('no-such-job', { awaitCompletion: true }), false);
		const job = await Jobs.run('test.quick', 'once');
		assert.strictEqual(await Jobs.execute(job._id, { awaitCompletion: true }), 'success');
		assert.strictEqual(await Jobs.execute(job._id, { awaitCompletion: true }), false);
	});

	it('is available on TypedJob.execute', async () => {
		const typed = new TypedJob('test.typedSlow', async function (key) { await sleep(100); finished.add(key); await this.success(); });
		const job = await typed.withArgs('t').run();
		const result = await typed.execute(job._id, { awaitCompletion: true });
		assert.strictEqual(result, 'success');
		assert.ok(finished.has('t'));
	});
});
