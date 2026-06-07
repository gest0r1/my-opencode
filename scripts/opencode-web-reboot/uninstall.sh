#!/usr/bin/env bash
# uninstall.sh — disable + remove opencode-web-reboot
set -euo pipefail

USER_UNIT_DIR="$HOME/.config/systemd/user"
LOCAL_BIN="$HOME/.local/bin"

echo "[uninstall] Stopping + disabling opencode-web-reboot.path..."
systemctl --user disable --now opencode-web-reboot.path 2>/dev/null || true

echo "[uninstall] Removing unit files..."
rm -fv "$USER_UNIT_DIR/opencode-web-reboot.service"
rm -fv "$USER_UNIT_DIR/opencode-web-reboot.path"

echo "[uninstall] Removing plugin symlink..."
rm -fv "$HOME/.config/opencode/plugins/opencode-web-reboot"

echo "[uninstall] Removing CLI..."
rm -fv "$LOCAL_BIN/opencode-web-reboot-request"

echo "[uninstall] Reloading systemd..."
systemctl --user daemon-reload
systemctl --user reset-failed opencode-web-reboot.service 2>/dev/null || true

echo "[uninstall] NOTE: ~/.config/opencode-web/reboot-marker.json was NOT removed."
echo "[uninstall]   (If a reboot is pending, the file is needed. Delete manually if stale.)"
