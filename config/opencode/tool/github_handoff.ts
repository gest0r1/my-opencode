import { tool } from '@opencode-ai/plugin';
import {
  formatHandoffError,
  prepareHandoff,
  probeHandoff,
  publishHandoff,
  statusHandoff,
} from '../skills/task-management/scripts/github-handoff-core.ts';

function render(value: unknown): string {
  return JSON.stringify(value, null, 2);
}

async function run(action: () => Promise<unknown>): Promise<string> {
  try {
    return render(await action());
  } catch (error) {
    return render(formatHandoffError(error));
  }
}

export const probe = tool({
  description:
    'Read-only GitHub handoff transport probe. Verifies that the current OpenCode process can see the exact origin/handoff/<handoff-id> ref through Git credentials. Use it for deterministic diagnosis; do not substitute webfetch/raw GitHub URLs for private repositories.',
  args: {
    run_id: tool.schema.string(),
    handoff_id: tool.schema.string(),
    project_root: tool.schema.string().optional(),
  },
  async execute(args) {
    return run(() => probeHandoff(args.run_id, args.handoff_id, args.project_root));
  },
});

export const prepare = tool({
  description:
    'Prepare a deterministic GitHub validation handoff in-process. Probes and fetches handoff/<handoff-id>, validates exact source SHA/repository, checks out pipeline/<run-id>, and creates local validation runtime/manifest. A blocked result is authoritative; do not bypass it with free-form git or webfetch.',
  args: {
    run_id: tool.schema.string(),
    handoff_id: tool.schema.string(),
    project_root: tool.schema.string().optional(),
  },
  async execute(args) {
    return run(() => prepareHandoff(args.run_id, args.handoff_id, args.project_root));
  },
});

export const publish = tool({
  description:
    'Publish a completed GitHub validation run in-process. Commits only allowed-scope fixes, rejects sensitive/out-of-scope paths and non-fast-forward remote changes, pushes the validated SHA to the original source branch, and verifies the remote SHA.',
  args: {
    run_id: tool.schema.string(),
    project_root: tool.schema.string().optional(),
  },
  async execute(args) {
    return run(() => publishHandoff(args.run_id, args.project_root));
  },
});

export const status = tool({
  description:
    'Read deterministic GitHub handoff runtime status for a run, including source/validated SHA, current branch/HEAD and validation manifest path.',
  args: {
    run_id: tool.schema.string(),
    project_root: tool.schema.string().optional(),
  },
  async execute(args) {
    return run(() => statusHandoff(args.run_id, args.project_root));
  },
});
