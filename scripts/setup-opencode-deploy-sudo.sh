#!/usr/bin/env bash
# Root-only bootstrap for the narrow dev-contour install helper used by the pipeline.
# The owner describes each contour in a root-owned file /etc/opencode/deploy-targets/<key>.conf:
#   REPO_DIR=/srv/opencode-deploy/sevami     root-owned clone of the project
#   INSTALLER=install.sh                     path inside REPO_DIR
#   ARGS=update --target dev --dev-key svd1  fixed installer arguments
#   VERSION_FLAG=--version                   flag that receives the candidate SHA or tag
#   STATUS_ARGS=status --target dev --dev-key svd1 --json   optional: installer status after the install
# The runtime user may then run exactly: sudo -n /usr/local/sbin/opencode-deploy-target <key> <sha|tag>
# After each install the helper records the outcome in /var/lib/opencode/deploy-targets/<key>.json
# (and the status output in <key>.status.json), readable by the pipeline without sudo.
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
for cmd in install mktemp visudo git stat; do
  command -v "$cmd" >/dev/null 2>&1 || { echo "Missing prerequisite: $cmd" >&2; exit 1; }
done

# Optional prefix supports isolated packaging tests; production always uses /.
PREFIX="${OPENCODE_SUDO_PREFIX:-}"
[[ -z "$PREFIX" || "$PREFIX" == /* ]] || exit 2
HELPER="$PREFIX/usr/local/sbin/opencode-deploy-target"
POLICY="$PREFIX/etc/sudoers.d/opencode-deploy-$RUNTIME_USER"
CONF_DIR="$PREFIX/etc/opencode/deploy-targets"
STATE_DIR="$PREFIX/var/lib/opencode/deploy-targets"
TMP="$(mktemp -d)"
trap 'rm -rf -- "$TMP"' EXIT

{
  printf '#!/usr/bin/env bash\nset -Eeuo pipefail\nCONF_DIR=%q\nSTATE_DIR=%q\n' "$CONF_DIR" "$STATE_DIR"
  cat <<'HELPER'
[[ "$EUID" == 0 ]] || { echo 'Use sudo -n /usr/local/sbin/opencode-deploy-target' >&2; exit 2; }
if [[ "${1:-}" == --check && "$#" == 1 ]]; then echo 'Dev deploy sudo: READY'; exit 0; fi
[[ "$#" == 2 ]] || { echo 'Usage: opencode-deploy-target --check | <target-key> <commit-sha|vX.Y.Z>' >&2; exit 2; }
KEY="$1"; REF="$2"
[[ "$KEY" =~ ^[a-z0-9][a-z0-9-]{0,31}$ ]] || { echo "Invalid target key: $KEY" >&2; exit 2; }
[[ "$REF" =~ ^[0-9a-f]{40}$ || "$REF" =~ ^v[0-9]+\.[0-9]+\.[0-9]+$ ]] || { echo "Invalid version: $REF" >&2; exit 2; }
CONF="$CONF_DIR/$KEY.conf"
root_owned() { [[ "$(stat -c %u "$1")" == 0 && "$(( 8#$(stat -c %a "$1") & 8#022 ))" == 0 ]]; }
[[ -f "$CONF" ]] && root_owned "$CONF" || { echo "Target $KEY is not configured by root: $CONF" >&2; exit 2; }
REPO_DIR=''; INSTALLER=''; ARGS=''; VERSION_FLAG='--version'; STATUS_ARGS=''
while IFS= read -r line || [[ -n "$line" ]]; do
  [[ -z "$line" || "$line" == \#* ]] && continue
  [[ "$line" =~ ^(REPO_DIR|INSTALLER|ARGS|VERSION_FLAG|STATUS_ARGS)=([A-Za-z0-9_./=:@+\ -]*)$ ]] || { echo "Invalid line in $CONF" >&2; exit 2; }
  printf -v "${BASH_REMATCH[1]}" '%s' "${BASH_REMATCH[2]}"
done < "$CONF"
[[ "$REPO_DIR" == /* && -d "$REPO_DIR/.git" ]] && root_owned "$REPO_DIR" && root_owned "$REPO_DIR/.git" || { echo "REPO_DIR must be a root-owned git clone" >&2; exit 2; }
[[ -n "$INSTALLER" && "$INSTALLER" != /* && "$INSTALLER" != *..* ]] || { echo 'INSTALLER must be a path inside REPO_DIR' >&2; exit 2; }
[[ "$VERSION_FLAG" =~ ^--?[a-z][a-z0-9-]*$ ]] || { echo 'Invalid VERSION_FLAG' >&2; exit 2; }
GIT=(/usr/bin/env -i PATH=/usr/sbin:/usr/bin:/sbin:/bin HOME=/root git -C "$REPO_DIR")
"${GIT[@]}" fetch --quiet --tags origin
SHA="$("${GIT[@]}" rev-parse --verify --quiet "$REF^{commit}")" || { echo "Version $REF is not in origin" >&2; exit 2; }
"${GIT[@]}" checkout --quiet --force --detach "$SHA"
read -r -a ARGV <<< "$ARGS"
echo "opencode-deploy-target: $KEY $REF ($SHA)" >&2
cd "$REPO_DIR"
RUN=(/usr/bin/env -i PATH=/usr/sbin:/usr/bin:/sbin:/bin HOME=/root /bin/bash "./$INSTALLER")
STARTED="$(date -u +%Y-%m-%dT%H:%M:%SZ)"
CODE=0; "${RUN[@]}" "${ARGV[@]}" "$VERSION_FLAG" "$REF" || CODE=$?
# The outcome for the pipeline: which exact commit was installed, when, and with what exit code.
install -d -o root -g root -m 755 "$STATE_DIR"
STATUS_FILE="$STATE_DIR/$KEY.status.json"; rm -f "$STATUS_FILE"
if [[ "$CODE" == 0 && -n "$STATUS_ARGS" ]]; then
  read -r -a STATUS_ARGV <<< "$STATUS_ARGS"
  "${RUN[@]}" "${STATUS_ARGV[@]}" > "$STATUS_FILE.tmp" 2>/dev/null && chmod 644 "$STATUS_FILE.tmp" && mv "$STATUS_FILE.tmp" "$STATUS_FILE" || rm -f "$STATUS_FILE.tmp"
fi
printf '{"key":"%s","ref":"%s","sha":"%s","exit_code":%d,"started_at":"%s","finished_at":"%s","status_file":%s}\n' \
  "$KEY" "$REF" "$SHA" "$CODE" "$STARTED" "$(date -u +%Y-%m-%dT%H:%M:%SZ)" \
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
echo "Narrow dev deploy sudo configured for $RUNTIME_USER. Describe each contour in $CONF_DIR/<key>.conf."
