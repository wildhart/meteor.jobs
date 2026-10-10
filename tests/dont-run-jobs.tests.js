import { Jobs } from 'meteor/wildhart:jobs';
import assert from 'assert';
import { sleep, waitFor, waitForDominator, resetJobs, dominator } from './helpers';

const dominatorCollection = () => Jobs.collection.rawDatabase().collection('jobs_dominator_3');

// Pretend another server has pinged. A stale date (older than maxWait, 2 s in the harness) is what a dead server
// leaves behind; a fresh date is what a live server writes.
const foreignPing = (date) => dominatorCollection().updateOne(
	{ _id: 'dominatorId' },
	{ $set: { serverId: 'some-other-server', instance: 'other-process', date } },
);

const ran = [];

Jobs.register({
	'test.dontRun': function (x) { ran.push(x); this.success(); },
});

describe('dontRunJobs', function () {
	this.timeout(15000);
	let mine;
	before(async () => {
		await waitForDominator();
		mine = (await dominator()).serverId;
	});
	beforeEach(async () => { ran.length = 0; await resetJobs(); });
	afterEach(async () => {
		Jobs.configure({ dontRunJobs: false });
		// leave this server in control for the other test files: a stale foreign ping triggers the normal takeover
		if ((await dominator()).serverId !== mine) {
			await foreignPing(new Date(Date.now() - 60000));
			await waitFor(async () => (await dominator()).serverId === mine, 5000, 'control to be restored');
		}
	});

	it('by default, a fresh foreign ping is respected until maxWait and then taken over', async () => {
		await foreignPing(new Date());
		await sleep(1000);
		assert.strictEqual((await dominator()).serverId, 'some-other-server');
		await waitFor(async () => (await dominator()).serverId === mine, 3000, 'takeover after maxWait');
	});

	it('with dontRunJobs the server never takes control, even from a stale ping', async () => {
		Jobs.configure({ dontRunJobs: true });
		await foreignPing(new Date(Date.now() - 60000));
		await sleep(2600); // well past maxWait
		assert.strictEqual((await dominator()).serverId, 'some-other-server');
	});

	it('with dontRunJobs the server still schedules jobs and runs one with Jobs.execute()', async () => {
		Jobs.configure({ dontRunJobs: true });
		await foreignPing(new Date(Date.now() - 60000));
		await sleep(200);
		assert.notStrictEqual((await dominator()).serverId, mine);
		const job = await Jobs.run('test.dontRun', 7, { in: { hours: 1 } });
		assert.strictEqual(job.state, 'pending');
		assert.strictEqual(await Jobs.execute(job._id), 'success');
		assert.deepStrictEqual(ran, [7]);
	});

	it('warns once when another process pings with this serverId', async () => {
		const warnings = [];
		const warn = console.warn;
		console.warn = (...args) => warnings.push(args.join(' '));
		try {
			await dominatorCollection().updateOne({ _id: 'dominatorId' }, { $set: { instance: 'impostor', date: new Date() } });
			await waitFor(() => warnings.some(w => w.includes('same serverId')), 2000, 'duplicate serverId warning');
			await dominatorCollection().updateOne({ _id: 'dominatorId' }, { $set: { instance: 'impostor-2', date: new Date() } });
			await sleep(300);
		} finally {
			console.warn = warn;
		}
		assert.strictEqual(warnings.filter(w => w.includes('same serverId')).length, 1);
		assert.ok(warnings[0].includes(mine));
		// the ping document still carries our serverId, so this server is still in control
		assert.strictEqual((await dominator()).serverId, mine);
	});

	it('rejects a non-boolean dontRunJobs', () => {
		assert.throws(() => Jobs.configure({ dontRunJobs: 'yes' }), /Match error/);
	});
});
