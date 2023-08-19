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
            replicate(config: Partial<JobConfig>): string | null | false;
            reschedule(config: Partial<JobConfig>): void;
            remove(): boolean;
            success(): void;
            failure(): void;
        }

        type JobFunction<TArgs extends any[]> = (this: JobThisType, ...args: TArgs) => void;
        type JobFunctions = Record<string, JobFunction<any>>;
        type RegisterFn = (jobFunctions: JobFunctions) => void;

        let collection: Mongo.Collection<JobDocument>;
        let jobs: JobFunctions;

        function configure(options: Partial<Config>): void;
        function register(jobFunctions: JobFunctions): void;
        function run(jobName: string, ...args: any[]): JobDocument | false;
        function execute(jobOrId: JobOrId): void;
        function replicate(jobOrId: JobOrId, config: Partial<JobConfig>): string | null;
        function reschedule(jobOrId: JobOrId, config: Partial<JobConfig>): void;
        function remove(jobOrId: JobOrId): boolean;
        function clear(state?: '*' | JobStatus | JobStatus[], jobName?: string, ...args: any[]): number;
        function findOne(jobName: string, ...args: any[]): JobDocument;
        function count(jobName: string, ...args: any[]): number;
        function countPending(jobName: string, ...args: any[]): number;
        function start(jobNames?: string | string[]): void;
        function stop(jobNames?: string | string[]): void;
    }

	export class TypedJob<TArgs extends any[]> {
		constructor(name: string, methodFn: Jobs.JobFunction<TArgs>);
        public name: string;

		public withArgs(...args: TArgs): {
		    run: (config?: Partial<Jobs.JobConfig>) => Jobs.JobDocument | false;
		}
		public clear(state: '*' | Jobs.JobStatus | Jobs.JobStatus[], ...args: PartialArray<TArgs>): number;
		public clearQuery(query: Mongo.Selector<Jobs.JobDocument>): void;
        public remove(jobOrId: JobOrId): boolean
        public execute(jobOrId: JobOrId): false | undefined;
        public reschedule(jobOrId: JobOrId, config: Partial<Jobs.JobConfig>): false | undefined;
        public replicate(jobOrId: JobOrId, config: Partial<Jobs.JobConfig>): false | undefined;
		public start(): void;
		public stop(): void;
        public count(...args: PartialArray<TArgs>): number;
		public update(selector: string | Mongo.Selector<Jobs.JobDocument>, options: Mongo.Modifier<Jobs.JobDocument>): number;
		public findOne(...args: PartialArray<TArgs>): Jobs.JobDocument | undefined;
	}
}

// create an array type which doesn't require all elements of the original type
// https://stackoverflow.com/a/73939891/9614402
type PartialArray<T extends ReadonlyArray<unknown>> =
    T extends readonly [...infer Head, any]
        ? PartialArray<Head> | T
        : T;

