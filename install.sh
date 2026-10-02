#!/usr/bin/env bash
set -Eeuo pipefail

REPO="${OPENCODE_CONFIG_REPO:-gest0r1/my-opencode}"
REF="${OPENCODE_CONFIG_REF:-main}"
OPENCODE_BIN="$HOME/.opencode/bin/opencode"
OPENCODE_INSTALL_VERSION="${OPENCODE_INSTALL_VERSION:-2.0.21}"
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

if [[ "${OPENCODE_SKIP_BINARY_INSTALL:-0}" == "1" ]]; then
  echo "Пропускаю обновление бинарника OpenCode (config-only mode)."
else
  echo "Устанавливаю/обновляю OpenCode до $OPENCODE_INSTALL_VERSION официальным установщиком..."
  curl -fsSL https://opencode.ai/v2/install | bash -s -- --version "$OPENCODE_INSTALL_VERSION"
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
  "$HOME/.config/opencode/agents" \
  "$HOME/.agents/skills"

# Remove retired managed artifacts that an overlay copy cannot delete.
# These paths were previously distributed by my-opencode and remain active/stale
# on existing installations unless explicitly removed.
rm -f -- "$HOME/.config/opencode/env.example"
rm -rf -- "$HOME/.config/opencode/skills/bitrix24"

# Глобальная конфигурация OpenCode, включая скрытые файлы. Каталог agent/
# из репозитория ставится отдельно в канонический upstream-путь agents/, поэтому
# не копируем его как ~/.config/opencode/agent и не удаляем существующий legacy.
shopt -s dotglob nullglob
for entry in "$SRC/config/opencode/"*; do
  [[ "$(basename "$entry")" == "agent" ]] && continue
  cp -a "$entry" "$HOME/.config/opencode/"
done
shopt -u dotglob nullglob

# OpenCode V2 читает Markdown-агентов из ~/.config/opencode/agents/**/*.md.
# Устанавливаем управляемые файлы в канонический plural-путь. Legacy-корни
# передаём мигратору для переноса пользовательских дополнений; после успешной
# установки они убираются из active lookup path в state-backup.
bash "$SRC/scripts/install-opencode-agents.sh" \
  "$SRC/config/opencode/agent" \
  "$HOME/.config/opencode/agents" \
  "$HOME/.opencode/agent" \
  "$HOME/.config/opencode/agent"

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
# Удаляем старые env-переопределения и секреты retired MCP, чтобы CLI и
# OpenChamber использовали только актуальные runtime credentials.
if [[ -f "$ENV_FILE" ]]; then
  ENV_TMP="$TMP_DIR/opencode.env"
  grep -Ev '^[[:space:]]*(OPENAI_API_KEY|OPENCODE_API_KEY|YONOTE_API_KEY|YANDEX_METRIKA_TOKEN)=' "$ENV_FILE" > "$ENV_TMP" || true
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

echo "Готово: OpenCode и конфигурация $REPO@$REF установлены."

if command -v opencode >/dev/null 2>&1; then
  echo "Проверка: $(command -v opencode) --version -> $(opencode --version)"
else
  echo "OpenCode установлен, но текущий shell ещё не видит ~/.opencode/bin." >&2
  echo "Выполни: export PATH=\"$HOME/.opencode/bin:$PATH\"" >&2
fi
