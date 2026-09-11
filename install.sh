#!/usr/bin/env bash
set -Eeuo pipefail

REPO="${OPENCODE_CONFIG_REPO:-gest0r1/my-opencode}"
REF="${OPENCODE_CONFIG_REF:-main}"
OPENCODE_BIN="$HOME/.opencode/bin/opencode"
ENV_FILE="$HOME/.config/opencode.env"
LEGACY_ENV_FILE="$HOME/.config/opencode-web.env"
CURRENT_CONFIG="$HOME/.config/opencode/opencode.json"
ROTATION_MARKER="$HOME/.config/opencode.secrets-rotation-required"

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
LEGACY_CONFIG_SNAPSHOT="$TMP_DIR/opencode.legacy.json"
mkdir -p "$SRC"

echo "Скачиваю конфигурацию $REPO@$REF..."
gh api "repos/$REPO/tarball/$REF" > "$ARCHIVE"
tar -xzf "$ARCHIVE" -C "$SRC" --strip-components=1

mkdir -p \
  "$HOME/.config/opencode" \
  "$HOME/.opencode/agent" \
  "$HOME/.agents/skills"

# Сохраняем старую конфигурацию только во временный каталог процесса, чтобы
# обнаружить literal credentials ДО замены безопасной конфигурацией.
if [[ -f "$CURRENT_CONFIG" ]]; then
  cp "$CURRENT_CONFIG" "$LEGACY_CONFIG_SNAPSHOT"
fi

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

# SECURITY: literal credentials, однажды попавшие в Git/config, считаются
# скомпрометированными. Их НЕЛЬЗЯ автоматически переносить в новый env:
# это не ротация, а сохранение старого секрета. Инсталлятор мигрирует только
# несекретный ITOP_URL и фиксирует имена credential'ов, требующих перевыпуска.
if [[ -f "$LEGACY_CONFIG_SNAPSHOT" && -f "$ENV_FILE" ]]; then
  python3 - "$LEGACY_CONFIG_SNAPSHOT" "$ENV_FILE" "$ROTATION_MARKER" <<'PY'
import json
import pathlib
import shlex
import sys

config_path = pathlib.Path(sys.argv[1])
env_path = pathlib.Path(sys.argv[2])
marker_path = pathlib.Path(sys.argv[3])

try:
    cfg = json.loads(config_path.read_text(encoding="utf-8"))
except Exception:
    cfg = {}

def get(*parts):
    node = cfg
    for part in parts:
        if not isinstance(node, dict) or part not in node:
            return None
        node = node[part]
    return node

secret_locations = {
    "EXCHANGE_MCP_API_KEY": get("mcp", "exchange", "headers", "X-API-Key"),
    "ITOP_TOKEN": get("mcp", "itop", "env", "ITOP_TOKEN"),
    "GDRIVE_MCP_CLIENT_ID": get("mcp", "google-drive", "env", "GDRIVE_MCP_CLIENT_ID"),
    "GDRIVE_MCP_CLIENT_SECRET": get("mcp", "google-drive", "env", "GDRIVE_MCP_CLIENT_SECRET"),
    "GDRIVE_MCP_REFRESH_TOKEN": get("mcp", "google-drive", "env", "GDRIVE_MCP_REFRESH_TOKEN"),
    "YANDEX_DISK_TOKEN": get("mcp", "yadisk", "env", "YANDEX_DISK_TOKEN"),
    "YONOTE_API_KEY": get("mcp", "yonote", "headers", "Authorization"),
    "YANDEX_METRIKA_TOKEN": get("mcp", "ya-metrika", "env", "YANDEX_METRIKA_TOKEN"),
}

existing_lines = env_path.read_text(encoding="utf-8").splitlines()
existing_keys = {
    line.split("=", 1)[0].strip()
    for line in existing_lines
    if line.strip() and not line.lstrip().startswith("#") and "=" in line
}

# Only non-secret configuration may be carried forward automatically.
itop_url = get("mcp", "itop", "env", "ITOP_URL")
if (
    isinstance(itop_url, str)
    and itop_url
    and not itop_url.startswith("{env:")
    and "ITOP_URL" not in existing_keys
):
    with env_path.open("a", encoding="utf-8") as handle:
        handle.write(f"\nITOP_URL={shlex.quote(itop_url)}\n")

compromised = []
for key, value in secret_locations.items():
    if not isinstance(value, str) or not value:
        continue
    # Placeholder-based values are already runtime-only and are not evidence
    # of a secret embedded in the legacy config.
    if "{env:" in value:
        continue
    compromised.append(key)

# Previous installer revisions could have copied exposed literals into env.
# Such values are explicitly quarantined: we remove them rather than trusting
# them as already rotated.
legacy_migration_marker = any(
    "Migrated from legacy opencode.json" in line for line in existing_lines
)
if legacy_migration_marker:
    sensitive_keys = set(secret_locations)
    filtered = []
    for line in existing_lines:
        stripped = line.strip()
        if "Migrated from legacy opencode.json" in line:
            continue
        key = stripped.split("=", 1)[0].strip() if "=" in stripped else None
        if key in sensitive_keys:
            continue
        filtered.append(line)
    env_path.write_text("\n".join(filtered).rstrip() + "\n", encoding="utf-8")

if compromised or legacy_migration_marker:
    names = sorted(set(compromised))
    marker_path.write_text(
        "Secrets requiring external revoke/reissue before production use:\n"
        + "\n".join(names)
        + ("\nLEGACY_ENV_MIGRATION_QUARANTINED\n" if legacy_migration_marker else ""),
        encoding="utf-8",
    )
else:
    marker_path.unlink(missing_ok=True)
PY
fi

# Сначала заменяем runtime-конфигурацию на безопасную версию с {env:...} —
# даже если далее установка остановится из-за обязательной внешней ротации.
cp -a "$SRC/config/opencode/." "$HOME/.config/opencode/"
rm -rf "$HOME/.config/opencode/agent"
cp -a "$SRC/config/opencode/agent/." "$HOME/.opencode/agent/"
cp -a "$SRC/config/agents/skills/." "$HOME/.agents/skills/"

if [[ -f "$ROTATION_MARKER" ]]; then
  chmod 600 "$ENV_FILE" 2>/dev/null || true
  echo "" >&2
  echo "ОШИБКА БЕЗОПАСНОСТИ: обнаружены credentials, которые ранее хранились literal-значениями." >&2
  echo "Старые значения НЕ перенесены; ранее мигрированные значения удалены из runtime env." >&2
  echo "Рабочая конфигурация уже заменена на безопасную версию с {env:...}." >&2
  echo "Требуется отозвать/перевыпустить credentials у соответствующих провайдеров" >&2
  echo "и записать новые значения в $ENV_FILE." >&2
  echo "Требуют проверки/ротации:" >&2
  sed 's/^/  - /' "$ROTATION_MARKER" >&2
  echo "" >&2
  echo "После внешней ротации удали $ROTATION_MARKER и повтори установку." >&2
  exit 2
fi

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
