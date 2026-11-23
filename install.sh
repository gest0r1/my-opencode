#!/usr/bin/env bash
# Always stage and validate a full configuration generation. Binary downloads
# remain independent and are skipped when the installed version matches.
set -Eeuo pipefail

RUNTIME_USER="${OPENCODE_RUNTIME_USER:-opencode}"
[[ "$RUNTIME_USER" == opencode ]] || {
  echo "Invalid runtime user '$RUNTIME_USER': required name is exactly opencode" >&2
  exit 2
}
for cmd in id getent cut; do
  command -v "$cmd" >/dev/null 2>&1 || { echo "Missing prerequisite: $cmd" >&2; exit 1; }
done

CURRENT_USER="$(id -un)"
RUNTIME_HOME="$(getent passwd "$RUNTIME_USER" | cut -d: -f6 || true)"
[[ -n "$RUNTIME_HOME" || "$CURRENT_USER" != "$RUNTIME_USER" ]] || {
  echo "Runtime user '$RUNTIME_USER' does not exist." >&2
  exit 2
}

reexec_as_runtime_user() {
  [[ "$CURRENT_USER" != "$RUNTIME_USER" ]] || return 0
  for cmd in sudo loginctl systemctl mktemp cp chmod rm gh; do
    command -v "$cmd" >/dev/null 2>&1 || {
      echo "Missing prerequisite for user switch: $cmd" >&2
      exit 1
    }
  done
  sudo -v || {
    echo "Current user '$CURRENT_USER' must have sudo rights." >&2
    exit 2
  }

  # Provision only the permanent dedicated runtime account and its narrow APT
  # helper. No legacy/root runtime state is read or migrated here.
  local provision_dir provision_sha provision_repo provision_ref file
  provision_repo="${OPENCODE_CONFIG_REPO:-gest0r1/my-opencode}"
  provision_ref="${OPENCODE_CONFIG_REF:-${MY_OPENCODE_REF:-main}}"
  provision_sha="$(gh api "repos/$provision_repo/commits/$provision_ref" --jq .sha)"
  [[ "$provision_sha" =~ ^[a-f0-9]{40}$ ]] || exit 1
  provision_dir="$(mktemp -d /tmp/my-opencode-provision.XXXXXXXX)"
  chmod 755 "$provision_dir"
  for file in provision-runtime-user.sh setup-opencode-package-sudo.sh setup-opencode-deploy-sudo.sh; do
    gh api -H 'Accept: application/vnd.github.raw' \
      "repos/$provision_repo/contents/scripts/$file?ref=$provision_sha" > "$provision_dir/$file"
    chmod 755 "$provision_dir/$file"
  done
  sudo env -i PATH=/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin \
    bash "$provision_dir/provision-runtime-user.sh"
  rm -rf -- "$provision_dir"

  RUNTIME_HOME="$(getent passwd "$RUNTIME_USER" | cut -d: -f6)"
  [[ -n "$RUNTIME_HOME" ]] || {
    echo "Runtime user '$RUNTIME_USER' was not provisioned." >&2
    exit 2
  }

  local runtime_uid script_copy rc token name source_file token_file=''
  local -a pass_env=("OPENCODE_CONFIG_REF=$provision_sha" "MY_OPENCODE_REF=$provision_sha")
  runtime_uid="$(id -u "$RUNTIME_USER")"
  sudo loginctl enable-linger "$RUNTIME_USER" >/dev/null
  sudo systemctl start "user@${runtime_uid}.service"

  script_copy="$(mktemp /tmp/my-opencode-install.XXXXXXXX)"
  source_file="${BASH_SOURCE[0]:-}"
  if [[ -n "$source_file" && -f "$source_file" ]]; then
    cp -- "$source_file" "$script_copy"
  else
    gh api -H 'Accept: application/vnd.github.raw' \
      "repos/$provision_repo/contents/install.sh?ref=$provision_sha" > "$script_copy"
  fi
  chmod 755 "$script_copy"

  for name in $(compgen -e); do
    case "$name" in
      OPENCODE_CONFIG_REF|MY_OPENCODE_REF) continue ;;
      OPENCODE_*|OPENCHAMBER_*|MY_OPENCODE_REF|EXPECTED_OPENCHAMBER_VERSION|GH_HOST|HTTP_PROXY|HTTPS_PROXY|NO_PROXY|http_proxy|https_proxy|no_proxy)
        pass_env+=("$name=${!name}")
        ;;
    esac
  done

  # Prefer the runtime user's GitHub auth. If it is not configured, hand over
  # the invoking sudo user's token through a mode-0600 runtime file, never argv.
  if ! sudo -H -u "$RUNTIME_USER" env -i \
      HOME="$RUNTIME_HOME" USER="$RUNTIME_USER" LOGNAME="$RUNTIME_USER" \
      PATH="$RUNTIME_HOME/.local/bin:$RUNTIME_HOME/.opencode/bin:$RUNTIME_HOME/.bun/bin:/usr/local/bin:/usr/bin:/bin" \
      XDG_RUNTIME_DIR="/run/user/$runtime_uid" DBUS_SESSION_BUS_ADDRESS="unix:path=/run/user/$runtime_uid/bus" \
      gh auth status --hostname github.com >/dev/null 2>&1; then
    if [[ -n "${GH_TOKEN:-}" ]]; then
      token="$GH_TOKEN"
    elif gh auth status --hostname github.com >/dev/null 2>&1; then
      token="$(gh auth token --hostname github.com)"
    fi
    if [[ -n "${token:-}" ]]; then
      token_file="/run/user/$runtime_uid/.my-opencode-gh-token.${BASHPID}.${RANDOM}"
      printf '%s' "$token" | sudo -H -u "$RUNTIME_USER" sh -c \
        'cd "$HOME"; umask 077; cat > "$1"' sh "$token_file"
      pass_env+=("OPENCODE_INSTALL_GH_TOKEN_FILE=$token_file")
    fi
  fi

  echo "Switching installer runtime: $CURRENT_USER -> $RUNTIME_USER"
  if sudo -H -u "$RUNTIME_USER" env -i \
      HOME="$RUNTIME_HOME" USER="$RUNTIME_USER" LOGNAME="$RUNTIME_USER" \
      PATH="$RUNTIME_HOME/.local/bin:$RUNTIME_HOME/.opencode/bin:$RUNTIME_HOME/.bun/bin:/usr/local/bin:/usr/bin:/bin" \
      XDG_RUNTIME_DIR="/run/user/$runtime_uid" DBUS_SESSION_BUS_ADDRESS="unix:path=/run/user/$runtime_uid/bus" \
      "${pass_env[@]}" bash -c 'cd "$HOME"; exec bash "$@"' bash "$script_copy" "$@"; then
    rc=0
  else
    rc=$?
  fi
  rm -f -- "$script_copy"
  [[ -z "$token_file" ]] || sudo -H -u "$RUNTIME_USER" rm -f -- "$token_file" >/dev/null 2>&1 || true
  exit "$rc"
}
reexec_as_runtime_user "$@"

cd "$RUNTIME_HOME"
export XDG_CONFIG_HOME="$HOME/.config" XDG_DATA_HOME="$HOME/.local/share" XDG_STATE_HOME="$HOME/.local/state"

if [[ -n "${OPENCODE_INSTALL_GH_TOKEN_FILE:-}" ]]; then
  [[ -r "$OPENCODE_INSTALL_GH_TOKEN_FILE" ]] || {
    echo 'Temporary GitHub token handoff is unreadable.' >&2
    exit 1
  }
  export GH_TOKEN="$(cat -- "$OPENCODE_INSTALL_GH_TOKEN_FILE")"
  rm -f -- "$OPENCODE_INSTALL_GH_TOKEN_FILE"
  unset OPENCODE_INSTALL_GH_TOKEN_FILE
fi

if [[ "$HOME" != "$RUNTIME_HOME" ]]; then
  echo "Invalid HOME for runtime user '$RUNTIME_USER': HOME='$HOME', expected='$RUNTIME_HOME'." >&2
  exit 2
fi
if ! command -v sudo >/dev/null || ! sudo -n /usr/local/sbin/opencode-install-packages --check >/dev/null 2>&1; then
  echo 'Package-install helper is not configured. Run scripts/setup-opencode-package-sudo.sh once with sudo/root.' >&2
  exit 2
fi

REPO="${OPENCODE_CONFIG_REPO:-gest0r1/my-opencode}"
REF="${OPENCODE_CONFIG_REF:-main}"
export OPENCODE_INSTALL_VERSION="${OPENCODE_INSTALL_VERSION:-2.3.2}"
GENERATION_PATH="scripts/install-opencode-generation.sh"
BOOTSTRAP_PATH="scripts/bootstrap-runtime-tools.sh"
for cmd in gh mktemp rm sed systemctl; do
  command -v "$cmd" >/dev/null 2>&1 || { echo "Missing prerequisite: $cmd" >&2; exit 1; }
done
gh auth status --hostname github.com >/dev/null 2>&1 || {
  echo 'GitHub CLI is not authorized for this install run.' >&2
  exit 1
}

CONFIG_SHA="${OPENCODE_RESOLVED_CONFIG_SHA:-$REF}"
if [[ ! "$CONFIG_SHA" =~ ^[a-f0-9]{40}$ ]]; then
  CONFIG_SHA="$(gh api "repos/$REPO/commits/$REF" --jq .sha)"
fi
export OPENCODE_RESOLVED_CONFIG_SHA="$CONFIG_SHA"

TMP_DIR="$(mktemp -d /tmp/opencode-generation-bootstrap.XXXXXXXX)"
GENERATION="$TMP_DIR/install-opencode-generation.sh"
BOOTSTRAP="$TMP_DIR/bootstrap-runtime-tools.sh"
trap 'rm -rf -- "$TMP_DIR"' EXIT
gh api -H 'Accept: application/vnd.github.raw' \
  "repos/$REPO/contents/$GENERATION_PATH?ref=$CONFIG_SHA" > "$GENERATION"
gh api -H 'Accept: application/vnd.github.raw' \
  "repos/$REPO/contents/$BOOTSTRAP_PATH?ref=$CONFIG_SHA" > "$BOOTSTRAP"
source "$BOOTSTRAP"
ensure_runtime_toolchain

OPENCODE_BIN="$HOME/.opencode/bin/opencode"
if [[ "${OPENCODE_SKIP_BINARY_INSTALL:-0}" != 1 &&
      "${OPENCODE_FORCE_BINARY_INSTALL:-0}" != 1 &&
      -x "$OPENCODE_BIN" ]] &&
   [[ "$("$OPENCODE_BIN" --version | sed -E 's/^opencode[[:space:]]+v?//')" == "$OPENCODE_INSTALL_VERSION" ]]; then
  export OPENCODE_SKIP_BINARY_INSTALL=1
fi

bash "$GENERATION" "$@"
configure_server_browser

# OpenCode is a persistent user service owned by opencode.
"$OPENCODE_BIN" serve --help > "$TMP_DIR/serve-help"
grep -q -- '--hostname' "$TMP_DIR/serve-help" && grep -q -- '--port' "$TMP_DIR/serve-help" || {
  echo 'Installed OpenCode does not support serve --hostname/--port' >&2
  exit 1
}
# The tracked V2 unit is the single service template. OpenCode stays local.
WEB_PORT="${OPENCODE_WEB_PORT:-4096}"
[[ "$WEB_PORT" =~ ^[0-9]+$ && "$WEB_PORT" -ge 1 && "$WEB_PORT" -le 65535 ]] || {
  echo 'OPENCODE_WEB_PORT must be 1..65535' >&2
  exit 2
}
USER_SYSTEMD_DIR="$HOME/.config/systemd/user"
UNIT="$USER_SYSTEMD_DIR/opencode-web.service"
mkdir -p "$USER_SYSTEMD_DIR"
UNIT_TMP="$(mktemp "$USER_SYSTEMD_DIR/.opencode-web.service.XXXXXXXX")"
gh api -H 'Accept: application/vnd.github.raw' \
  "repos/$REPO/contents/config/systemd/opencode-web.service?ref=$CONFIG_SHA" \
  | sed "s/OPENCODE_WEB_PORT=4096/OPENCODE_WEB_PORT=$WEB_PORT/" > "$UNIT_TMP"
chmod 644 "$UNIT_TMP"
mv -f "$UNIT_TMP" "$UNIT"
systemctl --user daemon-reload
systemctl --user enable opencode-web.service >/dev/null
echo "OpenCode autostart enabled for user $RUNTIME_USER."

