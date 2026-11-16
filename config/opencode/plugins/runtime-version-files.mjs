// OpenCode V2 loads plural commands/agents. Source checkout still uses singular roots.
// Only a repository checkout with its canonical installer marker may use source paths.
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';

const sha256 = value => createHash('sha256').update(value).digest('hex');
export function runtimeFiles(pluginUrl) {
  const url = value => fileURLToPath(new URL(value, pluginUrl));
  const source = fs.existsSync(url('../../../scripts/install-opencode-generation.sh'))
    && fs.existsSync(url('../command/pipeline-run.md'))
    && fs.existsSync(url('../agent/core/openstage-orchestrator.md'));
  return [
    url('./pipeline-runtime.ts'),
    url('./runtime-version-files.mjs'),
    url('../skills/task-management/scripts/pipeline-dispatch.ts'),
    url(source ? '../command/pipeline-run.md' : '../commands/pipeline-run.md'),
    url('../skills/task-management/run-worker-rules.md'),
    url(source ? '../agent/core/openstage-orchestrator.md' : '../agents/OpenStageOrchestrator.md'),
  ];
}
export function missingRuntimeFiles(files) {
  return files.filter(file => {
    try { return !fs.statSync(file).isFile(); } catch { return true; }
  });
}
export function fingerprintRuntimeFiles(files) {
  return sha256(files.map(file => {
    try { return `${file}:${sha256(fs.readFileSync(file))}`; }
    catch { return `${file}:missing-required-runtime-file`; }
  }).join('\n'));
}
