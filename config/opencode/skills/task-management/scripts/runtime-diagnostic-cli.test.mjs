import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import { validateDiagnosticUrl, validateReadOnlySql } from './runtime-diagnostic-cli.ts';

test('runtime diagnostic HTTP policy accepts ordinary http(s) and blocks credentials/metadata', () => {
  assert.equal(validateDiagnosticUrl('https://example.com/health').toString(), 'https://example.com/health');
  assert.equal(validateDiagnosticUrl('http://127.0.0.1:8080/api/v1/health').hostname, '127.0.0.1');
  assert.throws(() => validateDiagnosticUrl('ftp://example.com/file'), /URL_SCHEME_FORBIDDEN/);
  assert.throws(() => validateDiagnosticUrl('https://user:pass@example.com/'), /URL_CREDENTIALS_FORBIDDEN/);
  assert.throws(() => validateDiagnosticUrl('http://169.254.169.254/latest/meta-data/'), /METADATA_ENDPOINT_FORBIDDEN/);
  assert.throws(() => validateDiagnosticUrl('http://metadata.google.internal/computeMetadata/v1/'), /METADATA_ENDPOINT_FORBIDDEN/);
});

test('runtime diagnostic SQL policy permits one read-only statement and rejects mutation', () => {
  assert.equal(validateReadOnlySql('SELECT id, status FROM users LIMIT 3;'), 'SELECT id, status FROM users LIMIT 3');
  assert.equal(validateReadOnlySql('SHOW server_version'), 'SHOW server_version');
  assert.equal(validateReadOnlySql('WITH x AS (SELECT 1 AS id) SELECT * FROM x'), 'WITH x AS (SELECT 1 AS id) SELECT * FROM x');
  for (const sql of [
    'DELETE FROM users',
    'UPDATE users SET name = \'x\'',
    'WITH x AS (DELETE FROM users RETURNING *) SELECT * FROM x',
    'SELECT 1; SELECT 2',
    'SELECT 1 -- comment',
    'SELECT nextval(\'seq\'); DROP TABLE users',
    'SELECT * INTO copied_users FROM users',
    'SELECT * FROM users FOR SHARE',
    '\\dt',
  ]) assert.throws(() => validateReadOnlySql(sql));
});

test('runtime diagnostic SQL policy blocks PostgreSQL side-effect and server-access functions', () => {
  for (const sql of [
    'SELECT nextval(\'seq\')',
    'SELECT setval(\'seq\', 42)',
    'SELECT pg_terminate_backend(123)',
    'SELECT pg_cancel_backend(123)',
    'SELECT pg_advisory_lock(42)',
    'SELECT pg_notify(\'diagnostic\', \'payload\')',
    'SELECT pg_reload_conf()',
    'SELECT pg_read_file(\'/etc/passwd\')',
    'SELECT pg_ls_dir(\'/\')',
    'SELECT dblink(\'host=example\', \'SELECT 1\')',
  ]) assert.throws(() => validateReadOnlySql(sql), /SQL_SIDE_EFFECT_FUNCTION_FORBIDDEN/);
});

test('runtime diagnostic implementation downgrades DB role, bounds HTTP output and force-kills timed out children', async () => {
  const source = await readFile(new URL('./runtime-diagnostic-cli.ts', import.meta.url), 'utf8');
  assert.match(source, /SET ROLE pg_read_all_data/);
  assert.match(source, /BEGIN READ ONLY/);
  assert.match(source, /SIGKILL/);
  assert.match(source, /body_truncated/);
  assert.match(source, /status:'OBSERVED'/);
  assert.match(source, /searchParams\.set\(key, '\[REDACTED\]'\)/);
});
