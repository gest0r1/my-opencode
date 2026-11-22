#!/usr/bin/env bash
# Root OpenChamber must not execute an agent-installed OpenCode binary as root.
set -Eeuo pipefail
uid="$(id -u opencode)"
gid="$(id -g opencode)"
[[ "$uid" != 0 && "$gid" != 0 ]] || exit 126
exec /usr/bin/setpriv --reuid="$uid" --regid="$gid" --init-groups -- \
  /usr/bin/env -i HOME=/home/opencode USER=opencode LOGNAME=opencode \
  XDG_CONFIG_HOME=/home/opencode/.config XDG_DATA_HOME=/home/opencode/.local/share \
  XDG_STATE_HOME=/home/opencode/.local/state \
  PATH=/home/opencode/.local/bin:/home/opencode/.opencode/bin:/usr/local/bin:/usr/bin:/bin \
  /home/opencode/.opencode/bin/opencode "$@"
