#!/usr/bin/env python3
"""Reboot opencode-web: stop → 10s wait → start.

Single-file replacement. Invoked directly (not via systemd path units).
Stdlib only.
"""

import json
import os
import subprocess
import sys
import time
from datetime import datetime, timezone
from pathlib import Path

CONFIG_DIR = Path.home() / ".config" / "opencode-web"
MARKER_PATH = CONFIG_DIR / "reboot-marker.json"
LOG_PATH = CONFIG_DIR / "reboot.log"
SERVICE = "opencode-web.service"
STOP_TIMEOUT = 30
START_TIMEOUT = 30
SLEEP_SECONDS = 10


def log(level: str, msg: str) -> None:
    timestamp = datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")
    line = f"{timestamp} [{level}] {msg}\n"
    try:
        LOG_PATH.parent.mkdir(parents=True, exist_ok=True)
        with LOG_PATH.open("a", encoding="utf-8") as fh:
            fh.write(line)
    except OSError as exc:
        sys.stderr.write(f"warning: could not write log {LOG_PATH}: {exc}\n")
    sys.stderr.write(line)


def read_marker() -> dict | None:
    """Read marker if it exists. Returns None if absent or corrupt."""
    if not MARKER_PATH.exists():
        return None
    try:
        data = json.loads(MARKER_PATH.read_text(encoding="utf-8"))
        if isinstance(data, dict):
            return data
    except (json.JSONDecodeError, OSError):
        pass
    return None


def systemd_cmd(action: str, timeout: int) -> None:
    """Run systemctl --user <action> SERVICE. Raises on failure."""
    try:
        subprocess.run(
            ["systemctl", "--user", action, SERVICE],
            check=True,
            capture_output=True,
            text=True,
            timeout=timeout,
        )
    except subprocess.TimeoutExpired:
        log("ERROR", f"systemctl --user {action} {SERVICE} timed out after {timeout}s")
        raise
    except subprocess.CalledProcessError as exc:
        stderr = (exc.stderr or "").strip()
        log("ERROR", f"systemctl --user {action} {SERVICE} failed (rc={exc.returncode}): {stderr}")
        raise
    except FileNotFoundError:
        log("ERROR", "systemctl not found on PATH")
        raise


def main() -> int:
    pid = os.getpid()
    log("INFO", f"reboot.py starting pid={pid}")

    # Read marker (informational only — proceed regardless)
    marker = read_marker()
    if marker is not None:
        rid = marker.get("request_id", "unknown")
        log("INFO", f"marker found: request_id={rid}")
    else:
        log("INFO", "no marker found, proceeding with unconditional reboot")

    # Step 1: stop
    log("INFO", f"stopping {SERVICE}...")
    try:
        systemd_cmd("stop", STOP_TIMEOUT)
    except Exception:
        return 1
    log("INFO", f"{SERVICE} stopped successfully")

    # Step 2: wait
    log("INFO", f"waiting {SLEEP_SECONDS}s...")
    time.sleep(SLEEP_SECONDS)

    # Step 3: start
    log("INFO", f"starting {SERVICE}...")
    try:
        systemd_cmd("start", START_TIMEOUT)
    except Exception:
        return 1
    log("INFO", f"{SERVICE} started successfully")

    log("INFO", "reboot complete")
    return 0


if __name__ == "__main__":
    sys.exit(main())
