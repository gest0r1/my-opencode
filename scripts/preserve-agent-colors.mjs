#!/usr/bin/env node
// Keep the colour a user picked for a managed agent across reinstalls.
// OpenChamber saves an agent's colour as `color:` in that agent's Markdown file,
// and every install replaces the managed files, so the choice would be lost.
//   collect SOURCE TARGET OUT  record `color:` of the installed copies of managed agents
//   apply TARGET IN            write those colours into the freshly installed files
import fs from 'node:fs';
import path from 'node:path';

const FRONTMATTER = /^---\r?\n([\s\S]*?)\r?\n---/;
const HEX = /^#[0-9a-fA-F]{6}$/;

function walk(root) {
  if (!fs.existsSync(root)) return [];
  return fs.readdirSync(root, { withFileTypes: true }).flatMap((entry) => {
    const file = path.join(root, entry.name);
    if (entry.isDirectory()) return walk(file);
    return entry.isFile() && entry.name.endsWith('.md') ? [file] : [];
  });
}
function field(text, key) {
  const front = FRONTMATTER.exec(text)?.[1] ?? '';
  // A colour value starts with '#', so only a '#' after whitespace opens a comment.
  const value = new RegExp(`^${key}:\\s*["']?([^\\r\\n"']*?)["']?\\s*(?:\\s#.*)?$`, 'm').exec(front)?.[1]?.trim();
  return value || '';
}
function identity(file, text) {
  return (field(text, 'name') || path.basename(file, '.md')).toLowerCase();
}

const [command, ...args] = process.argv.slice(2);
if (command === 'collect') {
  const [source, target, out] = args;
  if (!source || !target || !out) throw new Error('usage: preserve-agent-colors.mjs collect SOURCE TARGET OUT');
  const managed = new Map(walk(source).map((file) => {
    const text = fs.readFileSync(file, 'utf8');
    return [identity(file, text), field(text, 'color')];
  }));
  const colors = {};
  for (const file of walk(target)) {
    if (fs.lstatSync(file).isSymbolicLink()) continue;
    const text = fs.readFileSync(file, 'utf8');
    const id = identity(file, text);
    const color = field(text, 'color');
    // Only a valid colour that differs from the distribution's own is a user choice.
    if (managed.has(id) && HEX.test(color) && color.toLowerCase() !== managed.get(id).toLowerCase()) colors[id] = color;
  }
  fs.writeFileSync(out, `${JSON.stringify(colors, null, 2)}\n`);
} else if (command === 'apply') {
  const [target, input] = args;
  if (!target || !input) throw new Error('usage: preserve-agent-colors.mjs apply TARGET IN');
  const colors = JSON.parse(fs.readFileSync(input, 'utf8'));
  let applied = 0;
  for (const file of walk(target)) {
    const text = fs.readFileSync(file, 'utf8');
    const color = colors[identity(file, text)];
    const match = FRONTMATTER.exec(text);
    if (!color || !HEX.test(color) || !match) continue;
    const front = /^color:.*$/m.test(match[1])
      ? match[1].replace(/^color:.*$/m, `color: "${color}"`)
      : `${match[1]}\ncolor: "${color}"`;
    fs.writeFileSync(file, text.replace(match[1], front));
    applied++;
  }
  if (applied) console.log(`Kept ${applied} user-chosen agent colours`);
} else {
  throw new Error('usage: preserve-agent-colors.mjs collect|apply ...');
}
