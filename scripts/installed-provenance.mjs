#!/usr/bin/env node
// Installed V2 provenance: hash the actual staged layout, never source machine paths.
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';

const hash = bytes => crypto.createHash('sha256').update(bytes).digest('hex');
const essential = relative => /^(?:plugins|commands|agents|skills|tools)(?:\/|$)/.test(relative)
  || ['AGENTS.md', 'PIPELINE.md', 'opencode.json', 'package.json', 'bun.lock', 'plugin-policy.json'].includes(relative);
function inventory(root) {
  const entries = [];
  const walk = (relative = '') => {
    const dir = path.join(root, relative);
    for (const item of fs.readdirSync(dir, { withFileTypes: true })) {
      const next = relative ? relative + '/' + item.name : item.name;
      if (next === 'node_modules' || next.startsWith('node_modules/')) continue;
      const abs = path.join(root, next);
      if (item.isSymbolicLink() && essential(next))
        throw new Error('PROVENANCE_SYMLINK_NOT_ALLOWED: ' + next);
      if (item.isDirectory()) walk(next);
      else if (item.isFile() && essential(next)) entries.push({ path: next, sha256: hash(fs.readFileSync(abs)) });
    }
  };
  walk();
  return entries.sort((a, b) => a.path.localeCompare(b.path));
}
export function sourceProvenance(root, { repository, revision, release, installedAt = new Date().toISOString() }) {
  const files = inventory(root);
  if (!files.length) throw new Error('Provenance requires staged V2 files');
  const trustedSha = typeof revision === 'string' && /^[a-f0-9]{40}$/i.test(revision) ? revision.toLowerCase() : null;
  return {
    schema_version: 2,
    source_repository: repository || 'unknown',
    source_revision: trustedSha,
    provenance_status: trustedSha ? 'verified-source-revision' : 'unknown',
    release_identity: release || 'unknown',
    installed_at: installedAt,
    layout: 'opencode-v2-plural',
    install_manifest_sha256: hash(JSON.stringify(files)),
    files,
  };
}
export function verifyProvenance(root, metadata) {
  if (!metadata || metadata.schema_version !== 2 || metadata.layout !== 'opencode-v2-plural' ||
      !Array.isArray(metadata.files) || !metadata.files.length) return { status: 'unknown', reason: 'legacy_or_missing_provenance' };
  let current;
  try { current = inventory(root); }
  catch (error) { return { status: 'mismatch', reason: 'installed_inventory_unreadable_or_symlink', detail: String(error?.message ?? error) }; }
  if (hash(JSON.stringify(current)) !== metadata.install_manifest_sha256 ||
      JSON.stringify(current) !== JSON.stringify(metadata.files)) return { status: 'mismatch', reason: 'installed_files_changed' };
  return { status: metadata.provenance_status === 'verified-source-revision' ? 'verified' : 'unknown',
    source_revision: metadata.source_revision ?? null };
}
if (process.argv[1] === new URL(import.meta.url).pathname) {
  const [action, root, repository, revision, release] = process.argv.slice(2);
  if (!root) throw new Error('Usage: node installed-provenance.mjs write|verify CONFIG_DIR [repository revision release]');
  const metadataFile = path.join(root, '.runtime-source.json');
  if (action === 'write') {
    const record = sourceProvenance(root, { repository, revision, release });
    const temp = metadataFile + '.tmp-' + process.pid;
    fs.writeFileSync(temp, JSON.stringify(record, null, 2) + '\n', { mode: 0o600 });
    fs.renameSync(temp, metadataFile);
  } else if (action === 'verify') {
    let metadata;
    try { metadata = JSON.parse(fs.readFileSync(metadataFile, 'utf8')); } catch {}
    const result = verifyProvenance(root, metadata);
    console.log(JSON.stringify(result));
    if (result.status !== 'verified') process.exitCode = 2;
  } else throw new Error('Unknown action');
}
