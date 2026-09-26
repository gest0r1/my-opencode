// Shared deterministic gate parser and invocation policy.
export function tokenizeGateCommand(command) {
  if (typeof command !== 'string' || !command.trim() || /[\n\r\0]/.test(command)) {
    throw new Error('empty or multiline gate command is forbidden');
  }
  if (/[;&|<>`]/.test(command) || /\$\(/.test(command)) {
    throw new Error('shell composition, redirects and substitution are forbidden');
  }
  const tokens = [];
  let current = '';
  let quote;
  let escaped = false;
  const push = () => { if (current) tokens.push(current); current = ''; };
  for (const char of command) {
    if (escaped) { current += char; escaped = false; continue; }
    if (char === '\\' && quote !== "'") { escaped = true; continue; }
    if (quote) { if (char === quote) quote = undefined; else current += char; continue; }
    if (char === "'" || char === '"') { quote = char; continue; }
    if (/\s/.test(char)) push(); else current += char;
  }
  if (escaped || quote) throw new Error('unterminated escape or quote');
  push();
  if (!tokens.length) throw new Error('gate command has no executable');
  return tokens;
}

function safeRelativePath(value) {
  return Boolean(value) && !value.startsWith('/') && !value.includes('\\') &&
    !value.split('/').some((part) => part === '..' || part === '.git');
}

function isRuntimeGate(gate) {
  return /(runtime|deploy|release|smoke|install)/i.test(gate);
}

export function isFrozenUvPytest(tokens) {
  const [exe, ...args] = tokens;
  if (exe !== 'uv' || args[0] !== 'run' || args[1] !== '--frozen') return false;
  const nested = args.slice(2);
  return nested[0] === 'pytest' ||
    (nested[0] === 'python' && nested[1] === '-m' && nested[2] === 'pytest');
}

// Return a reason instead of throwing so both preflight and runner preserve identical policy.
export function gatePolicyError(tokens, gate) {
  const [exe, ...args] = tokens;
  if (!exe) return 'missing executable';
  if (exe === 'bash') {
    if (args[0] === '-n' && args.length >= 2 && safeRelativePath(args[1])) return;
    if (isRuntimeGate(gate) && args.length >= 1 && safeRelativePath(args[0]) && !args[0]?.startsWith('-')) return;
    return 'bash is allowed only for -n checks or an approved repository script in a runtime gate';
  }
  if (exe === 'uv') {
    if (isFrozenUvPytest(tokens)) return;
    return 'uv is allowed only as "uv run --frozen pytest …" or "uv run --frozen python -m pytest …"';
  }
  if (exe === 'pytest') return;
  if ((exe === 'python' || exe === 'python3') && args[0] === '-m' && args[1] === 'pytest') return;
  if (exe === 'tsc' || exe === 'mypy') return;
  if (exe === 'npx' && (args[0] === '--yes' ? ['tsc', 'vitest', 'jest'].includes(args[1] ?? '') : ['tsc', 'vitest', 'jest'].includes(args[0] ?? ''))) return;
  if (exe === 'npm' && (args[0] === 'test' || (args[0] === 'run' && ['test', 'build', 'typecheck', 'lint'].includes(args[1] ?? '')))) return;
  if (exe === 'pnpm' && (args[0] === 'test' || (args[0] === 'run' && ['test', 'build', 'typecheck', 'lint'].includes(args[1] ?? '')) || (args[0] === 'exec' && ['tsc', 'vitest'].includes(args[1] ?? '')))) return;
  if (exe === 'corepack' && args[0] === 'pnpm') return gatePolicyError(['pnpm', ...args.slice(1)], gate);
  if (exe === 'yarn' && ['test', 'build', 'lint'].includes(args[0] ?? '')) return;
  if (exe === 'bun' && args[0] === 'test') return;
  if (exe === 'go' && ['test', 'build'].includes(args[0] ?? '')) return;
  if (exe === 'cargo' && ['test', 'check', 'build'].includes(args[0] ?? '')) return;
  if (exe === 'docker') {
    if (args[0] === 'pull' || args[0] === 'inspect' || (args[0] === 'image' && args[1] === 'inspect')) return;
    if (args[0] === 'compose') {
      const subcommands = new Set(['config', 'ps', 'build', 'pull', 'up', 'restart']);
      const subcommand = args.find((arg) => subcommands.has(arg));
      if (subcommand === 'config' || subcommand === 'ps' || subcommand === 'pull') return;
      if (isRuntimeGate(gate) && (subcommand === 'build' || subcommand === 'up' || subcommand === 'restart')) return;
    }
    return 'docker invocation is outside the safe gate policy';
  }
  if (exe === 'curl') {
    const forbidden = new Set(['-o', '--output', '-O', '--remote-name', '-d', '--data', '--data-raw', '-T', '--upload-file', '-X', '--request']);
    if (args.some((arg) => forbidden.has(arg))) return 'curl mutation/output options are forbidden';
    if (args.some((arg) => /^https?:\/\//.test(arg))) return;
  }
  return `executable is outside deterministic gate policy: ${exe}`;
}
