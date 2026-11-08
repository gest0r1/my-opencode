// One frozen PLAN gate identity shared by the runner and pre-approval manifest policy.
// The manifest SHA is audit provenance (drafts can evolve); the resource/commands/HEAD
// digest is the precise match condition for a previously completed PLAN probe.
import { createHash } from 'node:crypto';
import { realpathSync } from 'node:fs';
import { basename, dirname, resolve } from 'node:path';
import { commandsDigest } from './gate-testing-policy.mjs';

const SHA = /^[0-9a-f]{40}$/i;
const SAFE_ID = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;

export function planProbeInputDigest(commands, livePostgres, headSha) {
  if (!SHA.test(headSha ?? '') || !Array.isArray(commands) || commands.some(command => typeof command !== 'string')) {
    throw new Error('PLAN_PROBE_INPUT_INVALID: expected verified HEAD SHA and frozen commands');
  }
  const resource = livePostgres === undefined || livePostgres === null ? null : {
    image: livePostgres.image,
    command_indexes: livePostgres.command_indexes,
    preflight_command: livePostgres.preflight_command ?? null,
  };
  return createHash('sha256').update(JSON.stringify(['plan-probe-input-v1', headSha.toLowerCase(), commandsDigest(commands), resource])).digest('hex');
}

export function requirePlanProbeManifestPath(manifestFile, runId) {
  if (!SAFE_ID.test(runId ?? '') || runId === '.' || runId === '..' ||
      runId.includes('..') || typeof manifestFile !== 'string') {
    throw new Error('PLAN_PROBE_RUN_ID_INVALID');
  }
  const lexical = resolve(manifestFile);
  if (basename(lexical) !== 'manifest.json' || basename(dirname(lexical)) !== runId ||
      basename(dirname(dirname(lexical))) !== 'pipelines' ||
      basename(dirname(dirname(dirname(lexical)))) !== '.tmp') {
    throw new Error('PLAN_PROBE_MANIFEST_OUT_OF_RUN: manifest must be .tmp/pipelines/<run-id>/manifest.json');
  }
  let physical;
  try { physical = realpathSync(lexical); }
  catch { throw new Error('PLAN_PROBE_MANIFEST_UNAVAILABLE'); }
  if (physical !== lexical) throw new Error('PLAN_PROBE_MANIFEST_SYMLINK_ESCAPE');
  return lexical;
}
