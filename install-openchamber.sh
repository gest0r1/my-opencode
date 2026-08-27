#!/usr/bin/env bash
set -Eeuo pipefail

CONFIG_REPO="${OPENCODE_CONFIG_REPO:-gest0r1/my-opencode}"
CONFIG_REF="${OPENCODE_CONFIG_REF:-main}"
OPENCHAMBER_REPO="${OPENCHAMBER_REPO:-gest0r1/openchamber-ru}"
OPENCHAMBER_REF="${OPENCHAMBER_REF:-main}"
NVM_VERSION="${NVM_VERSION:-v0.40.6}"
NODE_MAJOR="${NODE_MAJOR:-22}"

for cmd in gh curl mktemp; do
  command -v "$cmd" >/dev/null 2>&1 || {
    echo "Ошибка: требуется команда '$cmd'." >&2
    exit 1
  }
done

if ! gh auth status >/dev/null 2>&1; then
  echo "Ошибка: GitHub CLI не авторизован. Выполни: gh auth login" >&2
  exit 1
fi

install_system_package() {
  local package="$1"
  local sudo_cmd=()

  if (( EUID != 0 )); then
    if command -v sudo >/dev/null 2>&1; then
      sudo_cmd=(sudo)
    else
      echo "Ошибка: для установки системного пакета '$package' нужны root-права или sudo." >&2
      exit 1
    fi
  fi

  if command -v apt-get >/dev/null 2>&1; then
    echo "Устанавливаю системный пакет: $package (apt)..."
    "${sudo_cmd[@]}" apt-get update
    DEBIAN_FRONTEND=noninteractive "${sudo_cmd[@]}" apt-get install -y "$package"
  elif command -v dnf >/dev/null 2>&1; then
    echo "Устанавливаю системный пакет: $package (dnf)..."
    "${sudo_cmd[@]}" dnf install -y "$package"
  elif command -v yum >/dev/null 2>&1; then
    echo "Устанавливаю системный пакет: $package (yum)..."
    "${sudo_cmd[@]}" yum install -y "$package"
  elif command -v apk >/dev/null 2>&1; then
    echo "Устанавливаю системный пакет: $package (apk)..."
    "${sudo_cmd[@]}" apk add --no-cache "$package"
  else
    echo "Ошибка: не найден поддерживаемый пакетный менеджер для установки '$package'." >&2
    exit 1
  fi
}

# Удаляем только заведомо повреждённые самоссылки из предыдущей версии installer.
for bin in node npm npx; do
  path="/usr/local/bin/$bin"
  if [[ -L "$path" ]] && [[ "$(readlink "$path" 2>/dev/null || true)" == "$path" ]]; then
    echo "Удаляю повреждённую самоссылку: $path"
    rm -f "$path"
  fi
done
hash -r 2>/dev/null || true

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

# 2. Подхватываем уже установленный nvm до проверки Node.js.
export NVM_DIR="${NVM_DIR:-$HOME/.nvm}"
if [[ -s "$NVM_DIR/nvm.sh" ]]; then
  # shellcheck disable=SC1090
  . "$NVM_DIR/nvm.sh"
fi

node_major=0
if command -v node >/dev/null 2>&1; then
  node_major="$(node -p 'process.versions.node.split(".")[0]' 2>/dev/null || echo 0)"
fi

if (( node_major < NODE_MAJOR )); then
  echo "Node.js ${NODE_MAJOR}+ не найден. Устанавливаю nvm $NVM_VERSION и Node.js $NODE_MAJOR..."

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
fi

if ! command -v node >/dev/null 2>&1 || ! command -v npm >/dev/null 2>&1; then
  echo "Ошибка: Node.js/npm недоступны после установки." >&2
  exit 1
fi

echo "Node.js: $(node --version)"
echo "npm: $(npm --version)"

# Если Node используется через nvm, создаём стабильные ссылки для текущей версии.
# Источник берём только из NVM_BIN, поэтому самоссылка /usr/local/bin -> сама в себя невозможна.
if [[ -n "${NVM_BIN:-}" && -d /usr/local/bin && -w /usr/local/bin ]]; then
  [[ -x "$NVM_BIN/node" ]] && ln -sfn "$NVM_BIN/node" /usr/local/bin/node
  [[ -e "$NVM_BIN/npm" ]] && ln -sfn "$NVM_BIN/npm" /usr/local/bin/npm
  [[ -e "$NVM_BIN/npx" ]] && ln -sfn "$NVM_BIN/npx" /usr/local/bin/npx
  hash -r 2>/dev/null || true
fi

# 3. Bun нужен для воспроизводимой установки зависимостей и сборки monorepo.
# Официальный installer Bun требует unzip.
if ! command -v unzip >/dev/null 2>&1; then
  install_system_package unzip
fi

if ! command -v unzip >/dev/null 2>&1; then
  echo "Ошибка: unzip недоступен после установки." >&2
  exit 1
fi

export BUN_INSTALL="${BUN_INSTALL:-$HOME/.bun}"
if [[ -x "$BUN_INSTALL/bin/bun" ]]; then
  export PATH="$BUN_INSTALL/bin:$PATH"
fi

if ! command -v bun >/dev/null 2>&1; then
  echo "Bun не найден. Устанавливаю Bun..."
  curl -fsSL https://bun.sh/install | bash
  export PATH="$BUN_INSTALL/bin:$PATH"
fi

if ! command -v bun >/dev/null 2>&1; then
  echo "Ошибка: Bun недоступен после установки." >&2
  exit 1
fi

echo "Bun: $(bun --version)"

# 4. Временная загрузка fork OpenChamber. Рабочий clone после установки удаляется.
if ! command -v git >/dev/null 2>&1; then
  install_system_package git
fi

TMP_DIR="$(mktemp -d)"
trap 'rm -rf "$TMP_DIR"' EXIT
SRC="$TMP_DIR/src"

echo "Скачиваю $OPENCHAMBER_REPO@$OPENCHAMBER_REF..."
clone_ok=0
for attempt in 1 2 3; do
  rm -rf "$SRC"
  echo "Попытка $attempt/3..."

  # Принудительно HTTP/1.1: на некоторых VDS длинный HTTP/2 transfer через GitHub
  # завершается ошибкой 'stream ID ... CANCEL'.
  if GIT_CONFIG_COUNT=1 \
     GIT_CONFIG_KEY_0=http.version \
     GIT_CONFIG_VALUE_0=HTTP/1.1 \
     gh repo clone "$OPENCHAMBER_REPO" "$SRC" -- \
       --depth=1 --branch "$OPENCHAMBER_REF" --single-branch; then
    clone_ok=1
    break
  fi

  echo "Скачивание не удалось. Повторяю..." >&2
  sleep $((attempt * 2))
done

if (( clone_ok == 0 )); then
  echo "Ошибка: не удалось скачать $OPENCHAMBER_REPO@$OPENCHAMBER_REF после 3 попыток." >&2
  exit 1
fi

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

# OpenChamber должен быть доступен и в родительском shell после installer через pipe.
if [[ -d /usr/local/bin && -w /usr/local/bin ]]; then
  openchamber_real="$(readlink -f "$OPENCHAMBER_BIN" 2>/dev/null || printf '%s' "$OPENCHAMBER_BIN")"
  if [[ "$openchamber_real" != "/usr/local/bin/openchamber" ]]; then
    ln -sfn "$openchamber_real" /usr/local/bin/openchamber
    OPENCHAMBER_BIN="/usr/local/bin/openchamber"
  fi
fi

OPENCHAMBER_VERSION="$($OPENCHAMBER_BIN --version 2>/dev/null || true)"

echo ""
echo "Готово."
echo "OpenCode: $(opencode --version)"
echo "OpenChamber: ${OPENCHAMBER_VERSION:-установлен}"
echo "Источник OpenChamber: $OPENCHAMBER_REPO@$OPENCHAMBER_REF"
echo "CLI: $OPENCHAMBER_BIN"
echo "Запуск: openchamber --ui-password '<password>'"
