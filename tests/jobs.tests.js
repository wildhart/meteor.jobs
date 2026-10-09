import { Jobs, TypedJob } from 'meteor/wildhart:jobs';
import assert from 'assert';
import { sleep, doc, waitFor, waitForDominator, resetJobs } from './helpers';

const ran = [];

Jobs.register({
	'test.sync': function (x) { ran.push(['sync', x]); },
	'test.async': async function (x) { await sleep(50); ran.push(['async', x]); await this.success(); },
	'test.throws': async function () { throw new Error('boom'); },
	'test.reschedules': async function () { ran.push('reschedule'); await this.reschedule({ in: { hours: 1 } }); },
	'test.removes': async function () { await this.remove(); },
});

describe('wildhart:jobs', function () {
	this.timeout(10000);
	before(waitForDominator);
	beforeEach(async () => { ran.length = 0; await resetJobs(); });

	describe('Jobs.run', () => {
		it('schedules a pending job with a due date computed from `in`', async () => {
			const before = Date.now();
			const job = await Jobs.run('test.sync', 1, { in: { minutes: 5 } });
			assert.strictEqual(job.state, 'pending');
			assert.deepStrictEqual(job.arguments, [1]);
			const expected = before + 5 * 60 * 1000;
			assert.ok(Math.abs(job.due.valueOf() - expected) < 2000, `due ${job.due.toISOString()}`);
			const stored = await doc(job._id);
			assert.strictEqual(stored.name, 'test.sync');
		});

		it('keeps a trailing object without config keys as an argument', async () => {
			const job = await Jobs.run('test.sync', { foo: 1 });
			assert.deepStrictEqual(job.arguments, [{ foo: 1 }]);
		});

		it('refuses duplicates with `unique` and `singular`', async () => {
			assert.ok(await Jobs.run('test.sync', 'u', { unique: true, in: { hours: 1 } }));
			assert.strictEqual(await Jobs.run('test.sync', 'u', { unique: true, in: { hours: 1 } }), false);
			assert.ok(await Jobs.run('test.sync', 's', { singular: true, in: { hours: 1 } }));
			assert.strictEqual(await Jobs.run('test.sync', 's', { singular: true, in: { hours: 1 } }), false);
			assert.strictEqual(await Jobs.countPending('test.sync', 's'), 1);
		});
	});

	describe('Jobs.execute', () => {
		it('runs a job ahead of its due date and marks it failed when it is not resolved', async () => {
			const job = await Jobs.run('test.sync', 'x', { in: { hours: 1 } });
			await Jobs.execute(job._id);
			assert.deepStrictEqual(ran, [['sync', 'x']]);
			// no defaultCompletion configured and the job did not call success/remove
			assert.strictEqual((await doc(job._id)).state, 'failure');
		});

		it('leaves an async job executing until its promise settles', async () => {
			const job = await Jobs.run('test.async', 'a');
			await Jobs.execute(job._id);
			assert.strictEqual((await doc(job._id)).state, 'executing');
			await waitFor(async () => (await doc(job._id)).state === 'success', 2000, 'async success');
			assert.deepStrictEqual(ran, [['async', 'a']]);
		});

		it('marks a job failed when its function throws', async () => {
			const job = await Jobs.run('test.throws');
			await Jobs.execute(job._id);
			await waitFor(async () => (await doc(job._id)).state === 'failure', 2000, 'failure');
		});

		it('honours reschedule and remove from inside the job', async () => {
			const again = await Jobs.run('test.reschedules');
			await Jobs.execute(again._id);
			await waitFor(async () => (await doc(again._id)).state === 'pending', 2000, 'rescheduled');
			assert.ok((await doc(again._id)).due.valueOf() > Date.now() + 59 * 60 * 1000);

			const gone = await Jobs.run('test.removes');
			await Jobs.execute(gone._id);
			await waitFor(async () => !(await doc(gone._id)), 2000, 'removed');
		});

		it('ignores jobs that are not pending', async () => {
			const job = await Jobs.run('test.sync', 'once', { in: { hours: 1 } });
			await Jobs.execute(job._id);
			await Jobs.execute(job._id);
			assert.strictEqual(ran.length, 1);
		});
	});

	describe('bookkeeping', () => {
		it('reschedules, counts, finds, removes and clears jobs', async () => {
			const job = await Jobs.run('test.sync', 'k', { in: { hours: 1 } });
			await Jobs.reschedule(job._id, { in: { days: 1 } });
			assert.ok((await doc(job._id)).due.valueOf() > Date.now() + 23 * 3600 * 1000);
			assert.strictEqual(await Jobs.count('test.sync', 'k'), 1);
			assert.strictEqual((await Jobs.findOne('test.sync', 'k'))._id, job._id);
			assert.strictEqual(await Jobs.remove(job._id), true);
			assert.strictEqual(await Jobs.count('test.sync'), 0);

			await Jobs.run('test.sync', 'c1', { in: { hours: 1 } });
			await Jobs.run('test.sync', 'c2', { in: { hours: 1 } });
			assert.strictEqual(await Jobs.clear('*', 'test.sync'), 2);
		});
	});

	describe('queue', () => {
		it('runs due jobs by itself once started and stops on Jobs.stop()', async () => {
			const job = await Jobs.run('test.async', 'auto');
			await Jobs.start();
			try {
				await waitFor(async () => (await doc(job._id)).state === 'success', 5000, 'queue to run the job');
			} finally {
				await Jobs.stop();
			}
			await waitFor(async () => {
				const ping = await Jobs.collection.rawDatabase().collection('jobs_dominator_3').findOne({ _id: 'dominatorId' });
				return ping.pausedJobs[0] === '*';
			}, 2000, 'queue paused');
			// the in-process observer that pauses the queue fires shortly after the write
			await sleep(500);
			const later = await Jobs.run('test.async', 'paused');
			await sleep(300);
			assert.strictEqual((await doc(later._id)).state, 'pending');
		});
	});

	describe('TypedJob', () => {
		const typed = new TypedJob('test.typed', async function (n) { ran.push(['typed', n]); await this.success(); });

		it('registers, runs, counts and executes through the typed API', async () => {
			const job = await typed.withArgs(7).run({ in: { hours: 1 } });
			assert.strictEqual(await typed.count(7), 1);
			await typed.execute(job._id);
			await waitFor(async () => (await doc(job._id)).state === 'success', 2000, 'typed success');
			assert.deepStrictEqual(ran, [['typed', 7]]);
		});
	});
});
