#!/usr/bin/env node
// stdin: output of "opencode models claude-agent" from pinned CLI, no secrets.
import fs from 'node:fs';
const [reportPath] = process.argv.slice(2);
if (!reportPath) throw new Error('Usage: verify-claude-models.mjs MIGRATION_REPORT < model-list');
const expected = JSON.parse(fs.readFileSync(reportPath, 'utf8'));
if (!Array.isArray(expected) || expected.some(x => typeof x !== 'string' || !x.startsWith('claude-agent/'))) throw new Error('Invalid migration report');
const lines = [];
for await (const part of process.stdin) lines.push(part);
const available = new Set(lines.join('').split(/\r?\n/).map(x => x.trim().split(/\s+/)[0]));
const missing = expected.filter(x => !available.has(x));
if (missing.length) {
  console.error('CLAUDE_NATIVE_MIGRATION_BLOCKED: chosen models missing from native claude-agent catalog: ' + missing.join(', '));
  console.error('Sign in/connect Claude Agent and confirm exact model IDs. No active configuration has been replaced.');
  process.exit(2);
}
if (expected.length) console.log('Native Claude migration validated for ' + expected.length + ' chosen model(s).');
