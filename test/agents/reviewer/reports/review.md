# Code Review Report

**Date:** March 4, 2026  
**Reviewer:** Code Review Agent  
**Files Reviewed:**
- `lib/minnx.js`
- `lib/group.js`
- `lib/process.js`

---

## lib/minnx.js

### Issues

1. **No validation on malformed config lines (Medium)**  
   `parseConfig()` does not handle lines without an `=` sign. When `indexOf('=')` returns `-1`, `line.slice(0, -1)` and `line.slice(0)` produce unexpected key/value pairs instead of erroring or skipping.
   ```js
   var i = line.indexOf('=');
   // if i === -1, key = line.slice(0, -1) — drops last char
   ```

2. **No validation of required fields (Low)**  
   The returned `conf` object does not guarantee that `logs` or `processes` are populated. Downstream code (`process.js`) calls `path.resolve(join(conf.logs, ...))` which will throw if `conf.logs` is `undefined`.

3. **Style: loose equality (Minor)**  
   `'' == line.trim()` uses loose equality. Prefer `=== ''`.

---

## lib/group.js

### Issues

1. **No validation of `conf.processes` (Medium)**  
   `Group.processes()` calls `Object.keys(procs)` where `procs = this.conf.processes`. If the config has no processes defined, this works (empty object), but if `conf.processes` is somehow `undefined`, it will throw.

2. **`find()` does not warn on unknown process names (Low)**  
   When a user passes names that don't match any defined process, `find()` silently returns an empty array. It might be useful to emit a warning or error for unrecognized names.

3. **`stop()` ignores the `sig` parameter partially (Medium)**  
   The `sig` argument is passed to `proc.stop(sig, ...)`, but in `process.js`, `stop()` uses `tmux kill-window` which sends `SIGKILL` to all pane processes. The `sig` parameter is accepted but never actually used — the user cannot perform a graceful shutdown with a custom signal (e.g., `SIGTERM`).

4. **Error in `stop()` silently swallowed (Medium)**  
   In `process.js` `stop()`, the `err` from `tmux kill-window` is ignored — `fn()` is called regardless. This means failures to kill a window are never reported. Meanwhile `group.js` `stop()` has `if (err) return fn(err)` which would never trigger.

---

## lib/process.js

### Issues

1. **`stop()` ignores errors and the `sig` parameter (Medium — also noted above)**  
   ```js
   Process.prototype.stop = function(sig, fn){
     var target = this.session + ':' + this.name;
     exec('tmux kill-window -t ' + shellQuote(target), function(err) {
       fn(); // err is ignored
     });
   };
   ```
   The `sig` parameter is unused. Consider using `tmux send-keys` or `kill -<sig> <pid>` for graceful signals before falling back to `kill-window`.

2. **`conf.logs` may be undefined (High)**  
   ```js
   this.logfile = path.resolve(join(conf.logs, name + '.log'));
   ```
   If the config file omits the `logs` directive, `conf.logs` is `undefined`, and `path.join(undefined, ...)` throws a `TypeError`. There is no default value or validation.

3. **`refreshState()` silently swallows all errors (Low)**  
   The catch block is empty. If the tmux query fails, `pid`, `_dead`, and `_startTime` remain unset (or stale from `windowInfo`). This could lead to the process appearing alive when it isn't, or vice versa.

4. **`wrapCommand()` shell injection risk via `this.onerror` / `this.onrestart` (Medium)**  
   The `on-error` and `on-restart` config values are interpolated directly into the shell command string without quoting:
   ```js
   parts.push(this.onerror + ' ' + this.name);
   ```
   While the config is user-controlled (so not a traditional injection vector), the process `name` is not shell-quoted here, allowing names with spaces or special characters to break the command.

5. **`wrapCommand()` restart loop runs forever when `attempts` is `'0'` (by design, but fragile) (Low)**  
   When `attempts` is `'0'` (default), the loop only breaks on exit code 0. A command that always fails will restart indefinitely with no upper bound. This is likely intentional but could benefit from documentation or a maximum retry safeguard.

6. **`require` inside a function body (Minor)**  
   `refreshState()` calls `require('child_process').execSync` inside the method body. This module is already available at the top of `group.js`. Consider importing it at the top of `process.js` for consistency and slight performance improvement.

7. **`hasSession` redirects stderr in the shell string (Minor)**  
   ```js
   exec('tmux has-session -t ' + shellQuote(this.session) + ' 2>/dev/null', ...);
   ```
   The `2>/dev/null` is outside the quoted argument, which is correct, but using `exec`'s `stdio` option would be cleaner and more portable.

---

## Summary

| Severity | Count |
|----------|-------|
| High     | 1     |
| Medium   | 5     |
| Low      | 4     |
| Minor    | 3     |

**Top priority fix:** Add a default or validation for `conf.logs` to prevent a runtime `TypeError` when the `logs` directive is missing from the config file.

**General recommendations:**
- Add input validation in `parseConfig()` for malformed lines and required fields.
- Actually use the `sig` parameter in `stop()` or remove it from the API.
- Quote process names in `wrapCommand()` shell strings.
- Move the `require('child_process').execSync` to the top of `process.js`.
