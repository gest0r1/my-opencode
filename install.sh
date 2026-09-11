#!/usr/bin/env bash
set -Eeuo pipefail

REPO="${OPENCODE_CONFIG_REPO:-gest0r1/my-opencode}"
REF="${OPENCODE_CONFIG_REF:-main}"
OPENCODE_BIN="$HOME/.opencode/bin/opencode"
ENV_FILE="$HOME/.config/opencode.env"
LEGACY_ENV_FILE="$HOME/.config/opencode-web.env"
CURRENT_CONFIG="$HOME/.config/opencode/opencode.json"

for cmd in gh curl tar mktemp python3; do
  command -v "$cmd" >/dev/null 2>&1 || {
    echo "Ошибка: требуется команда '$cmd'." >&2
    exit 1
  }
done

if ! gh auth status >/dev/null 2>&1; then
  echo "Ошибка: GitHub CLI не авторизован. Выполни: gh auth login" >&2
  exit 1
fi

echo "Устанавливаю/обновляю OpenCode официальным установщиком..."
curl -fsSL https://opencode.ai/install | bash

if [[ ! -x "$OPENCODE_BIN" ]]; then
  echo "Ошибка: OpenCode не найден после установки: $OPENCODE_BIN" >&2
  exit 1
fi

echo "OpenCode установлен: $($OPENCODE_BIN --version)"

TMP_DIR="$(mktemp -d)"
trap 'rm -rf "$TMP_DIR"' EXIT
ARCHIVE="$TMP_DIR/repo.tar.gz"
SRC="$TMP_DIR/src"
mkdir -p "$SRC"

echo "Скачиваю конфигурацию $REPO@$REF..."
gh api "repos/$REPO/tarball/$REF" > "$ARCHIVE"
tar -xzf "$ARCHIVE" -C "$SRC" --strip-components=1

mkdir -p \
  "$HOME/.config/opencode" \
  "$HOME/.opencode/agent" \
  "$HOME/.agents/skills"

# Единый runtime env для OpenCode CLI и OpenChamber.
# Старый opencode-web.env мигрируется один раз и затем удаляется, чтобы не было
# двух конкурирующих источников настроек.
if [[ ! -f "$ENV_FILE" ]]; then
  if [[ -f "$LEGACY_ENV_FILE" ]]; then
    cp "$LEGACY_ENV_FILE" "$ENV_FILE"
    echo "Мигрирован $LEGACY_ENV_FILE -> $ENV_FILE"
  else
    cp "$SRC/config/opencode.env.example" "$ENV_FILE"
    echo "Создан $ENV_FILE — добавь необходимые MCP/интеграционные секреты."
  fi
else
  echo "$ENV_FILE уже существует — не перезаписываю."
fi

# Одноразовая миграция literal MCP credentials из старого opencode.json в
# runtime-only env. Выполняется ДО замены конфигурации. Уже заданные env-ключи
# не перезаписываются. Значения не печатаются в stdout/stderr.
if [[ -f "$CURRENT_CONFIG" && -f "$ENV_FILE" ]]; then
  python3 - "$CURRENT_CONFIG" "$ENV_FILE" <<'PY'
import json
import pathlib
import shlex
import sys

config_path = pathlib.Path(sys.argv[1])
env_path = pathlib.Path(sys.argv[2])

try:
    cfg = json.loads(config_path.read_text(encoding="utf-8"))
except Exception:
    sys.exit(0)

existing = set()
for raw in env_path.read_text(encoding="utf-8").splitlines():
    line = raw.strip()
    if not line or line.startswith("#") or "=" not in line:
        continue
    existing.add(line.split("=", 1)[0].strip())

def get(*parts):
    node = cfg
    for part in parts:
        if not isinstance(node, dict) or part not in node:
            return None
        node = node[part]
    return node

mapping = {
    "EXCHANGE_MCP_API_KEY": get("mcp", "exchange", "headers", "X-API-Key"),
    "ITOP_URL": get("mcp", "itop", "env", "ITOP_URL"),
    "ITOP_TOKEN": get("mcp", "itop", "env", "ITOP_TOKEN"),
    "GDRIVE_MCP_CLIENT_ID": get("mcp", "google-drive", "env", "GDRIVE_MCP_CLIENT_ID"),
    "GDRIVE_MCP_CLIENT_SECRET": get("mcp", "google-drive", "env", "GDRIVE_MCP_CLIENT_SECRET"),
    "GDRIVE_MCP_REFRESH_TOKEN": get("mcp", "google-drive", "env", "GDRIVE_MCP_REFRESH_TOKEN"),
}

add = []
for key, value in mapping.items():
    if key in existing or not isinstance(value, str) or not value or value.startswith("{env:"):
        continue
    add.append(f"{key}={shlex.quote(value)}")

if add:
    with env_path.open("a", encoding="utf-8") as handle:
        handle.write("\n# Migrated from legacy opencode.json; rotate secrets after migration.\n")
        handle.write("\n".join(add) + "\n")
PY
fi

# Глобальная конфигурация OpenCode, включая скрытые файлы.
# agent/ ставится отдельно в ~/.opencode/agent; этот путь нативно читается
# OpenCode v1.18.30+ через global $HOME/.opencode config directory.
cp -a "$SRC/config/opencode/." "$HOME/.config/opencode/"
rm -rf "$HOME/.config/opencode/agent"
cp -a "$SRC/config/opencode/agent/." "$HOME/.opencode/agent/"
cp -a "$SRC/config/agents/skills/." "$HOME/.agents/skills/"

# LLM credentials являются каноничными в `opencode auth login` / auth.json.
# Удаляем старые env-переопределения, чтобы CLI и OpenChamber использовали
# одинаковые credentials и env не перекрывал OAuth/API credentials из auth.json.
if [[ -f "$ENV_FILE" ]]; then
  ENV_TMP="$TMP_DIR/opencode.env"
  grep -Ev '^[[:space:]]*(OPENAI_API_KEY|OPENCODE_API_KEY)=' "$ENV_FILE" > "$ENV_TMP" || true
  mv "$ENV_TMP" "$ENV_FILE"
  chmod 600 "$ENV_FILE"
fi

if [[ -f "$LEGACY_ENV_FILE" ]]; then
  rm -f "$LEGACY_ENV_FILE"
  echo "Удалён legacy runtime-файл: $LEGACY_ENV_FILE"
fi

# Интерактивные shell должны получать тот же env даже если официальный installer
# поставил ~/.opencode/bin раньше /usr/local/bin в PATH и CLI обходит launcher.
ensure_shell_env_loader() {
  local rc_file="$1"
  local marker_begin="# >>> my-opencode env >>>"

  touch "$rc_file"
  if ! grep -Fq "$marker_begin" "$rc_file"; then
    cat >> "$rc_file" <<'EOF'

# >>> my-opencode env >>>
set -a
if [ -f "$HOME/.config/opencode.env" ]; then
  . "$HOME/.config/opencode.env"
fi
set +a
# <<< my-opencode env <<<
EOF
    echo "Добавлена загрузка opencode.env: $rc_file"
  fi
}

ensure_shell_env_loader "$HOME/.bashrc"
ensure_shell_env_loader "$HOME/.profile"

# Управляемый launcher гарантирует тот же env и для non-interactive вызовов,
# если opencode разрешается через /usr/local/bin.
if [[ -d /usr/local/bin && -w /usr/local/bin ]]; then
  LAUNCHER="/usr/local/bin/opencode"
  manage_launcher=0

  if [[ ! -e "$LAUNCHER" && ! -L "$LAUNCHER" ]]; then
    manage_launcher=1
  elif [[ -L "$LAUNCHER" ]]; then
    launcher_target="$(readlink -f "$LAUNCHER" 2>/dev/null || true)"
    if [[ "$launcher_target" == "$OPENCODE_BIN" ]]; then
      manage_launcher=1
    fi
  elif grep -q '^# managed-by: my-opencode$' "$LAUNCHER" 2>/dev/null; then
    manage_launcher=1
  fi

  if (( manage_launcher == 1 )); then
    rm -f "$LAUNCHER"
    cat > "$LAUNCHER" <<'EOF'
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
    chmod 755 "$LAUNCHER"
    echo "Установлен launcher: $LAUNCHER (единый opencode.env)"
  else
    echo "Не изменяю существующий $LAUNCHER: он не управляется my-opencode." >&2
  fi
fi

# Внутри текущего installer shell тоже применяем env для корректной проверки.
if [[ -f "$ENV_FILE" ]]; then
  set -a
  # shellcheck disable=SC1090
  . "$ENV_FILE"
  set +a
fi

echo "Готово: OpenCode и конфигурация $REPO@$REF установлены."

if command -v opencode >/dev/null 2>&1; then
  echo "Проверка: $(command -v opencode) --version -> $(opencode --version)"
else
  echo "OpenCode установлен, но текущий shell ещё не видит ~/.opencode/bin." >&2
  echo "Выполни: export PATH=\"$HOME/.opencode/bin:$PATH\"" >&2
fi
