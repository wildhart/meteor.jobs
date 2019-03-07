Package.describe({
  name: 'wildhart:jobs',
<<<<<<< HEAD
  version: '1.0.0',
=======
  version: '0.0.3',
>>>>>>> dd298e4e45c6ea3ddafc8c9b18c9cca06b6f8d84
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
