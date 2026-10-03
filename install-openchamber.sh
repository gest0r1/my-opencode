#!/usr/bin/env bash
# Atomic orchestration wrapper for OpenChamber 2.x + OpenCode 2.x installation.
# The heavy incremental decision tree lives in scripts/install-openchamber-v2-core.sh.
# This wrapper adds a transaction boundary around the OpenChamber runtime/service:
# install into an immutable source-SHA prefix, health-check through the core,
# then atomically switch current; on failure restore the previous unit/env/runtime.
set -Eeuo pipefail

CONFIG_REPO="${OPENCODE_CONFIG_REPO:-gest0r1/my-opencode}"
CONFIG_REF="${OPENCODE_CONFIG_REF:-${MY_OPENCODE_REF:-main}}"
APP_REPO="${OPENCHAMBER_REPO:-gest0r1/openchamber-ru}"
APP_REF="${OPENCHAMBER_REF:-main}"
EXPECTED_OPENCHAMBER_VERSION="${OPENCHAMBER_EXPECTED_VERSION:-2.1.0}"
OPENCHAMBER_RUNTIME_ROOT="${OPENCHAMBER_RUNTIME_ROOT:-$HOME/.local/share/openchamber-v2}"
LEGACY_BUN_INSTALL="${LEGACY_BUN_INSTALL:-$HOME/.bun}"
STATE_ROOT="${XDG_STATE_HOME:-$HOME/.local/state}/my-opencode"
STATE="$STATE_ROOT/openchamber-v2-install.state"
TRANSACTION_LOCK="$STATE_ROOT/openchamber-v2-atomic.lock"
UNIT_DIR="$HOME/.config/systemd/user"
UNIT="$UNIT_DIR/openchamber.service"
DROP_DIR="$UNIT_DIR/openchamber.service.d"
NATIVE_STARTUP_ENV="$HOME/.config/openchamber/startup.env"

for cmd in gh mktemp systemctl readlink ln mv cp rm sed grep flock; do
  command -v "$cmd" >/dev/null 2>&1 || {
    echo "Missing prerequisite: $cmd" >&2
    exit 1
  }
done

gh auth status --hostname github.com >/dev/null 2>&1 || {
  echo 'Authenticate GitHub CLI with: gh auth login' >&2
  exit 1
}

TMP="$(mktemp -d /tmp/openchamber-v2-atomic.XXXXXXXX)"
CORE="$TMP/install-openchamber-v2-core.sh"
RUNTIME_HELPER="$TMP/openchamber-runtime-store.sh"
STATE_BACKUP="$TMP/openchamber-v2-install.state.before"
SERVICE_SNAPSHOT="$TMP/service-snapshot"
STATE_EXISTED=0
RELEASE_EXISTED=0
TRANSACTION_STARTED=0
TRANSACTION_COMMITTED=0
ROLLBACK_RUNNING=0

cleanup() {
  rm -rf -- "$TMP"
}
trap cleanup EXIT

APP_SHA="$(gh api "repos/$APP_REPO/commits/$APP_REF" --jq .sha)"
[[ "$APP_SHA" =~ ^[a-f0-9]{40}$ ]] || {
  echo "Could not resolve exact OpenChamber SHA for $APP_REPO@$APP_REF" >&2
  exit 1
}

# Fetch both scripts from the same config ref. This prevents mixing an old
# wrapper with a newer transaction helper/core during branch-based testing.
gh api -H 'Accept: application/vnd.github.raw' \
  "repos/$CONFIG_REPO/contents/scripts/install-openchamber-v2-core.sh?ref=$CONFIG_REF" > "$CORE"
gh api -H 'Accept: application/vnd.github.raw' \
  "repos/$CONFIG_REPO/contents/scripts/openchamber-runtime-store.sh?ref=$CONFIG_REF" > "$RUNTIME_HELPER"

export EXPECTED_OPENCHAMBER_VERSION OPENCHAMBER_RUNTIME_ROOT LEGACY_BUN_INSTALL
# shellcheck disable=SC1090
source "$RUNTIME_HELPER"
oc_runtime_init

# The core has its own execution lock, but the outer transaction starts earlier:
# it snapshots current/state/systemd before invoking the core. Serialize that
# whole interval as well so two installers cannot snapshot each other's partial
# generation and later roll back to inconsistent states.
mkdir -p "$STATE_ROOT" "$UNIT_DIR"
exec 8>"$TRANSACTION_LOCK"
flock -x 8

RELEASE_DIR="$OPENCHAMBER_RELEASES/$APP_SHA"
CURRENT_BEFORE="$(readlink -f "$OPENCHAMBER_CURRENT" 2>/dev/null || true)"
[[ -e "$RELEASE_DIR" ]] && RELEASE_EXISTED=1 || true

if [[ -f "$STATE" ]]; then
  cp -a "$STATE" "$STATE_BACKUP"
  STATE_EXISTED=1
fi

restore_state() {
  if (( STATE_EXISTED == 1 )); then
    cp -a "$STATE_BACKUP" "$STATE"
  else
    rm -f -- "$STATE"
  fi
}

rollback_all() {
  local rc=${1:-1}
  if (( ROLLBACK_RUNNING == 1 )); then
    exit "$rc"
  fi
  ROLLBACK_RUNNING=1
  trap - ERR INT TERM
  set +e

  echo "OpenChamber activation failed; restoring previous runtime/service state." >&2
  if (( TRANSACTION_STARTED == 1 )); then
    oc_rollback_service "$UNIT" "$NATIVE_STARTUP_ENV" "$DROP_DIR" || true
    restore_state || true
  fi

  # A release created only by this failed transaction was never committed via
  # current. Remove it after service/runtime rollback. Existing staged releases
  # are retained because a previous deferred run may own them.
  if (( RELEASE_EXISTED == 0 )) && [[ "$RELEASE_DIR" != "$CURRENT_BEFORE" ]]; then
    rm -rf -- "$RELEASE_DIR"
  fi
  exit "$rc"
}

on_error() {
  local rc=$?
  (( TRANSACTION_COMMITTED == 1 )) && return "$rc"
  rollback_all "$rc"
}

on_interrupt() {
  local rc=$1
  (( TRANSACTION_COMMITTED == 1 )) && exit "$rc"
  rollback_all "$rc"
}

oc_snapshot_service "$UNIT" "$NATIVE_STARTUP_ENV" "$DROP_DIR" "$SERVICE_SNAPSHOT"
TRANSACTION_STARTED=1
trap on_error ERR
trap 'on_interrupt 130' INT
trap 'on_interrupt 143' TERM

# Recover the only uncatchable crash window. If a previous process was SIGKILLed
# after native startup had already pinned the unit to a complete immutable
# release but before it published `current`, adopt that exact validated release
# as the baseline. Do not mutate a directory that may already be executing.
if [[ ! -x "$OPENCHAMBER_CURRENT_BIN" ]] &&
   oc_validate_release "$RELEASE_DIR" &&
   [[ -f "$UNIT" ]] && grep -Fq "$RELEASE_DIR/" "$UNIT"; then
  echo "Recovering interrupted OpenChamber activation from immutable runtime: $RELEASE_DIR"
  oc_activate_release "$RELEASE_DIR"
  oc_commit_activation
  CURRENT_BEFORE="$RELEASE_DIR"
fi

# First migration from Bun-global runtime: force the core to resolve/apply the
# verified package if there is no recovered/canonical immutable current. This
# avoids trusting an older pre-atomic state file that referred to Bun-global
# installation rather than the immutable release store.
if [[ ! -x "$OPENCHAMBER_CURRENT_BIN" ]]; then
  rm -f -- "$STATE"
fi

# The core's `bun add -g` is intentionally redirected into this immutable
# source-SHA release prefix. It is not active via `current` while Bun mutates it.
# Existing legacy Bun stays on PATH only as a rollback/runtime discovery source.
export BUN_INSTALL="$RELEASE_DIR"
export PATH="$BUN_INSTALL/bin:$HOME/.local/bin:$HOME/.opencode/bin:$LEGACY_BUN_INSTALL/bin:$PATH"

# Disable Bash command hashing in the child. The core reads the legacy CLI
# before installing the new release; with normal hashall Bash could keep using
# that old path after Bun creates $RELEASE_DIR/bin/openchamber and then write a
# new systemd unit that still points at the legacy global package.
if bash +h "$CORE" "$@"; then
  core_rc=0
else
  core_rc=$?
  rollback_all "$core_rc"
fi

state_value() {
  [[ -f "$STATE" ]] || return 0
  sed -n "s/^$1=//p" "$STATE" | head -1
}

runtime_pending="$(state_value runtime_pending)"
service_restart_pending="$(state_value service_restart_pending)"
runtime_pending="${runtime_pending:-0}"
service_restart_pending="${service_restart_pending:-0}"

# If the runtime was actually applied by the core, validate the immutable
# release and publish it through one atomic symlink switch. In defer mode the
# core may only cache the package; then RELEASE_DIR legitimately has no CLI yet.
if [[ "$runtime_pending" == 0 && -x "$RELEASE_DIR/bin/openchamber" ]]; then
  current_target="$(readlink -f "$OPENCHAMBER_CURRENT" 2>/dev/null || true)"
  if [[ "$current_target" != "$RELEASE_DIR" ]]; then
    oc_activate_release "$RELEASE_DIR"
  fi
fi

# A non-pending successful migration must end with a valid canonical runtime.
# It must also have a unit whose ExecStart resolves inside that same immutable
# generation. Only after these invariants pass may the legacy Bun package go.
if [[ "$runtime_pending" == 0 && "$service_restart_pending" == 0 ]]; then
  if [[ ! -x "$OPENCHAMBER_CURRENT_BIN" ]]; then
    echo "Atomic install finished without a canonical OpenChamber current runtime." >&2
    false
  fi
  current_version="$(oc_version_of "$OPENCHAMBER_CURRENT_BIN" || true)"
  if [[ "$current_version" != "$EXPECTED_OPENCHAMBER_VERSION" ]]; then
    echo "Canonical OpenChamber version mismatch: expected=$EXPECTED_OPENCHAMBER_VERSION actual=$current_version" >&2
    false
  fi
  if [[ ! -f "$UNIT" ]] || ! grep -Fq "$RELEASE_DIR/" "$UNIT"; then
    echo "OpenChamber unit is not pinned to immutable runtime $RELEASE_DIR" >&2
    false
  fi
  if ! systemctl --user is-active --quiet openchamber.service; then
    echo "OpenChamber service is not active after atomic apply." >&2
    false
  fi

  # While rollback metadata still knows the previous current target, prune all
  # older generations but retain both current and immediate previous. This keeps
  # one post-commit rollback generation without accumulating historical runtimes.
  oc_prune_releases
fi

# The core already performs bounded listener + HTTP readiness before returning
# a non-pending apply. At this point both service and runtime generation are
# committed. Only now retire the competing Bun-global V2 CLI.
oc_commit_service
TRANSACTION_COMMITTED=1
trap - ERR INT TERM

if [[ "$runtime_pending" == 0 && "$service_restart_pending" == 0 ]]; then
  oc_remove_legacy_bun_global
  echo "Atomic OpenChamber runtime committed: $(readlink -f "$OPENCHAMBER_CURRENT")"
elif [[ "$runtime_pending" == 0 && -x "$OPENCHAMBER_CURRENT_BIN" ]]; then
  echo "Atomic OpenChamber runtime staged/current; service restart remains deferred."
else
  echo "Atomic OpenChamber runtime activation remains deferred; legacy running service preserved."
fi
