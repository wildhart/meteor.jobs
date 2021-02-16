declare module 'meteor/wildhart:jobs' {

    export namespace Jobs {

        interface Config {
            startupDelay: number,
            maxWait: number,
            log: typeof console.log | boolean;
            autoStart: boolean;
            setServerId?: string | Function;
        }

        interface JobConfig {
            priority?: number;
            due?: Date;
            state: string;
            callback?: Function;
        }

        export type JobStatus = "pending" | "success" | "failure" | "executing";

        interface JobDocument {
            _id: string,
            name: string,
            state: JobStatus,
            arguments: any[],
            due: Date,
            priority: number,
            created: Date,
        }

        interface JobThisType {
            document: JobDocument;
            replicate(config: Partial<JobConfig>): string | null;
            reschedule(config: Partial<JobConfig>): void;
            remove(): boolean;
            success(): void;
            failure(): void;
        }

        type JobFunction = (this: JobThisType, ...args: any[]) => void;
        type JobFunctions = Record<string, JobFunction>;
        type RegisterFn = (jobFunctions: JobFunctions) => void;

        var collection: Mongo.Collection<JobDocument>;
        var jobs: JobFunctions;

        function configure(options: Partial<Config>): void;
        function register(jobFunctions: JobFunctions): void;
        function run(jobName: string, ...args: any[]): JobDocument | false;
        function execute(jobId: string): void;
        function replicate(jobId: string, config: Partial<JobConfig>): string | null;
        function reschedule(jobId: string, config: Partial<JobConfig>): void;
        function remove(jobId: string): boolean;
        function clear(state: '*' | JobStatus | JobStatus[], jobName: string, ...args: any[]): number;
        function findOne(jobName: string, ...args: any[]): JobDocument;
        function count(jobName: string, ...args: any[]): number;
        function countPending(jobName: string, ...args: any[]): number;
        function start(jobNames: string | string[]): void;
        function stop(jobNames: string | string[]): void;
    }

}