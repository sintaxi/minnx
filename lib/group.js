
/**
 * Module dependencies.
 */

var Emitter = require('events').EventEmitter;
var execSync = require('child_process').execSync;
var Process = require('./process');

/**
 * Expose `Group`.
 */

module.exports = Group;

/**
 * Initialize a `Group` with the given `conf`.
 *
 * @param {Object} conf
 * @api public
 */

function Group(conf) {
  this.conf = conf;
  this.session = conf.session || 'minnx';
  this.windowInfo = this.queryWindows();
  this.procs = this.processes();
}

/**
 * Inherit from `Emitter.prototype`.
 */

Object.setPrototypeOf(Group.prototype, Emitter.prototype);

/**
 * Query tmux for window info.
 *
 * @return {Object}
 * @api private
 */

Group.prototype.queryWindows = function(){
  try {
    var output = execSync(
      'tmux list-windows -t ' + this.session
        + ' -F "#{window_name}|#{pane_pid}|#{pane_dead}"',
      { encoding: 'utf8', stdio: ['pipe', 'pipe', 'pipe'] }
    );
    var info = {};
    output.trim().split('\n').forEach(function(line) {
      if (!line) return;
      var parts = line.split('|');
      var pid = parseInt(parts[1], 10);
      info[parts[0]] = {
        pid: pid,
        dead: parts[2] === '1',
        startTime: getProcessStartTime(pid)
      };
    });
    return info;
  } catch (e) {
    return {};
  }
};

/**
 * Get process start time from `ps`.
 *
 * @param {Number} pid
 * @return {Number} epoch ms or 0
 * @api private
 */

function getProcessStartTime(pid) {
  try {
    var output = execSync(
      'ps -o lstart= -p ' + pid,
      { encoding: 'utf8', stdio: ['pipe', 'pipe', 'pipe'] }
    );
    return new Date(output.trim()).getTime();
  } catch (e) {
    return 0;
  }
}

/**
 * Return hydrated `Process`es.
 *
 * @return {Array}
 * @api private
 */

Group.prototype.processes = function(){
  var self = this;
  var procs = this.conf.processes;
  return Object.keys(procs).map(function(key){
    return new Process(self, key, procs[key]);
  });
};

/**
 * Return procs filtered by `names`.
 *
 * @param {Array} names
 * @return {Array}
 * @api private
 */

Group.prototype.find = function(names){
  if (!names.length) return this.procs;
  return this.procs.filter(function(proc) {
    return names.indexOf(proc.name) !== -1;
  });
};

/**
 * Start process `names` and invoke `fn(err)`.
 * Starts sequentially to avoid tmux session race.
 *
 * @param {Array} names
 * @param {Function} fn
 * @api public
 */

Group.prototype.start = function(names, fn){
  var self = this;
  var procs = this.find(names);
  var toStart = [];

  procs.forEach(function(proc) {
    if (proc.alive()) {
      self.emit('running', proc);
    } else {
      toStart.push(proc);
    }
  });

  function next(i) {
    if (i >= toStart.length) return fn(null);
    var proc = toStart[i];
    proc.start(function(err) {
      if (err) return fn(err);
      self.emit('start', proc);
      next(i + 1);
    });
  }

  next(0);
};

/**
 * Stop process `names` and invoke `fn(err)`.
 *
 * @param {Array} names
 * @param {String} sig
 * @param {Function} fn
 * @api public
 */

Group.prototype.stop = function(names, sig, fn){
  var self = this;
  var procs = this.find(names);
  var toStop = [];

  procs.forEach(function(proc) {
    if (proc.alive()) {
      toStop.push(proc);
    }
  });

  function next(i) {
    if (i >= toStop.length) return fn(null);
    var proc = toStop[i];
    self.emit('stopping', proc);
    proc.stop(sig, function(err) {
      if (err) return fn(err);
      self.emit('stop', proc);
      next(i + 1);
    });
  }

  next(0);
};
