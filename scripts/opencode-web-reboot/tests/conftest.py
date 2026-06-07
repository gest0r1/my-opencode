"""Pytest fixtures for testing opencode-web-reboot/reboot.py.

Loads reboot.py as a fresh module per test (function-scoped, NOT session-scoped)
because constants like DRY_RUN are module-level and need fresh state per test.

All file paths (CONFIG_DIR / MARKER_PATH / LOG_PATH) are redirected to a
per-test tmp_path so tests never touch the real user config directory.
"""

import importlib.util
import json
import subprocess
from pathlib import Path
from unittest.mock import MagicMock

import pytest

SCRIPT_PATH = Path(__file__).resolve().parent.parent / "reboot.py"
_MODULE_NAME = "opencode_web_reboot_under_test"


def _load_reboot_module() -> object:
    """Load reboot.py as a fresh module via importlib (no sys.path pollution)."""
    spec = importlib.util.spec_from_file_location(_MODULE_NAME, SCRIPT_PATH)
    if spec is None or spec.loader is None:
        raise RuntimeError(f"Could not load spec for {SCRIPT_PATH}")
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


@pytest.fixture
def reboot_module(monkeypatch, tmp_path):
    """Fresh import of reboot.py with paths redirected to tmp_path.

    Clears DRY_RUN env var before import so the module's module-level
    DRY_RUN constant starts as False regardless of host environment.
    Patches CONFIG_DIR / MARKER_PATH / LOG_PATH to a per-test temp dir
    so tests can never write to ~/.config/opencode-web.
    """
    monkeypatch.delenv("DRY_RUN", raising=False)

    module = _load_reboot_module()

    # Defense in depth: always redirect paths, even if test forgets tmp_paths.
    tmp_path.mkdir(parents=True, exist_ok=True)
    monkeypatch.setattr(module, "CONFIG_DIR", tmp_path)
    monkeypatch.setattr(module, "MARKER_PATH", tmp_path / "reboot-marker.json")
    monkeypatch.setattr(module, "LOG_PATH", tmp_path / "reboot.log")

    return module


@pytest.fixture
def tmp_paths(tmp_path):
    """Alias for tmp_path (paths already redirected by reboot_module fixture)."""
    return tmp_path


@pytest.fixture
def mock_systemd_success(monkeypatch, reboot_module):
    """Patch subprocess.run to always return a successful CompletedProcess-like mock.

    Returns the mock so tests can assert on call args / count.
    """
    mock = MagicMock(return_value=MagicMock(returncode=0, stdout=b"", stderr=b""))
    monkeypatch.setattr(reboot_module.subprocess, "run", mock)
    return mock


@pytest.fixture
def mock_systemd_fail_stop(monkeypatch, reboot_module):
    """First subprocess.run call raises CalledProcessError; second returns success.

    Designed for testing the main() flow where stop fails and start is never called,
    and for testing systemd_cmd() in isolation (only the first call is consumed).
    """
    side_effect = [
        subprocess.CalledProcessError(
            returncode=1,
            cmd=["systemctl", "--user", "stop", "opencode-web.service"],
            stderr="unit not found",
        ),
        MagicMock(returncode=0, stdout=b"", stderr=b""),
    ]
    mock = MagicMock(side_effect=side_effect)
    monkeypatch.setattr(reboot_module.subprocess, "run", mock)
    return mock


@pytest.fixture
def mock_systemd_fail_start(monkeypatch, reboot_module):
    """First subprocess.run call succeeds; second raises CalledProcessError."""
    side_effect = [
        MagicMock(returncode=0, stdout=b"", stderr=b""),
        subprocess.CalledProcessError(
            returncode=1,
            cmd=["systemctl", "--user", "start", "opencode-web.service"],
            stderr="job failed",
        ),
    ]
    mock = MagicMock(side_effect=side_effect)
    monkeypatch.setattr(reboot_module.subprocess, "run", mock)
    return mock


@pytest.fixture
def mock_systemd_timeout(monkeypatch, reboot_module):
    """First subprocess.run call raises TimeoutExpired; second returns success."""
    side_effect = [
        subprocess.TimeoutExpired(
            cmd=["systemctl", "--user", "stop", "opencode-web.service"],
            timeout=30,
        ),
        MagicMock(returncode=0, stdout=b"", stderr=b""),
    ]
    mock = MagicMock(side_effect=side_effect)
    monkeypatch.setattr(reboot_module.subprocess, "run", mock)
    return mock


@pytest.fixture
def dry_run(monkeypatch, reboot_module):
    """Enable DRY_RUN mode (env + module constant). Returns a function to disable.

    Usage:
        def test_x(dry_run):
            dry_run()  # DRY_RUN is True
            # ... assertions ...

    The disable() callback is for tests that need to switch modes within a test.
    """
    monkeypatch.setenv("DRY_RUN", "1")
    monkeypatch.setattr(reboot_module, "DRY_RUN", True)

    def disable():
        monkeypatch.setattr(reboot_module, "DRY_RUN", False)

    return disable


@pytest.fixture
def no_sleep(monkeypatch, reboot_module):
    """Patch time.sleep to a no-op so tests don't wait 10 seconds between stop/start."""
    monkeypatch.setattr(reboot_module.time, "sleep", lambda *_args, **_kwargs: None)


@pytest.fixture
def write_marker(tmp_paths):
    """Factory fixture: write a valid marker JSON to tmp_paths/reboot-marker.json.

    Returns a callable that accepts overrides for request_id / session_id / requested_at
    and returns the dict that was written (for equality assertions).
    """
    def _factory(
        request_id: str = "test-rid",
        session_id: str = "sess-abc",
        requested_at: str = "2026-06-07T00:00:00Z",
    ) -> dict:
        marker = {
            "request_id": request_id,
            "session_id": session_id,
            "requested_at": requested_at,
        }
        (tmp_paths / "reboot-marker.json").write_text(
            json.dumps(marker), encoding="utf-8"
        )
        return marker

    return _factory
