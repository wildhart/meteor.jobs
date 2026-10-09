// Meteor 3 async APIs missing from @types/meteor (last published for Meteor 2). Editor / `npm run check` only;
// Meteor's build does not type-check, so this file has no effect on the published package.
// @types/meteor declares the global `Mongo` separately from the 'meteor/mongo' module, so augment both.

declare namespace Mongo {
	interface Cursor<T, U = T> {
		observeAsync(callbacks: Mongo.ObserveCallbacks<U>): Promise<Meteor.LiveQueryHandle>;
		observeChangesAsync(callbacks: Mongo.ObserveChangesCallbacks<T>, options?: {nonMutatingCallbacks?: boolean}): Promise<Meteor.LiveQueryHandle>;
	}
}

declare module 'meteor/mongo' {
	namespace Mongo {
		interface Cursor<T, U = T> {
			observeAsync(callbacks: Mongo.ObserveCallbacks<U>): Promise<Meteor.LiveQueryHandle>;
			observeChangesAsync(callbacks: Mongo.ObserveChangesCallbacks<T>, options?: {nonMutatingCallbacks?: boolean}): Promise<Meteor.LiveQueryHandle>;
		}
	}
}
