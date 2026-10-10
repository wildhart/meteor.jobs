import { Jobs } from 'meteor/wildhart:jobs';
import assert from 'assert';
import { sleep, doc, waitFor, waitForDominator, resetJobs } from './helpers';

// A stand-in for the Monti APM agent with the same contract as Monti.traceJob / recordNewJob / recordPendingJobs
// (monti-apm-agent lib/kadira.js): run `fn` straight away, return its result, end the trace when a returned
// promise settles, and rethrow a synchronous throw after recording it.
function fakeMonti() {
	const calls = { trace: [], newJobs: [], pending: [] };
	return {
		calls,
		traceJob(options, fn) {
			const rec = { options, error: null, ended: false };
			calls.trace.push(rec);
			let result;
			try {
				result = fn();
			} catch (e) {
				rec.error = e;
				rec.ended = true;
				throw e;
			}
			if (result && typeof result.then === 'function') {
				result.then(() => { rec.ended = true; }, (e) => { rec.error = e; rec.ended = true; });
			} else {
				rec.ended = true;
			}
			return result;
		},
		recordNewJob(name) { calls.newJobs.push(name); },
		recordPendingJobs(name, count) { calls.pending.push([name, count]); },
	};
}

const runs = {};

Jobs.register({
	'monti.sync': function (x) { runs.sync = (runs.sync || 0) + 1; this.success(); },
	'monti.async': async function () { await sleep(50); await this.success(); },
	'monti.flakySync': function (failUntil) {
		runs.flakySync = (runs.flakySync || 0) + 1;
		if (runs.flakySync < failUntil) throw new Error(`flaky ${runs.flakySync}`);
		this.success();
	},
	'monti.flakyAsync': async function (failUntil) {
		runs.flakyAsync = (runs.flakyAsync || 0) + 1;
		if (runs.flakyAsync < failUntil) throw new Error(`flaky ${runs.flakyAsync}`);
		await this.success();
	},
	'monti.fails': async function () { await this.failure(); },
	'monti.other': function () { this.success(); },
});

// Execute the job whenever it is pending and due, until it reaches a final state (retries reschedule it).
async function drive(id) {
	return waitFor(async () => {
		const job = await doc(id);
		if (job.state === 'success' || job.state === 'failure') return job;
		if (job.state === 'pending' && job.due <= new Date()) await Jobs.execute(id);
		return null;
	}, 5000, `job ${id} to settle`);
}

describe('Monti APM integration', function () {
	this.timeout(10000);
	before(waitForDominator);
	let monti;
	beforeEach(async () => {
		for (const k of Object.keys(runs)) delete runs[k];
		await resetJobs();
		monti = fakeMonti();
		Jobs.configure({ monti: { agent: monti } });
	});
	// so the other test files run without the fake
	afterEach(() => Jobs.configure({ monti: false }));

	it('records a new job when Jobs.run() inserts one, not when unique refuses it', async () => {
		assert.ok(await Jobs.run('monti.sync', 'u', { unique: true, in: { hours: 1 } }));
		assert.strictEqual(await Jobs.run('monti.sync', 'u', { unique: true, in: { hours: 1 } }), false);
		assert.deepStrictEqual(monti.calls.newJobs, ['monti.sync']);
	});

	it('traces a sync job with its name, delay and data', async () => {
		const job = await Jobs.run('monti.sync', 'x', { foo: 1 });
		const result = await Jobs.execute(job._id);
		assert.strictEqual(result, 'success');
		assert.strictEqual(runs.sync, 1);
		assert.strictEqual(monti.calls.trace.length, 1);
		const rec = monti.calls.trace[0];
		assert.strictEqual(rec.options.name, 'monti.sync');
		assert.ok(rec.options.waitTime >= 0, `waitTime ${rec.options.waitTime}`);
		assert.strictEqual(rec.options.data.jobId, job._id);
		assert.deepStrictEqual(rec.options.data.arguments, ['x', { foo: 1 }]);
		assert.strictEqual(rec.options.data.attempt, 1);
		assert.strictEqual(rec.error, null);
		assert.ok(rec.ended);
		assert.strictEqual((await doc(job._id)).state, 'success');
	});

	it('reports a delay of 0 for a job executed ahead of its due date', async () => {
		const job = await Jobs.run('monti.sync', { in: { hours: 1 } });
		await Jobs.execute(job._id);
		assert.strictEqual(monti.calls.trace[0].options.waitTime, 0);
	});

	it('ends the trace of an async job only once its promise has settled', async () => {
		const job = await Jobs.run('monti.async');
		const pending = Jobs.execute(job._id, { awaitCompletion: true });
		await waitFor(() => monti.calls.trace.length === 1, 2000, 'trace started');
		assert.strictEqual(monti.calls.trace[0].ended, false);
		assert.strictEqual(await pending, 'success');
		assert.strictEqual(monti.calls.trace[0].ended, true);
		assert.strictEqual(monti.calls.trace[0].error, null);
	});

	it('records an error on a throwing sync job and a clean trace for its retry', async () => {
		const job = await Jobs.run('monti.flakySync', 2, { retries: 1 });
		const settled = await drive(job._id);
		assert.strictEqual(settled.state, 'success');
		assert.strictEqual(monti.calls.trace.length, 2);
		assert.ok(monti.calls.trace[0].error instanceof Error);
		assert.strictEqual(monti.calls.trace[0].error.message, 'flaky 1');
		assert.strictEqual(monti.calls.trace[1].error, null);
		assert.strictEqual(monti.calls.trace[0].options.data.attempt, 1);
		assert.strictEqual(monti.calls.trace[1].options.data.attempt, 2);
	});

	it('records an error on a rejecting async job', async () => {
		const job = await Jobs.run('monti.flakyAsync', 2, { retries: 1 });
		const settled = await drive(job._id);
		assert.strictEqual(settled.state, 'success');
		assert.strictEqual(monti.calls.trace.length, 2);
		await waitFor(() => monti.calls.trace[0].ended, 1000, 'first trace ended');
		assert.strictEqual(monti.calls.trace[0].error.message, 'flaky 1');
		assert.strictEqual(monti.calls.trace[1].error, null);
	});

	it('shows this.failure() as a completed run, not an errored one', async () => {
		const job = await Jobs.run('monti.fails');
		assert.strictEqual(await Jobs.execute(job._id, { awaitCompletion: true }), 'failure');
		assert.strictEqual(monti.calls.trace.length, 1);
		assert.strictEqual(monti.calls.trace[0].error, null);
		assert.ok(monti.calls.trace[0].ended);
	});

	it('reports pending counts per registered job name from the server in control', async () => {
		// the harness has autoStart: false and this server is in control, so the reporter runs
		for (let i = 0; i < 3; i++) await Jobs.run('monti.sync', i, { in: { hours: 1 } });
		Jobs.configure({ monti: { agent: monti, pendingInterval: 200 } });
		const latest = (name) => monti.calls.pending.filter(([n]) => n === name).pop();
		await waitFor(() => latest('monti.sync')?.[1] === 3 && latest('monti.other')?.[1] === 0, 2000, 'pending counts');

		await Jobs.clear('*');
		monti.calls.pending.length = 0;
		await waitFor(() => latest('monti.sync')?.[1] === 0 && latest('monti.other')?.[1] === 0, 2000, 'drained counts');
	});

	it('does not report pending counts unless pendingInterval is set', async () => {
		await Jobs.run('monti.sync', { in: { hours: 1 } });
		await sleep(300);
		assert.deepStrictEqual(monti.calls.pending, []);
	});

	it('stops calling the agent after monti: false', async () => {
		Jobs.configure({ monti: false });
		const job = await Jobs.run('monti.sync', 'off');
		assert.strictEqual(await Jobs.execute(job._id), 'success');
		assert.deepStrictEqual(monti.calls.newJobs, []);
		assert.deepStrictEqual(monti.calls.trace, []);
	});

	it('warns once and runs jobs untraced when monti is on but no agent is available', async () => {
		const warnings = [];
		const warn = console.warn;
		console.warn = (...args) => warnings.push(args);
		try {
			Jobs.configure({ monti: true }); // the test app does not include montiapm:agent
		} finally {
			console.warn = warn;
		}
		assert.strictEqual(warnings.length, 1, JSON.stringify(warnings));
		assert.ok(warnings[0].join(' ').includes('montiapm:agent'));
		const job = await Jobs.run('monti.sync', 'noagent');
		assert.strictEqual(await Jobs.execute(job._id), 'success');
		assert.deepStrictEqual(monti.calls.trace, []);
	});

	it('rejects an agent without the expected functions', () => {
		assert.throws(() => Jobs.configure({ monti: { agent: { traceJob() {} } } }), /Match error/);
		assert.throws(() => Jobs.configure({ monti: 'yes' }), /Match error/);
	});
});
