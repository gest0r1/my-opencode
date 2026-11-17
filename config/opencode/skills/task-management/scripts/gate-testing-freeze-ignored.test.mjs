import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, symlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { freezeGateTesting } from './gate-testing-freeze.mjs';
import { resolveGateTestingFile, selectAffectedCommands } from './gate-testing-policy.mjs';
import { readFileSync } from 'node:fs';

function fixture(run) {
  const cwd=mkdtempSync(path.join(tmpdir(),'ignored-freeze-'));
  try {
    const make=(relative,content)=>{
      const file=path.join(cwd,relative);
      mkdirSync(path.dirname(file),{recursive:true});
      writeFileSync(file,content);
      return file;
    };
    const runDir=path.join(cwd,'.tmp/pipelines/run');
    const commands=['pnpm exec vitest run --config vitest.api.ts'];
    const manifestPath=make('.tmp/pipelines/run/manifest.json',JSON.stringify({
      schema_version:2,run_id:'run',
      gate_profiles:{local:{'release-check':commands}},
      gate_testing:{local:{'release-check':{input_kind:'tree'}}},
      pipelines:[{id:'api',profile:'local',stages:['release-check'],executors:{'release-check':'local_gate'}}],
    }));
    make('maps/impact.json',JSON.stringify({impact_groups:[{inputs:['apps/api/**'],command_index:0}]}));
    make('maps/commands.json',JSON.stringify({gate_profiles:{local:{'release-check':commands}}}));
    const ignored=make('maps/ignored.json',JSON.stringify(['docs/archive/note.md']));
    const git=(...args)=>spawnSync('git',args,{cwd,encoding:'utf8'});
    assert.equal(git('init','-q').status,0);
    return run({cwd,make,git,manifestPath,ignored,commands});
  } finally {rmSync(cwd,{recursive:true,force:true});}
}
function freeze(fx){
  return freezeGateTesting({manifestPath:fx.manifestPath,profile:'local',gate:'release-check',
    source:'maps/impact.json',commands:'maps/commands.json',ignored:'maps/ignored.json',cwd:fx.cwd});
}
test('O8 freeze binds a reviewed, existing tracked exact path to SHA-checked snapshot',()=>fixture(fx=>{
  fx.make('docs/archive/note.md','a harmless historical note');
  assert.equal(fx.git('add','docs/archive/note.md').status,0);
  const result=freeze(fx);
  assert.equal(result.status,'PASS');
  const m=resolveGateTestingFile(JSON.parse(readFileSync(fx.manifestPath,'utf8')),fx.manifestPath);
  const selected=selectAffectedCommands(fx.commands,m.gate_testing.local['release-check'],
    ['docs/archive/note.md'],[],{verifiedBaseline:true});
  assert.deepEqual(selected.selected,[]);
  assert.equal(selected.reason,'only verified ignored inputs changed');
}));
test('O8 freeze cannot whitelist nonexistent, untracked or symlinked exact documents',()=>fixture(fx=>{
  assert.throws(()=>freeze(fx),/GATE_TESTING_FREEZE_IGNORED_MISSING/);
  fx.make('docs/archive/note.md','untracked');
  assert.throws(()=>freeze(fx),/GATE_TESTING_FREEZE_IGNORED_NOT_TRACKED/);
  assert.equal(fx.git('add','docs/archive/note.md').status,0);
  rmSync(path.join(fx.cwd,'docs/archive/note.md'));
  symlinkSync('/tmp/foreign-ignored-doc',path.join(fx.cwd,'docs/archive/note.md'));
  assert.throws(()=>freeze(fx),/GATE_TESTING_FREEZE_IGNORED_NOT_REGULAR/);
}));
test('O8 an exact data or executable document path never reduces tests',()=>fixture(fx=>{
  fx.make('maps/ignored.json',JSON.stringify(['docs/archive/config.json']));
  assert.equal(freeze(fx).status,'PASS'); // conservative frozen legacy fallback
  const m=resolveGateTestingFile(JSON.parse(readFileSync(fx.manifestPath,'utf8')),fx.manifestPath);
  const selected=selectAffectedCommands(fx.commands,m.gate_testing.local['release-check'],
    ['docs/archive/config.json'],[],{verifiedBaseline:true});
  assert.equal(selected.selected.length,1);
  assert.match(selected.reason,/requires frozen verified exact paths/);
}));
test('O8 legacy glob still freezes but must choose full checks',()=>fixture(fx=>{
  fx.make('maps/ignored.json',JSON.stringify(['docs/**']));
  assert.equal(freeze(fx).status,'PASS');
  const m=resolveGateTestingFile(JSON.parse(readFileSync(fx.manifestPath,'utf8')),fx.manifestPath);
  const selected=selectAffectedCommands(fx.commands,m.gate_testing.local['release-check'],
    ['docs/archive/note.md'],[],{verifiedBaseline:true});
  assert.equal(selected.selected.length,1);
  assert.match(selected.reason,/requires frozen verified exact paths/);
}));
