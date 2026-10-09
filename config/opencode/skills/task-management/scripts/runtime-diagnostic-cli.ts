import { spawn } from 'node:child_process';
import { pathToFileURL } from 'node:url';
import process from 'node:process';

const MAX_CAPTURE = 256 * 1024;
const SAFE_NAME = /^[A-Za-z0-9][A-Za-z0-9_.-]{0,127}$/;
const SQL_WRITE = /\b(insert|update|delete|merge|copy|create|alter|drop|truncate|grant|revoke|vacuum|analyze|call|do|set|reset|begin|commit|rollback|savepoint|prepare|execute|deallocate|refresh|reindex|cluster|lock)\b/i;
const SQL_START = /^\s*(select|with|show)\b/i;

export class RuntimeDiagnosticError extends Error {}

function redact(value: string): string {
  return value
    .replace(/(postgres(?:ql)?:\/\/)[^\s@]+@/gi, '$1[REDACTED]@')
    .replace(/(authorization:\s*bearer\s+)[^\s]+/gi, '$1[REDACTED]')
    .replace(/((?:token|password|secret|api[_-]?key)\s*[=:]\s*)[^\s&]+/gi, '$1[REDACTED]');
}

export function validateDiagnosticUrl(raw: string): URL {
  let url: URL;
  try { url = new URL(raw); }
  catch { throw new RuntimeDiagnosticError('URL_INVALID'); }
  if (!['http:', 'https:'].includes(url.protocol)) throw new RuntimeDiagnosticError('URL_SCHEME_FORBIDDEN');
  if (url.username || url.password) throw new RuntimeDiagnosticError('URL_CREDENTIALS_FORBIDDEN');
  const host = url.hostname.toLowerCase().replace(/^\[|\]$/g, '');
  if (host === '169.254.169.254' || host === 'metadata.google.internal') {
    throw new RuntimeDiagnosticError('METADATA_ENDPOINT_FORBIDDEN');
  }
  return url;
}

export function validateReadOnlySql(raw: string): string {
  const sql = raw.trim();
  if (!sql) throw new RuntimeDiagnosticError('SQL_EMPTY');
  if (sql.includes('\0') || /--|\/\*|\*\/|\\/.test(sql)) throw new RuntimeDiagnosticError('SQL_UNSAFE_SYNTAX');
  const withoutTrailing = sql.endsWith(';') ? sql.slice(0, -1).trim() : sql;
  if (withoutTrailing.includes(';')) throw new RuntimeDiagnosticError('SQL_MULTIPLE_STATEMENTS');
  if (!SQL_START.test(withoutTrailing) || SQL_WRITE.test(withoutTrailing)) {
    throw new RuntimeDiagnosticError('SQL_READ_ONLY_REQUIRED');
  }
  return withoutTrailing;
}

function safePath(value: string, label: string): string {
  if (!value || value.includes('\0') || value.includes('\n') || value.includes('\r') || value.startsWith('-')) {
    throw new RuntimeDiagnosticError(`${label}_INVALID`);
  }
  return value;
}

function option(args: string[], name: string, required = false): string | undefined {
  const index = args.indexOf(name);
  const value = index < 0 ? undefined : args[index + 1];
  if (required && !value) throw new RuntimeDiagnosticError(`OPTION_REQUIRED: ${name}`);
  return value;
}

function runProcess(exe: string, args: string[], stdin?: string, timeoutMs = 15_000): Promise<{exit_code:number;stdout:string;stderr:string}> {
  return new Promise((resolvePromise, reject) => {
    const child = spawn(exe, args, { shell: false, stdio: ['pipe', 'pipe', 'pipe'] });
    let stdout = '';
    let stderr = '';
    const append = (current: string, chunk: unknown) => (current + String(chunk)).slice(0, MAX_CAPTURE);
    child.stdout.on('data', chunk => { stdout = append(stdout, chunk); });
    child.stderr.on('data', chunk => { stderr = append(stderr, chunk); });
    child.on('error', reject);
    const timer = setTimeout(() => child.kill('SIGTERM'), timeoutMs);
    child.on('close', code => {
      clearTimeout(timer);
      resolvePromise({ exit_code: code ?? 1, stdout: redact(stdout), stderr: redact(stderr) });
    });
    child.stdin.end(stdin ?? '');
  });
}

async function httpDiagnostic(method: 'GET'|'HEAD', rawUrl: string): Promise<void> {
  const url = validateDiagnosticUrl(rawUrl);
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 10_000);
  try {
    const response = await fetch(url, { method, redirect: 'manual', signal: controller.signal, headers: { 'user-agent': 'opencode-runtime-diagnostic/1' } });
    const body = method === 'HEAD' ? '' : (await response.text()).slice(0, MAX_CAPTURE);
    const headers = Object.fromEntries([...response.headers.entries()]
      .filter(([name]) => !['set-cookie', 'authorization', 'proxy-authorization'].includes(name.toLowerCase())));
    process.stdout.write(`${JSON.stringify({status:'PASS',kind:'http',method,url:url.toString(),http_status:response.status,headers,body:redact(body)},null,2)}\n`);
  } finally {
    clearTimeout(timer);
  }
}

async function postgresCompose(args: string[]): Promise<void> {
  const project = option(args, '--project', true)!;
  const service = option(args, '--service', true)!;
  const composeFile = safePath(option(args, '--compose-file', true)!, 'COMPOSE_FILE');
  const envFileRaw = option(args, '--env-file');
  const query = validateReadOnlySql(option(args, '--query', true)!);
  if (!SAFE_NAME.test(project)) throw new RuntimeDiagnosticError('PROJECT_INVALID');
  if (!SAFE_NAME.test(service)) throw new RuntimeDiagnosticError('SERVICE_INVALID');
  const dockerArgs = ['compose', '-p', project, '-f', composeFile];
  if (envFileRaw) dockerArgs.push('--env-file', safePath(envFileRaw, 'ENV_FILE'));
  dockerArgs.push(
    'exec', '-T',
    '-e', 'PGOPTIONS=-c default_transaction_read_only=on -c statement_timeout=5000',
    service,
    'sh', '-lc', 'exec psql -X -v ON_ERROR_STOP=1 -U "$POSTGRES_USER" -d "$POSTGRES_DB"',
  );
  const result = await runProcess('docker', dockerArgs, `${query};\n`, 15_000);
  const payload = {status: result.exit_code === 0 ? 'PASS' : 'FAIL', kind:'postgres-compose', project, service, exit_code:result.exit_code, stdout:result.stdout, stderr:result.stderr};
  process.stdout.write(`${JSON.stringify(payload,null,2)}\n`);
  if (result.exit_code !== 0) process.exitCode = 1;
}

export async function main(argv = process.argv.slice(2)): Promise<void> {
  const command = argv[0];
  if (command === 'http-get' || command === 'http-head') {
    if (!argv[1] || argv.length !== 2) throw new RuntimeDiagnosticError(`usage: runtime-diagnostic-cli.ts ${command} <url>`);
    await httpDiagnostic(command === 'http-get' ? 'GET' : 'HEAD', argv[1]);
    return;
  }
  if (command === 'postgres-compose') {
    await postgresCompose(argv.slice(1));
    return;
  }
  throw new RuntimeDiagnosticError('usage: runtime-diagnostic-cli.ts http-get|http-head <url> | postgres-compose --project <name> --compose-file <path> [--env-file <path>] --service <name> --query <read-only-sql>');
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
  main().catch(error => {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
  });
}
