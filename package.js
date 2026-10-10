Package.describe({
	name: 'wildhart:jobs-fibers',
	version: '1.2.0',
	summary: 'Schedule jobs to run later, multi-server, super efficient (sync/Fibers API for Meteor 1.3 - 2.x)',
	git: 'https://github.com/wildhart/meteor.jobs',
	documentation: 'README.md'
});

Package.onUse(function(api) {
	api.versionsFrom('1.3');
	api.use(["typescript@3.0.0 || 4.0.0", "mongo", "random", "ecmascript", "check"], "server");
	api.mainModule("jobs.ts", "server");
	api.export(["Jobs", "TypedJob"]);
});

Package.onTest(function(api) {
	api.use(['ecmascript', 'typescript', 'mongo', 'meteortesting:mocha@2.1.0', 'wildhart:jobs-fibers'], 'server');
	api.mainModule('tests/jobs.tests.js', 'server');
	api.addFiles('tests/execute-await-completion.tests.js', 'server');
	api.addFiles('tests/custom-job-id.tests.js', 'server');
	api.addFiles('tests/retry-failed-jobs.tests.js', 'server');
	api.addFiles('tests/recover-executing-jobs.tests.js', 'server');
	api.addFiles('tests/monti.tests.js', 'server');
	api.addFiles('tests/dont-run-jobs.tests.js', 'server');
});
