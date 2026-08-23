#!/usr/bin/env node

import {
  formatHandoffError,
  prepareHandoff,
  probeHandoff,
  publishHandoff,
  statusHandoff,
} from './github-handoff-core.ts';

function parseArgs(argv: string[]): { command: string; runId: string; handoffId?: string; projectRoot?: string } {
  const args = argv.slice(2);
  let projectRoot: string | undefined;
  const positional: string[] = [];

  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--project-root' && i + 1 < args.length) {
      projectRoot = args[++i];
    } else {
      positional.push(args[i]);
    }
  }

  const [command, runId, handoffId] = positional;
  return { command: command ?? '', runId: runId ?? '', handoffId, projectRoot };
}

function usage(): never {
  throw new Error(
    [
      'Usage:',
      '  github-handoff-cli.ts [--project-root <path>] probe <run-id> <handoff-id>',
      '  github-handoff-cli.ts [--project-root <path>] prepare <run-id> <handoff-id>',
      '  github-handoff-cli.ts [--project-root <path>] publish <run-id>',
      '  github-handoff-cli.ts [--project-root <path>] status <run-id>',
    ].join('\n'),
  );
}

async function main(): Promise<void> {
  const { command, runId, handoffId, projectRoot: cliRoot } = parseArgs(process.argv);
  if (!command || !runId) usage();

  const projectRoot = cliRoot ?? process.env.PIPELINE_PROJECT_ROOT;

  let result: unknown;
  if (command === 'probe') {
    if (!handoffId) usage();
    result = await probeHandoff(runId, handoffId, projectRoot);
  } else if (command === 'prepare') {
    if (!handoffId) usage();
    result = await prepareHandoff(runId, handoffId, projectRoot);
  } else if (command === 'publish') {
    if (handoffId) usage();
    result = await publishHandoff(runId, projectRoot);
  } else if (command === 'status') {
    if (handoffId) usage();
    result = await statusHandoff(runId, projectRoot);
  } else {
    usage();
  }

  process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
}

main().catch((error) => {
  process.stderr.write(`${JSON.stringify(formatHandoffError(error))}\n`);
  process.exitCode = 1;
});
