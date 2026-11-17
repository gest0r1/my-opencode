#!/usr/bin/env bash
# Append-only install audit. Values are caller-supplied and must never include
# credentials, tokens or environment dumps.
install_journal_file() {
  printf '%s/openchamber-install.log' "${XDG_STATE_HOME:-$HOME/.local/state}/my-opencode"
}

_install_journal_sanitize() {
  # Audit fields are a strict token alphabet: no whitespace, '=' or control
  # characters can forge another field or record.
  printf '%s' "$1" | LC_ALL=C tr -c 'A-Za-z0-9._:/@+-' '_'
}

install_journal_event() {
  local phase=$1 status=$2 file max size=0 line key value
  shift 2
  file="$(install_journal_file)"
  max="${INSTALL_JOURNAL_MAX_BYTES:-1048576}"
  [[ "$max" =~ ^[0-9]+$ ]] || max=1048576
  mkdir -p "$(dirname "$file")"
  chmod 700 "$(dirname "$file")" 2>/dev/null || true
  [[ ! -f "$file" ]] || size="$(stat -c%s "$file" 2>/dev/null || printf 0)"
  if (( size > max )); then
    mv -f -- "$file" "$file.1"
  fi
  line="$(date -u +%Y-%m-%dT%H:%M:%SZ) phase=$(_install_journal_sanitize "$phase") status=$(_install_journal_sanitize "$status") user=$(id -un 2>/dev/null || printf unknown)"
  for key in "$@"; do
    value="${key#*=}"
    line="$line $(_install_journal_sanitize "${key%%=*}")=$(_install_journal_sanitize "$value")"
  done
  ( umask 077; printf '%s\n' "$line" >> "$file" )
  chmod 600 "$file"
}
