#!/usr/bin/env python3
"""Shared marker helpers for opencode-web-reboot CLI and plugin.

Subcommands:
  write    Atomically write a new marker JSON.
  read     Read and parse marker (for plugin).
  consume  Read + parse + delete marker (for plugin on successful notification).
  quarantine Move corrupt marker to <name>.corrupt-<unix_ts> (for plugin on JSON parse error).
  processed-check  Return True if request_id is in last-processed-request ledger.
  processed-mark   Append request_id to last-processed-request ledger.

Stdlib only.
"""
import argparse, json, os, sys, tempfile
from datetime import datetime, timezone
from pathlib import Path

CONFIG_DIR = Path.home() / ".config" / "opencode-web"
MARKER_PATH = CONFIG_DIR / "reboot-marker.json"
LAST_PROCESSED_PATH = CONFIG_DIR / "last-processed-request"


def write_marker(marker_path: Path, session_id: str) -> dict:
    """Atomically write a fresh marker JSON. Returns the marker dict."""
    marker_path.parent.mkdir(parents=True, exist_ok=True)
    request_id = _uuid4()
    marker = {
        "request_id": request_id,
        "session_id": session_id or None,
        "requested_at": datetime.now(timezone.utc).isoformat(),
    }
    # Atomic write: temp file in same dir, fsync, rename
    fd, tmp_path = tempfile.mkstemp(prefix=".reboot-marker.", suffix=".tmp", dir=marker_path.parent)
    try:
        with os.fdopen(fd, "w") as f:
            json.dump(marker, f, indent=2)
            f.flush()
            os.fsync(f.fileno())
        os.replace(tmp_path, marker_path)
    except Exception:
        Path(tmp_path).unlink(missing_ok=True)
        raise
    return marker


def read_marker(marker_path: Path = MARKER_PATH) -> dict | None:
    """Read and parse marker. Returns None on missing/garbage/non-object."""
    if not marker_path.exists():
        return None
    try:
        text = marker_path.read_text()
        data = json.loads(text)
    except (json.JSONDecodeError, OSError):
        return None
    if not isinstance(data, dict):
        return None
    return data


def consume_marker(marker_path: Path = MARKER_PATH) -> dict | None:
    """Read + delete marker. Returns the marker dict (or None)."""
    marker = read_marker(marker_path)
    if marker is None:
        return None
    try:
        marker_path.unlink()
    except FileNotFoundError:
        pass
    return marker


def quarantine_corrupt(marker_path: Path = MARKER_PATH) -> Path | None:
    """Move a non-parseable marker to <name>.corrupt-<unix_ts>. Returns new path."""
    if not marker_path.exists():
        return None
    ts = int(datetime.now(timezone.utc).timestamp())
    new_path = marker_path.with_name(f"{marker_path.name}.corrupt-{ts}")
    marker_path.rename(new_path)
    return new_path


def is_processed(request_id: str) -> bool:
    """Return True if request_id was already recorded in the ledger."""
    if not LAST_PROCESSED_PATH.exists():
        return False
    return request_id in LAST_PROCESSED_PATH.read_text().splitlines()


def mark_processed(request_id: str) -> None:
    """Append request_id to the ledger (one per line)."""
    LAST_PROCESSED_PATH.parent.mkdir(parents=True, exist_ok=True)
    with LAST_PROCESSED_PATH.open("a") as f:
        f.write(request_id + "\n")


def _uuid4() -> str:
    import uuid
    return str(uuid.uuid4())


# --- CLI dispatch ---
def main():
    parser = argparse.ArgumentParser(description="opencode-web-reboot marker helpers")
    sub = parser.add_subparsers(dest="cmd", required=True)

    p_write = sub.add_parser("write", help="Write a fresh marker")
    p_write.add_argument("--marker-path", type=Path, default=MARKER_PATH)
    p_write.add_argument("--session-id", default="")

    p_read = sub.add_parser("read", help="Read and print marker (or empty)")
    p_read.add_argument("--marker-path", type=Path, default=MARKER_PATH)

    p_consume = sub.add_parser("consume", help="Read + delete marker")
    p_consume.add_argument("--marker-path", type=Path, default=MARKER_PATH)

    p_quar = sub.add_parser("quarantine", help="Move corrupt marker aside")
    p_quar.add_argument("--marker-path", type=Path, default=MARKER_PATH)

    p_check = sub.add_parser("processed-check", help="Exit 0 if request_id is in ledger")
    p_check.add_argument("request_id")

    p_mark = sub.add_parser("processed-mark", help="Append request_id to ledger")
    p_mark.add_argument("request_id")

    args = parser.parse_args()

    if args.cmd == "write":
        marker = write_marker(args.marker_path, args.session_id)
        print(json.dumps(marker))
    elif args.cmd == "read":
        marker = read_marker(args.marker_path)
        print(json.dumps(marker) if marker is not None else "")
    elif args.cmd == "consume":
        marker = consume_marker(args.marker_path)
        print(json.dumps(marker) if marker is not None else "")
    elif args.cmd == "quarantine":
        new_path = quarantine_corrupt(args.marker_path)
        print(str(new_path) if new_path else "")
    elif args.cmd == "processed-check":
        sys.exit(0 if is_processed(args.request_id) else 1)
    elif args.cmd == "processed-mark":
        mark_processed(args.request_id)


if __name__ == "__main__":
    main()
