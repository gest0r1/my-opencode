import assert from 'node:assert/strict';
import { chmod, mkdir, mkdtemp, readFile, rm, symlink, utimes, writeFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
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
  assert.match(result.stderr, /outside effective scope/);
  await rm(path.join(f.b, 'outside.txt'));
  result = gate(f.b, ['publish', f.manifestPath]);
  assert.equal(result.status, 0, result.stderr);
  const published = JSON.parse(result.stdout);
  assert.equal(published.run_id, 'run-b');
  assert.equal(published.candidate_sha, published.remote_sha);
  assert.equal(published.manifest_sha256, createHash('sha256').update(await readFile(f.manifestPath)).digest('hex'));
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


test('preserved baseline keeps existing branch work without granting new write scope', async (t) => {
  const f = await fixture();
  t.after(() => rm(f.root, { recursive: true, force: true }));

  await writeFile(path.join(f.b, 'legacy.txt'), 'existing implementation\n');
  exec(f.b, 'git', ['add', 'legacy.txt']);
  exec(f.b, 'git', ['commit', '-m', 'existing implementation']);

  const snapshotResult = gate(f.b, ['baseline', f.base]);
  assert.equal(snapshotResult.status, 0, snapshotResult.stderr);
  const snapshot = JSON.parse(snapshotResult.stdout);
  assert.equal(snapshot.status, 'PASS');
  assert.deepEqual(snapshot.changed_paths, ['legacy.txt']);
  assert.match(snapshot.diff_sha256, /^[0-9a-f]{64}$/);

  f.manifest.preserved_baseline = {
    head_sha: snapshot.head_sha,
    changed_paths: snapshot.changed_paths,
    diff_sha256: snapshot.diff_sha256,
  };
  await writeFile(f.manifestPath, JSON.stringify(f.manifest, null, 2));

  let result = gate(f.b, ['adopt', f.manifestPath]);
  assert.equal(result.status, 0, result.stderr);

  await writeFile(path.join(f.b, 'src/new.txt'), 'new V2 work\n');
  result = gate(f.b, ['verify', f.manifestPath]);
  assert.equal(result.status, 0, result.stderr);
  const verify = JSON.parse(result.stdout);
  assert.deepEqual(verify.changed_files, ['legacy.txt', 'src/new.txt']);
  const evidence = JSON.parse(await readFile(path.join(f.artifactRoot, 'git-verify.json'), 'utf8'));
  assert.deepEqual(evidence.writable_changed_files, ['src/new.txt']);
  assert.deepEqual(evidence.preserved_baseline_paths, ['legacy.txt']);

  await writeFile(path.join(f.b, 'legacy.txt'), 'mutated by new run\n');
  result = gate(f.b, ['verify', f.manifestPath]);
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /outside effective scope.*legacy\.txt/);
});


test('verify accepts machine-owned runtime scope extensions without mutating manifest', async (t) => {
  const f = await fixture();
  t.after(() => rm(f.root, { recursive: true, force: true }));
  const originalManifest = await readFile(f.manifestPath, 'utf8');
  await writeFile(path.join(f.artifactRoot, 'state.json'), JSON.stringify({
    run_id: 'run-b',
    runtime_scope_extensions: [{
      timestamp: new Date().toISOString(),
      scope_class: 'test',
      paths: ['outside.test.ts'],
      reason: 'automatic test/support scope extension for an already-approved component',
    }],
  }, null, 2) + '\n');
  await writeFile(path.join(f.b, 'outside.test.ts'), 'runtime-authorized test\n');

  const result = gate(f.b, ['verify', f.manifestPath]);
  assert.equal(result.status, 0, result.stderr);
  const output = JSON.parse(result.stdout);
  assert.deepEqual(output.changed_files, ['outside.test.ts']);
  const evidence = JSON.parse(await readFile(path.join(f.artifactRoot, 'git-verify.json'), 'utf8'));
  assert.ok(evidence.effective_allowed_change_paths.includes('outside.test.ts'));
  assert.equal(evidence.runtime_scope_extensions[0].scope_class, 'test');
  assert.equal(await readFile(f.manifestPath, 'utf8'), originalManifest);
});

test('quarantine-strays moves only untracked out-of-scope files created after the first dispatch, on the RUN branch', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'stray-'));
  try {
    exec(root, 'git', ['init']);
    exec(root, 'git', ['config', 'user.name', 'Pipeline Test']);
    exec(root, 'git', ['config', 'user.email', 'pipeline@example.invalid']);
    await writeFile(path.join(root, '.gitignore'), '.tmp/\n');
    await mkdir(path.join(root, 'src'));
    await writeFile(path.join(root, 'src/app.ts'), 'base\n');
    await writeFile(path.join(root, 'owner-notes.txt'), 'existed before the run\n');
    exec(root, 'git', ['add', '.gitignore', 'src']);
    exec(root, 'git', ['commit', '-m', 'base']);
    exec(root, 'git', ['checkout', '-b', 'pipeline/stray-run']);
    const runDir = path.join(root, '.tmp/pipelines/stray-run');
    await mkdir(path.join(runDir, 'checks/baselines'), { recursive: true });
    const manifestPath = path.join(runDir, 'manifest.json');
    await writeFile(manifestPath, JSON.stringify({ run_id: 'stray-run', allowed_change_paths: ['src/**'], git_setup: { branch: 'pipeline/stray-run' } }));
    await writeFile(path.join(runDir, 'checks/baselines/first.json'), JSON.stringify({
      recorded_at: '2026-10-11T00:00:00.000Z', files: { '.gitignore': 'x', 'src/app.ts': 'x', 'owner-notes.txt': 'x' },
    }));
    await writeFile(path.join(root, 'diffstat.txt'), '');
    await writeFile(path.join(root, 'test-infra.patch'), 'diff\n');
    await writeFile(path.join(root, 'src/new.ts'), 'in scope\n');
    await writeFile(path.join(root, 'secret.key'), 'never touched\n');
    await mkdir(path.join(root, 'dist'));
    await writeFile(path.join(root, 'dist/bundle.js'), 'build output\n');
    await writeFile(path.join(root, 'old-scratch.log'), 'older than the RUN\n');
    await utimes(path.join(root, 'old-scratch.log'), new Date('2026-10-01T00:00:00Z'), new Date('2026-10-01T00:00:00Z'));
    let result = gate(root, ['quarantine-strays', manifestPath]);
    assert.equal(result.status, 0, result.stderr);
    assert.deepEqual(JSON.parse(result.stdout).strays, ['diffstat.txt', 'test-infra.patch']);
    result = gate(root, ['quarantine-strays', manifestPath, '--apply']);
    assert.equal(result.status, 0, result.stderr);
    const output = JSON.parse(result.stdout);
    assert.deepEqual(output.moved.map(item => item.path), ['diffstat.txt', 'test-infra.patch']);
    assert.equal(await readFile(path.join(output.quarantine_dir, 'test-infra.patch'), 'utf8'), 'diff\n');
    await assert.rejects(readFile(path.join(root, 'diffstat.txt')));
    assert.equal(await readFile(path.join(root, 'owner-notes.txt'), 'utf8'), 'existed before the run\n');
    assert.equal(await readFile(path.join(root, 'src/new.ts'), 'utf8'), 'in scope\n');
    assert.equal(await readFile(path.join(root, 'secret.key'), 'utf8'), 'never touched\n');
    assert.equal(await readFile(path.join(root, 'dist/bundle.js'), 'utf8'), 'build output\n');
    assert.equal(await readFile(path.join(root, 'old-scratch.log'), 'utf8'), 'older than the RUN\n');
    exec(root, 'git', ['checkout', '-b', 'other-branch']);
    result = gate(root, ['quarantine-strays', manifestPath]);
    assert.notEqual(result.status, 0); assert.match(result.stderr, /QUARANTINE_BRANCH_MISMATCH/);
    exec(root, 'git', ['checkout', 'pipeline/stray-run']);
    await rm(path.join(runDir, 'checks/baselines/first.json'));
    result = gate(root, ['quarantine-strays', manifestPath]);
    assert.notEqual(result.status, 0); assert.match(result.stderr, /QUARANTINE_REQUIRES_DISPATCH_BASELINE/);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('quarantine-strays --include-pre-run --paths moves exactly the listed pre-run untracked files and refuses unsafe paths', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'prerun-'));
  try {
    exec(root, 'git', ['init']);
    exec(root, 'git', ['config', 'user.name', 'Pipeline Test']);
    exec(root, 'git', ['config', 'user.email', 'pipeline@example.invalid']);
    await writeFile(path.join(root, '.gitignore'), '.tmp/\n');
    await mkdir(path.join(root, 'src'));
    await writeFile(path.join(root, 'src/app.ts'), 'base\n');
    exec(root, 'git', ['add', '.gitignore', 'src']);
    exec(root, 'git', ['commit', '-m', 'base']);
    exec(root, 'git', ['checkout', '-b', 'pipeline/pre-run']);
    const runDir = path.join(root, '.tmp/pipelines/pre-run');
    await mkdir(runDir, { recursive: true });
    const manifestPath = path.join(runDir, 'manifest.json');
    await writeFile(manifestPath, JSON.stringify({ run_id: 'pre-run', allowed_change_paths: ['src/**'], git_setup: { branch: 'pipeline/pre-run' } }));
    await writeFile(path.join(root, 'old-notes.txt'), 'pre-run\n');
    await utimes(path.join(root, 'old-notes.txt'), new Date('2026-01-01T00:00:00Z'), new Date('2026-01-01T00:00:00Z'));
    await writeFile(path.join(root, 'src/old.ts'), 'in scope\n');
    await writeFile(path.join(root, 'untouched.txt'), 'keep\n');
    await writeFile(path.join(root, 'secret.key'), 'secret\n');
    await mkdir(path.join(root, 'adir'));
    await writeFile(path.join(root, 'adir/f.txt'), 'x\n');
    await symlink('untouched.txt', path.join(root, 'link.txt'));
    const refuse = (paths, code) => {
      const r = gate(root, ['quarantine-strays', manifestPath, '--apply', '--include-pre-run', '--paths', 'old-notes.txt', ...paths]);
      assert.notEqual(r.status, 0); assert.match(r.stderr, new RegExp(code));
    };
    refuse(['src/app.ts'], 'QUARANTINE_PATH_TRACKED');
    refuse(['adir'], 'QUARANTINE_PATH_DIRECTORY');
    refuse(['link.txt'], 'QUARANTINE_PATH_SYMLINK');
    refuse(['secret.key'], 'QUARANTINE_PATH_PROTECTED');
    refuse(['.github/x.yml'], 'QUARANTINE_PATH_PROTECTED');
    refuse(['.tmp/pipelines/pre-run/manifest.json'], 'QUARANTINE_PATH_FORBIDDEN');
    refuse(['.git/config'], 'QUARANTINE_PATH_INVALID');
    refuse(['missing.txt'], 'QUARANTINE_PATH_MISSING');
    assert.equal(await readFile(path.join(root, 'old-notes.txt'), 'utf8'), 'pre-run\n');
    let r = gate(root, ['quarantine-strays', manifestPath, '--include-pre-run']);
    assert.notEqual(r.status, 0); assert.match(r.stderr, /usage: quarantine-strays/);
    r = gate(root, ['quarantine-strays', manifestPath, '--paths', 'old-notes.txt']);
    assert.notEqual(r.status, 0); assert.match(r.stderr, /usage: quarantine-strays/);
    r = gate(root, ['quarantine-strays', manifestPath, '--include-pre-run', '--paths', 'old-notes.txt']);
    assert.equal(r.status, 0, r.stderr); assert.deepEqual(JSON.parse(r.stdout).strays, ['old-notes.txt']);
    assert.equal(await readFile(path.join(root, 'old-notes.txt'), 'utf8'), 'pre-run\n');
    r = gate(root, ['quarantine-strays', manifestPath, '--apply', '--include-pre-run', '--paths', 'old-notes.txt', 'src/old.ts']);
    assert.equal(r.status, 0, r.stderr);
    const output = JSON.parse(r.stdout);
    assert.equal(output.kind, 'stray_quarantine');
    assert.deepEqual(output.moved.map(item => item.path), ['old-notes.txt', 'src/old.ts']);
    assert.equal(await readFile(path.join(output.quarantine_dir, 'old-notes.txt'), 'utf8'), 'pre-run\n');
    assert.equal(JSON.parse(await readFile(path.join(output.quarantine_dir, 'quarantine.json'), 'utf8')).moved.length, 2);
    await assert.rejects(readFile(path.join(root, 'old-notes.txt')));
    assert.equal(await readFile(path.join(root, 'untouched.txt'), 'utf8'), 'keep\n');
    exec(root, 'git', ['checkout', '-b', 'other-branch']);
    r = gate(root, ['quarantine-strays', manifestPath, '--apply', '--include-pre-run', '--paths', 'untouched.txt']);
    assert.notEqual(r.status, 0); assert.match(r.stderr, /QUARANTINE_BRANCH_MISMATCH/);
  } finally { await rm(root, { recursive: true, force: true }); }
});

async function moveMain(f, file = 'notes/unrelated.txt') {
  await mkdir(path.dirname(path.join(f.main, file)), { recursive: true });
  await writeFile(path.join(f.main, file), 'upstream\n');
  exec(f.main, 'git', ['add', file]); exec(f.main, 'git', ['commit', '-m', `upstream ${file}`]); exec(f.main, 'git', ['push', 'origin', 'main']);
  return exec(f.main, 'git', ['rev-parse', 'HEAD']);
}
const head = (f) => exec(f.b, 'git', ['rev-parse', 'HEAD']);

test('sync-main --check is read-only and reports contains_main, clean and action', async (t) => {
  const f = await fixture(); t.after(() => rm(f.root, { recursive: true, force: true }));
  let out = JSON.parse(gate(f.b, ['sync-main', f.manifestPath, '--check']).stdout);
  assert.deepEqual([out.contains_main, out.clean, out.action], [true, true, 'none']);
  const newMain = await moveMain(f);
  await writeFile(path.join(f.b, 'src/work.txt'), 'wip\n');
  const before = head(f);
  const result = gate(f.b, ['sync-main', f.manifestPath, '--check']);
  assert.equal(result.status, 0, result.stderr);
  out = JSON.parse(result.stdout);
  assert.deepEqual([out.contains_main, out.clean, out.action, out.main_sha, out.head_sha], [false, false, 'checkpoint_and_merge', newMain, before]);
  assert.equal(head(f), before);
  assert.match(exec(f.b, 'git', ['status', '--porcelain']), /src\/work\.txt/);
  await rm(path.join(f.b, 'src/work.txt'));
  assert.equal(JSON.parse(gate(f.b, ['sync-main', f.manifestPath, '--check']).stdout).action, 'merge');
  assert.equal(head(f), before);
});

test('sync-main does nothing when main is already contained, even with a dirty tree', async (t) => {
  const f = await fixture(); t.after(() => rm(f.root, { recursive: true, force: true }));
  await writeFile(path.join(f.b, 'outside.txt'), 'dirty\n');
  const before = head(f);
  const result = gate(f.b, ['sync-main', f.manifestPath]);
  assert.equal(result.status, 0, result.stderr);
  assert.equal(JSON.parse(result.stdout).action, 'none');
  assert.equal(head(f), before);
  assert.match(exec(f.b, 'git', ['status', '--porcelain']), /outside\.txt/);
});

test('sync-main merges a clean tree and records the new run base', async (t) => {
  const f = await fixture(); t.after(() => rm(f.root, { recursive: true, force: true }));
  const newMain = await moveMain(f);
  const result = gate(f.b, ['sync-main', f.manifestPath]);
  assert.equal(result.status, 0, result.stderr);
  const out = JSON.parse(result.stdout);
  assert.equal(out.action, 'merge'); assert.equal(out.checkpoint_sha, undefined);
  assert.equal(JSON.parse(await readFile(path.join(f.artifactRoot, 'git-runtime.json'))).run_base_sha, newMain);
  exec(f.b, 'git', ['merge-base', '--is-ancestor', newMain, 'HEAD']);
});

test('sync-main refuses out-of-scope dirty paths without changing anything', async (t) => {
  const f = await fixture(); t.after(() => rm(f.root, { recursive: true, force: true }));
  await moveMain(f);
  await writeFile(path.join(f.b, 'src/ok.txt'), 'ok\n'); await writeFile(path.join(f.b, 'outside.txt'), 'no\n');
  const before = head(f), status = exec(f.b, 'git', ['status', '--porcelain']);
  const result = gate(f.b, ['sync-main', f.manifestPath]);
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /SYNC_MAIN_OUT_OF_SCOPE: outside\.txt/);
  assert.equal(head(f), before); assert.equal(exec(f.b, 'git', ['status', '--porcelain']), status);
});

test('sync-main checkpoints dirty in-scope work, merges, and verify and publish accept the result', async (t) => {
  const f = await fixture(); t.after(() => rm(f.root, { recursive: true, force: true }));
  const newMain = await moveMain(f);
  await writeFile(path.join(f.b, 'src/base.txt'), 'edited\n'); await writeFile(path.join(f.b, 'src/new.txt'), 'new\n');
  let result = gate(f.b, ['sync-main', f.manifestPath]);
  assert.equal(result.status, 0, result.stderr);
  const out = JSON.parse(result.stdout);
  assert.equal(out.action, 'checkpoint_and_merge');
  assert.equal(exec(f.b, 'git', ['log', '-1', '--format=%s', out.checkpoint_sha]), 'pipeline(run-b): checkpoint before main sync');
  assert.equal(exec(f.b, 'git', ['status', '--porcelain']), '');
  assert.equal(JSON.parse(await readFile(path.join(f.artifactRoot, 'git-runtime.json'))).run_base_sha, newMain);
  result = gate(f.b, ['verify', f.manifestPath]);
  assert.equal(result.status, 0, result.stderr);
  assert.deepEqual(JSON.parse(result.stdout).changed_files, ['src/base.txt', 'src/new.txt']);
  result = gate(f.b, ['publish', f.manifestPath]);
  assert.equal(result.status, 0, result.stderr);
  const published = JSON.parse(result.stdout);
  assert.equal(published.candidate_sha, published.remote_sha);
  assert.equal(published.candidate_sha, head(f));
});

test('sync-main conflict keeps checkpoint commit and leaves no merge in progress', async (t) => {
  const f = await fixture(); t.after(() => rm(f.root, { recursive: true, force: true }));
  // Scope excludes the conflicting file so the plan-relevant check passes and git itself conflicts.
  await writeFile(f.manifestPath, JSON.stringify({ ...f.manifest, allowed_change_paths: ['src/work.txt'] }));
  await writeFile(path.join(f.main, 'src/shared.txt'), 'main\n');
  exec(f.main, 'git', ['add', '.']); exec(f.main, 'git', ['commit', '-m', 'main shared']); exec(f.main, 'git', ['push', 'origin', 'main']);
  await writeFile(path.join(f.b, 'src/shared.txt'), 'branch\n');
  exec(f.b, 'git', ['add', '.']); exec(f.b, 'git', ['-c', 'user.name=T', '-c', 'user.email=t@example.invalid', 'commit', '-m', 'branch shared']);
  await writeFile(path.join(f.b, 'src/work.txt'), 'wip\n');
  const result = gate(f.b, ['sync-main', f.manifestPath]);
  assert.notEqual(result.status, 0);
  const sha = head(f);
  assert.match(result.stderr, new RegExp(`STALE_PLAN: safe main merge conflicted[\\s\\S]*checkpoint commit ${sha}`));
  assert.equal(exec(f.b, 'git', ['log', '-1', '--format=%s']), 'pipeline(run-b): checkpoint before main sync');
  assert.equal(run(f.b, 'git', ['rev-parse', '-q', '--verify', 'MERGE_HEAD']).status, 1);
  assert.equal(exec(f.b, 'git', ['status', '--porcelain']), '');
});

test('sync-plan fast-forwards main and merges it into the PLAN branch before any run is initialized', async (t) => {
  const f = await fixture();
  t.after(() => rm(f.root, { recursive: true, force: true }));
  const other = path.join(f.root, 'other');
  exec(f.root, 'git', ['clone', '-b', 'main', f.remote, other]);
  exec(other, 'git', ['config', 'user.name', 'Other']);
  exec(other, 'git', ['config', 'user.email', 'other@example.invalid']);
  await writeFile(path.join(other, 'src/upstream.txt'), 'upstream\n');
  exec(other, 'git', ['add', '.']);
  exec(other, 'git', ['commit', '-m', 'upstream']);
  exec(other, 'git', ['push', 'origin', 'main']);
  const upstream = exec(other, 'git', ['rev-parse', 'HEAD']);
  await writeFile(path.join(f.b, 'src/plan.txt'), 'plan\n');
  exec(f.b, 'git', ['add', 'src/plan.txt']);
  exec(f.b, 'git', ['commit', '-m', 'plan work']);

  let result = gate(f.b, ['sync-plan', '--check']);
  assert.equal(result.status, 0, result.stderr);
  assert.equal(JSON.parse(result.stdout).action, 'sync');
  assert.equal(exec(f.main, 'git', ['rev-parse', 'HEAD']), f.base);

  result = gate(f.b, ['sync-plan']);
  assert.equal(result.status, 0, result.stderr);
  assert.equal(JSON.parse(result.stdout).action, 'merged');
  assert.equal(exec(f.main, 'git', ['rev-parse', 'HEAD']), upstream);
  assert.equal(run(f.b, 'git', ['merge-base', '--is-ancestor', upstream, 'HEAD']).status, 0);
  assert.equal(await readFile(path.join(f.b, 'src/plan.txt'), 'utf8'), 'plan\n');
  assert.equal(JSON.parse(gate(f.b, ['sync-plan']).stdout).action, 'none');

  await writeFile(path.join(f.artifactRoot, 'state.json'), '{}\n');
  result = gate(f.b, ['sync-plan']);
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /SYNC_PLAN_AFTER_FREEZE: run run-b/);
});

test('a candidate is identified by its SHA, gets no tag, and the release tag lands on it after a merge-commit merge', async (t) => {
  const f = await fixture();
  t.after(() => rm(f.root, { recursive: true, force: true }));
  const manifest = { ...f.manifest, release: { version: '0.6.5', milestone: { number: 7, title: 'v.0.6.5' } } };
  await writeFile(f.manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);
  assert.equal(gate(f.b, ['adopt', f.manifestPath]).status, 0);
  await writeFile(path.join(f.b, 'src/allowed.txt'), 'one\n');
  let result = gate(f.b, ['publish', f.manifestPath]);
  assert.equal(result.status, 0, result.stderr);
  assert.equal(JSON.parse(result.stdout).rc_tag, undefined);
  await writeFile(path.join(f.b, 'src/allowed.txt'), 'two\n');
  result = gate(f.b, ['publish', f.manifestPath]);
  const candidate = JSON.parse(result.stdout).candidate_sha;
  assert.equal(exec(f.root, 'git', ['--git-dir', f.remote, 'tag', '--list']), '');

  // The owner merges the PR with a merge commit; release tags the tested candidate.
  exec(f.main, 'git', ['merge', '--no-ff', '-m', 'Merge PR', 'feature/B']);
  exec(f.main, 'git', ['push', 'origin', 'main']);
  const mergeSha = exec(f.main, 'git', ['rev-parse', 'HEAD']);
  await writeFile(path.join(f.artifactRoot, 'state.json'), JSON.stringify({ run_id: 'run-b', status: 'completed', manifest_file: f.manifestPath }));
  const bin = path.join(f.root, 'bin'); await mkdir(bin);
  const realGit = exec(f.root, 'which', ['git']);
  await writeFile(path.join(bin, 'git'), `#!/bin/sh\nif [ "$*" = "remote get-url origin" ]; then echo git@github.com:o/r.git; exit 0; fi\nexec ${realGit} "$@"\n`);
  await writeFile(path.join(bin, 'gh'), `#!/bin/bash
if [[ "$1" == auth ]]; then exit 0; fi
if [[ "$1" == pr ]]; then echo '{"number":5,"state":"'"\${PR_STATE:-MERGED}"'","headRefOid":"${candidate}","mergeCommit":{"oid":"${mergeSha}"}}'; exit 0; fi
if [[ "$*" == *"--method PATCH"* ]]; then echo closed >> "${path.join(f.root, 'patched')}"; exit 0; fi
if [[ "$*" == *milestones/7* ]]; then echo '{"state":"open","open_issues":0}'; exit 0; fi
exit 2
`);
  await chmod(path.join(bin, 'git'), 0o755); await chmod(path.join(bin, 'gh'), 0o755);
  const release = (env = {}) => spawnSync('npx', ['--yes', 'tsx', path.join(HERE, 'github-pr-cli.ts'), 'release', 'run-b'],
    { cwd: f.b, encoding: 'utf8', env: { ...process.env, PATH: `${bin}:${process.env.PATH}`, ...env } });
  result = release({ PR_STATE: 'OPEN' });
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /RELEASE_PR_NOT_MERGED/);
  result = release();
  assert.equal(result.status, 0, result.stderr);
  const out = JSON.parse(result.stdout);
  assert.equal(out.tag, 'v0.6.5');
  assert.equal(out.merge_sha, mergeSha);
  assert.equal(exec(f.root, 'git', ['--git-dir', f.remote, 'rev-parse', 'v0.6.5^{commit}']), candidate);
  assert.equal((await readFile(path.join(f.root, 'patched'), 'utf8')).trim(), 'closed');
  assert.equal(release().status, 0);
});
