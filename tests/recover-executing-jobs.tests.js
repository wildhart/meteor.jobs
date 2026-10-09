import { Jobs } from 'meteor/wildhart:jobs';
import assert from 'assert';
import { sleep, doc, waitFor, waitForDominator, resetJobs } from './helpers';

const stuck = (id, startedAt) => Jobs.collection.insertAsync({
	_id: id, name: 'test.recover', arguments: [], state: 'executing', priority: 0,
	created: new Date(), due: new Date(Date.now() - 60000), startedAt,
});

Jobs.register({
	'test.recover': async function () { await sleep(150); await this.success(); },
});

describe('crash recovery', function () {
	this.timeout(10000);
	before(waitForDominator);
	beforeEach(resetJobs);
	afterEach(() => Jobs.configure({ maxExecutionTime: 0 }));

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
		// helpers configure maxWait: 2000, so the ping runs every 1.6 s
		Jobs.configure({ maxExecutionTime: 500 });
		await stuck('hung', new Date(Date.now() - 1000));
		await stuck('young', new Date());
		await waitFor(async () => (await doc('hung')).state === 'pending', 4000, 'ping to requeue the hung job');
		assert.strictEqual((await doc('young')).state, 'executing');
	});

	it('without maxExecutionTime the ping leaves executing jobs alone', async () => {
		await stuck('untouched', new Date(Date.now() - 60000));
		await sleep(2200);
		assert.strictEqual((await doc('untouched')).state, 'executing');
	});
});
