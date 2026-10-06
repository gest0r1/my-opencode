import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFileSync } from 'node:child_process';
import { parseConfig } from './merge-user-plugins.mjs';

const root = fileURLToPath(new URL('../', import.meta.url));
const read = name => fs.readFileSync(path.join(root, name), 'utf8');
const version = JSON.parse(read('config/opencode/package.json')).dependencies['@opencode/plugin'];
if (!/^2\.\d+\.\d+$/.test(version)) throw Error('OpenCode plugin must use an exact v2 pin');
for (const file of ['install.sh', 'scripts/install-opencode-generation.sh', 'scripts/install-openchamber-v2-core.sh']) {
  const found = read(file).match(/OPENCODE_(?:INSTALL_)?VERSION="\$\{OPENCODE_INSTALL_VERSION:-(2\.\d+\.\d+)\}"/);
  if (found?.[1] !== version) throw Error(`${file}: OpenCode default differs from ${version}`);
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
console.log(`PASS: distribution OpenCode pins ${version}`);
