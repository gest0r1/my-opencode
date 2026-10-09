import { spawn } from 'node:child_process';
import { pathToFileURL } from 'node:url';
import process from 'node:process';

const MAX_CAPTURE = 256 * 1024;
const SAFE_NAME = /^[A-Za-z0-9][A-Za-z0-9_.-]{0,127}$/;
const SQL_WRITE = /\b(insert|update|delete|merge|copy|create|alter|drop|truncate|grant|revoke|vacuum|analyze|call|do|set|reset|begin|commit|rollback|savepoint|prepare|execute|deallocate|refresh|reindex|cluster|lock|into)\b/i;
const SQL_ROW_LOCK = /\bfor\s+(?:update|no\s+key\s+update|share|key\s+share)\b/i;
const SQL_SIDE_EFFECT = /\b(?:nextval|setval|set_config|pg_notify|pg_terminate_backend|pg_cancel_backend|pg_reload_conf|pg_rotate_logfile|pg_switch_wal|pg_create_restore_point|pg_promote|pg_log_backend_memory_contexts|pg_read_file|pg_read_binary_file|pg_ls_dir|pg_stat_file|pg_ls_logdir|pg_ls_waldir|pg_ls_archive_statusdir|lo_import|lo_export|dblink\w*|pg_(?:try_)?advisory_(?:xact_)?(?:lock|unlock)(?:_shared|_all)?)\s*\(/i;
const SQL_START = /^\s*(select|with|show)\b/i;

export class RuntimeDiagnosticError extends Error {}

function redact(value: string): string {
  return value
    .replace(/(postgres(?:ql)?:\/\/)[^\s@]+@/gi, '$1[REDACTED]@')
    .replace(/(authorization:\s*(?:bearer|basic)\s+)[^\s]+/gi, '$1[REDACTED]')
    .replace(/((?:token|password|secret|api[_-]?key|access[_-]?key|client[_-]?secret)\s*[=:]\s*)[^\s&]+/gi, '$1[REDACTED]');
}

function displayUrl(url: URL): string {
  const copy = new URL(url.toString());
  for (const key of [...copy.searchParams.keys()]) copy.searchParams.set(key, '[REDACTED]');
  copy.hash = '';
  return copy.toString();
}

function safeHeaders(headers: Headers): Record<string, string> {
  const blocked = new Set(['set-cookie', 'cookie', 'authorization', 'proxy-authorization', 'x-api-key', 'x-auth-token']);
  return Object.fromEntries([...headers.entries()]
    .filter(([name]) => !blocked.has(name.toLowerCase()))
    .map(([name, value]) => [name, redact(value)]));
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
  if (!SQL_START.test(withoutTrailing) || SQL_WRITE.test(withoutTrailing) || SQL_ROW_LOCK.test(withoutTrailing)) {
    throw new RuntimeDiagnosticError('SQL_READ_ONLY_REQUIRED');
  }
  if (SQL_SIDE_EFFECT.test(withoutTrailing)) {
    throw new RuntimeDiagnosticError('SQL_SIDE_EFFECT_FUNCTION_FORBIDDEN');
  }
  return withoutTrailing;
}

function safePath(value: string, label: string): string {
  if (!value || value.startsWith('/') || value.startsWith('-') || value.includes('\\') || /[\0\r\n]/.test(value) ||
      value.split('/').some(part => part === '..' || part === '.git')) {
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

type ProcessResult = {exit_code:number;stdout:string;stderr:string;timed_out:boolean};

function runProcess(exe: string, args: string[], stdin?: string, timeoutMs = 15_000): Promise<ProcessResult> {
  return new Promise((resolvePromise, reject) => {
    const child = spawn(exe, args, { shell: false, stdio: ['pipe', 'pipe', 'pipe'], detached: process.platform !== 'win32' });
    let stdout = '';
    let stderr = '';
    let timedOut = false;
    let killTimer: ReturnType<typeof setTimeout> | undefined;
    const append = (current: string, chunk: unknown) => (current + String(chunk)).slice(0, MAX_CAPTURE);
    const terminate = (signal: NodeJS.Signals) => {
      try {
        if (process.platform !== 'win32' && child.pid) process.kill(-child.pid, signal);
        else child.kill(signal);
      } catch {}
    };
    child.stdout.on('data', chunk => { stdout = append(stdout, chunk); });
    child.stderr.on('data', chunk => { stderr = append(stderr, chunk); });
    child.on('error', reject);
    const timer = setTimeout(() => {
      timedOut = true;
      terminate('SIGTERM');
      killTimer = setTimeout(() => terminate('SIGKILL'), 3_000);
    }, timeoutMs);
    child.on('close', code => {
      clearTimeout(timer);
      if (killTimer) clearTimeout(killTimer);
      resolvePromise({ exit_code: timedOut ? 124 : code ?? 1, stdout: redact(stdout), stderr: redact(stderr), timed_out: timedOut });
    });
    child.stdin.end(stdin ?? '');
  });
}

async function boundedBody(response: Response): Promise<{body:string;truncated:boolean}> {
  if (!response.body) return { body: '', truncated: false };
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let body = '';
  let bytes = 0;
  let truncated = false;
  try {
    while (bytes < MAX_CAPTURE) {
      const { done, value } = await reader.read();
      if (done) break;
      const remaining = MAX_CAPTURE - bytes;
      const slice = value.byteLength > remaining ? value.subarray(0, remaining) : value;
      bytes += slice.byteLength;
      body += decoder.decode(slice, { stream: true });
      if (value.byteLength > remaining) {
        truncated = true;
        await reader.cancel();
        break;
      }
    }
    body += decoder.decode();
    return { body: redact(body), truncated };
  } finally {
    reader.releaseLock();
  }
}

async function httpDiagnostic(method: 'GET'|'HEAD', rawUrl: string): Promise<void> {
  const url = validateDiagnosticUrl(rawUrl);
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 10_000);
  try {
    const response = await fetch(url, { method, redirect: 'manual', signal: controller.signal, headers: { 'user-agent': 'opencode-runtime-diagnostic/1' } });
    const body = method === 'HEAD' ? { body: '', truncated: false } : await boundedBody(response);
    process.stdout.write(`${JSON.stringify({status:'OBSERVED',kind:'http',method,url:displayUrl(url),transport_ok:true,http_status:response.status,http_ok:response.ok,headers:safeHeaders(response.headers),body:body.body,body_truncated:body.truncated},null,2)}\n`);
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
  const script = [
    'SET ROLE pg_read_all_data;',
    'BEGIN READ ONLY;',
    "SET LOCAL statement_timeout = '5s';",
    `${query};`,
    'ROLLBACK;',
    '',
  ].join('\n');
  const result = await runProcess('docker', dockerArgs, script, 15_000);
  const payload = {status:'OBSERVED',kind:'postgres-compose',project,service,query_ok:result.exit_code === 0,exit_code:result.exit_code,timed_out:result.timed_out,read_identity:'pg_read_all_data',stdout:result.stdout,stderr:result.stderr};
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
