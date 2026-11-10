import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFileSync } from 'node:child_process';
import { parseConfig } from './merge-user-plugins.mjs';

const root = fileURLToPath(new URL('../', import.meta.url));
const read = name => fs.readFileSync(path.join(root, name), 'utf8');
const version = JSON.parse(read('config/opencode/package.json')).dependencies['@opencode/plugin'];
if (!/^2\.\d+\.\d+$/.test(version)) throw Error('OpenCode plugin must use an exact v2 pin');
for (const file of ['install.sh', 'install-openchamber.sh', 'scripts/install-opencode-generation.sh', 'scripts/install-openchamber-v2-core.sh']) {
  const found = read(file).match(/OPENCODE_(?:INSTALL_)?VERSION="\$\{OPENCODE_INSTALL_VERSION:-(2\.\d+\.\d+)\}"/);
  if (found?.[1] !== version) throw Error(`${file}: OpenCode default differs from ${version}`);
}
// OpenChamber RU: install-openchamber.sh is the single source; every other default and the README follow it.
const openchamber = read('install-openchamber.sh').match(/OPENCHAMBER_EXPECTED_VERSION="\$\{OPENCHAMBER_EXPECTED_VERSION:-(\d+\.\d+\.\d+)\}"/)?.[1];
if (!openchamber) throw Error('install-openchamber.sh: OpenChamber pin missing');
/* TEMPORARY LEGACY RUN COMPATIBILITY (#18), REMOVE ON NEXT UPSTREAM UPDATE.
 * No upstream OpenCode/OpenChamber version bump may ship with the one-off
 * SeVami v0.6.7 frozen RUN exemption still installed. Removing the exemption
 * and its test is part of the upstream version-bump acceptance contract.
 */
const legacyCompat = 'config/opencode/skills/task-management/scripts/legacy-live-preflight-v067.mjs';
if (fs.existsSync(path.join(root, legacyCompat)) &&
    (version !== '2.2.5' || openchamber !== '2.6.1')) {
  throw Error('TEMPORARY_COMPAT_REMOVAL_REQUIRED: remove legacy-live-preflight-v067.mjs + import/test/doc before the next upstream OpenCode/OpenChamber update');
}

if (read('scripts/install-openchamber-v2-core.sh').match(/EXPECTED_OPENCHAMBER_VERSION="\$\{OPENCHAMBER_EXPECTED_VERSION:-(\d+\.\d+\.\d+)\}"/)?.[1] !== openchamber) {
  throw Error(`scripts/install-openchamber-v2-core.sh: OpenChamber default differs from ${openchamber}`);
}
const readme = read('README.md');
for (const [label, pinned] of [['OpenCode', version], ['OpenChamber', openchamber]]) {
  const stale = [...readme.matchAll(new RegExp(`${label}(?: RU)?:? \`?(\\d+\\.\\d+\\.\\d+)`, 'g'))].filter(match => match[1] !== pinned);
  if (stale.length) throw Error(`README.md: ${label} ${stale[0][1]} differs from ${pinned}`);
}
const lock = parseConfig(read('config/opencode/bun.lock'));
if (lock.workspaces[''].dependencies['@opencode/plugin'] !== version) throw Error('Plugin lock workspace differs from manifest');
for (const name of ['plugin', 'client', 'protocol', 'schema']) {
  if (lock.packages[`@opencode/${name}`]?.[0] !== `@opencode/${name}@${version}`) throw Error(`Locked @opencode/${name} differs from ${version}`);
}
if (process.argv[2] === '--openchamber') {
  if (!process.argv[3]) throw Error('--openchamber requires the other checkout path');
  execFileSync(process.execPath, [path.resolve(process.argv[3], 'scripts/check-opencode-pins.mjs'), '--expected', version], { stdio: 'inherit', timeout: 10000 });
} else if (process.argv.length > 2) throw Error('Usage: node scripts/check-opencode-pins.mjs [--openchamber PATH]');
console.log(`PASS: distribution OpenCode pins ${version}, OpenChamber ${openchamber}`);
