import { tool } from '@opencode-ai/plugin';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const helper = fileURLToPath(
  new URL('../skills/task-management/scripts/github-handoff-cli.ts', import.meta.url),
);

function run(args: string[]): string {
  try {
    return execFileSync('bun', [helper, ...args], {
      cwd: process.cwd(),
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
      timeout: 120_000,
    }).trim();
  } catch (error: any) {
    const stderr = String(error?.stderr ?? '').trim();
    const stdout = String(error?.stdout ?? '').trim();
    throw new Error(stderr || stdout || `github-handoff helper failed: ${args.join(' ')}`);
  }
}

export const prepare = tool({
  description:
    'Prepare a deterministic GitHub validation handoff. Fetches handoff/<handoff-id>, validates exact source SHA/repository, checks out pipeline/<run-id>, and creates local validation runtime/manifest.',
  args: {
    run_id: tool.schema.string(),
    handoff_id: tool.schema.string(),
  },
  async execute(args) {
    return run(['prepare', args.run_id, args.handoff_id]);
  },
});

export const publish = tool({
  description:
    'Publish a completed GitHub validation run. Commits only allowed-scope fixes, rejects sensitive/out-of-scope paths and non-fast-forward remote changes, pushes the validated SHA to the original source branch, and verifies the remote SHA.',
  args: {
    run_id: tool.schema.string(),
  },
  async execute(args) {
    return run(['publish', args.run_id]);
  },
});

export const status = tool({
  description:
    'Read deterministic GitHub handoff runtime status for a run, including source/validated SHA, current branch/HEAD and validation manifest path.',
  args: {
    run_id: tool.schema.string(),
  },
  async execute(args) {
    return run(['status', args.run_id]);
  },
});
