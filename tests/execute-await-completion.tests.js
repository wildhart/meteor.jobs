import { Jobs, TypedJob } from 'meteor/wildhart:jobs';
import assert from 'assert';
import { sleep, doc, waitFor, waitForDominator, resetJobs } from './helpers';

const finished = new Set();

Jobs.register({
	'test.slow': async function (key) { await sleep(200); finished.add(key); await this.success(); },
	'test.slowReject': async function () { await sleep(50); throw new Error('boom'); },
	'test.slowReschedule': async function () { await sleep(50); await this.reschedule({ in: { hours: 1 } }); },
	'test.quick': function (key) { finished.add(key); this.success(); },
});

describe('Jobs.execute with awaitCompletion', function () {
	this.timeout(10000);
	before(waitForDominator);
	beforeEach(async () => { finished.clear(); await resetJobs(); });

	it('resolves only after an async job function has finished', async () => {
		const job = await Jobs.run('test.slow', 'a');
		await Jobs.execute(job._id, { awaitCompletion: true });
		assert.ok(finished.has('a'));
		assert.strictEqual((await doc(job._id)).state, 'success');
	});

	it('keeps resolving early without the option', async () => {
		const job = await Jobs.run('test.slow', 'b');
		await Jobs.execute(job._id);
		assert.ok(!finished.has('b'));
		assert.strictEqual((await doc(job._id)).state, 'executing');
		await waitFor(async () => (await doc(job._id)).state === 'success', 2000, 'success');
	});

	it('resolves after a rejecting job has been marked failed', async () => {
		const job = await Jobs.run('test.slowReject');
		await Jobs.execute(job._id, { awaitCompletion: true });
		assert.strictEqual((await doc(job._id)).state, 'failure');
	});

	it('resolves after a job that reschedules itself is pending again', async () => {
		const job = await Jobs.run('test.slowReschedule');
		await Jobs.execute(job._id, { awaitCompletion: true });
		const stored = await doc(job._id);
		assert.strictEqual(stored.state, 'pending');
		assert.ok(stored.due.valueOf() > Date.now() + 59 * 60 * 1000);
	});

	it('accepts the option for sync jobs, whose function has always finished on return', async () => {
		const job = await Jobs.run('test.quick', 'q');
		await Jobs.execute(job._id, { awaitCompletion: true });
		assert.ok(finished.has('q'));
		// a sync job's un-awaited this.success() write lands a moment later
		await waitFor(async () => (await doc(job._id)).state === 'success', 2000, 'success');
	});

	it('is available on TypedJob.execute', async () => {
		const typed = new TypedJob('test.typedSlow', async function (key) { await sleep(100); finished.add(key); await this.success(); });
		const job = await typed.withArgs('t').run();
		await typed.execute(job._id, { awaitCompletion: true });
		assert.ok(finished.has('t'));
	});
});
