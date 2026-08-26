#!/usr/bin/env bash
set -Eeuo pipefail

CONFIG_REPO="${OPENCODE_CONFIG_REPO:-gest0r1/my-opencode}"
CONFIG_REF="${OPENCODE_CONFIG_REF:-main}"
OPENCHAMBER_REPO="${OPENCHAMBER_REPO:-gest0r1/openchamber-ru}"
OPENCHAMBER_REF="${OPENCHAMBER_REF:-main}"
NVM_VERSION="${NVM_VERSION:-v0.40.6}"
NODE_MAJOR="${NODE_MAJOR:-22}"

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

# 1. Всегда обновляем OpenCode и приватную конфигурацию my-opencode.
echo "Устанавливаю/обновляю OpenCode и приватную конфигурацию $CONFIG_REPO@$CONFIG_REF..."
gh api \
  -H "Accept: application/vnd.github.raw" \
  "repos/$CONFIG_REPO/contents/install.sh?ref=$CONFIG_REF" | \
  OPENCODE_CONFIG_REPO="$CONFIG_REPO" OPENCODE_CONFIG_REF="$CONFIG_REF" bash

if [[ -x "$HOME/.opencode/bin/opencode" ]] && ! command -v opencode >/dev/null 2>&1; then
  export PATH="$HOME/.opencode/bin:$PATH"
fi

if ! command -v opencode >/dev/null 2>&1; then
  echo "Ошибка: OpenCode не доступен после установки." >&2
  exit 1
fi

echo "OpenCode: $(opencode --version)"

# 2. Node.js 22+ через nvm. OpenChamber CLI требует Node.js >=22.
node_major=0
if command -v node >/dev/null 2>&1; then
  node_major="$(node -p 'process.versions.node.split(".")[0]' 2>/dev/null || echo 0)"
fi

if (( node_major < NODE_MAJOR )); then
  echo "Node.js ${NODE_MAJOR}+ не найден. Устанавливаю nvm $NVM_VERSION и Node.js $NODE_MAJOR..."
  export NVM_DIR="${NVM_DIR:-$HOME/.nvm}"

  if [[ ! -s "$NVM_DIR/nvm.sh" ]]; then
    curl -fsSL \
      "https://raw.githubusercontent.com/nvm-sh/nvm/$NVM_VERSION/install.sh" | \
      PROFILE=/dev/null bash
  fi

  # shellcheck disable=SC1090
  . "$NVM_DIR/nvm.sh"
  nvm install "$NODE_MAJOR"
  nvm alias default "$NODE_MAJOR"
  nvm use "$NODE_MAJOR"
else
  echo "Node.js: $(node --version)"
fi

if ! command -v node >/dev/null 2>&1 || ! command -v npm >/dev/null 2>&1; then
  echo "Ошибка: Node.js/npm недоступны после установки." >&2
  exit 1
fi

# При запуске installer через pipe родительский shell не получит PATH от nvm.
# Для root/обычной Ubuntu делаем runtime доступным через стандартный PATH.
if [[ -d /usr/local/bin && -w /usr/local/bin ]]; then
  ln -sf "$(command -v node)" /usr/local/bin/node
  ln -sf "$(command -v npm)" /usr/local/bin/npm
  if command -v npx >/dev/null 2>&1; then
    ln -sf "$(command -v npx)" /usr/local/bin/npx
  fi
fi

echo "Node.js: $(node --version)"
echo "npm: $(npm --version)"

# 3. Bun нужен для воспроизводимой установки зависимостей и сборки monorepo.
if ! command -v bun >/dev/null 2>&1; then
  echo "Bun не найден. Устанавливаю Bun..."
  curl -fsSL https://bun.sh/install | bash
  export BUN_INSTALL="${BUN_INSTALL:-$HOME/.bun}"
  export PATH="$BUN_INSTALL/bin:$PATH"
fi

if ! command -v bun >/dev/null 2>&1; then
  echo "Ошибка: Bun недоступен после установки." >&2
  exit 1
fi

echo "Bun: $(bun --version)"

# 4. Временная загрузка fork OpenChamber. Рабочий git clone не создаётся.
TMP_DIR="$(mktemp -d)"
trap 'rm -rf "$TMP_DIR"' EXIT
ARCHIVE="$TMP_DIR/openchamber.tar.gz"
SRC="$TMP_DIR/src"
mkdir -p "$SRC"

echo "Скачиваю $OPENCHAMBER_REPO@$OPENCHAMBER_REF..."
gh api "repos/$OPENCHAMBER_REPO/tarball/$OPENCHAMBER_REF" > "$ARCHIVE"
tar -xzf "$ARCHIVE" -C "$SRC" --strip-components=1

if [[ ! -f "$SRC/package.json" || ! -f "$SRC/packages/web/package.json" ]]; then
  echo "Ошибка: структура репозитория OpenChamber не распознана." >&2
  exit 1
fi

# 5. Сборка именно fork, а не публичного @openchamber/web из npm.
echo "Устанавливаю зависимости OpenChamber..."
(
  cd "$SRC"
  bun install --frozen-lockfile
  echo "Собираю Web/CLI OpenChamber..."
  bun run build:web
)

# Устанавливаем не локальную папку, а tarball. Иначе npm может оставить symlink
# на временный каталог, который будет удалён после завершения installer.
echo "Упаковываю OpenChamber..."
PACKAGE_TGZ="$(
  cd "$SRC/packages/web"
  npm pack --silent --pack-destination "$TMP_DIR" | tail -n 1
)"
PACKAGE_PATH="$TMP_DIR/$PACKAGE_TGZ"

if [[ ! -f "$PACKAGE_PATH" ]]; then
  echo "Ошибка: npm pack не создал пакет OpenChamber." >&2
  exit 1
fi

echo "Устанавливаю собранный OpenChamber глобально..."
npm install -g "$PACKAGE_PATH"

OPENCHAMBER_BIN="$(command -v openchamber || true)"
if [[ -z "$OPENCHAMBER_BIN" ]]; then
  npm_prefix="$(npm prefix -g)"
  if [[ -x "$npm_prefix/bin/openchamber" ]]; then
    OPENCHAMBER_BIN="$npm_prefix/bin/openchamber"
  fi
fi

if [[ -z "$OPENCHAMBER_BIN" || ! -x "$OPENCHAMBER_BIN" ]]; then
  echo "Ошибка: openchamber не найден после глобальной установки." >&2
  exit 1
fi

# Та же защита от PATH-проблемы, что и для OpenCode.
if [[ -d /usr/local/bin && -w /usr/local/bin ]]; then
  ln -sf "$OPENCHAMBER_BIN" /usr/local/bin/openchamber
  OPENCHAMBER_BIN="/usr/local/bin/openchamber"
fi

OPENCHAMBER_VERSION="$($OPENCHAMBER_BIN --version 2>/dev/null || true)"

echo ""
echo "Готово."
echo "OpenCode: $(opencode --version)"
echo "OpenChamber: ${OPENCHAMBER_VERSION:-установлен}"
echo "Источник OpenChamber: $OPENCHAMBER_REPO@$OPENCHAMBER_REF"
echo "CLI: $OPENCHAMBER_BIN"
echo "Запуск: openchamber --ui-password '<password>'"
