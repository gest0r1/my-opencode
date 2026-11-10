import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {spawnSync} from 'node:child_process';
const migrate = new URL('../scripts/migrate-claude-provider.mjs', import.meta.url).pathname;
const verify = new URL('../scripts/verify-claude-models.mjs', import.meta.url).pathname;
test('legacy Claude IDs migrate but keep exact model and variant across JSON and Markdown', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'claude-migrate-')); const report = path.join(dir, 'migrate.json');
  try {
    fs.mkdirSync(path.join(dir, 'agents'));
    fs.writeFileSync(path.join(dir, 'opencode.json'), '{"model":"claude-code/claude-sonnet-5#high","plugins":[]}');
    fs.writeFileSync(path.join(dir, 'agents', 'A.md'), '---\nname: A\nmodel: claude-code/claude-opus-5#max\nvariant: max\n---\nkeep body\n');
    fs.writeFileSync(path.join(dir, 'agents', 'B.md'), '---\nname: B\nmodel: my-provider/custom\n---\nkeep\n');
    const result = spawnSync(process.execPath, [migrate,dir,report], {encoding:'utf8'});
    assert.equal(result.status,0,result.stderr);
    assert.equal(JSON.parse(fs.readFileSync(path.join(dir,'opencode.json'))).model,'claude-agent/claude-sonnet-5#high');
    assert.match(fs.readFileSync(path.join(dir,'agents','A.md'),'utf8'),/model: "claude-agent\/claude-opus-5#max"/);
    assert.match(fs.readFileSync(path.join(dir,'agents','A.md'),'utf8'),/variant: max[\s\S]*keep body/);
    assert.match(fs.readFileSync(path.join(dir,'agents','B.md'),'utf8'),/my-provider\/custom/);
    const expected=JSON.parse(fs.readFileSync(report,'utf8'));
    assert.deepEqual(expected,['claude-agent/claude-opus-5','claude-agent/claude-sonnet-5']);
    const good=spawnSync(process.execPath,[verify,report],{encoding:'utf8',input:expected.join('\n')+'\n'});
    assert.equal(good.status,0,good.stderr);
    const bad=spawnSync(process.execPath,[verify,report],{encoding:'utf8',input:'claude-agent/claude-opus-5\n'});
    assert.equal(bad.status,2);
    assert.match(bad.stderr,/CLAUDE_NATIVE_MIGRATION_BLOCKED/);
    assert.ok(!bad.stderr.includes('refresh_token'));
    const repeat=spawnSync(process.execPath,[migrate,dir,report],{encoding:'utf8'});
    assert.equal(repeat.status,0,repeat.stderr);
    assert.deepEqual(JSON.parse(fs.readFileSync(report,'utf8')),[]);
  } finally {fs.rmSync(dir,{recursive:true});}
});
test('object global model migrates provider only; no exact ID invention', () => {
 const dir=fs.mkdtempSync(path.join(os.tmpdir(),'claude-object-'));
 try {fs.writeFileSync(path.join(dir,'opencode.json'),JSON.stringify({model:{providerID:'claude-code',model:'claude-opus-5',variant:'high'}}));
 const report=path.join(dir,'report.json'); assert.equal(spawnSync(process.execPath,[migrate,dir,report]).status,0);
 assert.deepEqual(JSON.parse(fs.readFileSync(path.join(dir,'opencode.json'))).model,{providerID:'claude-agent',model:'claude-opus-5',variant:'high'});
 } finally {fs.rmSync(dir,{recursive:true});}
});
