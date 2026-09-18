#!/usr/bin/env bash
set -Eeuo pipefail

REPO="${OPENCODE_CONFIG_REPO:-gest0r1/my-opencode}"
REF="${OPENCODE_CONFIG_REF:-main}"
OPENCODE_BIN="$HOME/.opencode/bin/opencode"
ENV_FILE="$HOME/.config/opencode.env"
LEGACY_ENV_FILE="$HOME/.config/opencode-web.env"

for cmd in gh curl tar mktemp; do
  command -v "$cmd" >/dev/null 2>&1 || {
    echo "Ошибка: требуется команда '$cmd'." >&2
    exit 1
  }
done

if ! gh auth status >/dev/null 2>&1; then
  echo "Ошибка: GitHub CLI не авторизован. Выполни: gh auth login" >&2
  exit 1
fi

as_root() {
  if (( EUID == 0 )); then
    "$@"
  elif command -v sudo >/dev/null 2>&1; then
    sudo "$@"
  else
    echo "Ошибка: для установки системных зависимостей нужны root или sudo." >&2
    return 1
  fi
}

python_runtime_ready() {
  command -v python3 >/dev/null 2>&1 || return 1
  python3 -m pip --version >/dev/null 2>&1 || return 1

  local probe
  probe="$(mktemp -d)"
  if ! python3 -m venv "$probe/venv" >/dev/null 2>&1; then
    rm -rf "$probe"
    return 1
  fi
  if ! "$probe/venv/bin/python" -m pip --version >/dev/null 2>&1; then
    rm -rf "$probe"
    return 1
  fi
  rm -rf "$probe"
}

python_command_ready() {
  command -v python >/dev/null 2>&1 || return 1
  python -c 'import sys; raise SystemExit(0 if sys.version_info.major == 3 else 1)' >/dev/null 2>&1
}

ensure_python_runtime() {
  if command -v python >/dev/null 2>&1 && ! python_command_ready; then
    echo "Ошибка: команда python уже существует, но это не Python 3; installer не будет её перезаписывать." >&2
    exit 1
  fi

  if ! python_runtime_ready || ! python_command_ready; then
    if ! command -v apt-get >/dev/null 2>&1; then
      echo "Ошибка: Python baseline недоступен, а поддерживаемый пакетный менеджер apt-get не найден." >&2
      echo "Требуются: python3, python3-venv, python3-pip и команда python -> Python 3." >&2
      exit 1
    fi
    echo "Устанавливаю системный Python baseline..."
    as_root apt-get update
    as_root apt-get install -y python3 python3-venv python3-pip python-is-python3
  fi

  python_runtime_ready || {
    echo "Ошибка: Python runtime не прошёл проверку после установки." >&2
    exit 1
  }
  python_command_ready || {
    echo "Ошибка: команда python не разрешается в Python 3 после установки." >&2
    exit 1
  }
  python --version
  python -m pip --version >/dev/null
}

ensure_uv_runtime() {
  local uv_bin
  uv_bin="$(command -v uv || true)"
  if [[ -z "$uv_bin" || ! -x "$uv_bin" ]]; then
    if [[ -x "$HOME/.local/bin/uv" ]]; then
      uv_bin="$HOME/.local/bin/uv"
    else
      echo "Устанавливаю общий uv в профиль пользователя..."
      curl -LsSf https://astral.sh/uv/install.sh | sh
      uv_bin="$HOME/.local/bin/uv"
    fi
  fi
  [[ -x "$uv_bin" ]] || {
    echo "Ошибка: uv не найден после установки: $uv_bin" >&2
    exit 1
  }
  "$uv_bin" --version
  # 3.13 нужен Otclick-hh. uv хранит интерпретаторы и cache общими для проектов,
  # не подменяет /usr/bin/python и не устанавливает app-deps глобально.
  "$uv_bin" python install 3.13
  "$uv_bin" python find 3.13 >/dev/null || {
    echo "Ошибка: uv не смог подготовить Python 3.13." >&2
    exit 1
  }
}

ensure_python_runtime
ensure_uv_runtime

if [[ "${OPENCODE_SKIP_BINARY_INSTALL:-0}" == "1" ]]; then
  echo "Пропускаю обновление бинарника OpenCode (config-only mode)."
else
  echo "Устанавливаю/обновляю OpenCode официальным установщиком..."
  curl -fsSL https://opencode.ai/install | bash
fi

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

# Глобальная конфигурация OpenCode, включая скрытые файлы.
# agent/ ставится отдельно в ~/.opencode/agent, поэтому не оставляем его копию
# в ~/.config/opencode.
cp -a "$SRC/config/opencode/." "$HOME/.config/opencode/"
rm -rf "$HOME/.config/opencode/agent"
cp -a "$SRC/config/opencode/agent/." "$HOME/.opencode/agent/"
cp -a "$SRC/config/agents/skills/." "$HOME/.agents/skills/"

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
  local marker_end="# <<< my-opencode env <<<"

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

# Installation is sourced from the same verified GitHub archive as config, never
# from a development checkout. Refuse unknown containers; do not mutate secrets.
if [[ "${OPENCODE_SKIP_MCP_INSTALL:-0}" != 1 ]]; then
  [[ -f "$SRC/scripts/install-mcp.sh" ]] || {
    echo 'Ошибка: в установленном GitHub archive нет scripts/install-mcp.sh.' >&2
    exit 1
  }
  OPENCODE_SOURCE_ROOT="$SRC" OPENCODE_ENV_FILE="$ENV_FILE" bash "$SRC/scripts/install-mcp.sh"
else
  echo 'Внимание: MCP installation явно пропущена (OPENCODE_SKIP_MCP_INSTALL=1).'
fi

echo "Готово: OpenCode и конфигурация $REPO@$REF установлены."

if command -v opencode >/dev/null 2>&1; then
  echo "Проверка: $(command -v opencode) --version -> $(opencode --version)"
else
  echo "OpenCode установлен, но текущий shell ещё не видит ~/.opencode/bin." >&2
  echo "Выполни: export PATH=\"$HOME/.opencode/bin:$PATH\"" >&2
fi
