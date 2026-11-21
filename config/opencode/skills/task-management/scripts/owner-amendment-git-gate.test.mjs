import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { appendFile, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import test from 'node:test';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const STAGE_CLI = path.join(HERE, 'stage-cli.ts');
const GIT_CLI = path.join(HERE, 'git-worktree-cli.ts');

function run(cwd, command, args) {
  return spawnSync(command, args, { cwd, encoding: 'utf8', env: process.env });
}

function exec(cwd, command, args) {
  const result = run(cwd, command, args);
  assert.equal(result.status, 0, `${command} ${args.join(' ')}\n${result.stderr}`);
  return result.stdout.trim();
}

function stage(cwd, args) {
  return run(cwd, 'npx', ['--yes', 'tsx', STAGE_CLI, ...args]);
}

function gitGate(cwd, args) {
  return run(cwd, 'npx', ['--yes', 'tsx', GIT_CLI, ...args]);
}

function sha256(value) {
  return createHash('sha256').update(value).digest('hex');
}

async function approvalArgs(f, response = 'Approved final manifest for this run') {
  return ['--approval-subject', 'final-manifest', '--approval-run-id', f.runId,
    '--approval-manifest-sha256', sha256(await readFile(f.manifestPath, 'utf8')),
    '--approval-decision', 'approved', '--owner-response', response,
    '--owner-message-id', 'msg_test_1', '--owner-source-session', 'ses_test_1'];
}

async function frozen(root, relative, content) {
  const file = path.join(root, relative);
  await mkdir(path.dirname(file), { recursive: true });
  await writeFile(file, content, 'utf8');
  return { path: relative, sha256: sha256(content) };
}

async function fixture() {
  const root = await mkdtemp(path.join(os.tmpdir(), 'owner-amend-git-gate-'));
  const remote = path.join(root, 'remote.git');
  const main = path.join(root, 'main');
  const worktree = path.join(root, 'worktree');
  const policyText = JSON.stringify({
    schema_version: 1,
    protected_paths: [],
    required_gates: [],
    deployment_target: {
      kind: 'opencode_host',
      transport: 'github_ssh',
      target_id: 'opencode-development-host',
      environment: 'development',
      probe_workflow: '.github/workflows/deployment-target-probe.yml',
      probe_job: 'probe_target',
      trusted_ref: 'main',
      required_environment_secrets: ['DEPLOY_SSH_KEY'],
      runner_labels: [],
      probe_timeout_seconds: 180,
    },
  }, null, 2);

  exec(root, 'git', ['init', '--bare', remote]);
  await mkdir(main);
  exec(main, 'git', ['init']);
  exec(main, 'git', ['config', 'user.name', 'Pipeline Test']);
  exec(main, 'git', ['config', 'user.email', 'pipeline@example.invalid']);
  await mkdir(path.join(main, 'src'));
  await mkdir(path.join(main, '.opencode'));
  await writeFile(path.join(main, '.gitignore'), '.tmp/\n');
  await writeFile(path.join(main, 'src/base.txt'), 'base\n');
  await writeFile(path.join(main, '.opencode/pipeline-policy.json'), policyText);
  exec(main, 'git', ['add', '.']);
  exec(main, 'git', ['commit', '-m', 'base']);
  exec(main, 'git', ['branch', '-M', 'main']);
  exec(main, 'git', ['remote', 'add', 'origin', remote]);
  exec(main, 'git', ['push', '-u', 'origin', 'main']);
  const base = exec(main, 'git', ['rev-parse', 'HEAD']);
  exec(main, 'git', ['worktree', 'add', '-b', 'feature/owner-amend', worktree, 'main']);

  const runId = 'run-owner-amend';
  const stateRoot = path.join(worktree, '.tmp', 'pipelines');
  const artifactRoot = path.join(stateRoot, runId);
  await mkdir(artifactRoot, { recursive: true });

  const architecture = await frozen(artifactRoot, 'planning/architecture.md', '# architecture\n');
  const architectureReview = await frozen(artifactRoot, 'reviews/architecture.md', '# review\n');
  const requiredArtifacts = {
    decision_register: await frozen(artifactRoot, 'decision-register.md', '# decisions\n'),
    work_items: await frozen(artifactRoot, 'work-items/index.json', '{"schema":2}\n'),
  };
  const workItemArtifact = await frozen(
    artifactRoot,
    'work-items/WI-OWNER-1.json',
    JSON.stringify({ id: 'WI-OWNER-1', pipeline_id: 'onboarding', stage: 'implementation', suggested_agent: 'CoderAgent' }),
  );
  const deploymentTarget = await frozen(
    artifactRoot,
    'planning/deployment-target.json',
    JSON.stringify({
      status: 'READY',
      run_id: runId,
      kind: 'opencode_host',
      transport: 'github_ssh',
      target_id: 'opencode-development-host',
      environment: 'development',
      trusted_ref: 'main',
      workflow_run_id: 99,
      probe_job: 'probe_target',
    }, null, 2),
  );

  const manifest = {
    schema_version: 2,
    work_item_output_contract_version: 1,
    run_id: runId,
    rules_file: 'docs/pipeline-rules.md',
    rules_version: 2,
    planning_mode: 'design-freeze',
    planning_readiness: {
      design_freeze: true,
      required_gates: ['architecture'],
      gates: {
        architecture: {
          required: true,
          status: 'ready',
          cycles: 1,
          artifact: architecture,
          review: architectureReview,
          blocking_decision_ids: [],
        },
      },
      required_artifacts: requiredArtifacts,
    },
    open_decisions: [],
    planning_base_sha: base,
    allowed_change_paths: ['src/base.txt'],
    gate_profiles: {},
    git_setup: {
      base_sha: base,
      branch: 'feature/owner-amend',
      must_absent: [],
    },
    project_policy: {
      path: '.opencode/pipeline-policy.json',
      sha256: sha256(policyText),
    },
    deployment_target_check: deploymentTarget,
    pipelines: [{
      id: 'onboarding',
      deployable: true,
      stages: ['implementation', 'git-verify', 'publish', 'tests', 'dev', 'owner-acceptance'],
      executors: {
        implementation: 'agent',
        'git-verify': 'git_verify',
        publish: 'git_publish',
        tests: 'github_ci',
        dev: 'github_dev',
        'owner-acceptance': 'owner_acceptance',
      },
      deployment_validation: {
        stage: 'tests',
        fresh_job: 'fresh_install',
        upgrade_job: 'upgrade_install',
      },
      testing_strategy: {
        mode: 'opencode_host',
        owner_decision_id: 'decision-testing-strategy',
        github_validation_stage: 'tests',
        opencode_host_stage: 'dev',
        post_deploy_test: 'automated_then_user',
        owner_acceptance_stage: 'owner-acceptance',
      },
      github_gates: {
        tests: {
          workflow: '.github/workflows/ci.yml',
          terminal_job: 'pipeline_ci',
          required_jobs: ['fresh_install', 'upgrade_install'],
          trigger: 'push',
          artifact: 'candidate-build',
        },
        dev: {
          workflow: '.github/workflows/dev.yml',
          terminal_job: 'pipeline_dev',
          trigger: 'workflow_dispatch',
          mode: 'stateful',
          environment: 'development',
          trusted_ref: 'main',
          concurrency_group: 'development',
          target_id: 'opencode-development-host',
          source_ci_stage: 'tests',
          artifact: 'dev-evidence',
          evidence_file: 'dev-evidence.json',
        },
      },
      work_items: ['WI-OWNER-1'],
      decision_ids: ['decision-testing-strategy'],
      research_ids: [],
      contract_ids: [],
    }],
    work_items: [{
      id: 'WI-OWNER-1',
      pipeline_id: 'onboarding',
      ...workItemArtifact,
    }],
  };

  const manifestPath = path.join(artifactRoot, 'manifest.json');
  await writeFile(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`, 'utf8');
  return { root, worktree, runId, stateRoot, artifactRoot, manifestPath };
}

test('technical revision retains folder and approval until actual implementation start', async t => {
  const f=await fixture(); t.after(()=>rm(f.root,{recursive:true,force:true}));
  for(const args of [['init',f.manifestPath],['approve',f.runId,...await approvalArgs(f)]]) {
    const r=stage(f.worktree,[...args,'--state-root',f.stateRoot]); assert.equal(r.status,0,r.stderr);
  }
  const reviseCli=path.join(HERE,'pipeline-reconcile-cli.ts');
  const evidence=path.join(f.artifactRoot,'planning/revision-review.json');
  const originallyApprovedHash=sha256(await readFile(f.manifestPath,'utf8'));
  await writeFile(evidence,JSON.stringify({manifest_sha256:originallyApprovedHash,owner_contract_changed:false,affected_gates:[],reason:'Technical correction, approved behavior unchanged'}));
  const statePath=path.join(f.artifactRoot,'state.json');
  const approvedState=JSON.parse(await readFile(statePath,'utf8'));
  approvedState.github_outbox=[{id:'pipeline-status:onboarding:7:planned:approved',kind:'pipeline_status',pipeline_id:'onboarding',issue_numbers:[51],from_status:'planned',to_status:'approved',created_at:'2026-11-05T00:00:00.000Z',delivered_issue_numbers:[51]}];
  await writeFile(statePath,JSON.stringify(approvedState,null,2));
  let r=run(f.worktree,'npx',['--yes','tsx',reviseCli,'revise-plan',f.runId,'--evidence',evidence,'--state-root',f.stateRoot]);
  assert.equal(r.status,0,r.stderr);
  await appendFile(f.manifestPath,'\n');
  r=stage(f.worktree,['init',f.manifestPath,'--state-root',f.stateRoot]);assert.equal(r.status,0,r.stderr);
  const carriedState=JSON.parse(await readFile(path.join(f.artifactRoot,'state.json'),'utf8'));
  assert.equal(carriedState.status,'approved');
  assert.equal(carriedState.approval_record.shown_manifest_sha256, originallyApprovedHash);
  assert.notEqual(carriedState.approval_record.shown_manifest_sha256, carriedState.manifest_sha256);
  assert.equal(carriedState.approval_record.current_manifest_sha256, carriedState.manifest_sha256);
  assert.equal(carriedState.approval_record.owner_response, 'Approved final manifest for this run');
  assert.equal(carriedState.approval_record.message_id, 'msg_test_1');
  assert.deepEqual(carriedState.github_outbox, approvedState.github_outbox);
  r=stage(f.worktree,['start',f.runId,'implementation','--pipeline','onboarding','--state-root',f.stateRoot]);assert.equal(r.status,0,r.stderr);
  r=stage(f.worktree,['block',f.runId,'implementation','--pipeline','onboarding','--state-root',f.stateRoot]);assert.equal(r.status,0,r.stderr);
  r=run(f.worktree,'npx',['--yes','tsx',reviseCli,'revise-plan',f.runId,'--evidence',evidence,'--state-root',f.stateRoot]);
  assert.notEqual(r.status,0);assert.match(r.stderr,/IMPLEMENTATION_STARTED/);
  const oldState=await readFile(path.join(f.artifactRoot,'state.json'),'utf8');
  r=run(f.worktree,'npx',['--yes','tsx',reviseCli,'inherit-replan',f.runId,'--new-run','replanned','--state-root',f.stateRoot]);assert.equal(r.status,0,r.stderr);
  assert.equal(await readFile(path.join(f.artifactRoot,'state.json'),'utf8'),oldState);
  const inherited=JSON.parse(await readFile(path.join(f.stateRoot,'replanned/planning/inherited/lineage.json'),'utf8'));
  assert.equal(inherited.previous_run_id,f.runId);
  await assert.rejects(readFile(path.join(f.stateRoot,'replanned/state.json')),{code:'ENOENT'});
});

test('owner-contract-changing revision does not carry prior approval', async t => {
  const f=await fixture(); t.after(()=>rm(f.root,{recursive:true,force:true}));
  let r=stage(f.worktree,['init',f.manifestPath,'--state-root',f.stateRoot]);assert.equal(r.status,0,r.stderr);
  r=stage(f.worktree,['approve',f.runId,...await approvalArgs(f),'--state-root',f.stateRoot]);assert.equal(r.status,0,r.stderr);
  const evidence=path.join(f.artifactRoot,'planning/revision-owner-change.json');
  const hash=sha256(await readFile(f.manifestPath,'utf8'));
  await writeFile(evidence,JSON.stringify({manifest_sha256:hash,owner_contract_changed:true,affected_gates:[],reason:'Owner-visible behavior changed'}));
  const reconcile=path.join(HERE,'pipeline-reconcile-cli.ts');
  r=run(f.worktree,'npx',['--yes','tsx',reconcile,'revise-plan',f.runId,'--evidence',evidence,'--state-root',f.stateRoot]);assert.equal(r.status,0,r.stderr);
  await appendFile(f.manifestPath,'\n');
  r=stage(f.worktree,['init',f.manifestPath,'--state-root',f.stateRoot]);assert.equal(r.status,0,r.stderr);
  const revised=JSON.parse(await readFile(path.join(f.artifactRoot,'state.json'),'utf8'));
  assert.equal(revised.status,'planned');
  assert.equal(revised.approval_record,undefined);
});

test('final-manifest approval rejects wrong subject or hash before state mutation', async t => {
  const f=await fixture(); t.after(()=>rm(f.root,{recursive:true,force:true}));
  let result=stage(f.worktree,['init',f.manifestPath,'--state-root',f.stateRoot]);
  assert.equal(result.status,0,result.stderr);
  const valid=await approvalArgs(f);
  result=stage(f.worktree,['approve',f.runId,...valid.map((value,index)=>index===1?'scope-clarification':value),'--state-root',f.stateRoot]);
  assert.notEqual(result.status,0);
  assert.match(result.stderr,/FINAL_MANIFEST_APPROVAL_REQUIRED/);
  let state=JSON.parse(await readFile(path.join(f.artifactRoot,'state.json'),'utf8'));
  assert.equal(state.status,'planned');
  assert.equal(state.approval_record,undefined);

  const wrongHash=[...valid];
  wrongHash[wrongHash.indexOf('--approval-manifest-sha256')+1]='0'.repeat(64);
  result=stage(f.worktree,['approve',f.runId,...wrongHash,'--state-root',f.stateRoot]);
  assert.notEqual(result.status,0);
  assert.match(result.stderr,/FINAL_MANIFEST_APPROVAL_HASH_MISMATCH/);
  state=JSON.parse(await readFile(path.join(f.artifactRoot,'state.json'),'utf8'));
  assert.equal(state.status,'planned');

  for (const [field,value,error] of [
    ['--owner-response',' ','FINAL_MANIFEST_APPROVAL_RESPONSE_REQUIRED'],
    ['--approval-decision','rejected','FINAL_MANIFEST_APPROVAL_DECISION_REQUIRED'],
  ]) {
    const invalid=[...valid]; invalid[invalid.indexOf(field)+1]=value;
    result=stage(f.worktree,['approve',f.runId,...invalid,'--state-root',f.stateRoot]);
    assert.notEqual(result.status,0); assert.match(result.stderr,new RegExp(error));
    state=JSON.parse(await readFile(path.join(f.artifactRoot,'state.json'),'utf8'));
    assert.equal(state.status,'planned');
  }

  result=stage(f.worktree,['approve',f.runId,...valid,'--state-root',f.stateRoot]);
  assert.equal(result.status,0,result.stderr);
  state=JSON.parse(await readFile(path.join(f.artifactRoot,'state.json'),'utf8'));
  assert.equal(state.status,'approved');
  assert.equal(state.approval_record.subject,'final-manifest');
  assert.equal(state.approval_record.decision,'approved');
  result=stage(f.worktree,['approve',f.runId,'--state-root',f.stateRoot]);
  assert.notEqual(result.status,0);
  assert.match(result.stderr,/Cannot approve run while it is approved/);
});

test('final-manifest approval accepts a short explicit response without optional message correlation', async t => {
  const f=await fixture(); t.after(()=>rm(f.root,{recursive:true,force:true}));
  let result=stage(f.worktree,['init',f.manifestPath,'--state-root',f.stateRoot]);assert.equal(result.status,0,result.stderr);
  const args=(await approvalArgs(f,'Ок')).filter((value,index,all)=>value!=='--owner-message-id'&&value!=='msg_test_1'&&value!=='--owner-source-session'&&value!=='ses_test_1');
  result=stage(f.worktree,['approve',f.runId,...args,'--state-root',f.stateRoot]);assert.equal(result.status,0,result.stderr);
  const state=JSON.parse(await readFile(path.join(f.artifactRoot,'state.json'),'utf8'));
  assert.equal(state.approval_record.owner_response,'Ок');
  assert.equal(state.approval_record.message_id,undefined);
  assert.equal(state.approval_record.source_session,undefined);
});

test('new planned run cannot approve without an explicit audit descriptor', async t => {
  const f=await fixture(); t.after(()=>rm(f.root,{recursive:true,force:true}));
  let result=stage(f.worktree,['init',f.manifestPath,'--state-root',f.stateRoot]);assert.equal(result.status,0,result.stderr);
  result=stage(f.worktree,['approve',f.runId,'--state-root',f.stateRoot]);
  assert.notEqual(result.status,0);
  assert.match(result.stderr,/FINAL_MANIFEST_APPROVAL_REQUIRED/);
  const state=JSON.parse(await readFile(path.join(f.artifactRoot,'state.json'),'utf8'));
  assert.equal(state.status,'planned');
  assert.equal(state.approval_record,undefined);
});

test('legacy approved and in-progress states without approval record validate without backfill', async t => {
  for (const status of ['approved','in_progress']) {
    const f=await fixture(); t.after(()=>rm(f.root,{recursive:true,force:true}));
    let result=stage(f.worktree,['init',f.manifestPath,'--state-root',f.stateRoot]);assert.equal(result.status,0,result.stderr);
    const statePath=path.join(f.artifactRoot,'state.json');
    const state=JSON.parse(await readFile(statePath,'utf8'));
    state.status=status;
    for (const pipeline of Object.values(state.pipelines)) pipeline.status=status;
    delete state.approval_record;
    await writeFile(statePath,JSON.stringify(state,null,2));
    result=stage(f.worktree,['validate',f.runId,'--state-root',f.stateRoot]);assert.equal(result.status,0,result.stderr);
    const validated=JSON.parse(await readFile(statePath,'utf8'));
    assert.equal(validated.status,status);
    assert.equal(validated.approval_record,undefined);
  }
});

test('plan-start rejects a mismatched final-manifest hash before init creates state', async t => {
  const f=await fixture(); t.after(()=>rm(f.root,{recursive:true,force:true}));
  const valid=await approvalArgs(f);
  valid[valid.indexOf('--approval-manifest-sha256')+1]='0'.repeat(64);
  const result=stage(f.worktree,['plan-start',f.manifestPath,...valid,'--state-root',f.stateRoot]);
  assert.notEqual(result.status,0);
  assert.match(result.stderr,/FINAL_MANIFEST_APPROVAL_HASH_MISMATCH/);
  await assert.rejects(readFile(path.join(f.artifactRoot,'state.json')),{code:'ENOENT'});
});

test('owner can add a runtime unit between stages and dispatch it with immutable evidence', async t => {
  const f=await fixture(); t.after(()=>rm(f.root,{recursive:true,force:true}));
  for(const args of [['init',f.manifestPath],['approve',f.runId,...await approvalArgs(f)]]) {
    const r=stage(f.worktree,[...args,'--state-root',f.stateRoot]); assert.equal(r.status,0,r.stderr);
  }
  const unitArtifact=await frozen(f.artifactRoot,'work-items/runtime.json',JSON.stringify({role:'CoderAgent',summary:'Owner clarification',context_files:[],reference_files:[]}));
  const evidence=path.join(f.artifactRoot,'planning/owner-runtime.json');
  await writeFile(evidence,JSON.stringify({kind:'owner_amendment',status:'ready',bounded:true,pipeline_id:'onboarding',source_stage:'implementation',target_stage:'implementation',work_item_id:'WI-RUNTIME',new_work_item_required:true,work_items:[{id:'WI-RUNTIME',pipeline_id:'onboarding',...unitArtifact}],paths:['src/clarification.txt'],requirements_changed:true,acceptance_criteria_changed:true,business_intent_changed:false,external_contract_changed:false,security_boundary_changed:false,destructive_change:false}));
  let r=stage(f.worktree,['owner-amend-apply',f.runId,'implementation','--pipeline','onboarding','--evidence',evidence,'--state-root',f.stateRoot]);assert.equal(r.status,0,r.stderr);
  r=stage(f.worktree,['start',f.runId,'implementation','--pipeline','onboarding','--state-root',f.stateRoot]);assert.equal(r.status,0,r.stderr);
  r=stage(f.worktree,['dispatch',f.runId,'--pipeline','onboarding','--stage','implementation','--work-item','WI-RUNTIME','--role','CoderAgent']);assert.equal(r.status,0,r.stderr);
  const packet=JSON.parse(r.stdout);assert.equal(packet.work_item_id,'WI-RUNTIME');assert.ok(packet.effective_scope.includes('src/clarification.txt'));
  await writeFile(evidence,'tampered');
  r=stage(f.worktree,['dispatch',f.runId,'--pipeline','onboarding','--stage','implementation','--work-item','WI-RUNTIME','--role','CoderAgent']);assert.notEqual(r.status,0);assert.match(r.stderr,/OWNER_AMENDMENT_EVIDENCE_CHANGED/);
});

test('owner-amend-apply output is accepted by git verify and stays exact-path bounded', async (t) => {
  const f = await fixture();
  t.after(() => rm(f.root, { recursive: true, force: true }));

  let result = stage(f.worktree, ['init', f.manifestPath, '--state-root', f.stateRoot]);
  assert.equal(result.status, 0, result.stderr);
  result = stage(f.worktree, ['approve', f.runId, ...await approvalArgs(f), '--state-root', f.stateRoot]);
  assert.equal(result.status, 0, result.stderr);

  // This test isolates the machine handoff from an already-failed owner checkpoint.
  // The explicit owner acceptance lifecycle itself is covered by pipeline-v2-contract.test.mjs.
  const statePath = path.join(f.artifactRoot, 'state.json');
  const before = JSON.parse(await readFile(statePath, 'utf8'));
  before.status = 'blocked';
  before.current_stage = 'onboarding/owner-acceptance';
  before.pipelines.onboarding.status = 'blocked';
  before.pipelines.onboarding.current_stage = 'owner-acceptance';
  before.pipelines.onboarding.stages['owner-acceptance'].status = 'blocked';
  before.pipelines.onboarding.stages['owner-acceptance'].message = 'owner requested bounded correction';
  await writeFile(statePath, `${JSON.stringify(before, null, 2)}\n`, 'utf8');

  const amendmentPath = path.join(f.artifactRoot, 'owner', 'owner-amendment.json');
  await mkdir(path.dirname(amendmentPath), { recursive: true });
  await writeFile(amendmentPath, `${JSON.stringify({
    kind: 'owner_amendment',
    status: 'ready',
    bounded: true,
    pipeline_id: 'onboarding',
    source_stage: 'owner-acceptance',
    target_stage: 'implementation',
    work_item_id: 'WI-OWNER-1',
    new_work_item_required: false,
    summary: 'Allow one exact implementation path requested by owner acceptance',
    paths: ['src/amended.txt'],
    work_items: [],
    requirements_changed: true,
    acceptance_criteria_changed: true,
    business_intent_changed: false,
    external_contract_changed: false,
    security_boundary_changed: false,
    destructive_change: false,
  }, null, 2)}\n`, 'utf8');

  result = stage(f.worktree, [
    'owner-amend-apply', f.runId, 'owner-acceptance', '--pipeline', 'onboarding',
    '--evidence', amendmentPath, '--state-root', f.stateRoot,
  ]);
  assert.equal(result.status, 0, result.stderr);

  const state = JSON.parse(await readFile(statePath, 'utf8'));
  assert.equal(state.runtime_scope_extensions.length, 1);
  assert.equal(state.runtime_scope_extensions[0].scope_class, 'owner_amendment');
  assert.deepEqual(state.runtime_scope_extensions[0].paths, ['src/amended.txt']);
  assert.equal(state.pipelines.onboarding.stages.implementation.status, 'pending');
  assert.equal(state.pipelines.onboarding.stages['owner-acceptance'].status, 'pending');

  await writeFile(path.join(f.worktree, 'src/amended.txt'), 'owner-approved amendment\n');
  result = gitGate(f.worktree, ['verify', f.manifestPath]);
  assert.equal(result.status, 0, result.stderr);
  const verify = JSON.parse(result.stdout);
  assert.deepEqual(verify.changed_files, ['src/amended.txt']);

  const verifyEvidence = JSON.parse(await readFile(path.join(f.artifactRoot, 'git-verify.json'), 'utf8'));
  assert.equal(verifyEvidence.runtime_scope_extensions[0].scope_class, 'owner_amendment');
  assert.ok(verifyEvidence.effective_allowed_change_paths.includes('src/amended.txt'));

  await writeFile(path.join(f.worktree, 'src/outside.txt'), 'not owner approved\n');
  result = gitGate(f.worktree, ['verify', f.manifestPath]);
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /outside effective scope/);
});
