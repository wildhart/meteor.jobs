import { Jobs, JobOrId } from "./jobs";

export default class TypedJob<TArgs extends any[]> {
	constructor(public name: string, methodFn: Jobs.JobFunction<TArgs>) {
		Jobs.register({[name]: methodFn});
	}

	public withArgs(...args: TArgs) {
		return {
			run: (config?: Partial<Jobs.JobConfig>) => Jobs.run(this.name, ...args, config),
		}
	}

	public clear = (state: '*' | Jobs.JobStatus | Jobs.JobStatus[], ...args: PartialArray<TArgs>) => Jobs.clear(state, this.name, ...args);

	public clearQuery = (query: Mongo.Selector<Jobs.JobDocument>) => Jobs.collection.remove({...query, name: this.name});

	public remove = (jobOrId: JobOrId) => Jobs.remove(jobOrId);

	public execute = (jobOrId: JobOrId) => Jobs.execute(jobOrId);

	public reschedule = (jobOrId: JobOrId, config: Partial<Jobs.JobConfig>) => Jobs.reschedule(jobOrId, config);

	public replicate = (jobOrId: JobOrId, config: Partial<Jobs.JobConfig>) => Jobs.replicate(jobOrId, config);

	public start = () => Jobs.start(this.name);

	public stop = () => Jobs.stop(this.name);

	public count = (...args: PartialArray<TArgs>) => Jobs.count(this.name, ...args);

	public update: Mongo.Collection<Jobs.JobDocument>['update'] = (selector, options) => {
		const mySelector = typeof selector == 'string' ? selector : {...selector, name: this.name};
		return Jobs.collection.update(mySelector, options);
	}

	public findOne = (...args: PartialArray<TArgs>) => Jobs.findOne(this.name, ...args);
}

// create an array type which doesn't require all elements of the original type
// https://stackoverflow.com/a/73939891/9614402
type PartialArray<T extends ReadonlyArray<unknown>> =
    T extends readonly [...infer Head, any]
        ? PartialArray<Head> | T
        : T;

