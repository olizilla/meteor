var _ = require('underscore');
var Future = require('fibers/future');

var files = require('./files.js');
var release = require('./release.js');
var buildmessage = require('./buildmessage.js');
var fiberHelpers = require('./fiber-helpers.js');
var runLog = require('./run-log.js');

var Console = require('./console.js').Console;

var Proxy = require('./run-proxy.js').Proxy;
var Selenium = require('./run-selenium.js').Selenium;
var HttpProxy = require('./run-httpproxy.js').HttpProxy;
var AppRunner = require('./run-app.js').AppRunner;
var MongoRunner = require('./run-mongo.js').MongoRunner;
var Updater = require('./run-updater.js').Updater;

// options: proxyPort, proxyHost, appPort, appHost, buildOptions,
// settingsFile, banner, program, onRunEnd, onFailure, watchForChanges,
// quiet, rootUrl, mongoUrl, oplogUrl, mobileServerUrl, disableOplog,
// appDirForVersionCheck
var Runner = function (appDir, options) {
  var self = this;
  self.appDir = appDir;

  if (! _.has(options, 'proxyPort'))
    throw new Error("no proxyPort?");

  var listenPort = options.proxyPort;
  var mongoPort = parseInt(listenPort) + 1;
  self.specifiedAppPort = options.appPort;
  self.regenerateAppPort();

  self.stopped = false;
  self.quiet = options.quiet;
  self.banner = options.banner || files.prettyPath(self.appDir);
  if (options.rootUrl) {
    self.rootUrl = options.rootUrl;
  } else if (options.proxyHost) {
    self.rootUrl = 'http://' + options.proxyHost + ':' + listenPort + '/';
  } else {
    self.rootUrl = 'http://localhost:' + listenPort + '/';
  }

  self.extraRunners = options.extraRunners;

  self.proxy = new Proxy({
    listenPort: listenPort,
    listenHost: options.proxyHost,
    proxyToPort: self.appPort,
    proxyToHost: options.appHost,
    onFailure: options.onFailure
  });

  self.httpProxy = null;
  if (options.httpProxyPort) {
    self.httpProxy = new HttpProxy({
      listenPort: options.httpProxyPort
    });
  }

  self.mongoRunner = null;
  var mongoUrl, oplogUrl;
  if (options.mongoUrl) {
    mongoUrl = options.mongoUrl;
    oplogUrl = options.disableOplog ? null : options.oplogUrl;
  } else {
    self.mongoRunner = new MongoRunner({
      appDir: self.appDir,
      port: mongoPort,
      onFailure: options.onFailure,
      // For testing mongod failover, run with 3 mongod if the env var is
      // set. Note that data is not preserved from one run to the next.
      multiple: !!process.env.METEOR_TEST_MULTIPLE_MONGOD_REPLSET
    });

    mongoUrl = self.mongoRunner.mongoUrl();
    oplogUrl = options.disableOplog ? null : self.mongoRunner.oplogUrl();
  }

  self.updater = new Updater;

  self.appRunner = new AppRunner(appDir, {
    appDirForVersionCheck: options.appDirForVersionCheck,
    port: self.appPort,
    listenHost: options.appHost,
    mongoUrl: mongoUrl,
    oplogUrl: oplogUrl,
    mobileServerUrl: options.mobileServerUrl,
    buildOptions: options.buildOptions,
    rootUrl: self.rootUrl,
    settingsFile: options.settingsFile,
    program: options.program,
    debugPort: options.debugPort,
    proxy: self.proxy,
    onRunEnd: options.onRunEnd,
    watchForChanges: options.watchForChanges,
    noRestartBanner: self.quiet,
    recordPackageUsage: options.recordPackageUsage
  });

  self.selenium = null;
  if (options.selenium) {
    self.selenium = new Selenium({
      runner: self,
      browser: options.seleniumBrowser
    });
  }
};

_.extend(Runner.prototype, {
  // XXX leave a pidfile and check if we are already running
  start: function () {
    var self = this;

    // XXX: Include all runners, and merge parallel-launch patch
    var allRunners = [ ] ;
    allRunners = allRunners.concat(self.extraRunners);
    _.each(allRunners, function (runner) {
      if (!runner) return;
      runner.prestart && runner.prestart();
    });

    self.proxy.start();

    // print the banner only once we've successfully bound the port
    if (! self.quiet && ! self.stopped) {
      runLog.log("[[[[[ " + self.banner + " ]]]]]\n");
      runLog.log("=> Started proxy.");
    }

    if (! self.stopped) {
      self.updater.start();
    }

    // print the banner only once we've successfully bound the port
    if (! self.stopped && self.httpProxy) {
      self.httpProxy.start();
      if (! self.quiet) {
        runLog.log("=> Started http proxy.");
      }
    }

    if (! self.stopped && self.mongoRunner) {
      buildmessage.enterJob({ title: 'Starting MongoDB' }, function () {
        self.mongoRunner.start();
      });

      if (! self.quiet) {
        if (! self.stopped)
          runLog.log("=> Started MongoDB.");
      }
    }

    _.forEach(self.extraRunners, function (extraRunner) {
      if (! self.stopped) {
        var title = extraRunner.title;
        buildmessage.enterJob({ title: "Starting " + title }, function () {
          extraRunner.start();
        });
        if (! self.quiet && ! self.stopped)
          runLog.log("=> Started " + title + ".");
      }
    });

    if (! self.stopped) {
      buildmessage.enterJob({ title: "Starting your app" }, function () {
        self.appRunner.start();
      });
      if (! self.quiet && ! self.stopped)
        runLog.log("=> Started your app.");
    }

    if (! self.stopped && ! self.quiet)
      runLog.log("\n=> App running at: " + self.rootUrl);

    if (self.selenium && ! self.stopped) {
      buildmessage.enterJob({ title: "Starting Selenium" }, function () {
        self.selenium.start();
      });
      if (! self.quiet && ! self.stopped)
        runLog.log("=> Started Selenium.");
    }

    // XXX It'd be nice to (cosmetically) handle failure better. Right
    // now we overwrite the "starting foo..." message with the
    // error. It'd be better to overwrite it with "failed to start
    // foo" and then print the error.
  },

  // Idempotent
  stop: function () {
    var self = this;
    if (self.stopped)
      return;

    self.stopped = true;
    self.proxy.stop();
    self.httpProxy && self.httpProxy.stop();
    self.updater.stop();
    self.mongoRunner && self.mongoRunner.stop();
    _.forEach(self.extraRunners, function (extraRunner) {
      extraRunner.stop();
    });
    self.appRunner.stop();
    self.selenium && self.selenium.stop();
    // XXX does calling this 'finish' still make sense now that runLog is a
    // singleton?
    runLog.finish();
  },

  // Call this whenever you want to regenerate the app's port (if it is not
  // explicitly specified by the user).
  //
  // Rationale: if we randomly chose a port that's in use and the app failed to
  // listen on it, we should try a different port when we restart the app!
  regenerateAppPort: function () {
    var self = this;
    if (self.specifiedAppPort) {
      self.appPort = self.specifiedAppPort;
    } else {
      self.appPort = require('./utils.js').randomPort();
    }
    if (self.proxy)
      self.proxy.proxyToPort = self.appPort;
    if (self.appRunner)
      self.appRunner.port = self.appPort;
  }
});

// Run the app and all of its associated processes. Runs (and does not
// return) until an unrecoverable failure happens. Logs to
// stdout. Returns a suggested exit code.
//
// If 'once' is set, run the app process exactly once and pass through
// its exit code. Return an exit code of 255 if the app process was
// killed by a signal and 254 if the app process could not start
// (build failure, invalid program name, database couldn't start, and
// so on).
//
// If the 'once' option is not set, the default, restart the app
// process if it crashes or if source files change. (Non-app
// processes, such as the database, are always restarted as
// necessary.) The function will only return if there is an
// unrecoverable error, which generally means an error that could not
// be fixed by source code changes (such as the database refusing to
// run), but also currently includes Meteor version mismatches. So the
// exit code will always be 254 because in all other cases we'll
// persevere.
//
// Options:
//
// - proxyPort: the port to connect to to access the application (we will
//   run a proxy here that proxies to the actual app process). required
// - buildOptions: 'buildOptions' argument to bundler.bundle()
// - settingsFile: path to file containing deploy-time settings
// - program: the program in the app bundle to run
// - once: see above
// - banner: replace the application path that is normally printed on
//   startup with an arbitrary string (eg, 'Tests')
// - rootUrl: tell the app that traffic at this URL will be routed to
//   it at '/' (used by the app to construct absolute URLs)
// - disableOplog: don't use oplog tailing
// - mongoUrl: don't start a mongo process; instead use the mongo at
//   this mongo URL
// - oplogUrl: URL of the mongo oplog to use. if mongoUrl isn't
//   set (we're starting a mongo) a default will be provided, but can
//   be overridden. if mongoUrl is set, you must set this or you don't
//   get oplog tailing.
// - appDirForVersionCheck: when checking whether we're running the
//   right release of Meteor, check against this app rather than
//   appDir. Useful when you have autogenerated a test harness app
//   based on some other app.
// - recordPackageUsage: (default true) if set to false, don't send
//   information about packages used by this app to the package stats
//   server.
exports.run = function (appDir, options) {
  var runOptions = _.clone(options);
  var once = runOptions.once;
  delete runOptions.once;

  var fut = new Future;

  _.extend(runOptions, {
    onFailure: function () {
      // Ensure that runner stops now. You might think this is unnecessary
      // because the runner is stopped immediately after `fut.wait()`, but if
      // the failure happens while runner.start() is still running, we want the
      // rest of start to stop, and it's not like fut['return'] magically makes
      // us jump to a fut.wait() that hasn't happened yet!.
      runner.stop();
      fut.isResolved() || fut['return']({ outcome: 'failure' });
    },
    onRunEnd: function (result) {
      if (once ||
          result.outcome === "conflicting-versions" ||
          result.outcome === "wrong-release" ||
          result.outcome === "outdated-cordova-platforms" ||
          result.outcome === "outdated-cordova-plugins" ||
          (result.outcome === "terminated" &&
           result.signal === undefined && result.code === undefined)) {
        // Allow run() to continue (and call runner.stop()) only once the
        // AppRunner has processed our "return false"; otherwise we deadlock.
        process.nextTick(function () {
          fut.isResolved() || fut['return'](result);
        });
        return false;  // stop restarting
      }
      runner.regenerateAppPort();
      return true;  // restart it
    },
    watchForChanges: ! once,
    quiet: once
  });

  var runner = new Runner(appDir, runOptions);
  runner.start();
  var result = fut.wait();
  runner.stop();

  if (result.outcome === "conflicting-versions") {
    process.stderr.write(
"The constraint solver could not find a set of package versions to use that would\n" +
"satisfy the constraints of .meteor/versions and .meteor/packages. This could be\n" +
"caused by conflicts in .meteor/versions, conflicts in .meteor/packages, and/or\n" +
"inconsistent changes to the dependencies in local packages.");
    return 254;
  }

  if (result.outcome === "outdated-cordova-plugins") {
    process.stderr.write(
"Your app's Cordova plugins have changed.\n" +
"Restart meteor to use the new set of plugins.\n");
    return 254;
  }

  if (result.outcome === "outdated-cordova-platforms") {
    process.stderr.write(
"Your app's platforms have changed.\n" +
"Restart meteor to use the new set of platforms.\n");
    return 254;
  }

  if (result.outcome === "wrong-release") {
    if (once)
      // We lost a race where the user ran 'meteor update' and 'meteor
      // run --once' simultaneously.
      throw new Error("wrong release?");

    // If the user did not specify a --release on the command line,
    // and simultaneously runs `meteor update` during this run, just
    // exit and let them restart the run. (We can do something fancy
    // like allowing this to work if the tools version didn't change,
    // or even springboarding if the tools version does change, but
    // this (which prevents weird errors) is a start.)
    var utils = require('./utils.js');
    var trackAndVersion = utils.splitReleaseName(result.releaseNeeded);
    var to = utils.displayRelease(
        trackAndVersion[0], trackAndVersion[1]);

    var from = release.current.getDisplayName();
    process.stderr.write(
"Your app has been updated to " + to + " from " + from +
".\n" +
"Restart meteor to use the new release.\n");
    return 254;
  }

  if (result.outcome === "failure" ||
      (result.outcome === "terminated" &&
       result.signal === undefined && result.code === undefined)) {
    // Fatal problem with something other than the app process. An
    // explanation should already have been logged.
    return 254;
  }

  if (once && result.outcome === "bundle-fail") {
    process.stderr.write("=> Build failed:\n\n" +
                         result.bundleResult.errors.formatMessages() + "\n");
    return 254;
  }

  if (once && result.outcome === "terminated") {
    if (result.signal) {
      process.stderr.write("Killed (" + result.signal + ")\n");
      return 255;
    } else if (typeof result.code === "number") {
      // We used to print 'Your application is exiting' here, but that
      // seems unnecessarily chatty? once mode is otherwise silent
      return result.code;
    } else {
      // If there is neither a code nor a signal, it means that we
      // failed to start the process. We logged the reason. Probably a
      // bad program name.
      return 254;
    }
  }

  throw new Error("unexpected outcome " + result.outcome);
};
