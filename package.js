Package.describe({
	name: 'wildhart:jobs',
	version: '2.2.0',
	summary: 'Schedule jobs to run at a later time, multi-server, super efficient (Meteor 3.0 compatible)',
	git: 'https://github.com/wildhart/meteor.jobs',
	documentation: 'README.md'
});

Package.onUse(function(api) {
	api.versionsFrom(['2.8.1', '3.0']);
	api.use(["typescript@3.0.0 || 4.0.0 || 5.0.0", "mongo", "random", "ecmascript", "check"], "server");
	api.mainModule("jobs.ts", "server");
	api.export(["Jobs", "TypedJob"]);
});

Package.onTest(function(api) {
	api.use(['ecmascript', 'typescript', 'mongo', 'meteortesting:mocha@3.3.0', 'wildhart:jobs'], 'server');
	api.mainModule('tests/jobs.tests.js', 'server');
	api.addFiles('tests/execute-await-completion.tests.js', 'server');
	api.addFiles('tests/custom-job-id.tests.js', 'server');
	api.addFiles('tests/retry-failed-jobs.tests.js', 'server');
	api.addFiles('tests/recover-executing-jobs.tests.js', 'server');
	api.addFiles('tests/monti.tests.js', 'server');
});
