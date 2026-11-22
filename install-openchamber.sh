#!/usr/bin/env bash
# Exact-SHA entrypoint. OpenCode remains under opencode; OpenChamber is root-owned.
set -Eeuo pipefail
[[ $EUID == 0 ]] || {
  echo 'OpenChamber installation must run as root (use sudo). OpenCode stays under opencode.' >&2
  exit 2
}
for tool in gh mktemp chmod rm; do
  command -v "$tool" >/dev/null || { echo "Missing prerequisite: $tool" >&2; exit 2; }
done
valid_source_ref() {
  [[ "$1" =~ ^[A-Za-z0-9][A-Za-z0-9._/-]{0,255}$ ]] &&
    [[ "$1" != *..* && "$1" != *//* && "$1" != */ ]]
}
CONFIG_REPO="${OPENCODE_CONFIG_REPO:-gest0r1/my-opencode}"
APP_REPO="${OPENCHAMBER_REPO:-gest0r1/openchamber-ru}"
REQUESTED_CONFIG_REF="${OPENCODE_CONFIG_SOURCE_REF:-${OPENCODE_CONFIG_REF:-${MY_OPENCODE_REF:-main}}}"
REQUESTED_APP_REF="${OPENCHAMBER_SOURCE_REF:-${OPENCHAMBER_REF:-main}}"
for ref in "$REQUESTED_CONFIG_REF" "$REQUESTED_APP_REF"; do
  valid_source_ref "$ref" || { echo 'INSTALL_SOURCE_REF_INVALID' >&2; exit 2; }
done
CONFIG_SHA="$(gh api "repos/$CONFIG_REPO/commits/${OPENCODE_CONFIG_REF:-$REQUESTED_CONFIG_REF}" --jq .sha)"
APP_SHA="$(gh api "repos/$APP_REPO/commits/${OPENCHAMBER_REF:-$REQUESTED_APP_REF}" --jq .sha)"
[[ "$CONFIG_SHA" =~ ^[a-f0-9]{40}$ && "$APP_SHA" =~ ^[a-f0-9]{40}$ ]] || {
  echo 'INSTALL_PINNED_SHA_INVALID' >&2; exit 2;
}
TEMP="$(mktemp /tmp/openchamber-root-install.XXXXXXXX)"
trap 'rm -f -- "$TEMP"' EXIT
# Resolve all mutable refs once. A single trusted root coordinator performs
# the OpenCode installer under opencode and all OpenChamber work under root.
gh api -H 'Accept: application/vnd.github.raw' \
  "repos/$CONFIG_REPO/contents/scripts/install-openchamber-root.sh?ref=$CONFIG_SHA" > "$TEMP"
OPENCODE_CONFIG_REF="$CONFIG_SHA" MY_OPENCODE_REF="$CONFIG_SHA" \
OPENCODE_CONFIG_SOURCE_REF="$REQUESTED_CONFIG_REF" \
OPENCHAMBER_REF="$APP_SHA" OPENCHAMBER_SOURCE_REF="$REQUESTED_APP_REF" \
  bash "$TEMP" "$@"