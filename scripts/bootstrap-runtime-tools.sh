#!/usr/bin/env bash
# Source only as runtime user; deterministic user PATH also works in systemd.
set -Eeuo pipefail
export PATH="$HOME/.local/bin:$HOME/.opencode/bin:$HOME/.bun/bin:/usr/local/bin:/usr/bin:/bin"
export XDG_CONFIG_HOME="$HOME/.config" XDG_DATA_HOME="$HOME/.local/share" XDG_STATE_HOME="$HOME/.local/state"
cd "$HOME"

ensure_runtime_node() {
  local major=0
  if command -v node >/dev/null 2>&1; then major="$(node -p 'Number(process.versions.node.split(".")[0])' 2>/dev/null || echo 0)"; fi
  if [[ "$major" =~ ^[0-9]+$ ]] && (( major >= 22 )); then return 0; fi
  # Pin the supported LTS bootstrap; an existing compatible runtime is retained.
  local version=24.21.0 arch archive tmp dest
  case "$(uname -m)" in x86_64) arch=x64;; *) echo 'Node bootstrap supports Linux x86_64 only' >&2; return 1;; esac
  archive="node-v$version-linux-$arch.tar.xz"
  tmp="$(mktemp -d)"
  dest="$HOME/.local/share/my-opencode/node-v$version"
  if ! (
    cd "$tmp"
    curl -fsSLO "https://nodejs.org/dist/v$version/$archive" || exit 1
    curl -fsSLO "https://nodejs.org/dist/v$version/SHASUMS256.txt" || exit 1
    awk -v file="$archive" '$2 == file {print}' SHASUMS256.txt > checksum
    [[ "$(wc -l < checksum)" == 1 ]] || exit 1
    sha256sum -c checksum || exit 1
    tar -xJf "$archive" || exit 1
    "node-v$version-linux-$arch/bin/node" --version || exit 1
    mkdir -p "$(dirname "$dest")" "$HOME/.local/bin" || exit 1
    [[ ! -e "$dest" ]] || { echo 'Incomplete Node bootstrap exists; inspect before retry' >&2; exit 1; }
    mv "node-v$version-linux-$arch" "$dest" || exit 1
    for tool in node npm npx; do ln -sfn "$dest/bin/$tool" "$HOME/.local/bin/$tool" || exit 1; done
  ); then rm -rf -- "$tmp"; return 1; fi
  rm -rf -- "$tmp"
  hash -r
  node -e 'if (Number(process.versions.node.split(".")[0]) < 22) process.exit(1)'
}

ensure_claude_cli() {
  # Required only when the subscription plugin is enabled/preserved.
  if ! grep -Rqs '@openchamber/opencode-claude' "$HOME/.config/opencode/opencode.json" "$HOME/.config/opencode/plugins.json" 2>/dev/null; then return 0; fi
  if ! command -v claude >/dev/null 2>&1 || ! claude --version >/dev/null 2>&1; then
    npm install --global --prefix "$HOME/.local" @anthropic-ai/claude-code@2.1.289
    hash -r
  fi
  claude --version
  # Authentication is an explicit unfinished step, never fabricated by install.
  local status auth_rc=0 parsed_rc=0
  status="$(claude auth status)" || auth_rc=$?
  printf '%s' "$status" | node -e 'let s="";process.stdin.on("data",d=>s+=d);process.stdin.on("end",()=>{try{const v=JSON.parse(s);process.exit(v.loggedIn===true?0:v.loggedIn===false?2:1)}catch{process.exit(1)}})' || parsed_rc=$?
  if (( parsed_rc == 2 )); then
    echo 'CLAUDE_LOGIN_REQUIRED: run claude auth login --claudeai as opencode' >&2
  elif (( parsed_rc != 0 || auth_rc != 0 )); then
    echo 'Claude CLI auth check failed' >&2; return 1
  fi
}

configure_server_browser() {
  local config="$HOME/.config/openchamber/extensions/server-browser/config.json"
  [[ -f "$config" ]] || return 0
  local chrome=''
  for candidate in /usr/bin/google-chrome /usr/bin/google-chrome-stable /usr/bin/chromium; do
    if [[ -x "$candidate" ]] && [[ "$(readlink -f "$candidate")" != /snap/* ]]; then chrome="$candidate"; break; fi
  done
  [[ -n "$chrome" ]] || { echo 'SERVER_BROWSER_NATIVE_CHROME_REQUIRED: install native Chrome; sandbox stays enabled' >&2; return 1; }
  node - "$config" "$chrome" <<'NODE'
const fs = require('node:fs');
const [file, chrome] = process.argv.slice(2);
const data = JSON.parse(fs.readFileSync(file, 'utf8'));
if (data.chromePath === chrome) process.exit(0);
fs.copyFileSync(file, `${file}.backup-${Date.now()}`);
data.chromePath = chrome;
const tmp = `${file}.tmp`;
fs.writeFileSync(tmp, JSON.stringify(data, null, 2) + '\n', {mode: 0o600});
fs.renameSync(tmp, file);
NODE
}
