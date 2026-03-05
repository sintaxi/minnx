
/**
 * Module dependencies.
 */

var exec = require('child_process').exec;
var path = require('path');
var join = path.join;

/**
 * Expose `Process`.
 */

module.exports = Process;

/**
 * Initialize a `Process` of `name` with `cmd`.
 *
 * @param {String} name
 * @param {String} cmd
 * @api public
 */

function Process(group, name, cmd) {
  var conf = group.conf;
  this.cmd = cmd;
  this.name = name;
  this.group = group;
  this.session = group.session;
  this.sleep = conf.sleep || '1';
  this.attempts = conf.attempts || '0';
  this.onerror = conf['on-error'];
  this.onrestart = conf['on-restart'];
  this.logfile = path.resolve(join(conf.logs, name + '.log'));
  this.statsfile = path.resolve(join('stats', name + '.json'));
  this.extensionPath = path.resolve(join(__dirname, '..', 'extensions', 'stats.ts'));

  // load tmux state
  var info = group.windowInfo[name];
  if (info) {
    this.pid = info.pid;
    this._dead = info.dead;
    this._startTime = info.startTime;
  }
}

/**
 * Return stats from the stats file.
 *
 * @return {Object} { cost, tokens } or null
 * @api public
 */

Process.prototype.stats = function(){
  try {
    var data = require('fs').readFileSync(this.statsfile, 'utf8');
    return JSON.parse(data);
  } catch (e) {
    return null;
  }
};

/**
 * Return start time.
 *
 * @return {Number}
 * @api public
 */

Process.prototype.mtime = function(){
  return this._startTime || 0;
};

/**
 * Return the state:
 *
 *  - standby
 *  - dead
 *  - alive
 *
 * @return {String}
 * @api public
 */

Process.prototype.state = function(){
  if (!this.pid) return 'standby';
  if (this._dead) return 'dead';
  return 'alive';
};

/**
 * Check if the process is alive.
 *
 * @return {Boolean}
 * @api public
 */

Process.prototype.alive = function(){
  return this.state() === 'alive';
};

/**
 * Start the process in a tmux window.
 *
 * @param {Function} fn
 * @api public
 */

Process.prototype.start = function(fn){
  var self = this;
  var cmd = this.wrapCommand();
  var cwd = process.cwd();

  this.hasSession(function(exists) {
    var tmuxCmd;
    if (!exists) {
      tmuxCmd = 'tmux new-session -d'
        + ' -s ' + shellQuote(self.session)
        + ' -n ' + shellQuote(self.name)
        + ' -c ' + shellQuote(cwd)
        + ' ' + shellQuote(cmd);
    } else {
      tmuxCmd = 'tmux new-window'
        + ' -t ' + shellQuote(self.session)
        + ' -n ' + shellQuote(self.name)
        + ' -c ' + shellQuote(cwd)
        + ' ' + shellQuote(cmd);
    }

    exec(tmuxCmd, function(err) {
      if (err) return fn(err);

      // pipe pane output to log file
      var target = self.session + ':' + self.name;
      var pipeCmd = 'tmux pipe-pane -t ' + shellQuote(target)
        + ' ' + shellQuote('cat >> ' + self.logfile);

      exec(pipeCmd, function(err) {
        if (err) return fn(err);
        self.refreshState();
        fn();
      });
    });
  });
};

/**
 * Stop the process by killing its tmux window.
 *
 * @param {String} sig
 * @param {Function} fn
 * @api public
 */

Process.prototype.stop = function(sig, fn){
  var target = this.session + ':' + this.name;
  exec('tmux kill-window -t ' + shellQuote(target), function(err) {
    fn();
  });
};

/**
 * Check if the tmux session exists.
 *
 * @param {Function} fn
 * @api private
 */

Process.prototype.hasSession = function(fn){
  exec('tmux has-session -t ' + shellQuote(this.session) + ' 2>/dev/null', function(err) {
    fn(!err);
  });
};

/**
 * Refresh state from tmux after starting.
 *
 * @api private
 */

Process.prototype.refreshState = function(){
  try {
    var target = this.session + ':' + this.name;
    var execSync = require('child_process').execSync;
    var output = execSync(
      'tmux list-panes -t ' + shellQuote(target)
        + ' -F "#{pane_pid}|#{pane_dead}"',
      { encoding: 'utf8', stdio: ['pipe', 'pipe', 'pipe'] }
    );
    var parts = output.trim().split('|');
    this.pid = parseInt(parts[0], 10);
    this._dead = parts[1] === '1';
    this._startTime = getProcessStartTime(this.pid);
  } catch (e) {
    // window might not be ready yet
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
    var execSync = require('child_process').execSync;
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
 * Build the shell command with restart wrapper.
 *
 * @return {String}
 * @api private
 */

Process.prototype.wrapCommand = function(){
  var parts = [];

  parts.push('export MINNX_PROC_NAME=' + shellQuote(this.name));

  if (this.attempts !== '0') {
    parts.push('_n=0');
  }

  parts.push('while true; do');
  parts.push(this.injectExtension(this.cmd));
  parts.push('_rc=$?');
  parts.push('[ $_rc -eq 0 ] && break');

  if (this.onerror) {
    parts.push(this.onerror + ' ' + this.name);
  }

  if (this.attempts !== '0') {
    parts.push('_n=$((_n+1))');
    parts.push('[ $_n -ge ' + this.attempts + ' ] && break');
  }

  if (this.onrestart) {
    parts.push(this.onrestart + ' ' + this.name);
  }

  parts.push('sleep ' + this.sleep);
  parts.push('done');

  return parts.join('; ');
};

/**
 * Inject the stats extension into a pi command.
 * If the command doesn't invoke pi, return it unchanged.
 *
 * @param {String} cmd
 * @return {String}
 * @api private
 */

Process.prototype.injectExtension = function(cmd){
  // match "pi" as a standalone command (possibly after && or ;)
  return cmd.replace(/(^|&&\s*|;\s*)pi(\s)/g, '$1pi -e ' + shellQuote(this.extensionPath) + '$2');
};

/**
 * Shell-quote a string.
 *
 * @param {String} str
 * @return {String}
 * @api private
 */

function shellQuote(str) {
  return "'" + str.replace(/'/g, "'\\''") + "'";
}
