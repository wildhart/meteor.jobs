import { Mongo } from 'meteor/mongo';
/********************************* Dominator *********************/
declare namespace Dominator {
    interface Document {
        _id?: string;
        serverId?: string;
        pausedJobs: string[];
        date?: Date;
    }
    export const collection: Mongo.Collection<Document, Document>;
    export let lastPing: Readonly<Document>;
    export function init(): void;
    export function start(jobNames?: string[] | string): void;
    export function stop(jobNames?: string[] | string): void;
    export {};
}
/********************************* Public API *********************/
export declare namespace Jobs {
    interface Config {
        startupDelay: number;
        maxWait: number;
        log: typeof console.log | boolean;
        autoStart: boolean;
        setServerId?: string | Function;
        defaultCompletion?: 'success' | 'remove';
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
        _id: string;
        name: string;
        state: JobStatus;
        arguments: any[];
        due: Date;
        priority: number;
        created: Date;
        awaitAsync?: boolean;
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
    const jobs: JobFunctions;
    const collection: Mongo.Collection<JobDocument, JobDocument>;
    function configure(config: Partial<Config>): void;
    function register(newJobs: JobFunctions): void;
    function run(name: string, ...args: any): false | JobDocument;
    function execute(jobId: string): void;
    function replicate(jobId: string, config: Partial<JobConfig>): string;
    function reschedule(jobId: string, config: Partial<JobConfig>): void;
    function remove(jobId: string): boolean;
    function clear(state?: '*' | JobStatus | JobStatus[], jobName?: string, ...args: any[]): number;
    function findOne(jobName: string, ...args: any[]): JobDocument;
    function count(jobName: string, ...args: any[]): number;
    function countPending(jobName: string, ...args: any[]): number;
    const start: typeof Dominator.start;
    const stop: typeof Dominator.stop;
}
export {};
