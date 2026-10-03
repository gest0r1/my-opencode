#!/usr/bin/env node
// Run only against the candidate tree, before atomic activation.
import fs from 'node:fs';
import path from 'node:path';
const [source, target] = process.argv.slice(2);
if (!source || !target) throw new Error('Usage: retire-opencode-agent-copies.mjs SOURCE TARGET');
function walk(root) {
  return fs.readdirSync(root, {withFileTypes:true}).flatMap(e => {
    const p=path.join(root,e.name);
    return e.isDirectory() ? walk(p) : e.name.endsWith('.md') ? [p] : [];
  });
}
function name(file) {
  if (fs.lstatSync(file).isSymbolicLink()) return '';
  const text=fs.readFileSync(file,'utf8');
  const front=/^---\r?\n([\s\S]*?)\r?\n---/.exec(text)?.[1] || '';
  return /^name:\s*["']?([^\r\n"'#]+)["']?\s*$/m.exec(front)?.[1]?.trim() || '';
}
const identities=new Set();
for (const file of walk(source)) {
  identities.add(name(file).toLowerCase());
  identities.add(path.basename(file,'.md').toLowerCase());
}
identities.delete('');
let removed=0;
for (const file of walk(target)) {
  if (identities.has(name(file).toLowerCase()) || identities.has(path.basename(file,'.md').toLowerCase())) {
    fs.unlinkSync(file);
    console.log(`Retired previous distribution agent: ${file}`);
    removed++;
  }
}
function prune(root) {
  for (const e of fs.readdirSync(root,{withFileTypes:true})) {
    if (!e.isDirectory()) continue;
    const p=path.join(root,e.name); prune(p);
    if (!fs.readdirSync(p).length) fs.rmdirSync(p);
  }
}
prune(target);
console.log(`Retired ${removed} previous distribution agent definitions.`);
