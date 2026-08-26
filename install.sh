#!/usr/bin/env bash
set -Eeuo pipefail

REPO="${OPENCODE_CONFIG_REPO:-gest0r1/my-opencode}"
REF="${OPENCODE_CONFIG_REF:-main}"

for cmd in gh tar mktemp; do
  command -v "$cmd" >/dev/null 2>&1 || {
    echo "Ошибка: требуется команда '$cmd'." >&2
    exit 1
  }
done

if ! gh auth status >/dev/null 2>&1; then
  echo "Ошибка: GitHub CLI не авторизован. Выполни: gh auth login" >&2
  exit 1
fi

TMP_DIR="$(mktemp -d)"
trap 'rm -rf "$TMP_DIR"' EXIT
ARCHIVE="$TMP_DIR/repo.tar.gz"
SRC="$TMP_DIR/src"
mkdir -p "$SRC"

echo "Скачиваю $REPO@$REF..."
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

echo "Готово: конфигурация $REPO@$REF установлена."
