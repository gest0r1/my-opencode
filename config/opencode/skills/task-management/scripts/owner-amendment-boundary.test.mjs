import assert from 'node:assert/strict';
import test from 'node:test';
import { implementationStarted, hasActiveStages } from './plan-lifecycle.ts';
const manifest = { pipelines: [{ id: 'app', stages: ['review','implementation'], executors: { review:'review', implementation:'agent' } }] };
test('legacy in_progress without any implementation start remains editable', () => {
  assert.equal(implementationStarted({status:'in_progress', active_stages:[], history:[], pipelines:{app:{stages:{implementation:{status:'pending'}}}}}, manifest), false);
});
test('review/preflight does not freeze PLAN, implementation start does', () => {
  const state={history:[{pipeline_id:'app',stage:'review',status:'in_progress'}],pipelines:{app:{stages:{implementation:{status:'pending'}}}}};
  assert.equal(implementationStarted(state, manifest),false);
  state.history.push({pipeline_id:'app',stage:'implementation',status:'in_progress'});
  assert.equal(implementationStarted(state, manifest),true);
});
test('activity follows real stages rather than aggregate run status', () => {
  assert.equal(hasActiveStages({status:'in_progress',active_stages:[]}),false);
  assert.equal(hasActiveStages({active_stages:[],pipelines:{app:{stages:{implementation:{status:'in_progress'}}}}}),true);
});
