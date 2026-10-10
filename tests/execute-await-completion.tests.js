import { Jobs, TypedJob } from 'meteor/wildhart:jobs-fibers';
import assert from 'assert';
import { sleep, doc, waitFor, waitForDominator, resetJobs } from './helpers';

const finished = new Set();

Jobs.register({
	'test.slow': async function (key) { await sleep(200); finished.add(key); this.success(); },
	'test.slowReject': async function () { await sleep(50); throw new Error('boom'); },
	'test.slowReschedule': async function () { await sleep(50); this.reschedule({ in: { hours: 1 } }); },
	'test.slowRemove': async function () { await sleep(50); this.remove(); },
	'test.quick': function (key) { finished.add(key); this.success(); },
	'test.unresolved': function () {},
});

// awaitCompletion waits with Promise.await, which needs a Fiber; the test driver runs each test in one
describe('Jobs.execute with awaitCompletion', function () {
	this.timeout(10000);
	before(waitForDominator);
	beforeEach(() => { finished.clear(); resetJobs(); });

	it('returns only after an async job function has finished, with its result', () => {
		const job = Jobs.run('test.slow', 'a');
		const result = Jobs.execute(job._id, { awaitCompletion: true });
		assert.strictEqual(result, 'success');
		assert.ok(finished.has('a'));
		assert.strictEqual(doc(job._id).state, 'success');
	});

	it('keeps returning early without the option, reporting the job as executing', async () => {
		const job = Jobs.run('test.slow', 'b');
		const result = Jobs.execute(job._id);
		assert.strictEqual(result, 'executing');
		assert.ok(!finished.has('b'));
		assert.strictEqual(doc(job._id).state, 'executing');
		await waitFor(() => doc(job._id).state === 'success', 2000, 'success');
	});

	it('returns after a rejecting job has been marked failed', () => {
		const job = Jobs.run('test.slowReject');
		const result = Jobs.execute(job._id, { awaitCompletion: true });
		assert.strictEqual(result, 'failure');
		assert.strictEqual(doc(job._id).state, 'failure');
	});

	it('returns after a job that reschedules itself is pending again', () => {
		const job = Jobs.run('test.slowReschedule');
		const result = Jobs.execute(job._id, { awaitCompletion: true });
		assert.strictEqual(result, 'reschedule');
		const stored = doc(job._id);
		assert.strictEqual(stored.state, 'pending');
		assert.ok(stored.due.valueOf() > Date.now() + 59 * 60 * 1000);
	});

	it('returns after a job that removes itself is gone', () => {
		const job = Jobs.run('test.slowRemove');
		const result = Jobs.execute(job._id, { awaitCompletion: true });
		assert.strictEqual(result, 'remove');
		assert.strictEqual(doc(job._id), undefined);
	});

	it('accepts the option for sync jobs, whose function has always finished on return', () => {
		const job = Jobs.run('test.quick', 'q');
		const result = Jobs.execute(job._id, { awaitCompletion: true });
		assert.strictEqual(result, 'success');
		assert.ok(finished.has('q'));
		assert.strictEqual(doc(job._id).state, 'success');
	});

	it('reports the resolution applied when the job did not resolve itself', () => {
		// no defaultCompletion configured in the test harness: an unresolved job is marked failed
		const job = Jobs.run('test.unresolved');
		assert.strictEqual(Jobs.execute(job._id), 'failure');
		assert.strictEqual(doc(job._id).state, 'failure');
	});

	it('reports the resolution applied by defaultCompletion, which null returns to the default', () => {
		Jobs.configure({ defaultCompletion: 'remove' });
		try {
			const removed = Jobs.run('test.unresolved');
			assert.strictEqual(Jobs.execute(removed._id), 'remove');
			assert.strictEqual(doc(removed._id), undefined);
		} finally {
			Jobs.configure({ defaultCompletion: null });
		}
		const job = Jobs.run('test.unresolved');
		assert.strictEqual(Jobs.execute(job._id), 'failure');
	});

	it('returns false for a missing or non-pending job', () => {
		assert.strictEqual(Jobs.execute('no-such-job', { awaitCompletion: true }), false);
		const job = Jobs.run('test.quick', 'once');
		assert.strictEqual(Jobs.execute(job._id, { awaitCompletion: true }), 'success');
		assert.strictEqual(Jobs.execute(job._id, { awaitCompletion: true }), false);
	});

	it('is available on TypedJob.execute', () => {
		const typed = new TypedJob('test.typedSlow', async function (key) { await sleep(100); finished.add(key); this.success(); });
		const job = typed.withArgs('t').run();
		const result = typed.execute(job._id, { awaitCompletion: true });
		assert.strictEqual(result, 'success');
		assert.ok(finished.has('t'));
	});
});
