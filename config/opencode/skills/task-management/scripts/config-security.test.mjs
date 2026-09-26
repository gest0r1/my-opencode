import assert from 'node:assert/strict';
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import test from 'node:test';

const root = process.cwd();
const configPath = join(root, 'config/opencode/opencode.json');
const config = JSON.parse(readFileSync(configPath, 'utf8'));

const allowedMcp = [
  'context7',
  'gh_grep',
  'exa',
  'yadisk',
  'memory',
  '1c-buddy',
].sort();

const retiredMcp = [
  'yonote',
  'exchange',
  'bitrix24',
  'n8n',
  'ya-metrika',
  'itop',
  'google-drive',
  'image-gen',
];

const secretKey = /(token|secret|api.?key|password|authorization|credential|refresh.?token)/i;
const envRef = /^\{env:[A-Z][A-Z0-9_]*\}$/;

function collectSecretFields(value, path = [], out = []) {
  if (!value || typeof value !== 'object') return out;
  for (const [key, child] of Object.entries(value)) {
    const next = [...path, key];
    if (typeof child === 'string' && secretKey.test(key) && !next.includes('permission')) {
      out.push({ path: next.join('.'), value: child });
      continue;
    }
    if (child && typeof child === 'object') collectSecretFields(child, next, out);
  }
  return out;
}

function filesUnder(dir) {
  if (!existsSync(dir)) return [];
  const out = [];
  for (const entry of readdirSync(dir)) {
    const path = join(dir, entry);
    if (statSync(path).isDirectory()) out.push(...filesUnder(path));
    else out.push(path);
  }
  return out;
}

test('distribution exposes only the approved MCP allowlist', () => {
  assert.deepEqual(Object.keys(config.mcp ?? {}).sort(), allowedMcp);
  for (const name of retiredMcp) {
    assert.equal(config.mcp?.[name], undefined, `retired MCP must stay absent: ${name}`);
  }
});

test('all credential-like config fields are runtime env references', () => {
  const findings = collectSecretFields(config);
  assert.ok(findings.length > 0, 'expected retained integrations to use env-backed credentials');
  for (const finding of findings) {
    assert.match(
      finding.value,
      envRef,
      `${finding.path} must use {env:NAME}, never a literal credential`,
    );
  }
});

test('legacy secret-bearing env template is absent', () => {
  assert.equal(existsSync(join(root, 'config/opencode/env.example')), false);
});

test('retired MCP permission references are absent from active agents', () => {
  const agentFiles = filesUnder(join(root, 'config/opencode/agent')).filter((path) => path.endsWith('.md'));
  const forbidden = [
    'yonote_*',
    'exchange_*',
    'bitrix24_*',
    'n8n_*',
    'ya-metrika_*',
    'itop_*',
    'google-drive_*',
    'image-gen_*',
  ];

  for (const path of agentFiles) {
    const text = readFileSync(path, 'utf8');
    for (const token of forbidden) {
      assert.equal(
        text.includes(token),
        false,
        `${relative(root, path)} still references retired MCP tool pattern ${token}`,
      );
    }
  }
});

test('retired Bitrix24 MCP skill and live-looking webhook URLs are absent', () => {
  assert.equal(existsSync(join(root, 'config/opencode/skills/bitrix24')), false);

  const activeFiles = [
    ...filesUnder(join(root, 'config/opencode/agent')),
    ...filesUnder(join(root, 'config/opencode/skills')),
  ].filter((path) => /\.(?:md|json|jsonc|js|mjs|ts|sh)$/.test(path));

  const liveBitrixWebhook = /https?:\/\/[^/\s]+\.bitrix24\.[^/\s]+\/rest\/\d+\/[A-Za-z0-9_-]{8,}\//i;
  for (const path of activeFiles) {
    const text = readFileSync(path, 'utf8');
    assert.equal(
      liveBitrixWebhook.test(text),
      false,
      `${relative(root, path)} contains a live-looking Bitrix24 webhook URL`,
    );
  }
});

test('unified env template contains placeholders only for runtime credentials', () => {
  const path = join(root, 'config/opencode.env.example');
  const text = readFileSync(path, 'utf8');

  const required = [
    'YANDEX_DISK_TOKEN',
    'TELEGRAM_BOT_TOKEN',
    'GEMINI_API_KEY',
    'MINIMAX_API_KEY',
  ];
  for (const name of required) {
    assert.match(text, new RegExp(`^# ${name}=$`, 'm'), `missing empty placeholder for ${name}`);
  }

  const literalSecretAssignment = /^\s*(?!#)([A-Z][A-Z0-9_]*(?:TOKEN|SECRET|PASSWORD|API_KEY)[A-Z0-9_]*)\s*=\s*(\S.+)$/gm;
  assert.equal(literalSecretAssignment.test(text), false, 'env example must not contain literal secrets');
});


test('installer purges retired managed MCP artifacts and env secrets', () => {
  const installer = readFileSync(join(root, 'install.sh'), 'utf8');

  assert.match(
    installer,
    /rm -f -- "\$HOME\/\.config\/opencode\/env\.example"/,
    'installer must remove the legacy secret-bearing env template from existing installs',
  );
  assert.match(
    installer,
    /rm -rf -- "\$HOME\/\.config\/opencode\/skills\/bitrix24"/,
    'installer must remove the retired Bitrix24 skill from existing installs',
  );
  assert.match(
    installer,
    /YONOTE_API_KEY\|YANDEX_METRIKA_TOKEN/,
    'installer must strip retired MCP secrets from the shared runtime env',
  );
});
