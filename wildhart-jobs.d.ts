type JobOrId = string | false | null | {_id: string};

declare module 'meteor/wildhart:jobs' {

    export namespace Jobs {

        /** Package settings, changed with `Jobs.configure()`. Every option is optional; defaults are in the README. */
        interface Config {
            /** Milliseconds to wait after server startup before the package starts. Default 1000. */
            startupDelay: number,
            /**
             * Milliseconds the server in control of the queue may go without pinging before another server
             * takes over. The server in control pings every 80% of this. Default 5 minutes.
             */
            maxWait: number,
            /** Logging: `console.log` (default), any other function, or `false` to disable. */
            log: typeof console.log | boolean;
            /**
             * Whether the job queue runs on a fresh install (default `true`). After a restart the list of
             * paused job names is restored from the database, so this only matters the first time.
             */
            autoStart: boolean;
            /**
             * Identifies this server in a multi-server deployment: a string, or a function returning one.
             * Default: a random string per process. In a single-server deployment set a static string so the
             * server knows it is always in control and can resume quickly after a restart.
             */
            setServerId?: string | Function;
            /**
             * Opt-out of running the job queue on this server (default `false`). A server with this set never takes
             * control of the queue, even when the server in control goes quiet, but can still schedule jobs, pause and
             * resume the queue, and run one job on demand with `Jobs.execute()`. Set it on web servers to keep jobs
             * on one or more dedicated servers. See "Dedicated jobs server" in the README.
             */
            dontRunJobs: boolean;
            /**
             * What to do with a job whose function returned without calling `this.success()`, `this.failure()`,
             * `this.reschedule()` or `this.remove()`. Unset (default): mark it `'failure'` and log a warning.
             * Pass `null` to return to the default after setting it.
             */
            defaultCompletion?: 'success' | 'remove' | null;
            /**
             * Opt-in crash recovery (default `false`). Whenever a server takes control of the queue, every job
             * still `'executing'` is returned to `'pending'` and runs again. This makes execution at-least-once,
             * so job functions must be safe to run twice. Read "Crash recovery" in the README before enabling.
             */
            requeueOnTakeover: boolean;
            /**
             * Milliseconds, default `0` (off). When set, on every ping the server in control requeues jobs which
             * have been `'executing'` for longer than this, for job functions which hang. Keep it comfortably
             * longer than your longest job. See "Crash recovery" in the README.
             */
            maxExecutionTime: number;
            /**
             * Monti APM jobs dashboard integration, default `false`. `true` traces every job run and counts
             * jobs added by `Jobs.run()`; an object additionally reports pending counts every `pendingInterval`
             * ms from the server in control (0 = off). The `montiapm:agent` package must be in the app; it is
             * found at run time, never a dependency. See "Monti APM" in the README.
             */
            monti?: boolean | {pendingInterval?: number; agent?: MontiLike};
        }

        /** A time span or point in time for the `in` / `on` / `retryIn` options, e.g. `{minutes: 5}` or `{hour: 9, minute: 0}`. */
        interface JobInConfig {
            millisecond?: number;
            milliseconds?: number;
            second?: number;
            seconds?: number;
            minute?: number;
            minutes?: number;
            hour?: number;
            hours?: number;
            day?: number;
            days?: number;
            month?: number;
            months?: number;
            year?: number;
            years?: number;
            date?: Date;
        }

        /** Options for `Jobs.run()`, passed as the last argument after the job's own arguments. */
        interface JobConfig {
            /** Run the job this long from now (or from `date`), e.g. `{in: {hours: 1}}`. */
            in: any;
            /** Run the job at this time within the current (or `date`) period, e.g. `{on: {hour: 9, minute: 0}}`. */
            on: any;
            /** Among jobs due at the same time, a higher priority runs first. Default 0. */
            priority: number;
            /** The base date for `in` / `on`. Default: now. */
            date: Date;
            state: string;
            /** For async job functions: no other job with this name starts until this one has completed. */
            awaitAsync: boolean;
            /** Only schedule if no job with the same name and arguments exists, in any state. */
            unique: boolean;
            /** Only schedule if no job with the same name and arguments is pending. */
            singular: boolean;
            /**
             * Use this `_id` for the job document instead of a generated one, so scheduling is idempotent.
             * If a job with this id already exists in any state, `Jobs.run()` returns `false`. Must be a non-empty string.
             */
            jobId: string;
            /**
             * Run the job again up to this many times if its function throws or rejects. Default 0.
             * Must be a non-negative integer. An explicit `this.failure()` is never retried.
             */
            retries: number;
            /** Delay before each retry, in the same format as `in`. Default: retry as soon as possible. */
            retryIn: JobInConfig;
            /** Called after scheduling with `(error, jobDocument)`. */
            callback?: Function;
        }

        type JobStatus = "pending" | "success" | "failure" | "executing";

        /** Options for `Jobs.execute()`. */
        interface ExecuteOptions {
            /**
             * Resolve only once the job function has finished and the job's state has been resolved, including for
             * async job functions. Default `false`: resolves as soon as an async job function has started.
             */
            awaitCompletion?: boolean;
        }

        /** How a job was resolved, or `'executing'` for an async job which is still running (no `awaitCompletion`). */
        type ExecuteResult = 'success' | 'failure' | 'reschedule' | 'remove' | 'executing';

        /** A document in `Jobs.collection`. */
        interface JobDocument {
            _id: string,
            name: string,
            state: JobStatus,
            arguments: any[],
            due: Date,
            priority: number,
            created: Date,
            awaitAsync?: boolean,
            /** How many times the current scheduling of this job has run. Reset when the job is rescheduled. */
            attempts?: number,
            retries?: number,
            retryIn?: JobInConfig,
            /** Set while the job is `'executing'`. */
            startedAt?: Date,
        }

        /** `this` inside a job function. */
        interface JobThisType {
            /** The job document being executed. */
            document: JobDocument;
            /** Insert a copy of this job due at the time given by `config`. Resolves to the new job's id. */
            replicate(config: Partial<JobConfig>): Promise<string | null | false>;
            /** Run this job again at the time given by `config`. Starts a new run cycle, so `attempts` is reset. */
            reschedule(config: Partial<JobConfig>): Promise<void>;
            /** Delete the job document. */
            remove(): Promise<boolean>;
            /** Mark the job `'success'`. */
            success(): Promise<void>;
            /** Mark the job `'failure'`. Not retried, even if the job has `retries`. */
            failure(): Promise<void>;
        }

        type JobFunction<TArgs extends any[]> = (this: JobThisType, ...args: TArgs) => void | Promise<void>;
        type JobFunctions = Record<string, JobFunction<any>>;
        type RegisterFn = (jobFunctions: JobFunctions) => void;

        /** The `jobs_data` collection. Query it directly if you need to. */
        let collection: Mongo.Collection<JobDocument>;
        /** The registered job functions, by name. */
        let jobs: JobFunctions;

        /** Change package settings. Call it at server start-up, before the queue starts (`startupDelay` after `Meteor.startup`). */
        function configure(options: Partial<Config>): void;
        /** Register job functions by name. */
        function register(jobFunctions: JobFunctions): void;
        /**
         * Schedule a job. Pass a `JobConfig` as the last argument to say when it runs; otherwise it runs as soon as possible.
         * Resolves to the job document, or `false` if a `unique`, `singular` or `jobId` check refused it.
         */
        function run(jobName: string, ...args: any[]): Promise<JobDocument | false>;
        /** Run a pending job now, ahead of its due date. Resolves to how it was resolved, or `false` if it was not found or not pending. */
        function execute(jobOrId: JobOrId, options?: ExecuteOptions): Promise<ExecuteResult | false>;
        /** Insert a copy of a job due at the time given by `config`. Resolves to the new job's id. */
        function replicate(jobOrId: JobOrId, config: Partial<JobConfig>): Promise<string | null | false>;
        /** Make a job pending again at the time given by `config`. Starts a new run cycle, so `attempts` is reset. */
        function reschedule(jobOrId: JobOrId, config: Partial<JobConfig>): Promise<void>;
        /** Delete a job document. */
        function remove(jobOrId: JobOrId): Promise<boolean>;
        /** Delete jobs by state (default `'success'` and `'failure'`; `'*'` for all), optionally by name and leading arguments. Resolves to the number removed. */
        function clear(state?: '*' | JobStatus | JobStatus[], jobName?: string, ...args: any[]): Promise<number>;
        /** Find one job by name and leading arguments. */
        function findOne(jobName: string, ...args: any[]): Promise<JobDocument | undefined>;
        /** Count jobs by name and leading arguments, in any state. */
        function count(jobName: string, ...args: any[]): Promise<number>;
        /** Count pending jobs by name and leading arguments. */
        function countPending(jobName: string, ...args: any[]): Promise<number>;
        /** Resume the queue for all jobs (no argument) or for the given job names. */
        function start(jobNames?: string | string[]): Promise<void>;
        /** Pause the queue for all jobs (no argument) or for the given job names. Paused names persist across restarts. */
        function stop(jobNames?: string | string[]): Promise<void>;
        /** Create the collection indexes. Called automatically on startup. */
        function createIndexes(): Promise<void>;
        /**
         * Return `'executing'` jobs to `'pending'` so they run again, optionally only those started before `olderThan`.
         * Jobs whose `retries` are used up are marked `'failure'` instead. Resolves to the number requeued.
         * See "Crash recovery" in the README.
         */
        function requeueExecuting(olderThan?: Date): Promise<number>;
    }

    /** The subset of the Monti APM agent (the `Monti` global) used by the `monti` option. Pass your own via `monti: {agent}` in tests. */
    export interface MontiLike {
        traceJob<T>(options: {name: string; waitTime?: number; data?: object}, fn: () => T): T;
        recordNewJob(name: string): void;
        recordPendingJobs(name: string, count: number): void;
    }

    /**
     * A job with typed arguments. Constructing one registers the job function under `name` and gives you the
     * `Jobs` API scoped to that job name, with the arguments type-checked against the function's parameters.
     *
     * @example
     * const sendReminder = new TypedJob('sendReminder', async function (email: string, text: string) { ... });
     * await sendReminder.withArgs('jon@example.com', 'Hi').run({in: {days: 1}});
     */
    export class TypedJob<TArgs extends any[]> {
        /** Registers `methodFn` as the job function for `name`. */
        constructor(name: string, methodFn: Jobs.JobFunction<TArgs>);
        /** The job name this instance is scoped to. */
        public name: string;

        /** Bind the job's arguments, then call `.run(config)` to schedule it. `config` is the same as the last argument of `Jobs.run()`. */
        public withArgs(...args: TArgs): {
            run: (config?: Partial<Jobs.JobConfig>) => Promise<Jobs.JobDocument | false>;
        }
        /** Delete this job's documents by state (`'*'` for all), optionally only those with the given leading arguments. Resolves to the number removed. */
        public clear(state: '*' | Jobs.JobStatus | Jobs.JobStatus[], ...args: PartialArray<TArgs>): Promise<number>;
        /** Delete this job's documents matching a Mongo selector (the job name is added to the selector for you). */
        public clearQuery(query: any): Promise<number>;
        /** Delete one job document. */
        public remove(jobOrId: JobOrId): Promise<boolean>
        /** Run a pending job now, ahead of its due date. Resolves to how it was resolved, or `false` if it was not found or not pending. */
        public execute(jobOrId: JobOrId, options?: Jobs.ExecuteOptions): Promise<Jobs.ExecuteResult | false>;
        /** Make a job pending again at the time given by `config`. Starts a new run cycle, so `attempts` is reset. */
        public reschedule(jobOrId: JobOrId, config: Partial<Jobs.JobConfig>): Promise<void>;
        /** Insert a copy of a job due at the time given by `config`. Resolves to the new job's id. */
        public replicate(jobOrId: JobOrId, config: Partial<Jobs.JobConfig>): Promise<string | null | false>;
        /** Resume the queue for this job name. */
        public start(): Promise<void>;
        /** Pause the queue for this job name. Persists across restarts. */
        public stop(): Promise<void>;
        /** Count this job's documents, in any state, optionally only those with the given leading arguments. */
        public count(...args: PartialArray<TArgs>): Promise<number>;
        /** Update this job's documents matching a Mongo selector (the job name is added for you) or a single id. Resolves to the number updated. */
        public update(selector: any, options: any): Promise<number>;
        /** Find one of this job's documents, optionally by leading arguments. */
        public findOne(...args: PartialArray<TArgs>): Promise<Jobs.JobDocument | undefined>;
    }
}

// create an array type which doesn't require all elements of the original type
// https://stackoverflow.com/a/73939891/9614402
type PartialArray<T extends ReadonlyArray<unknown>> =
    T extends readonly [...infer Head, any]
        ? PartialArray<Head> | T
        : T;
