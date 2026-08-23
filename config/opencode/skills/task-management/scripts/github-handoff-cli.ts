#!/usr/bin/env node

import {
  formatHandoffError,
  prepareHandoff,
  probeHandoff,
  publishHandoff,
  statusHandoff,
} from './github-handoff-core.ts';

function usage(): never {
  throw new Error(
    [
      'Usage:',
      '  github-handoff-cli.ts probe <run-id> <handoff-id>',
      '  github-handoff-cli.ts prepare <run-id> <handoff-id>',
      '  github-handoff-cli.ts publish <run-id>',
      '  github-handoff-cli.ts status <run-id>',
    ].join('\n'),
  );
}

async function main(): Promise<void> {
  const [command, runId, handoffId, ...extra] = process.argv.slice(2);
  if (!command || !runId || extra.length) usage();

  let result: unknown;
  if (command === 'probe') {
    if (!handoffId) usage();
    result = await probeHandoff(runId, handoffId);
  } else if (command === 'prepare') {
    if (!handoffId) usage();
    result = await prepareHandoff(runId, handoffId);
  } else if (command === 'publish') {
    if (handoffId) usage();
    result = await publishHandoff(runId);
  } else if (command === 'status') {
    if (handoffId) usage();
    result = await statusHandoff(runId);
  } else {
    usage();
  }

  process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
}

main().catch((error) => {
  process.stderr.write(`${JSON.stringify(formatHandoffError(error))}\n`);
  process.exitCode = 1;
});
