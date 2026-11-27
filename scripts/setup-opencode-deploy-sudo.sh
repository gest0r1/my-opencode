#!/usr/bin/env bash
# Root-only bootstrap for the narrow dev-contour install helper used by the pipeline.
# The owner describes each contour in a root-owned file /etc/opencode/deploy-targets/<key>.conf:
#   REPO_DIR=/var/lib/opencode-dev/targets/sevami  clone owned by opencode-dev
#   INSTALLER=install.sh                     path inside REPO_DIR
#   ARGS=update --target dev --dev-key svd1  fixed installer arguments
#   VERSION_FLAG=--version                   flag that receives the candidate SHA or tag
#   STATUS_ARGS=status --target dev --dev-key svd1 --json   required for verified dev_deploy
#   STATUS_READER=/usr/local/lib/my-opencode/contour-status optional owner-managed runtime readback
#   ENV_<NAME>=<value> optional nonsecret installer environment passed to opencode-dev
#     The installer status JSON must contain an exact top-level sha of the currently
#     running commit (40 hex characters); desired/requested/history refs are not proof.
# The runtime user may then run exactly: sudo -n /usr/local/sbin/opencode-deploy-target <key> <sha|tag>
# Root owns the policy and result. Git, install and status run as opencode-dev.
set -Eeuo pipefail
umask 077

RUNTIME_USER="${OPENCODE_RUNTIME_USER:-opencode}"
[[ "$RUNTIME_USER" == opencode ]] || {
  echo "Invalid runtime user '$RUNTIME_USER': required name is exactly opencode" >&2
  exit 2
}
[[ "$EUID" == 0 ]] || { echo 'Run sudo bootstrap as root' >&2; exit 2; }
id "$RUNTIME_USER" >/dev/null 2>&1 || { echo "Runtime user '$RUNTIME_USER' does not exist" >&2; exit 2; }
[[ "$(id -u "$RUNTIME_USER")" != 0 ]] || { echo "Runtime user must not have UID 0" >&2; exit 2; }
for cmd in install mktemp sudo visudo git stat getent setpriv python3 flock; do
  command -v "$cmd" >/dev/null 2>&1 || { echo "Missing prerequisite: $cmd" >&2; exit 1; }
done

# Optional prefix supports isolated packaging tests; production always uses /.
PREFIX="${OPENCODE_SUDO_PREFIX:-}"
[[ -z "$PREFIX" || "$PREFIX" == /* ]] || exit 2
HELPER="$PREFIX/usr/local/sbin/opencode-deploy-target"
POLICY="$PREFIX/etc/sudoers.d/opencode-deploy-$RUNTIME_USER"
CONF_DIR="$PREFIX/etc/opencode/deploy-targets"
STATE_DIR="$PREFIX/var/lib/opencode/deploy-targets"
DEV_HOME="$PREFIX/var/lib/opencode-dev"
if ! id opencode-dev >/dev/null 2>&1; then
  useradd --system --user-group --no-create-home --home-dir /var/lib/opencode-dev --shell /usr/sbin/nologin opencode-dev
fi
DEV_UID="$(id -u opencode-dev)" DEV_GID="$(id -g opencode-dev)"
[[ "$DEV_UID" != 0 && "$DEV_UID" != "$(id -u opencode)" && "$DEV_GID" != 0 && "$DEV_GID" != "$(id -g opencode)" ]] || exit 2
if id opencode-approval >/dev/null 2>&1; then
  [[ "$DEV_UID" != "$(id -u opencode-approval)" && "$DEV_GID" != "$(id -g opencode-approval)" ]] || exit 2
fi
[[ "$DEV_GID" != "$(getent group opencode-approval-proxy | cut -d: -f3)" ]] || exit 2
install -d -o "$DEV_UID" -g "$DEV_GID" -m 700 "$DEV_HOME"
TMP="$(mktemp -d)"
trap 'rm -rf -- "$TMP"' EXIT

{
  printf '#!/usr/bin/env bash\nset -Eeuo pipefail\numask 077\nCONF_DIR=%q\nSTATE_DIR=%q\nDEV_HOME=%q\nDEV_UID=%q\nDEV_GID=%q\n' "$CONF_DIR" "$STATE_DIR" "$DEV_HOME" "$DEV_UID" "$DEV_GID"
  cat <<'HELPER'
[[ "$EUID" == 0 ]] || { echo 'Use sudo -n /usr/local/sbin/opencode-deploy-target' >&2; exit 2; }
root_owned() { [[ "$(stat -c %u "$1")" == 0 && "$(( 8#$(stat -c %a "$1") & 8#022 ))" == 0 ]]; }
trusted_reader() {
  local path=$1
  [[ "$path" == /* && -f "$path" && -x "$path" && "$(realpath -e "$path")" == "$path" ]] || return 1
  while [[ "$path" != / ]]; do
    root_owned "$path" || return 1
    path="$(dirname "$path")"
  done
}
isolated_clone() {
  local dir=$1
  [[ "$dir" == "$DEV_HOME/targets/"* && ! -L "$dir" && ! -L "$dir/.git" && -d "$dir/.git" &&
     "$(realpath -e "$dir")" == "$dir" && "$(stat -c %u "$dir")" == "$DEV_UID" &&
     "$(stat -c %u "$dir/.git")" == "$DEV_UID" ]]
}
if [[ "${1:-}" == --check && "$#" == 1 ]]; then echo 'Dev deploy sudo: READY'; exit 0; fi
[[ "$(id -u opencode-dev)" == "$DEV_UID" && "$(id -g opencode-dev)" == "$DEV_GID" && "$DEV_UID" != 0 && "$DEV_GID" != 0 ]]
[[ "$DEV_UID" != "$(id -u opencode)" && "$DEV_GID" != "$(id -g opencode)" ]]
if id opencode-approval >/dev/null 2>&1; then
  [[ "$DEV_UID" != "$(id -u opencode-approval)" && "$DEV_GID" != "$(id -g opencode-approval)" ]]
fi
[[ "$DEV_GID" != "$(getent group opencode-approval-proxy | cut -d: -f3)" ]]
if [[ "${1:-}" == --check-isolation && "$#" == 1 ]]; then
  command -v sudo >/dev/null
  for group in $(id -nG opencode-dev); do
    case "$group" in root|sudo|wheel|docker|lxd|incus|opencode-approval|opencode-approval-proxy) exit 2;; esac
  done
  dev_policy="$(LC_ALL=C sudo -n -l -U opencode-dev 2>&1 || true)"
  [[ "$dev_policy" == *'User opencode-dev is not allowed to run sudo on '* ]]
  shopt -s nullglob
  for config in "$CONF_DIR"/*.conf; do
    [[ -f "$config" && ! -L "$config" ]] && root_owned "$config"
    isolated_clone "$(sed -n 's/^REPO_DIR=//p' "$config")"
  done
  echo 'Dev deploy isolation: opencode-dev'
  exit 0
fi
[[ "$#" == 2 ]] || { echo 'Usage: opencode-deploy-target --check | <target-key> <commit-sha|vX.Y.Z>' >&2; exit 2; }
KEY="$1"; REF="$2"
[[ "$KEY" =~ ^[a-z0-9][a-z0-9-]{0,31}$ ]] || { echo "Invalid target key: $KEY" >&2; exit 2; }
[[ "$REF" =~ ^[0-9a-f]{40}$ || "$REF" =~ ^v[0-9]+\.[0-9]+\.[0-9]+$ ]] || { echo "Invalid version: $REF" >&2; exit 2; }
CONF="$CONF_DIR/$KEY.conf"
[[ -f "$CONF" && ! -L "$CONF" ]] && root_owned "$CONF" || { echo "Target $KEY is not configured by root: $CONF" >&2; exit 2; }
REPO_DIR=''; INSTALLER=''; ARGS=''; VERSION_FLAG='--version'; STATUS_ARGS=''; STATUS_READER=''
target_env=()
while IFS= read -r line || [[ -n "$line" ]]; do
  [[ -z "$line" || "$line" == \#* ]] && continue
  if [[ "$line" =~ ^ENV_([A-Z][A-Z0-9_]{0,63})=([A-Za-z0-9_./=:@+\ -]*)$ ]]; then
    name="${BASH_REMATCH[1]}" value="${BASH_REMATCH[2]}"
    case "$name" in
      HOME|PATH|USER|LOGNAME|XDG_*|DBUS_*|DOCKER_*|LD_*|BASH_ENV|ENV|GIT_*|*TOKEN*|*SECRET*|*PASSWORD*)
        echo 'Reserved deployment environment field' >&2; exit 2;;
    esac
    target_env+=("$name=$value")
    continue
  fi
  [[ "$line" =~ ^(REPO_DIR|INSTALLER|ARGS|VERSION_FLAG|STATUS_ARGS|STATUS_READER)=([A-Za-z0-9_./=:@+\ -]*)$ ]] || { echo "Invalid line in $CONF" >&2; exit 2; }
  printf -v "${BASH_REMATCH[1]}" '%s' "${BASH_REMATCH[2]}"
done < "$CONF"
isolated_clone "$REPO_DIR" || { echo 'REPO_DIR must be a private opencode-dev clone' >&2; exit 2; }
[[ -n "$INSTALLER" && "$INSTALLER" != /* && "$INSTALLER" != *..* ]] || { echo 'INSTALLER must be a path inside REPO_DIR' >&2; exit 2; }
[[ "$VERSION_FLAG" =~ ^--?[a-z][a-z0-9-]*$ ]] || { echo 'Invalid VERSION_FLAG' >&2; exit 2; }
if [[ -n "$STATUS_READER" ]]; then trusted_reader "$STATUS_READER" || { echo 'STATUS_READER must be a root-owned executable in a protected path' >&2; exit 2; }; fi
DEV=(/usr/bin/setpriv --reuid="$DEV_UID" --regid="$DEV_GID" --clear-groups --no-new-privs --inh-caps=-all --ambient-caps=-all --bounding-set=-all
     /usr/bin/env -i PATH=/usr/local/bin:/usr/bin:/bin "HOME=$DEV_HOME" USER=opencode-dev LOGNAME=opencode-dev GIT_TERMINAL_PROMPT=0
     "XDG_RUNTIME_DIR=/run/user/$DEV_UID" "DBUS_SESSION_BUS_ADDRESS=unix:path=/run/user/$DEV_UID/bus")
docker_socket="/run/user/$DEV_UID/docker.sock"
if [[ -S "$docker_socket" && ! -L "$docker_socket" && "$(stat -c %u "$docker_socket")" == "$DEV_UID" ]]; then
  DEV+=("DOCKER_HOST=unix://$docker_socket")
fi
install -d -o root -g root -m 755 "$STATE_DIR"
exec 9>"$STATE_DIR/$KEY.lock"
flock -x 9
GIT=("${DEV[@]}" /usr/bin/git -C "$REPO_DIR")
"${GIT[@]}" fetch --quiet --tags origin 9>&-
SHA="$("${GIT[@]}" rev-parse --verify --quiet "$REF^{commit}" 9>&-)" || { echo "Version $REF is not in origin" >&2; exit 2; }
[[ "$SHA" =~ ^[a-f0-9]{40}$ ]] || exit 2
"${GIT[@]}" checkout --quiet --force --detach "$SHA" 9>&-
read -r -a ARGV <<< "$ARGS"
echo "opencode-deploy-target: $KEY $REF ($SHA)" >&2
RUN=("${DEV[@]}" "${target_env[@]}" /bin/bash -ceu 'cd -- "$1"; installer="$2"; shift 2; exec /bin/bash "./$installer" "$@"' bash "$REPO_DIR" "$INSTALLER")
STARTED="$(date -u +%Y-%m-%dT%H:%M:%SZ)"
CODE=0; "${RUN[@]}" "${ARGV[@]}" "$VERSION_FLAG" "$REF" 9>&- || CODE=$?
# The outcome for the pipeline: which exact commit was installed, when, and with what exit code.
STATUS_FILE="$STATE_DIR/$KEY.status.json"; rm -f "$STATUS_FILE"
STATUS_PROVENANCE='unavailable'
if [[ "$CODE" == 0 && ( -n "$STATUS_ARGS" || -n "$STATUS_READER" ) ]]; then
  read -r -a STATUS_ARGV <<< "$STATUS_ARGS"
  status_cmd=("${RUN[@]}" "${STATUS_ARGV[@]}")
  status_provenance='candidate-reported'
  if [[ -n "$STATUS_READER" ]]; then
    status_cmd=("${DEV[@]}" "${target_env[@]}" "$STATUS_READER" "$KEY" "$REPO_DIR")
    status_provenance='owner-configured-reader'
  fi
  if (ulimit -f 128; "${status_cmd[@]}" 9>&-) > "$STATUS_FILE.raw" 2>/dev/null &&
      python3 - "$STATUS_FILE.raw" "$SHA" > "$STATUS_FILE.tmp" <<'PY'
import json, re, sys
with open(sys.argv[1], encoding='utf-8') as stream:
    status = json.load(stream)
if not isinstance(status, dict) or status.get('sha') != sys.argv[2]:
    raise SystemExit(1)
result = {'sha': status['sha']}
version = status.get('version')
if isinstance(version, str) and re.fullmatch(r'v?[0-9]+\.[0-9]+\.[0-9]+(?:[-.][A-Za-z0-9.-]{1,32})?', version):
    result['version'] = version
print(json.dumps(result, separators=(',', ':')))
PY
  then
    chmod 644 "$STATUS_FILE.tmp"
    mv "$STATUS_FILE.tmp" "$STATUS_FILE"
    STATUS_PROVENANCE="$status_provenance"
  fi
  rm -f "$STATUS_FILE.raw" "$STATUS_FILE.tmp"
fi
printf '{"key":"%s","ref":"%s","sha":"%s","exit_code":%d,"started_at":"%s","finished_at":"%s","status_provenance":"%s","status_file":%s}\n' \
  "$KEY" "$REF" "$SHA" "$CODE" "$STARTED" "$(date -u +%Y-%m-%dT%H:%M:%SZ)" \
  "$STATUS_PROVENANCE" \
  "$([[ -f "$STATUS_FILE" ]] && printf '"%s"' "$STATUS_FILE" || printf null)" > "$STATE_DIR/$KEY.json.tmp"
chmod 644 "$STATE_DIR/$KEY.json.tmp"; mv "$STATE_DIR/$KEY.json.tmp" "$STATE_DIR/$KEY.json"
exit "$CODE"
HELPER
} > "$TMP/helper"

printf '%s ALL=(root) NOPASSWD: %s\n' "$RUNTIME_USER" "$HELPER" > "$TMP/policy"
visudo -cf "$TMP/policy" >/dev/null
install -d -o root -g root -m 755 "$(dirname "$HELPER")" "$(dirname "$POLICY")" "$CONF_DIR" "$STATE_DIR"
install -o root -g root -m 755 "$TMP/helper" "$HELPER"
install -o root -g root -m 440 "$TMP/policy" "$POLICY"
visudo -cf "$POLICY" >/dev/null
echo "Dev deployments use opencode-dev. Describe each contour in $CONF_DIR/<key>.conf."
