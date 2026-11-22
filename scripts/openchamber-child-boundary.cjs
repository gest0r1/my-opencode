'use strict';
/** Restrict every Node child process launched by root OpenChamber to opencode.
 * Runs as a trusted, root-owned preload before ESM imports are evaluated.
 * Native node-pty is independently isolated in root-execution-boundary.js.
 */
const os = require('node:os');
const child = require('node:child_process');
const Module = require('node:module');

if (typeof process.getuid === 'function' && process.getuid() === 0) {
  if (process.env.OPENCHAMBER_ROOT_MODE !== 'separated') {
    throw new Error('ROOT_CHILD_EXECUTION_FORBIDDEN: unisolated root OpenChamber');
  }
  const uid = Number(process.env.OPENCHAMBER_EXECUTION_UID);
  const gid = Number(process.env.OPENCHAMBER_EXECUTION_GID);
  if (!Number.isSafeInteger(uid) || uid < 1 || !Number.isSafeInteger(gid) || gid < 1) {
    throw new Error('ROOT_CHILD_EXECUTION_FORBIDDEN: missing opencode UID/GID');
  }
  const envClean = (source) => {
    // Preserve explicit project variables except service auth; root HOME must
    // never be inherited by an untrusted process.
    const out = { ...source };
    for (const key of Object.keys(out)) {
      if (/^(OPENCODE_PASSWORD|OPENCODE_SERVER_PASSWORD|OPENCHAMBER_UI_PASSWORD|OPENCHAMBER_DATA_DIR|OPENCODE_JWT_SECRET|GH_TOKEN|GITHUB_TOKEN|NODE_OPTIONS|OPENCHAMBER_ROOT_MODE|OPENCHAMBER_EXECUTION_UID|OPENCHAMBER_EXECUTION_GID|OPENCHAMBER_APPROVAL_[A-Z_]+)$/.test(key)) delete out[key];
    }
    out.HOME = '/home/opencode';
    out.USER = 'opencode';
    out.LOGNAME = 'opencode';
    out.XDG_CONFIG_HOME = '/home/opencode/.config';
    out.XDG_DATA_HOME = '/home/opencode/.local/share';
    out.XDG_STATE_HOME = '/home/opencode/.local/state';
    out.PATH = '/home/opencode/.local/bin:/home/opencode/.opencode/bin:/home/opencode/.bun/bin:/usr/local/bin:/usr/bin:/bin';
    return out;
  };
  function optionsOf(options) {
    if (options && typeof options === 'object') {
      // Explicit uid/gid from a dynamic plugin must not override the boundary.
      return { ...options, uid, gid, env: envClean(options.env || process.env) };
    }
    return { uid, gid, env: envClean(process.env) };
  }
  // Normalize every overload before applying the identity. All executable
  // child_process entrypoints must be protected, including sync and callbacks.
  const spawn = child.spawn.bind(child);
  const spawnSync = child.spawnSync.bind(child);
  const fork = child.fork.bind(child);
  const exec = child.exec.bind(child);
  const execFile = child.execFile.bind(child);
  const execSync = child.execSync.bind(child);
  const execFileSync = child.execFileSync.bind(child);
  const launch = (original, file, args, options) => {
    if (!Array.isArray(args)) { options = args; args = []; }
    return original(file, args, optionsOf(options));
  };
  child.spawn = (file, args, options) => launch(spawn, file, args, options);
  child.spawnSync = (file, args, options) => launch(spawnSync, file, args, options);
  child.fork = (file, args, options) => launch(fork, file, args, options);
  child.execSync = (command, options) => execSync(command, optionsOf(options));
  child.execFileSync = (file, args, options) => launch(execFileSync, file, args, options);
  child.exec = function (command, options, callback) {
    if (typeof options === 'function') { callback = options; options = undefined; }
    return exec(command, optionsOf(options), callback);
  };
  child.execFile = function (file, args, options, callback) {
    if (typeof args === 'function') { callback = args; args = []; options = undefined; }
    else if (!Array.isArray(args)) { callback = typeof options === 'function' ? options : callback; options = args; args = []; }
    else if (typeof options === 'function') { callback = options; options = undefined; }
    return execFile(file, args, optionsOf(options), callback);
  };
  Module.syncBuiltinESMExports();
  process.env.OPENCHAMBER_CHILD_BOUNDARY_ACTIVE = '1';
}