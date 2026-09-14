# Legacy source-build fallback. It is intentionally invoked only by
# install-openchamber.sh --build-from-source.
# Default installation uses a verified GitHub release bundle.

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
if [[ -n "${NVM_BIN:-}" && -d /usr/local/bin && -w /usr/local/bin ]]; then
  [[ -x "$NVM_BIN/node" ]] && ln -sfn "$NVM_BIN/node" /usr/local/bin/node
  [[ -e "$NVM_BIN/npm" ]] && ln -sfn "$NVM_BIN/npm" /usr/local/bin/npm
  [[ -e "$NVM_BIN/npx" ]] && ln -sfn "$NVM_BIN/npx" /usr/local/bin/npx
  hash -r 2>/dev/null || true
fi

# 3. Bun нужен для воспроизводимой установки зависимостей и сборки monorepo.
if ! command -v unzip >/dev/null 2>&1; then
  install_system_package unzip
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

# 4. Временная загрузка fork OpenChamber.
# Основной путь — GitHub tarball через curl HTTP/1.1 с retry. Это устойчивее
# большого git pack на соединениях, где встречаются GnuTLS recv/early EOF.
if ! command -v tar >/dev/null 2>&1; then
  install_system_package tar
fi
if ! command -v git >/dev/null 2>&1; then
  install_system_package git
fi

TMP_DIR="$(mktemp -d)"
trap 'rm -rf "$TMP_DIR"' EXIT
SRC="$TMP_DIR/src"
ARCHIVE="$TMP_DIR/openchamber.tar.gz"
mkdir -p "$SRC"

GITHUB_TOKEN="$(gh auth token 2>/dev/null || true)"
ARCHIVE_URL="https://api.github.com/repos/$OPENCHAMBER_REPO/tarball/$OPENCHAMBER_REF"

echo "Скачиваю $OPENCHAMBER_REPO@$OPENCHAMBER_REF snapshot..."
download_ok=0

curl_args=(
  --fail --location --http1.1
  --retry 6 --retry-delay 3 --retry-max-time 300 --retry-all-errors
  --connect-timeout 20
  --speed-time 60 --speed-limit 1024
  -H "Accept: application/vnd.github+json"
  -H "X-GitHub-Api-Version: 2022-11-28"
)
if [[ -n "$GITHUB_TOKEN" ]]; then
  curl_args+=( -H "Authorization: Bearer $GITHUB_TOKEN" )
fi

if curl "${curl_args[@]}" "$ARCHIVE_URL" -o "$ARCHIVE"; then
  if tar -tzf "$ARCHIVE" >/dev/null 2>&1; then
    tar -xzf "$ARCHIVE" -C "$SRC" --strip-components=1
    download_ok=1
  else
    echo "Полученный tarball повреждён. Перехожу к fallback." >&2
  fi
fi

# Fallback: минимальный partial clone, также через HTTP/1.1.
if (( download_ok == 0 )); then
  echo "Tarball не скачался. Fallback: partial git clone..." >&2
  rm -rf "$SRC"

  for attempt in 1 2 3; do
    echo "Fallback попытка $attempt/3..."
    rm -rf "$SRC"

    if git \
      -c http.version=HTTP/1.1 \
      -c http.lowSpeedLimit=1024 \
      -c http.lowSpeedTime=60 \
      clone \
      --depth=1 \
      --filter=blob:none \
      --no-tags \
      --single-branch \
      --branch "$OPENCHAMBER_REF" \
      "https://github.com/$OPENCHAMBER_REPO.git" "$SRC"; then
      download_ok=1
      break
    fi

    sleep $((attempt * 3))
  done
fi

if (( download_ok == 0 )); then
  echo "Ошибка: не удалось скачать $OPENCHAMBER_REPO@$OPENCHAMBER_REF ни tarball, ни partial clone." >&2
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

# Ищем реальный бинарник именно в текущем npm prefix, а не старый launcher
# /usr/local/bin/openchamber от предыдущей установки.
npm_prefix="$(npm prefix -g)"
OPENCHAMBER_NPM_BIN="$npm_prefix/bin/openchamber"
OPENCHAMBER_REAL=""
if [[ -e "$OPENCHAMBER_NPM_BIN" || -L "$OPENCHAMBER_NPM_BIN" ]]; then
  OPENCHAMBER_REAL="$(readlink -f "$OPENCHAMBER_NPM_BIN" 2>/dev/null || true)"
fi

if [[ -z "$OPENCHAMBER_REAL" || ! -x "$OPENCHAMBER_REAL" ]]; then
  candidate="$(command -v openchamber || true)"
  if [[ -n "$candidate" && "$candidate" != "/usr/local/bin/openchamber" ]]; then
    OPENCHAMBER_REAL="$(readlink -f "$candidate" 2>/dev/null || printf '%s' "$candidate")"
  fi
fi

if [[ -z "$OPENCHAMBER_REAL" || ! -x "$OPENCHAMBER_REAL" ]]; then
  echo "Ошибка: реальный openchamber не найден после глобальной установки." >&2
  exit 1
fi

# Managed launcher загружает тот же opencode.env, что используется обычным
# OpenCode CLI. Для `startup enable` автоматически запрещаем snapshot общего
# окружения: systemd получает общий env отдельным EnvironmentFile.
OPENCHAMBER_BIN="$OPENCHAMBER_REAL"
if [[ -d /usr/local/bin && -w /usr/local/bin ]]; then
  OPENCHAMBER_LAUNCHER="/usr/local/bin/openchamber"
  rm -f "$OPENCHAMBER_LAUNCHER"
  cat > "$OPENCHAMBER_LAUNCHER" <<EOF
#!/usr/bin/env bash
# managed-by: my-opencode-openchamber
set -a
if [[ -f "\$HOME/.config/opencode.env" ]]; then
  # shellcheck disable=SC1090
  . "\$HOME/.config/opencode.env"
fi
set +a

if [[ "\${1:-}" == "startup" && "\${2:-}" == "enable" ]]; then
  has_no_env_snapshot=0
  for arg in "\$@"; do
    if [[ "\$arg" == "--no-env-snapshot" ]]; then
      has_no_env_snapshot=1
      break
    fi
  done
  if (( has_no_env_snapshot == 0 )); then
    exec "$OPENCHAMBER_REAL" "\$@" --no-env-snapshot
  fi
fi

exec "$OPENCHAMBER_REAL" "\$@"
EOF
  chmod 755 "$OPENCHAMBER_LAUNCHER"
  OPENCHAMBER_BIN="$OPENCHAMBER_LAUNCHER"
fi

# 6. OpenChamber systemd использует тот же общий env, что и CLI.
# Сам OpenChamber по-прежнему может хранить в startup.env только собственные
# параметры (UI password и т.п.), но не копию общего окружения.
SYSTEMD_DROPIN_DIR="$HOME/.config/systemd/user/openchamber.service.d"
SYSTEMD_DROPIN="$SYSTEMD_DROPIN_DIR/10-opencode-env.conf"
mkdir -p "$SYSTEMD_DROPIN_DIR"
cat > "$SYSTEMD_DROPIN" <<EOF
[Service]
EnvironmentFile=-$HOME/.config/opencode.env
Environment="OPENCODE_BINARY=$HOME/.opencode/bin/opencode"
EOF
chmod 600 "$SYSTEMD_DROPIN"

# Если startup.env был создан старой версией со snapshot окружения, удаляем из
# него переменные, которые теперь принадлежат единому opencode.env, а также
# старые LLM API key overrides.
STARTUP_ENV="$HOME/.local/share/openchamber/startup.env"
SHARED_ENV="$HOME/.config/opencode.env"
if [[ -f "$STARTUP_ENV" ]]; then
  CLEAN_STARTUP_ENV="$TMP_DIR/startup.env"
  if [[ -f "$SHARED_ENV" ]]; then
    awk -F= '
      NR==FNR {
        key=$1
        gsub(/^[[:space:]]+|[[:space:]]+$/, "", key)
        if (key ~ /^[A-Za-z_][A-Za-z0-9_]*$/) shared[key]=1
        next
      }
      {
        key=$1
        if (key == "OPENAI_API_KEY" || key == "OPENCODE_API_KEY") next
        if (!(key in shared)) print
      }
    ' "$SHARED_ENV" "$STARTUP_ENV" > "$CLEAN_STARTUP_ENV"
  else
    grep -Ev '^(OPENAI_API_KEY|OPENCODE_API_KEY)=' "$STARTUP_ENV" > "$CLEAN_STARTUP_ENV" || true
  fi
  mv "$CLEAN_STARTUP_ENV" "$STARTUP_ENV"
  chmod 600 "$STARTUP_ENV"
fi

# Если автозагрузка уже включена, применяем drop-in к существующему сервису.
if command -v systemctl >/dev/null 2>&1 && \
   [[ -f "$HOME/.config/systemd/user/openchamber.service" ]]; then
  systemctl --user daemon-reload || true
  systemctl --user restart openchamber.service || true
fi

OPENCHAMBER_VERSION="$($OPENCHAMBER_BIN --version 2>/dev/null || true)"

echo ""
echo "Готово."
echo "OpenCode: $(opencode --version)"
echo "OpenChamber: ${OPENCHAMBER_VERSION:-установлен}"
echo "Источник OpenChamber: $OPENCHAMBER_REPO@$OPENCHAMBER_REF"
echo "CLI: $OPENCHAMBER_BIN"
echo "Общий env: $HOME/.config/opencode.env"
echo "Запуск: openchamber --ui-password '<password>'"
echo "Автозагрузка: openchamber startup enable --host '<docker-bridge-ip>' --port 3000 --ui-password '<password>'"
