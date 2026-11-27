#!/usr/bin/env bash
# Called only by an already sudo-authorized installer caller, before user switch.
set -Eeuo pipefail
[[ "$EUID" == 0 ]] || { echo 'Runtime provisioning requires root' >&2; exit 2; }
if ! id opencode >/dev/null 2>&1; then useradd --create-home --shell /bin/bash opencode; fi
[[ "$(id -u opencode)" != 0 ]] || exit 2
OPENCODE_RUNTIME_USER=opencode bash "$(dirname "${BASH_SOURCE[0]}")/setup-opencode-package-sudo.sh"
if [[ "${1:-}" != --managed-openchamber && ! -f /etc/my-opencode/owner-broker-passkey ]]; then
  OPENCODE_RUNTIME_USER=opencode bash "$(dirname "${BASH_SOURCE[0]}")/setup-opencode-deploy-sudo.sh"
fi
