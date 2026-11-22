#!/usr/bin/env bash
# The only root service entrypoint. Never source credentials as shell code.
set -Eeuo pipefail
[[ $EUID == 0 ]] || { echo 'OPENCHAMBER_ROOT_REQUIRED' >&2; exit 126; }
[[ $# -ge 1 ]] || { echo 'missing OpenChamber executable' >&2; exit 2; }
SECRET=/etc/my-opencode/opencode-connect.secret
if [[ -e "$SECRET" || -L "$SECRET" ]]; then
  [[ -f "$SECRET" && ! -L "$SECRET" && "$(stat -c %u "$SECRET")" == 0 &&
     "$(stat -c %a "$SECRET")" == 600 ]] || {
    echo 'OPENCODE_CONNECT_SECRET_UNTRUSTED' >&2; exit 126;
  }
  # Command substitution strips trailing newlines; service passwords cannot
  # be multiline. Reject instead of silently authenticating as another user.
  [[ "$(tail -c 1 "$SECRET" | od -An -tu1 | tr -d '[:space:]')" != 10 ]] || {
    echo 'OPENCODE_CONNECT_MULTILINE_UNSUPPORTED' >&2; exit 126;
  }
  export OPENCODE_PASSWORD="$(cat -- "$SECRET")"
else
  unset OPENCODE_PASSWORD OPENCODE_SERVER_PASSWORD
fi
exec "$@"
