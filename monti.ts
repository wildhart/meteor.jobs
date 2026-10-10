// Optional Monti APM integration (https://docs.montiapm.com/dashboards/jobs-dashboard), enabled with
// Jobs.configure({monti: ...}). The agent package is never a dependency: it is looked up at run time
// through the `Package` global, so apps without it (or on any agent version) build unchanged.

/** The subset of the Monti APM agent (`Monti` / `Kadira` global) used by this package. */
export interface MontiLike {
	traceJob<T>(options: {name: string; waitTime?: number; data?: object}, fn: () => T): T;
	recordNewJob(name: string): void;
	recordPendingJobs(name: string, count: number): void;
}

export interface MontiOptions {
	/** Milliseconds between pending-count reports from the server in control. 0 (default) = off. */
	pendingInterval?: number;
	/** The agent to use instead of `Package['montiapm:agent'].Monti`. Intended for tests. */
	agent?: MontiLike;
}

export type MontiConfig = boolean | MontiOptions;

// what the pending reporter needs from jobs.ts, passed in to avoid a circular import
interface Deps {
	collection: Mongo.Collection<any>;
	jobNames(): string[];
}

let agent: MontiLike | null = null;
let pendingInterval = 0;
let deps: Deps | null = null;
let controlling = false;
let pendingTimer: number | null = null;
let reporting = false;

export function isEnabled() {
	return !!agent;
}

export function configure(option: MontiConfig | undefined, newDeps: Deps) {
	agent = null;
	pendingInterval = 0;
	deps = newDeps;
	if (option) {
		const options: MontiOptions = typeof option == 'object' ? option : {};
		const found: MontiLike | undefined = options.agent || (globalThis as any).Package?.['montiapm:agent']?.Monti;
		if (found && typeof found.traceJob == 'function') {
			agent = found;
			pendingInterval = options.pendingInterval || 0;
		} else {
			console.warn('Jobs', 'monti is configured but the Monti APM agent (montiapm:agent) was not found; jobs will run without tracing');
		}
	}
	syncPendingTimer();
}

/** `Jobs.run()` inserted a job: count it as added on the dashboard. */
export function recordNewJob(name: string) {
	agent?.recordNewJob(name);
}

/** Run a job function inside a Monti job trace. Returns whatever `fn` returns (a promise for an async job). */
export function trace<T>(job: {_id: string; name: string; due: Date; arguments: any[]; attempts?: number}, fn: () => T): T {
	if (!agent) {
		return fn();
	}
	return agent.traceJob({
		name: job.name,
		// shown as the job's delay; Jobs.execute() can run a job ahead of its due date, hence the floor
		waitTime: Math.max(0, Date.now() - job.due.valueOf()),
		data: {jobId: job._id, arguments: job.arguments, attempt: job.attempts},
	}, fn);
}

/** Called by the Dominator: only the server in control reports pending counts, otherwise N servers over-report. */
export function setControlling(value: boolean) {
	controlling = value;
	syncPendingTimer();
}

function syncPendingTimer() {
	if (pendingTimer) {
		Meteor.clearInterval(pendingTimer);
		pendingTimer = null;
	}
	if (controlling && agent && pendingInterval > 0) {
		pendingTimer = Meteor.setInterval(() => reportPending(), pendingInterval);
		// Monti wants a first report soon after start-up, so don't wait a whole interval for it
		reportPending();
	}
}

async function reportPending() {
	if (!agent || !deps || reporting) {
		return;
	}
	reporting = true;
	const reportTo = agent;
	try {
		// a scan of the pending documents: the {name, due, state} index cannot serve a query on state alone
		const rows: Array<{_id: string; n: number}> = await deps.collection.rawCollection().aggregate([
			{$match: {state: 'pending'}},
			{$group: {_id: '$name', n: {$sum: 1}}},
		]).toArray();
		const counts: Record<string, number> = {};
		rows.forEach(row => counts[row._id] = row.n);
		// report every registered name, so a drained queue goes back to 0 rather than keeping its last value
		deps.jobNames().forEach(name => reportTo.recordPendingJobs(name, counts[name] || 0));
	} catch (e) {
		console.warn('Jobs', 'monti pending report failed');
		console.warn(e);
	} finally {
		reporting = false;
	}
}
