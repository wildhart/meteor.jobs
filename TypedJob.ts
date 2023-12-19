import { Jobs, JobOrId } from "./jobs";

export default class TypedJob<TArgs extends any[]> {
	constructor(public name: string, methodFn: Jobs.JobFunction<TArgs>) {
		Jobs.register({[name]: methodFn});
	}

	public withArgs(...args: TArgs) {
		return {
			run: (config?: Partial<Jobs.JobConfig>) => Jobs.runAsync(this.name, ...args, config),
		}
	}

	public clearAsync = (state: '*' | Jobs.JobStatus | Jobs.JobStatus[], ...args: PartialArray<TArgs>) => Jobs.clearAsync(state, this.name, ...args);

	public clearQueryAsync = (query: Mongo.Selector<Jobs.JobDocument>) => Jobs.collection.removeAsync({...query, name: this.name});

	public removeAsync = (jobOrId: JobOrId) => Jobs.removeAsync(jobOrId);

	public executeAsync = (jobOrId: JobOrId) => Jobs.executeAsync(jobOrId);

	public rescheduleAsync = (jobOrId: JobOrId, config: Partial<Jobs.JobConfig>) => Jobs.rescheduleAsync(jobOrId, config);

	public replicateAsync = (jobOrId: JobOrId, config: Partial<Jobs.JobConfig>) => Jobs.replicateAsync(jobOrId, config);

	public startAsync = () => Jobs.startAsync(this.name);

	public stopAsync = () => Jobs.stopAsync(this.name);

	public countAsync = (...args: PartialArray<TArgs>) => Jobs.countAsync(this.name, ...args);

	public updateAsync: Mongo.Collection<Jobs.JobDocument>['updateAsync'] = (selector, options) => {
		const mySelector = typeof selector == 'string' ? selector : {...selector, name: this.name};
		return Jobs.collection.updateAsync(mySelector, options);
	}

	public findOneAsync = (...args: PartialArray<TArgs>) => Jobs.findOneAsync(this.name, ...args);
}

// create an array type which doesn't require all elements of the original type
// https://stackoverflow.com/a/73939891/9614402
type PartialArray<T extends ReadonlyArray<unknown>> =
    T extends readonly [...infer Head, any]
        ? PartialArray<Head> | T
        : T;

