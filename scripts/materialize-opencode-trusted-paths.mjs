#!/usr/bin/env node
// Permission matching uses command text. Add only equivalent spellings of the
// installer-owned CLI prefix, retaining the portable rules in source Markdown.
import fs from 'node:fs';
import path from 'node:path';

export function materializeTrustedPaths(text, home) {
  if (!path.isAbsolute(home) || /[\n\r"*?]/.test(home)) throw new Error('Unsafe installation home');
  const lines = text.split('\n');
  const end = lines.indexOf('---', 1);
  let action = '';
  const out = [];
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (i < end && /^  \S/.test(line)) action = /^  bash:\s*$/.test(line) ? 'bash' : '';
    out.push(line);
    if (i >= end || action !== 'bash') continue;
    const match = /^    "([^"]*\$HOME\/\.config\/opencode\/skills\/(?:task-management|context7)\/[^"]*)": (allow|deny|ask)(.*)$/.exec(line);
    if (!match) continue;
    for (const spelling of [home, '${HOME}']) {
      const resource = match[1].replaceAll('$HOME', spelling);
      const equivalent = `    ${JSON.stringify(resource)}: ${match[2]}${match[3]}`;
      if (!lines.includes(equivalent) && !out.includes(equivalent)) out.push(equivalent);
    }
  }
  return out.join('\n');
}

if (process.argv[1] === new URL(import.meta.url).pathname) {
  const [root, home] = process.argv.slice(2);
  if (!root || !home) throw new Error('Usage: materialize-opencode-trusted-paths.mjs AGENTS_DIR HOME');
  for (const file of fs.readdirSync(root).filter(x => x.endsWith('.md'))) {
    const full = path.join(root, file);
    const before = fs.readFileSync(full, 'utf8');
    const after = materializeTrustedPaths(before, home);
    if (before !== after) fs.writeFileSync(full, after);
  }
}
