// Stable CLI entry point. Keep core stage/DAG/state implementation untouched and
// reject non-executable machine gates BEFORE init creates any state or approve mutates it.
export * from './stage-cli-core.ts';
import { readFile } from 'node:fs/promises';
import { resolve, join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { runCli } from './stage-cli-core.ts';
import { preflightFile } from './manifest-preflight.mjs';

function stateRootFromArgs(args: string[]): string {
  const index = args.indexOf('--state-root');
  return index < 0 ? '.tmp/pipelines' : (args[index + 1] ?? '.tmp/pipelines');
}

async function main(args: string[]): Promise<void> {
  const [command, identifier] = args;
  if (command === 'preflight') {
    if (!identifier || args.some((arg, index) => index > 1 && arg !== '--environment')) {
      throw new Error('usage: stage-cli preflight <manifest.json> [--environment]');
    }
    const result = await preflightFile(resolve(identifier), { environment: args.includes('--environment') });
    console.log(JSON.stringify(result));
    return;
  }
  if (command === 'init') {
    if (!identifier) throw new Error('manifest path is required');
    // No state files are created until every gate and the actual pytest executable
    // have passed validation. Python dependencies are never installed implicitly.
    await preflightFile(resolve(identifier), { environment: true });
  }
  if (command === 'approve') {
    if (!identifier) throw new Error('run-id is required');
    const state = JSON.parse(await readFile(join(resolve(stateRootFromArgs(args)), identifier, 'state.json'), 'utf8'));
    if (!state.manifest_file) throw new Error('approved manifest path is missing');
    await preflightFile(state.manifest_file, { environment: true });
  }
  await runCli(args);
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
  main(process.argv.slice(2)).catch((error: unknown) => {
    console.error(`stage-cli: ${error instanceof Error ? error.message : String(error)}`);
    process.exitCode = 1;
  });
}
