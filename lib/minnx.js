
/**
 * Module dependencies.
 */

var Group = require('./group');

/**
 * Expose `Group`.
 */

exports = module.exports = Group;

/**
 * Parse configuration `str`.
 *
 * @param {String} str
 * @return {Object}
 * @api public
 */

exports.parseConfig = function(str){
  var conf = {};
  conf.processes = {};

  str.split(/\r?\n/).forEach(function(line){
    if ('' == line.trim()) return;
    if (/^ *#/.test(line)) return;

    var i = line.indexOf('=');

    // bare path — pi agent
    if (i === -1) {
      var dir = line.trim();
      var name = dir.replace(/\//g, '-');
      conf.processes[name] = { cmd: 'pi --no-session', dir: dir };
      return;
    }

    var key = line.slice(0, i).trim();
    var val = line.slice(i + 1).trim();

    switch (key) {
      case 'logs':
      case 'on-error':
      case 'on-restart':
      case 'sleep':
      case 'attempts':
      case 'prefix':
        conf[key] = val;
        break;
      default:
        conf.processes[key] = { cmd: val, dir: null };
    }
  });

  return conf;
};
