type JobOrId = string | false | null | {_id: string};

declare module 'meteor/wildhart:jobs' {

    export namespace Jobs {

        interface Config {
            startupDelay: number,
            maxWait: number,
            log: typeof console.log | boolean;
            autoStart: boolean;
            setServerId?: string | Function;
            defaultCompletion?: 'success' | 'remove';
        }

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

        interface JobConfig {
            in: any;
            on: any;
            priority: number;
            date: Date;
            state: string;
            awaitAsync: boolean;
            unique: boolean;
            singular: boolean;
            callback?: Function;
        }

        type JobStatus = "pending" | "success" | "failure" | "executing";

        interface JobDocument {
            _id: string,
            name: string,
            state: JobStatus,
            arguments: any[],
            due: Date,
            priority: number,
            created: Date,
            awaitAsync?: boolean,
        }

        interface JobThisType {
            document: JobDocument;
            replicate(config: Partial<JobConfig>): Promise<string | null | false>;
            reschedule(config: Partial<JobConfig>): Promise<void>;
            remove(): Promise<boolean>;
            success(): Promise<void>;
            failure(): Promise<void>;
        }

        type JobFunction<TArgs extends any[]> = (this: JobThisType, ...args: TArgs) => void | Promise<void>;
        type JobFunctions = Record<string, JobFunction<any>>;
        type RegisterFn = (jobFunctions: JobFunctions) => void;

        let collection: Mongo.Collection<JobDocument>;
        let jobs: JobFunctions;

        function configure(options: Partial<Config>): void;
        function register(jobFunctions: JobFunctions): void;
        function run(jobName: string, ...args: any[]): Promise<JobDocument | false>;
        function execute(jobOrId: JobOrId): Promise<void>;
        function replicate(jobOrId: JobOrId, config: Partial<JobConfig>): Promise<string | null | false>;
        function reschedule(jobOrId: JobOrId, config: Partial<JobConfig>): Promise<void>;
        function remove(jobOrId: JobOrId): Promise<boolean>;
        function clear(state?: '*' | JobStatus | JobStatus[], jobName?: string, ...args: any[]): Promise<number>;
        function findOne(jobName: string, ...args: any[]): Promise<JobDocument | undefined>;
        function count(jobName: string, ...args: any[]): Promise<number>;
        function countPending(jobName: string, ...args: any[]): Promise<number>;
        function start(jobNames?: string | string[]): Promise<void>;
        function stop(jobNames?: string | string[]): Promise<void>;
        function createIndexes(): Promise<void>;
    }

	export class TypedJob<TArgs extends any[]> {
		constructor(name: string, methodFn: Jobs.JobFunction<TArgs>);
        public name: string;

		public withArgs(...args: TArgs): {
		    run: (config?: Partial<Jobs.JobConfig>) => Promise<Jobs.JobDocument | false>;
		}
		public clear(state: '*' | Jobs.JobStatus | Jobs.JobStatus[], ...args: PartialArray<TArgs>): Promise<number>;
		public clearQuery(query: any): Promise<number>;
        public remove(jobOrId: JobOrId): Promise<boolean>
        public execute(jobOrId: JobOrId): Promise<void>;
        public reschedule(jobOrId: JobOrId, config: Partial<Jobs.JobConfig>): Promise<void>;
        public replicate(jobOrId: JobOrId, config: Partial<Jobs.JobConfig>): Promise<string | null | false>;
		public start(): Promise<void>;
		public stop(): Promise<void>;
        public count(...args: PartialArray<TArgs>): Promise<number>;
		public update(selector: any, options: any): Promise<number>;
		public findOne(...args: PartialArray<TArgs>): Promise<Jobs.JobDocument | undefined>;
	}
}

// create an array type which doesn't require all elements of the original type
// https://stackoverflow.com/a/73939891/9614402
type PartialArray<T extends ReadonlyArray<unknown>> =
    T extends readonly [...infer Head, any]
        ? PartialArray<Head> | T
        : T;

