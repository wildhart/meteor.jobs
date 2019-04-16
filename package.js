Package.describe({
  name: 'wildhart:jobs',
  version: '1.0.3',
  summary: 'Schedule jobs to run at a later time, including multi-server, super efficient',
  git: '',
  documentation: 'README.md'
});

Package.onUse(function(api) {
    api.versionsFrom('1.3');
	api.use(["mongo", "random", "ecmascript", "check"], "server");
	api.mainModule("jobs.js", "server");
	api.export(["Jobs"]);
});
