import { Plugin } from '@opencode/plugin';
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

const probe = {
  name: "github_handoff_probe",
  options: { codemode: false },
  description:
    'Read-only GitHub handoff transport probe. Verifies that the current OpenCode process can see the exact origin/handoff/<handoff-id> ref through Git credentials. Use it for deterministic diagnosis; do not substitute webfetch/raw GitHub URLs for private repositories.',
  input: { type: "object", properties: { run_id: { type: "string" }, handoff_id: { type: "string" }, project_root: { type: "string" } }, required: ["run_id", "handoff_id"], additionalProperties: false },
  async execute(args: any) {
    return { content: await run(() => probeHandoff(args.run_id, args.handoff_id, args.project_root)) };
  },
};

const prepare = {
  name: "github_handoff_prepare",
  options: { codemode: false },
  description:
    'Prepare a deterministic GitHub validation handoff in-process. Probes and fetches handoff/<handoff-id>, validates exact source SHA/repository, checks out pipeline/<run-id>, and creates local validation runtime/manifest. A blocked result is authoritative; do not bypass it with free-form git or webfetch.',
  input: { type: "object", properties: { run_id: { type: "string" }, handoff_id: { type: "string" }, project_root: { type: "string" } }, required: ["run_id", "handoff_id"], additionalProperties: false },
  async execute(args: any) {
    return { content: await run(() => prepareHandoff(args.run_id, args.handoff_id, args.project_root)) };
  },
};

const publish = {
  name: "github_handoff_publish",
  options: { codemode: false },
  description:
    'Publish a completed GitHub validation run in-process. Commits only allowed-scope fixes, rejects sensitive/out-of-scope paths and non-fast-forward remote changes, pushes the validated SHA to the original source branch, and verifies the remote SHA.',
  input: { type: "object", properties: { run_id: { type: "string" }, project_root: { type: "string" } }, required: ["run_id"], additionalProperties: false },
  async execute(args: any) {
    return { content: await run(() => publishHandoff(args.run_id, args.project_root)) };
  },
};

const status = {
  name: "github_handoff_status",
  options: { codemode: false },
  description:
    'Read deterministic GitHub handoff runtime status for a run, including source/validated SHA, current branch/HEAD and validation manifest path.',
  input: { type: "object", properties: { run_id: { type: "string" }, project_root: { type: "string" } }, required: ["run_id"], additionalProperties: false },
  async execute(args: any) {
    return { content: await run(() => statusHandoff(args.run_id, args.project_root)) };
  },
};


export default Plugin.define({
  id: "github-handoff",
  setup: async (plugin) => {
    await plugin.tool.transform((editor) => {
      for (const definition of [probe, prepare, publish, status]) editor.add(definition);
    });
  },
});
