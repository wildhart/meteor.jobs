type JobOrId = string | false | null | {_id: string};

declare module 'meteor/wildhart:jobs' {

    export namespace Jobs {

        interface Config {
            startupDelay: number,
            maxWait: number,
            log: typeof console.log | boolean;
            autoStart: boolean;
            setServerId?: string | (() => string);
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
            callback?: (err: string | null, res: any) => void | Promise<void>;
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
            replicateAsync(config: Partial<JobConfig>): Promise<string | null | false>;
            rescheduleAsync(config: Partial<JobConfig>): Promise<void>;
            removeAsync(): Promise<boolean>;
            successAsync(): Promise<void>;
            failureAsync(): Promise<void>;
        }

        type JobFunction<TArgs extends any[]> = (this: JobThisType, ...args: TArgs) => void;
        type JobFunctions = Record<string, JobFunction<any>>;
        type RegisterFn = (jobFunctions: JobFunctions) => void;

        let collection: Mongo.Collection<JobDocument>;
        let jobs: JobFunctions;

        function configure(options: Partial<Config>): void;
        function register(jobFunctions: JobFunctions): void;
        function runAsync(jobName: string, ...args: any[]): Promise<JobDocument | false>;
        function executeAsync(jobOrId: JobOrId): Promise<void>;
        function replicateAsync(jobOrId: JobOrId, config: Partial<JobConfig>): Promise<string | null>;
        function rescheduleAsync(jobOrId: JobOrId, config: Partial<JobConfig>): Promise<void>;
        function removeAsync(jobOrId: JobOrId): Promise<boolean>;
        function clearAsync(state?: '*' | JobStatus | JobStatus[], jobName?: string, ...args: any[]): Promise<number>;
        function findOneAsync(jobName: string, ...args: any[]): Promise<JobDocument>;
        function countAsync(jobName: string, ...args: any[]): Promise<number>;
        function countPendingAsync(jobName: string, ...args: any[]): Promise<number>;
        function startAsync(jobNames?: string | string[]): Promise<void>;
        function stopAsync(jobNames?: string | string[]): Promise<void>;
    }

	export class TypedJob<TArgs extends any[]> {
		constructor(name: string, methodFn: Jobs.JobFunction<TArgs>);
        public name: string;

		public withArgs(...args: TArgs): {
		    runAsync: (config?: Partial<Jobs.JobConfig>) => Jobs.JobDocument | false;
		}
		public clearAsync(state: '*' | Jobs.JobStatus | Jobs.JobStatus[], ...args: PartialArray<TArgs>): Promise<number>;
		public clearQueryAsync(query: Mongo.Selector<Jobs.JobDocument>): Promise<void>;
        public removeAsync(jobOrId: JobOrId): Promise<boolean>;
        public executeAsync(jobOrId: JobOrId): Promise<false | undefined>;
        public rescheduleAsync(jobOrId: JobOrId, config: Partial<Jobs.JobConfig>): Promise<false | undefined>;
        public replicateAsync(jobOrId: JobOrId, config: Partial<Jobs.JobConfig>): Promise<false | undefined>;
		public startAsync(): Promise<void>;
		public stopAsync(): Promise<void>;
        public countAsync(...args: PartialArray<TArgs>): Promise<number>;
		public updateAsync(selector: string | Mongo.Selector<Jobs.JobDocument>, options: Mongo.Modifier<Jobs.JobDocument>): Promise<number>;
		public findOneAsync(...args: PartialArray<TArgs>): Promise<Jobs.JobDocument | undefined>;
	}
}

// create an array type which doesn't require all elements of the original type
// https://stackoverflow.com/a/73939891/9614402
type PartialArray<T extends ReadonlyArray<unknown>> =
    T extends readonly [...infer Head, any]
        ? PartialArray<Head> | T
        : T;

