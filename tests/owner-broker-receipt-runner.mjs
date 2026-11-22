// Called only by real-UID owner broker integration tests through tsx.
import fs from 'node:fs';
import { buildOwnerCheckpoint, verifyOwnerCheckpointReceipt } from '../config/opencode/skills/task-management/scripts/owner-approval-checkpoint.ts';

const [mode, stateFile, operation, pipelineId='all', stage='approval', receipt=''] = process.argv.slice(2);
if (!mode || !stateFile || !operation) throw new Error('Usage: tuple|verify state.json operation [pipeline stage receipt]');
const state=JSON.parse(fs.readFileSync(stateFile,'utf8'));
if (mode==='tuple') {
  process.stdout.write(JSON.stringify(await buildOwnerCheckpoint(state,operation,pipelineId,stage))+'\n');
} else if (mode==='verify') {
  await verifyOwnerCheckpointReceipt(state,operation,receipt,pipelineId,stage);
  process.stdout.write('BROKER_RECEIPT_PASS\n');
} else throw new Error('Unsupported mode');
