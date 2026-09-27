import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import test from 'node:test';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const CLI = path.join(HERE, 'git-worktree-cli.ts');
function run(cwd, command, args) {
  return spawnSync(command, args, { cwd, encoding: 'utf8', env: process.env });
}
function exec(cwd, command, args) {
  const result = run(cwd, command, args);
  assert.equal(result.status, 0, `${command} ${args.join(' ')}\n${result.stderr}`);
  return result.stdout.trim();
}
function gate(cwd, args) {
  return run(cwd, 'npx', ['--yes', 'tsx', CLI, ...args]);
}
async function fixture() {
  const root = await mkdtemp(path.join(os.tmpdir(), 'manual-worktree-'));
  const remote = path.join(root, 'remote.git');
  const main = path.join(root, 'main');
  const b = path.join(root, 'worktree-b');
  exec(root, 'git', ['init', '--bare', remote]);
  await mkdir(main);
  exec(main, 'git', ['init']);
  exec(main, 'git', ['config', 'user.name', 'Pipeline Test']);
  exec(main, 'git', ['config', 'user.email', 'pipeline@example.invalid']);
  await mkdir(path.join(main, 'src'));
  await writeFile(path.join(main, '.gitignore'), '.tmp/\n');
  await writeFile(path.join(main, 'src/base.txt'), 'base\n');
  exec(main, 'git', ['add', '.']);
  exec(main, 'git', ['commit', '-m', 'base']);
  exec(main, 'git', ['branch', '-M', 'main']);
  exec(main, 'git', ['remote', 'add', 'origin', remote]);
  exec(main, 'git', ['push', '-u', 'origin', 'main']);
  const base = exec(main, 'git', ['rev-parse', 'HEAD']);
  exec(main, 'git', ['worktree', 'add', '-b', 'feature/B', b, 'main']);
  const artifactRoot = path.join(b, '.tmp/pipelines/run-b');
  await mkdir(path.join(artifactRoot, 'planning'), { recursive: true });
  await writeFile(path.join(artifactRoot, 'planning/research.md'), 'Important owner decision: retain\n');
  const manifest = { schema_version: 1, run_id: 'run-b', allowed_change_paths: ['src/**'],
    git_setup: { base_sha: base, branch: 'feature/B', must_absent: ['forbidden.txt'] } };
  await writeFile(path.join(artifactRoot, 'manifest.json'), `${JSON.stringify(manifest, null, 2)}\n`);
  await writeFile(path.join(artifactRoot, 'decision-register.md'), 'Owner approved design only\n');
  return { root, main, b, remote, base, artifactRoot, manifest,
    manifestPath: path.join(artifactRoot, 'manifest.json') };
}

test('owner-created linked worktree is adopted read-only; setup and primary checkout are blocked', async (t) => {
  const f = await fixture();
  t.after(() => rm(f.root, { recursive: true, force: true }));
  const start = exec(f.b, 'git', ['rev-parse', 'HEAD']);
  let result = gate(f.b, ['adopt', f.manifestPath]);
  assert.equal(result.status, 0, result.stderr);
  assert.equal(exec(f.b, 'git', ['rev-parse', 'HEAD']), start);
  assert.equal(exec(f.b, 'git', ['branch', '--show-current']), 'feature/B');
  result = gate(f.b, ['setup', f.manifestPath]);
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /setup is disabled/);
  result = gate(f.main, ['adopt', f.manifestPath]);
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /linked worktree|mismatch/);

  await writeFile(path.join(f.b, 'src/allowed.txt'), 'allowed\n');
  result = gate(f.b, ['verify', f.manifestPath]);
  assert.equal(result.status, 0, result.stderr);
  assert.deepEqual(JSON.parse(result.stdout).changed_files, ['src/allowed.txt']);
  const verifyEvidence = JSON.parse(await readFile(path.join(f.artifactRoot, 'git-verify.json'), 'utf8'));
  assert.equal(verifyEvidence.status, 'PASS');
  assert.equal(verifyEvidence.run_id, 'run-b');
  assert.equal(verifyEvidence.branch, 'feature/B');
  assert.deepEqual(verifyEvidence.changed_files, ['src/allowed.txt']);
  await writeFile(path.join(f.b, 'outside.txt'), 'out of scope\n');
  result = gate(f.b, ['verify', f.manifestPath]);
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /outside approved scope/);
  await rm(path.join(f.b, 'outside.txt'));
  result = gate(f.b, ['publish', f.manifestPath]);
  assert.equal(result.status, 0, result.stderr);
  const published = JSON.parse(result.stdout);
  assert.equal(published.run_id, 'run-b');
  assert.equal(published.candidate_sha, published.remote_sha);
  assert.equal(exec(f.b, 'git', ['branch', '--show-current']), 'feature/B');
  assert.equal(JSON.parse(await readFile(path.join(f.artifactRoot, 'candidate.json'))).candidate_sha,
    published.candidate_sha);
});

test('plan-relevant origin/main change is blocked by deterministic freshness', async (t) => {
  const f = await fixture();
  t.after(() => rm(f.root, { recursive: true, force: true }));
  const originalManifest = await readFile(f.manifestPath, 'utf8');
  const originalResearch = await readFile(path.join(f.artifactRoot, 'planning/research.md'), 'utf8');
  const archiveDir = path.join(f.main, '.git', 'pipeline-backups');
  await mkdir(archiveDir, { recursive: true });
  const archive = path.join(archiveDir, 'B-before-main-merge.tar.gz');
  exec(f.b, 'tar', ['-czf', archive, '.tmp/pipelines']);
  exec(f.main, 'git', ['checkout', 'main']);
  await writeFile(path.join(f.main, 'src/A.txt'), 'merged A\n');
  exec(f.main, 'git', ['add', 'src/A.txt']);
  exec(f.main, 'git', ['commit', '-m', 'merge A result']);
  const newMain = exec(f.main, 'git', ['rev-parse', 'HEAD']);
  exec(f.main, 'git', ['push', 'origin', 'main']);
  assert.notEqual(newMain, f.base);
  let result = gate(f.b, ['freshness', f.manifestPath]);
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /STALE_PLAN.*src\/A\.txt/);
  assert.equal(await readFile(f.manifestPath, 'utf8'), originalManifest);
  assert.equal(await readFile(path.join(f.artifactRoot, 'planning/research.md'), 'utf8'), originalResearch);
  exec(f.b, 'tar', ['-tzf', archive]);
  assert.equal(exec(f.b, 'git', ['rev-parse', 'HEAD']), f.base);
  assert.equal(newMain, exec(f.main, 'git', ['rev-parse', 'HEAD']));
});

test('manual mode rejects implicit source checkout and wrong base before mutation', async (t) => {
  const f = await fixture();
  t.after(() => rm(f.root, { recursive: true, force: true }));
  const before = exec(f.b, 'git', ['rev-parse', 'HEAD']);
  const invalid = { ...f.manifest, git_setup: { ...f.manifest.git_setup,
    source_sha: f.base, checkout_paths: ['src/base.txt'] } };
  const pathBad = path.join(f.root, 'invalid.json');
  await writeFile(pathBad, JSON.stringify(invalid));
  const result = gate(f.b, ['adopt', pathBad]);
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /does not perform source checkout/);
  assert.equal(exec(f.b, 'git', ['rev-parse', 'HEAD']), before);
});


test('unrelated origin/main change is merged and becomes effective run base', async (t) => {
  const f=await fixture();t.after(()=>rm(f.root,{recursive:true,force:true}));const original=await readFile(f.manifestPath,'utf8');await mkdir(path.join(f.main,'notes'),{recursive:true});await writeFile(path.join(f.main,'notes/unrelated.txt'),'safe upstream\n');exec(f.main,'git',['add','notes/unrelated.txt']);exec(f.main,'git',['commit','-m','unrelated upstream']);exec(f.main,'git',['push','origin','main']);const newMain=exec(f.main,'git',['rev-parse','HEAD']);
  const result=gate(f.b,['freshness',f.manifestPath]);assert.equal(result.status,0,result.stderr);assert.equal(JSON.parse(result.stdout).run_base_sha,newMain);assert.equal(await readFile(f.manifestPath,'utf8'),original);assert.equal(JSON.parse(await readFile(path.join(f.artifactRoot,'git-runtime.json'))).run_base_sha,newMain);const verify=gate(f.b,['verify',f.manifestPath]);assert.equal(verify.status,0,verify.stderr);
});
