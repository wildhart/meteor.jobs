import { Jobs, TypedJob } from 'meteor/wildhart:jobs-fibers';
import assert from 'assert';
import { sleep, doc, waitFor, waitForDominator, resetJobs, dominator } from './helpers';

const ran = [];

Jobs.register({
	'test.sync': function (x) { ran.push(['sync', x]); },
	'test.async': async function (x) { await sleep(50); ran.push(['async', x]); this.success(); },
	'test.throws': async function () { throw new Error('boom'); },
	'test.reschedules': function () { ran.push('reschedule'); this.reschedule({ in: { hours: 1 } }); },
	'test.removes': function () { this.remove(); },
});

describe('wildhart:jobs-fibers', function () {
	this.timeout(10000);
	before(waitForDominator);
	beforeEach(() => { ran.length = 0; resetJobs(); });

	describe('Jobs.run', () => {
		it('schedules a pending job with a due date computed from `in`', () => {
			const before = Date.now();
			const job = Jobs.run('test.sync', 1, { in: { minutes: 5 } });
			assert.strictEqual(job.state, 'pending');
			assert.deepStrictEqual(job.arguments, [1]);
			const expected = before + 5 * 60 * 1000;
			assert.ok(Math.abs(job.due.valueOf() - expected) < 2000, `due ${job.due.toISOString()}`);
			assert.strictEqual(doc(job._id).name, 'test.sync');
		});

		it('keeps a trailing object without config keys as an argument', () => {
			const job = Jobs.run('test.sync', { foo: 1 });
			assert.deepStrictEqual(job.arguments, [{ foo: 1 }]);
		});

		it('refuses duplicates with `unique` and `singular`', () => {
			assert.ok(Jobs.run('test.sync', 'u', { unique: true, in: { hours: 1 } }));
			assert.strictEqual(Jobs.run('test.sync', 'u', { unique: true, in: { hours: 1 } }), false);
			assert.ok(Jobs.run('test.sync', 's', { singular: true, in: { hours: 1 } }));
			assert.strictEqual(Jobs.run('test.sync', 's', { singular: true, in: { hours: 1 } }), false);
			assert.strictEqual(Jobs.countPending('test.sync', 's'), 1);
		});
	});

	describe('Jobs.execute', () => {
		it('runs a job ahead of its due date and marks it failed when it is not resolved', () => {
			const job = Jobs.run('test.sync', 'x', { in: { hours: 1 } });
			Jobs.execute(job._id);
			assert.deepStrictEqual(ran, [['sync', 'x']]);
			// no defaultCompletion configured and the job did not call success/remove
			assert.strictEqual(doc(job._id).state, 'failure');
		});

		it('leaves an async job executing until its promise settles', async () => {
			const job = Jobs.run('test.async', 'a');
			Jobs.execute(job._id);
			assert.strictEqual(doc(job._id).state, 'executing');
			await waitFor(() => doc(job._id).state === 'success', 2000, 'async success');
			assert.deepStrictEqual(ran, [['async', 'a']]);
		});

		it('marks a job failed when its function throws', async () => {
			const job = Jobs.run('test.throws');
			Jobs.execute(job._id);
			await waitFor(() => doc(job._id).state === 'failure', 2000, 'failure');
		});

		it('honours reschedule and remove from inside the job', () => {
			const again = Jobs.run('test.reschedules');
			Jobs.execute(again._id);
			assert.strictEqual(doc(again._id).state, 'pending');
			assert.ok(doc(again._id).due.valueOf() > Date.now() + 59 * 60 * 1000);

			const gone = Jobs.run('test.removes');
			Jobs.execute(gone._id);
			assert.strictEqual(doc(gone._id), undefined);
		});

		it('ignores jobs that are not pending', () => {
			const job = Jobs.run('test.sync', 'once', { in: { hours: 1 } });
			Jobs.execute(job._id);
			Jobs.execute(job._id);
			assert.strictEqual(ran.length, 1);
		});
	});

	describe('bookkeeping', () => {
		it('reschedules, counts, finds, removes and clears jobs', () => {
			const job = Jobs.run('test.sync', 'k', { in: { hours: 1 } });
			Jobs.reschedule(job._id, { in: { days: 1 } });
			assert.ok(doc(job._id).due.valueOf() > Date.now() + 23 * 3600 * 1000);
			assert.strictEqual(Jobs.count('test.sync', 'k'), 1);
			assert.strictEqual(Jobs.findOne('test.sync', 'k')._id, job._id);
			assert.strictEqual(Jobs.remove(job._id), true);
			assert.strictEqual(Jobs.count('test.sync'), 0);

			Jobs.run('test.sync', 'c1', { in: { hours: 1 } });
			Jobs.run('test.sync', 'c2', { in: { hours: 1 } });
			assert.strictEqual(Jobs.clear('*', 'test.sync'), 2);
		});
	});

	describe('queue', () => {
		it('runs due jobs by itself once started and stops on Jobs.stop()', async () => {
			const job = Jobs.run('test.async', 'auto');
			Jobs.start();
			try {
				await waitFor(() => doc(job._id).state === 'success', 5000, 'queue to run the job');
			} finally {
				Jobs.stop();
			}
			await waitFor(async () => (await dominator()).pausedJobs[0] === '*', 2000, 'queue paused');
			// the in-process observer that pauses the queue fires shortly after the write
			await sleep(500);
			const later = Jobs.run('test.async', 'paused');
			await sleep(300);
			assert.strictEqual(doc(later._id).state, 'pending');
		});
	});

	describe('TypedJob', () => {
		const typed = new TypedJob('test.typed', function (n) { ran.push(['typed', n]); this.success(); });

		it('registers, runs, counts and executes through the typed API', () => {
			const job = typed.withArgs(7).run({ in: { hours: 1 } });
			assert.strictEqual(typed.count(7), 1);
			typed.execute(job._id);
			assert.strictEqual(doc(job._id).state, 'success');
			assert.deepStrictEqual(ran, [['typed', 7]]);
		});
	});
});
