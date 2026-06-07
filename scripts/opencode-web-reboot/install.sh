#!/usr/bin/env bash
# install.sh — install + enable opencode-web-reboot path unit
# Idempotent: safe to re-run. Cleans v1 leftovers if present.
set -euo pipefail

# --- 0. Root guard ---
if [[ $EUID -eq 0 ]]; then
    echo "[install] ERROR: do not run as root (systemd --user required)" >&2
    exit 1
fi

# --- 1. Paths ---
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
USER_UNIT_DIR="$HOME/.config/systemd/user"
PLUGIN_TARGET_DIR="$HOME/.config/opencode/plugins"
PLUGIN_LINK="$PLUGIN_TARGET_DIR/opencode-web-reboot"
LOCAL_BIN="$HOME/.local/bin"

# --- 2. Sanity: reboot.py exists ---
REBOOT_PY="$SCRIPT_DIR/reboot.py"
if [[ ! -f "$REBOOT_PY" ]]; then
    echo "[install] ERROR: $REBOOT_PY not found" >&2
    exit 1
fi

# --- 3. v1 cleanup (defensive, ignore errors) ---
echo "[install] Cleaning v1 leftovers (if any)..."
systemctl --user disable --now opencode-web-reboot-stop.path 2>/dev/null || true
systemctl --user disable --now opencode-web-reboot-start.path 2>/dev/null || true
rm -fv "$USER_UNIT_DIR/opencode-web-reboot@.service" || true
rm -fv "$USER_UNIT_DIR/opencode-web-reboot-stop.path" || true
rm -fv "$USER_UNIT_DIR/opencode-web-reboot-start.path" || true
rm -fv "$PLUGIN_LINK" || true

# --- 4. Copy unit files ---
echo "[install] Installing systemd units..."
mkdir -p "$USER_UNIT_DIR"
cp -v "$SCRIPT_DIR/units/opencode-web-reboot.service" "$USER_UNIT_DIR/"
cp -v "$SCRIPT_DIR/units/opencode-web-reboot.path"    "$USER_UNIT_DIR/"

# --- 5. Install CLI to ~/.local/bin ---
if [[ -f "$SCRIPT_DIR/cli/opencode-web-reboot-request" ]]; then
    echo "[install] Installing CLI..."
    mkdir -p "$LOCAL_BIN"
    install -m 0755 "$SCRIPT_DIR/cli/opencode-web-reboot-request" "$LOCAL_BIN/"
fi

# --- 6. Symlink plugin (opencode discovers via ~/.config/opencode/plugins/<name>) ---
if [[ -d "$SCRIPT_DIR/plugin" ]]; then
    echo "[install] Symlinking opencode plugin..."
    mkdir -p "$PLUGIN_TARGET_DIR"
    ln -sfn "$SCRIPT_DIR/plugin" "$PLUGIN_LINK"
    echo "[install]   -> $PLUGIN_LINK -> $SCRIPT_DIR/plugin"
fi

# --- 7. Reload + enable ---
echo "[install] Reloading systemd user daemon..."
systemctl --user daemon-reload

echo "[install] Enabling opencode-web-reboot.path (auto-start on login)..."
systemctl --user enable opencode-web-reboot.path

# --- 8. Start now (does NOT trigger reboot — path only watches, no marker = no fire) ---
echo "[install] Starting opencode-web-reboot.path..."
systemctl --user restart opencode-web-reboot.path 2>&1 || {
    echo "[install] ERROR: failed to start path unit" >&2
    systemctl --user status opencode-web-reboot.path --no-pager >&2 || true
    exit 1
}

# --- 9. Sanity check ---
STATE="$(systemctl --user is-active opencode-web-reboot.path 2>&1 || true)"
if [[ "$STATE" != "active" && "$STATE" != "active (waiting)" ]]; then
    echo "[install] ERROR: path unit is $STATE, expected 'active (waiting)'" >&2
    systemctl --user status opencode-web-reboot.path --no-pager >&2 || true
    exit 1
fi

# --- 10. Linger check (optional but recommended for boot-time trigger) ---
if ! loginctl show-user "$USER" 2>/dev/null | grep -q "^Linger=yes"; then
    echo "[install] NOTE: user lingering is OFF. Path unit only runs while you're logged in."
    echo "[install]   To enable: sudo loginctl enable-linger $USER"
fi

# --- 11. Final status ---
echo ""
echo "[install] DONE. opencode-web-reboot.path is $STATE."
echo "[install] Trigger a reboot via: opencode-web-reboot-request"
echo "[install]   (marker appears, path fires within ~1s, service runs reboot.py)"
