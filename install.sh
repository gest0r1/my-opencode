#!/usr/bin/env bash
set -Eeuo pipefail

REPO="${OPENCODE_CONFIG_REPO:-gest0r1/my-opencode}"
REF="${OPENCODE_CONFIG_REF:-main}"
OPENCODE_BIN="$HOME/.opencode/bin/opencode"

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

echo "Устанавливаю/обновляю OpenCode официальным установщиком..."
curl -fsSL https://opencode.ai/install | bash

if [[ ! -x "$OPENCODE_BIN" ]]; then
  echo "Ошибка: OpenCode не найден после установки: $OPENCODE_BIN" >&2
  exit 1
fi

echo "OpenCode установлен: $($OPENCODE_BIN --version)"

# Официальный installer добавляет ~/.opencode/bin в shell rc, но при запуске
# через `... | bash` дочерний shell не может изменить PATH родительского shell.
# Для root-сценария делаем opencode доступным сразу через стандартный PATH.
if ! command -v opencode >/dev/null 2>&1; then
  if [[ -d /usr/local/bin && -w /usr/local/bin ]]; then
    ln -sf "$OPENCODE_BIN" /usr/local/bin/opencode
    echo "Создана ссылка: /usr/local/bin/opencode -> $OPENCODE_BIN"
  fi
fi

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

ENV_FILE="$HOME/.config/opencode-web.env"
if [[ ! -f "$ENV_FILE" ]]; then
  cp "$SRC/config/opencode-web.env.example" "$ENV_FILE"
  echo "Создан $ENV_FILE — добавь API keys."
else
  echo "$ENV_FILE уже существует — не перезаписываю."
fi

echo "Готово: OpenCode и конфигурация $REPO@$REF установлены."

if command -v opencode >/dev/null 2>&1; then
  echo "Проверка: $(command -v opencode) --version -> $(opencode --version)"
else
  echo "OpenCode установлен, но текущий shell ещё не видит ~/.opencode/bin." >&2
  echo "Выполни: export PATH=\"$HOME/.opencode/bin:$PATH\"" >&2
fi
