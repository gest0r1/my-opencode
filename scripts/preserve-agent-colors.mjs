#!/usr/bin/env node
// Preserve a user's agent model, variant and colour across managed reinstalls.
// OpenChamber saves an agent's colour as `color:` in that agent's Markdown file,
// and every install replaces the managed files, so the choice would be lost.
//   collect SOURCE TARGET OUT  save the installed model/variant presence and chosen colour
//   apply TARGET IN            restore those preferences into newly staged managed files
import fs from 'node:fs';
import path from 'node:path';

const FRONTMATTER = /^---\r?\n([\s\S]*?)\r?\n---/;
const HEX = /^#[0-9a-fA-F]{6}$/;

const MODEL_KEYS = ['model', 'variant'];
function scalarLine(text, key) {
  const front = FRONTMATTER.exec(text)?.[1] ?? '';
  const line = front.split(/\r?\n/).find((line) => line.startsWith(key + ':'));
  return line && line.slice(key.length + 1).trim() ? line : null;
}
function replaceScalar(text, key, line) {
  const match = FRONTMATTER.exec(text);
  if (!match) return text;
  const lines = match[1].split(/\r?\n/).filter((item) => !item.startsWith(key + ':'));
  if (line !== null) lines.push(line);
  return text.replace(match[0], '---\n' + lines.join('\n') + '\n---');
}


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

  const preferences = {};
  // Canonical flat agents win over obsolete nested copies with the same name.
  const files = walk(target).sort((a, b) =>
    Number(path.dirname(a) !== target) - Number(path.dirname(b) !== target));
  for (const file of files) {
    if (fs.lstatSync(file).isSymbolicLink()) continue;
    const text = fs.readFileSync(file, 'utf8');
    const id = identity(file, text);
    if (!managed.has(id) || Object.hasOwn(preferences, id)) continue;
    const choice = Object.fromEntries(MODEL_KEYS.map((key) => [key, scalarLine(text, key)]));
    const color = field(text, 'color');
    if (HEX.test(color) && color.toLowerCase() !== managed.get(id).toLowerCase()) choice.color = color;
    preferences[id] = choice;
  }
  fs.writeFileSync(out, JSON.stringify(preferences, null, 2) + '\n');
} else if (command === 'apply') {
  const [target, input] = args;
  if (!target || !input) throw new Error('usage: preserve-agent-colors.mjs apply TARGET IN');
  const preferences = JSON.parse(fs.readFileSync(input, 'utf8'));
  let applied = 0;
  for (const file of walk(target)) {
    if (fs.lstatSync(file).isSymbolicLink()) continue;
    let text = fs.readFileSync(file, 'utf8');
    const choice = preferences[identity(file, text)];
    if (!choice || !FRONTMATTER.test(text)) continue;
    for (const key of MODEL_KEYS) {
      if (Object.hasOwn(choice, key)) text = replaceScalar(text, key, choice[key]);
    }
    if (HEX.test(choice.color ?? '')) text = replaceScalar(text, 'color', 'color: "' + choice.color + '"');
    fs.writeFileSync(file, text);
    applied++;
  }
  if (applied) console.log('Kept ' + applied + ' managed-agent model/variant preferences');
} else {
  throw new Error('usage: preserve-agent-colors.mjs collect|apply ...');
}
