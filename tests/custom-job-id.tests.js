import { Jobs } from 'meteor/wildhart:jobs';
import assert from 'assert';
import { doc, waitFor, waitForDominator, resetJobs } from './helpers';

Jobs.register({
	'test.customId': async function () { await this.success(); },
});

describe('Jobs.run with jobId', function () {
	this.timeout(10000);
	before(waitForDominator);
	beforeEach(resetJobs);

	it('inserts the job with the given id', async () => {
		const job = await Jobs.run('test.customId', 'a', { jobId: 'reminder-1', in: { hours: 1 } });
		assert.strictEqual(job._id, 'reminder-1');
		const stored = await doc('reminder-1');
		assert.strictEqual(stored.name, 'test.customId');
		assert.deepStrictEqual(stored.arguments, ['a']);
		assert.strictEqual(stored.state, 'pending');
	});

	it('returns false and reports the error through the callback when the id exists', async () => {
		await Jobs.run('test.customId', 'a', { jobId: 'reminder-2', in: { hours: 1 } });
		let callbackError;
		let callbackDoc = 'untouched';
		const again = await Jobs.run('test.customId', 'b', {
			jobId: 'reminder-2', in: { hours: 1 },
			callback: (error, result) => { callbackError = error; callbackDoc = result; },
		});
		assert.strictEqual(again, false);
		assert.match(String(callbackError), /already exists/);
		assert.strictEqual(callbackDoc, null);
		assert.deepStrictEqual((await doc('reminder-2')).arguments, ['a']);
	});

	it('treats a finished job with the same id as existing', async () => {
		const job = await Jobs.run('test.customId', { jobId: 'reminder-3' });
		await Jobs.execute(job._id);
		await waitFor(async () => (await doc('reminder-3')).state === 'success', 2000, 'success');
		assert.strictEqual(await Jobs.run('test.customId', { jobId: 'reminder-3' }), false);
	});

	it('still generates an id when jobId is not given', async () => {
		const job = await Jobs.run('test.customId', { in: { hours: 1 } });
		assert.strictEqual(typeof job._id, 'string');
		assert.ok(job._id.length >= 17);
	});

	it('rejects a non-string or empty jobId before checking unique/singular', async () => {
		await assert.rejects(Jobs.run('test.customId', { jobId: 42 }), /Match error/);
		await assert.rejects(Jobs.run('test.customId', { jobId: '' }), /Match error/);
		// validation happens before the unique query, so the duplicate is never looked up
		await Jobs.run('test.customId', 'dup', { unique: true });
		await assert.rejects(Jobs.run('test.customId', 'dup', { unique: true, jobId: 42 }), /Match error/);
	});
});
