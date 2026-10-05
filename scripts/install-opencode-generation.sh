#!/usr/bin/env bash
set -Eeuo pipefail

REPO="${OPENCODE_CONFIG_REPO:-gest0r1/my-opencode}"
REF="${OPENCODE_CONFIG_REF:-main}"
OPENCODE_BIN="$HOME/.opencode/bin/opencode"
OPENCODE_INSTALL_VERSION="${OPENCODE_INSTALL_VERSION:-2.0.21}"

CONFIG_HOME="$HOME/.config/opencode"
CONFIG_PARENT="$HOME/.config"
SKILLS_HOME="$HOME/.agents/skills"
SKILLS_PARENT="$HOME/.agents"
ENV_FILE="$HOME/.config/opencode.env"
LEGACY_ENV_FILE="$HOME/.config/opencode-web.env"
STATE_ROOT="${XDG_STATE_HOME:-$HOME/.local/state}/my-opencode"

BUN_INSTALL="${BUN_INSTALL:-$HOME/.bun}"
export BUN_INSTALL
export PATH="$HOME/.opencode/bin:$BUN_INSTALL/bin:$PATH"

for cmd in gh curl tar mktemp mv cp grep; do
  command -v "$cmd" >/dev/null 2>&1 || {
    echo "Ошибка: требуется команда '$cmd'." >&2
    exit 1
  }
done

if ! gh auth status >/dev/null 2>&1; then
  echo "Ошибка: GitHub CLI не авторизован. Выполни: gh auth login" >&2
  exit 1
fi

ensure_bun() {
  if command -v bun >/dev/null 2>&1; then
    return 0
  fi
  echo "Устанавливаю Bun для зависимостей локальных OpenCode V2 plugins..."
  curl -fsSL https://bun.sh/install | bash
  export BUN_INSTALL="${BUN_INSTALL:-$HOME/.bun}"
  export PATH="$BUN_INSTALL/bin:$PATH"
  command -v bun >/dev/null 2>&1 || {
    echo "Ошибка: Bun не установлен." >&2
    exit 1
  }
}

TMP_DIR="$(mktemp -d)"
STAGE_CONFIG=''
STAGE_SKILLS=''
BINARY_BACKUP="$TMP_DIR/opencode.previous"
HAD_BINARY=0
BINARY_UPDATE_ATTEMPTED=0
INSTALL_TRANSACTION_COMMITTED=0

if [[ -x "$OPENCODE_BIN" ]]; then
  cp -p "$OPENCODE_BIN" "$BINARY_BACKUP"
  HAD_BINARY=1
fi

rollback_binary() {
  (( BINARY_UPDATE_ATTEMPTED == 1 )) || return 0
  (( INSTALL_TRANSACTION_COMMITTED == 0 )) || return 0

  if (( HAD_BINARY == 1 )) && [[ -f "$BINARY_BACKUP" ]]; then
    mkdir -p "$(dirname "$OPENCODE_BIN")"
    local tmp="${OPENCODE_BIN}.rollback.${BASHPID}"
    cp -p "$BINARY_BACKUP" "$tmp"
    mv -f "$tmp" "$OPENCODE_BIN"
    echo "OpenCode binary rollback: restored previous executable." >&2
  else
    rm -f -- "$OPENCODE_BIN"
    echo "OpenCode binary rollback: removed incomplete new executable." >&2
  fi
}

cleanup() {
  local status=$?
  if (( status != 0 )); then
    rollback_binary || true
  fi
  [[ -z "$STAGE_CONFIG" || ! -e "$STAGE_CONFIG" ]] || rm -rf -- "$STAGE_CONFIG"
  [[ -z "$STAGE_SKILLS" || ! -e "$STAGE_SKILLS" ]] || rm -rf -- "$STAGE_SKILLS"
  rm -rf -- "$TMP_DIR"
  return "$status"
}
trap cleanup EXIT

ARCHIVE="$TMP_DIR/repo.tar.gz"
SRC="$TMP_DIR/src"
mkdir -p "$SRC" "$CONFIG_PARENT" "$SKILLS_PARENT" "$STATE_ROOT"

echo "Скачиваю конфигурацию $REPO@$REF..."
CONFIG_SHA="${OPENCODE_RESOLVED_CONFIG_SHA:-$(gh api "repos/$REPO/commits/$REF" --jq .sha)}"
gh api "repos/$REPO/tarball/$CONFIG_SHA" > "$ARCHIVE"
tar -xzf "$ARCHIVE" -C "$SRC" --strip-components=1

source "$SRC/scripts/bootstrap-runtime-tools.sh"
ensure_runtime_node

[[ -f "$SRC/config/opencode/opencode.json" ]] || {
  echo "Ошибка: config/opencode/opencode.json отсутствует в $REPO@$REF" >&2
  exit 1
}
[[ -d "$SRC/config/opencode/agent" ]] || {
  echo "Ошибка: config/opencode/agent отсутствует в $REPO@$REF" >&2
  exit 1
}


# ---- Build complete candidate trees outside active lookup paths ------------

STAGE_CONFIG="$(mktemp -d "$CONFIG_PARENT/.opencode-stage.XXXXXXXX")"
STAGE_SKILLS="$(mktemp -d "$SKILLS_PARENT/.skills-stage.XXXXXXXX")"

# Repo source mirrors still use some V1 singular names. Never expose those
# singular roots to OpenCode V2; map them into canonical plural runtime paths.
shopt -s dotglob nullglob
for entry in "$SRC/config/opencode/"*; do
  case "$(basename "$entry")" in
    agent|command|tool) continue ;;
  esac
  cp -a "$entry" "$STAGE_CONFIG/"
done
shopt -u dotglob nullglob

mkdir -p "$STAGE_CONFIG/agents" "$STAGE_CONFIG/commands" "$STAGE_CONFIG/tools"
if [[ -d "$SRC/config/opencode/command" ]]; then
  cp -a "$SRC/config/opencode/command/." "$STAGE_CONFIG/commands/"
fi
# Only direct tool definition files are activated. The old tool/env helper
# subtree is not a callable tool definition and is intentionally retired.
if [[ -d "$SRC/config/opencode/tool" ]]; then
  find "$SRC/config/opencode/tool" -maxdepth 1 -type f \( -name '*.ts' -o -name '*.js' \) -print0 |
    while IFS= read -r -d '' tool_file; do
      cp -a "$tool_file" "$STAGE_CONFIG/tools/"
    done
fi

# Preserve existing canonical user agents first; repo-managed agents overwrite
# only their own names. Legacy roots are copied into staging but remain active
# until the whole config transaction commits successfully.
if [[ -d "$CONFIG_HOME/agents" ]]; then
  cp -a "$CONFIG_HOME/agents/." "$STAGE_CONFIG/agents/"
fi
OPENCODE_ARCHIVE_LEGACY=0 bash "$SRC/scripts/install-opencode-agents.sh" \
  "$SRC/config/opencode/agent" \
  "$STAGE_CONFIG/agents" \
  "$HOME/.opencode/agent" \
  "$CONFIG_HOME/agent"

# Host-specific command spellings are derived only after source normalization.
# User agents are excluded: materialize only the repository-managed catalog.
MANAGED_PATHS="$(mktemp -d "$TMP_DIR/managed-paths.XXXXXXXX")"
while IFS= read -r -d '' file; do
  name=$(sed -n 's/^name: *//p' "$file" | head -1 | tr -d '\"')
  cp "$STAGE_CONFIG/agents/$name.md" "$MANAGED_PATHS/"
done < <(find "$SRC/config/opencode/agent" -name '*.md' -type f -print0)
node "$SRC/scripts/materialize-opencode-trusted-paths.mjs" "$MANAGED_PATHS" "$HOME"
cp "$MANAGED_PATHS/"*.md "$STAGE_CONFIG/agents/"

# Skills preserve the previous overlay semantics, but are prepared as a full
# tree and swapped atomically together with the config.
if [[ -d "$SKILLS_HOME" ]]; then
  cp -a "$SKILLS_HOME/." "$STAGE_SKILLS/"
fi
cp -a "$SRC/config/agents/skills/." "$STAGE_SKILLS/"
rm -rf -- "$STAGE_SKILLS/bitrix24"

# Remove known retired managed artifacts from the candidate tree.
rm -f -- "$STAGE_CONFIG/env.example"
rm -rf -- "$STAGE_CONFIG/skills/bitrix24"

# Merge user plugins before validation/atomic commit; parsing errors preserve active config.
node "$SRC/scripts/merge-user-plugins.mjs" "$CONFIG_HOME" "$STAGE_CONFIG" "$SRC/config/opencode/plugin-policy.json"

# V2 local plugins resolve external dependencies from the config directory.
# Install them before commit so an unavailable/incompatible dependency cannot
# corrupt the active configuration.
ensure_bun
bash "$SRC/scripts/install-opencode-dependencies.sh" "$STAGE_CONFIG" "$STATE_ROOT"

# Validate config and local V2 plugin entrypoints before touching active paths.
node - "$STAGE_CONFIG/opencode.json" <<'NODE'
const fs = require("node:fs");
const file = process.argv[2];
const config = JSON.parse(fs.readFileSync(file, "utf8"));
if ("agent" in config || "agents" in config) throw new Error("Agent definitions must live only in agents/*.md");
if ("plugin" in config) throw new Error("V1 key 'plugin' is not allowed in OpenCode V2 config");
if (config.plugins != null && !Array.isArray(config.plugins)) throw new Error("'plugins' must be an array");
if (config.instructions != null && (!Array.isArray(config.instructions) || config.instructions.length > 0)) {
  throw new Error("OpenCode V2 does not load config.instructions; use global AGENTS.md");
}
NODE

(
  cd "$STAGE_CONFIG"
  bun -e '
    const mod = await import("./plugins/pipeline-runtime.ts");
    if (!mod.default || typeof mod.default.id !== "string" || typeof mod.default.setup !== "function") {
      throw new Error("pipeline-runtime.ts is not a valid OpenCode V2 Plugin.define export");
    }
  '
)

(
  cd "$STAGE_CONFIG"
  bun -e '
    const mod = await import("./plugins/github-handoff.ts");
    if (!mod.default || typeof mod.default.setup !== "function") {
      throw new Error("github-handoff.ts is not a native V2 plugin");
    }
  '
)

[[ -f "$STAGE_CONFIG/AGENTS.md" ]] || {
  echo "Ошибка: global AGENTS.md missing from staged OpenCode V2 config." >&2
  exit 1
}
grep -Fq '# Shell Non-Interactive Strategy (Global)' "$STAGE_CONFIG/AGENTS.md" || {
  echo "Ошибка: managed shell strategy missing from global AGENTS.md." >&2
  exit 1
}
[[ ! -e "$STAGE_CONFIG/plugins/shell-strategy" ]] || {
  echo "Ошибка: shell-strategy must not live under plugins/ in V2." >&2
  exit 1
}

# ---- Binary phase: only after config/plugin validation --------------------

if [[ "${OPENCODE_SKIP_BINARY_INSTALL:-0}" == "1" ]]; then
  echo "Пропускаю обновление бинарника OpenCode (config-only mode)."
else
  BINARY_UPDATE_ATTEMPTED=1
  echo "Устанавливаю/обновляю OpenCode до $OPENCODE_INSTALL_VERSION официальным установщиком..."
  curl -fsSL https://opencode.ai/v2/install | bash -s -- --version "$OPENCODE_INSTALL_VERSION"
fi

if [[ ! -x "$OPENCODE_BIN" ]]; then
  echo "Ошибка: OpenCode не найден после binary phase: $OPENCODE_BIN" >&2
  exit 1
fi

installed_version="$("$OPENCODE_BIN" --version | sed -E 's/^opencode[[:space:]]+v?//')"
if [[ "$installed_version" != "$OPENCODE_INSTALL_VERSION" ]]; then
  echo "Ошибка версии OpenCode: expected=$OPENCODE_INSTALL_VERSION actual=$installed_version" >&2
  exit 1
fi
echo "OpenCode binary validated: $installed_version"

# ---- Atomic commit ---------------------------------------------------------

STAMP="$(date -u +%Y%m%dT%H%M%SZ)"
CONFIG_BACKUP="$CONFIG_PARENT/.opencode-prev-$STAMP-${BASHPID}"
SKILLS_BACKUP="$SKILLS_PARENT/.skills-prev-$STAMP-${BASHPID}"
had_config=0
had_skills=0
config_committed=0
skills_committed=0

rollback_transaction() {
  set +e
  if (( skills_committed == 1 )); then
    rm -rf -- "$SKILLS_HOME"
    if (( had_skills == 1 )) && [[ -e "$SKILLS_BACKUP" ]]; then
      mv "$SKILLS_BACKUP" "$SKILLS_HOME"
    fi
  elif (( had_skills == 1 )) && [[ -e "$SKILLS_BACKUP" && ! -e "$SKILLS_HOME" ]]; then
    mv "$SKILLS_BACKUP" "$SKILLS_HOME"
  fi

  if (( config_committed == 1 )); then
    rm -rf -- "$CONFIG_HOME"
    if (( had_config == 1 )) && [[ -e "$CONFIG_BACKUP" ]]; then
      mv "$CONFIG_BACKUP" "$CONFIG_HOME"
    fi
  elif (( had_config == 1 )) && [[ -e "$CONFIG_BACKUP" && ! -e "$CONFIG_HOME" ]]; then
    mv "$CONFIG_BACKUP" "$CONFIG_HOME"
  fi
  set -e
}

if [[ -e "$CONFIG_HOME" ]]; then
  mv "$CONFIG_HOME" "$CONFIG_BACKUP"
  had_config=1
fi
if ! mv "$STAGE_CONFIG" "$CONFIG_HOME"; then
  rollback_transaction
  echo "Ошибка: atomic config commit failed; previous config restored." >&2
  exit 1
fi
STAGE_CONFIG=''
config_committed=1

if [[ -e "$SKILLS_HOME" ]]; then
  mv "$SKILLS_HOME" "$SKILLS_BACKUP"
  had_skills=1
fi
if ! mv "$STAGE_SKILLS" "$SKILLS_HOME"; then
  rollback_transaction
  echo "Ошибка: atomic skills commit failed; previous config/skills restored." >&2
  exit 1
fi
STAGE_SKILLS=''
skills_committed=1

# Binary + config + skills now form one validated generation. From this point
# onward a failure in optional env/launcher housekeeping must not roll the
# executable back to a generation that no longer matches the active config.
INSTALL_TRANSACTION_COMMITTED=1

# Commit is complete. Old active trees are no longer in any OpenCode lookup
# path; remove them instead of leaving duplicate config/plugin/agent locations.
rm -rf -- "$CONFIG_BACKUP" "$SKILLS_BACKUP"

# ~/.config/opencode/agent was inside the old tree and disappeared with the
# atomic swap. ~/.opencode/agent is outside it, so archive that one now, only
# after successful commit.
if [[ -d "$HOME/.opencode/agent" ]]; then
  LEGACY_AGENT_BACKUP="$STATE_ROOT/legacy-agent-roots/$STAMP"
  mkdir -p "$LEGACY_AGENT_BACKUP"
  mv "$HOME/.opencode/agent" "$LEGACY_AGENT_BACKUP/home__opencode__agent"
  echo "Legacy agent root archived: $HOME/.opencode/agent"
fi

# ---- Persistent env --------------------------------------------------------

if [[ ! -f "$ENV_FILE" ]]; then
  ENV_NEW="$(mktemp "$CONFIG_PARENT/.opencode.env.XXXXXXXX")"
  if [[ -f "$LEGACY_ENV_FILE" ]]; then
    cp "$LEGACY_ENV_FILE" "$ENV_NEW"
    echo "Мигрирован $LEGACY_ENV_FILE -> $ENV_FILE"
  else
    cp "$SRC/config/opencode.env.example" "$ENV_NEW"
    echo "Создан $ENV_FILE — добавь необходимые MCP/интеграционные секреты."
  fi
  chmod 600 "$ENV_NEW"
  mv -f "$ENV_NEW" "$ENV_FILE"
else
  echo "$ENV_FILE уже существует — не перезаписываю."
fi

if [[ -f "$ENV_FILE" ]]; then
  ENV_TMP="$(mktemp "$CONFIG_PARENT/.opencode.env.clean.XXXXXXXX")"
  grep -Ev '^[[:space:]]*(OPENAI_API_KEY|OPENCODE_API_KEY|YONOTE_API_KEY|YANDEX_METRIKA_TOKEN)=' "$ENV_FILE" > "$ENV_TMP" || true
  chmod 600 "$ENV_TMP"
  mv -f "$ENV_TMP" "$ENV_FILE"
fi

if [[ -f "$LEGACY_ENV_FILE" ]]; then
  rm -f "$LEGACY_ENV_FILE"
  echo "Удалён legacy runtime-файл: $LEGACY_ENV_FILE"
fi

ensure_claude_cli
if [[ ! -f "$HOME/.local/state/my-opencode/root-state-sync.pending" ]]; then configure_server_browser; fi

# ---- Shell env + managed launcher -----------------------------------------

ensure_shell_env_loader() {
  local rc_file="$1"
  local marker_begin="# >>> my-opencode env >>>"
  local tmp

  touch "$rc_file"
  if grep -Fq "$marker_begin" "$rc_file"; then
    return 0
  fi

  tmp="$(mktemp "${rc_file}.tmp.XXXXXXXX")"
  cat "$rc_file" > "$tmp"
  cat >> "$tmp" <<'EOF'

# >>> my-opencode env >>>
set -a
if [ -f "$HOME/.config/opencode.env" ]; then
  . "$HOME/.config/opencode.env"
fi
set +a
# <<< my-opencode env <<<
EOF
  chmod --reference="$rc_file" "$tmp" 2>/dev/null || chmod 600 "$tmp"
  mv -f "$tmp" "$rc_file"
  echo "Добавлена загрузка opencode.env: $rc_file"
}

ensure_shell_env_loader "$HOME/.bashrc"
ensure_shell_env_loader "$HOME/.profile"

if [[ -d /usr/local/bin && -w /usr/local/bin ]]; then
  LAUNCHER="/usr/local/bin/opencode"
else
  mkdir -p "$HOME/.local/bin"
  LAUNCHER="$HOME/.local/bin/opencode"
fi
if [[ -n "$LAUNCHER" ]]; then
  manage_launcher=0

  if [[ ! -e "$LAUNCHER" && ! -L "$LAUNCHER" ]]; then
    manage_launcher=1
  elif [[ -L "$LAUNCHER" ]]; then
    launcher_target="$(readlink -f "$LAUNCHER" 2>/dev/null || true)"
    [[ "$launcher_target" == "$OPENCODE_BIN" ]] && manage_launcher=1
  elif grep -q '^# managed-by: my-opencode$' "$LAUNCHER" 2>/dev/null; then
    manage_launcher=1
  fi

  if (( manage_launcher == 1 )); then
    LAUNCHER_TMP="$(mktemp "$(dirname "$LAUNCHER")/.opencode.XXXXXXXX")"
    cat > "$LAUNCHER_TMP" <<'EOF'
#!/usr/bin/env bash
# managed-by: my-opencode
set -a
if [[ -f "$HOME/.config/opencode.env" ]]; then
  # shellcheck disable=SC1090
  . "$HOME/.config/opencode.env"
fi
set +a
exec "$HOME/.opencode/bin/opencode" "$@"
EOF
    chmod 755 "$LAUNCHER_TMP"
    mv -f "$LAUNCHER_TMP" "$LAUNCHER"
    echo "Установлен launcher: $LAUNCHER (единый opencode.env)"
  else
    echo "Не изменяю существующий $LAUNCHER: он не управляется my-opencode." >&2
  fi
fi

# Apply env in this installer shell only after the transaction committed.
if [[ -f "$ENV_FILE" ]]; then
  set -a
  # shellcheck disable=SC1090
  . "$ENV_FILE"
  set +a
fi

# Final invariants: no active legacy plugin/agent paths and local V2 plugin
# dependencies are present in the committed tree.
[[ -f "$CONFIG_HOME/node_modules/@opencode/plugin/package.json" ]] || {
  echo "Ошибка: @opencode/plugin dependency missing after commit." >&2
  exit 1
}
[[ ! -e "$CONFIG_HOME/plugins/shell-strategy" ]] || {
  echo "Ошибка: legacy shell-strategy plugin path still active." >&2
  exit 1
}
[[ ! -e "$CONFIG_HOME/agent" ]] || {
  echo "Ошибка: legacy singular agent path still active." >&2
  exit 1
}
[[ ! -e "$CONFIG_HOME/command" ]] || {
  echo "Ошибка: legacy singular command path still active." >&2
  exit 1
}
[[ -d "$CONFIG_HOME/commands" ]] || {
  echo "Ошибка: canonical commands path missing after commit." >&2
  exit 1
}
[[ ! -e "$CONFIG_HOME/tool" ]] || {
  echo "Ошибка: legacy singular tool path still active." >&2
  exit 1
}
[[ -d "$CONFIG_HOME/tools" ]] || {
  echo "Ошибка: canonical tools path missing after commit." >&2
  exit 1
}
[[ -f "$CONFIG_HOME/plugins/github-handoff.ts" ]] || {
  echo "Ошибка: github-handoff native V2 plugin missing after commit." >&2
  exit 1
}

# Retire receipts from the superseded config no-op policy.
rm -f -- "$STATE_ROOT/config-generation.json"

echo "Готово: OpenCode и конфигурация $REPO@$REF установлены атомарно."
echo "Проверка: $OPENCODE_BIN --version -> $("$OPENCODE_BIN" --version)"
