import { Jobs } from 'meteor/wildhart:jobs';
import assert from 'assert';
import { sleep, doc, waitFor, waitForDominator, resetJobs, dominator } from './helpers';

const stuck = (id, startedAt, extra = {}) => Jobs.collection.insertAsync({
	_id: id, name: 'test.recover', arguments: [], state: 'executing', priority: 0,
	created: new Date(), due: new Date(Date.now() - 60000), startedAt, ...extra,
});

// Make it look as if another server had taken control and then gone quiet: this server's dominator
// observer sees the foreign ping, waits maxWait (2 s in the test harness) and takes control again.
async function simulateTakeover() {
	const mine = (await dominator()).serverId;
	await Jobs.collection.rawDatabase().collection('jobs_dominator_3').updateOne(
		{ _id: 'dominatorId' },
		{ $set: { serverId: 'some-other-server', date: new Date(Date.now() - 60000) } },
	);
	await waitFor(async () => (await dominator()).serverId === mine, 5000, 'this server to take control again');
}

Jobs.register({
	'test.recover': async function () { await sleep(150); await this.success(); },
});

describe('crash recovery', function () {
	this.timeout(10000);
	before(waitForDominator);
	beforeEach(resetJobs);
	afterEach(() => Jobs.configure({ maxExecutionTime: 0, requeueOnTakeover: false }));

	it('records startedAt when a job starts executing and clears it on requeue', async () => {
		const job = await Jobs.run('test.recover');
		const before = Date.now();
		await Jobs.execute(job._id);
		const running = await doc(job._id);
		assert.strictEqual(running.state, 'executing');
		assert.ok(running.startedAt instanceof Date && running.startedAt.valueOf() >= before - 5);
		await waitFor(async () => (await doc(job._id)).state === 'success', 2000, 'success');
	});

	it('requeueExecuting(olderThan) only touches jobs started before that date', async () => {
		await stuck('old', new Date(Date.now() - 60000));
		await stuck('fresh', new Date());
		assert.strictEqual(await Jobs.requeueExecuting(new Date(Date.now() - 30000)), 1);
		const old = await doc('old');
		assert.strictEqual(old.state, 'pending');
		assert.strictEqual(old.startedAt, undefined);
		assert.strictEqual((await doc('fresh')).state, 'executing');
	});

	it('requeueExecuting() without a date requeues every executing job', async () => {
		await stuck('one', new Date(Date.now() - 60000));
		await stuck('two', new Date());
		assert.strictEqual(await Jobs.requeueExecuting(), 2);
		assert.strictEqual((await doc('one')).state, 'pending');
		assert.strictEqual((await doc('two')).state, 'pending');
		assert.strictEqual(await Jobs.requeueExecuting(), 0);
	});

	it('a requeued job runs again when executed', async () => {
		await stuck('rerun', new Date(Date.now() - 60000));
		await Jobs.requeueExecuting();
		await Jobs.execute('rerun');
		await waitFor(async () => (await doc('rerun')).state === 'success', 2000, 'rerun success');
	});

	it('with maxExecutionTime the server in control requeues long-running jobs on its ping', async () => {
		// helpers configure maxWait: 2000, so the ping runs every 1.6 s. maxExecutionTime must be longer than
		// that, otherwise 'young' can also be older than the limit by the time the ping happens.
		Jobs.configure({ maxExecutionTime: 3000 });
		await stuck('hung', new Date(Date.now() - 60000));
		await stuck('young', new Date());
		await waitFor(async () => (await doc('hung')).state === 'pending', 4000, 'ping to requeue the hung job');
		assert.strictEqual((await doc('young')).state, 'executing');
	});

	it('without maxExecutionTime the ping leaves executing jobs alone', async () => {
		await stuck('untouched', new Date(Date.now() - 60000));
		await sleep(2200);
		assert.strictEqual((await doc('untouched')).state, 'executing');
	});

	it('marks a job failed instead of requeueing it once its retries are used up', async () => {
		await stuck('spent', new Date(Date.now() - 60000), { retries: 1, attempts: 2 });
		await stuck('oneLeft', new Date(Date.now() - 60000), { retries: 1, attempts: 1 });
		await stuck('noRetries', new Date(Date.now() - 60000), { attempts: 5 });
		assert.strictEqual(await Jobs.requeueExecuting(), 2);
		assert.strictEqual((await doc('spent')).state, 'failure');
		assert.strictEqual((await doc('oneLeft')).state, 'pending');
		assert.strictEqual((await doc('noRetries')).state, 'pending');
	});

	it('replicate does not copy startedAt', async () => {
		await stuck('src', new Date(Date.now() - 60000));
		const copyId = await Jobs.replicate('src', { in: { hours: 1 } });
		const copy = await doc(copyId);
		assert.strictEqual(copy.state, 'pending');
		assert.strictEqual(copy.startedAt, undefined);
	});

	it('with requeueOnTakeover, taking control of the queue requeues jobs left executing', async () => {
		Jobs.configure({ requeueOnTakeover: true });
		await stuck('orphan', new Date(Date.now() - 60000));
		await simulateTakeover();
		await waitFor(async () => (await doc('orphan')).state === 'pending', 2000, 'orphan to be requeued');
	});

	it('without requeueOnTakeover (the default), taking control leaves executing jobs alone', async () => {
		await stuck('kept', new Date(Date.now() - 60000));
		await simulateTakeover();
		await sleep(300);
		assert.strictEqual((await doc('kept')).state, 'executing');
	});
});
