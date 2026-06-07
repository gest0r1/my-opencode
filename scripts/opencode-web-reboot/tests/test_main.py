"""Tests for reboot.main() — the end-to-end reboot orchestration.

main() returns:
  - 0 on full success (stop + sleep + start all OK)
  - 1 if stop fails (start is NEVER called)
  - 1 if start fails (after stop succeeded and sleep completed)

main() also logs:
  - "reboot.py starting pid=..." at start
  - "marker found: request_id=..." OR "no marker found, proceeding with unconditional reboot"
  - "stopping <service>..." / "<service> stopped successfully"
  - "waiting 10s..." / (10 second sleep)
  - "starting <service>..." / "<service> started successfully"
  - "reboot complete" on success
"""

import pytest


def test_main_success_with_marker(reboot_module, tmp_paths, mock_systemd_success, no_sleep, write_marker):
    """Valid marker + everything OK: exit 0, log has starting/stopped/started."""
    write_marker()

    exit_code = reboot_module.main()

    assert exit_code == 0

    log_content = (tmp_paths / "reboot.log").read_text()
    assert "starting" in log_content  # from "reboot.py starting pid=..."
    assert "stopped" in log_content  # from "<service> stopped successfully"
    assert "started" in log_content  # from "<service> started successfully"
    assert "reboot complete" in log_content

    # Stop and start both invoked
    assert mock_systemd_success.call_count == 2


def test_main_success_no_marker(reboot_module, tmp_paths, mock_systemd_success, no_sleep):
    """No marker file + everything OK: exit 0, log has 'no marker found'."""
    # No write_marker call — tmp_paths has no marker file
    exit_code = reboot_module.main()

    assert exit_code == 0

    log_content = (tmp_paths / "reboot.log").read_text()
    assert "no marker found" in log_content

    # Still reboots unconditionally
    assert mock_systemd_success.call_count == 2


def test_main_stop_fails(reboot_module, tmp_paths, mock_systemd_fail_stop, no_sleep, write_marker):
    """Stop fails: exit 1, start is NEVER called (call_count == 1)."""
    write_marker()

    exit_code = reboot_module.main()

    assert exit_code == 1
    # Only the stop call happened; start was not attempted
    assert mock_systemd_fail_stop.call_count == 1


def test_main_start_fails(reboot_module, tmp_paths, mock_systemd_fail_start, no_sleep, write_marker):
    """Stop OK, start fails: exit 1, both calls made (count == 2)."""
    write_marker()

    exit_code = reboot_module.main()

    assert exit_code == 1
    # Stop succeeded, then start failed
    assert mock_systemd_fail_start.call_count == 2


def test_main_dry_run(reboot_module, tmp_paths, mock_systemd_success, no_sleep, write_marker, dry_run):
    """DRY_RUN=True + valid marker: exit 0, subprocess.run is NEVER called (count == 0)."""
    write_marker()

    exit_code = reboot_module.main()

    assert exit_code == 0
    # DRY_RUN short-circuits before subprocess.run
    assert mock_systemd_success.call_count == 0

    log_content = (tmp_paths / "reboot.log").read_text()
    assert "DRY_RUN=1" in log_content
    assert "DRY_RUN: would run" in log_content


def test_main_sleep_called_between_stop_and_start(reboot_module, tmp_paths, monkeypatch, write_marker):
    """time.sleep IS called with SLEEP_SECONDS=10 between the stop and start systemctl calls.

    Verifies the wait actually happens (and the order: stop -> sleep -> start).
    """
    write_marker()

    # Track exact call order across subprocess.run and time.sleep
    call_log = []

    def fake_run(*args, **kwargs):
        call_log.append(("run", list(args[0])))
        return _make_success_result()

    def fake_sleep(seconds):
        call_log.append(("sleep", seconds))

    monkeypatch.setattr(reboot_module.subprocess, "run", fake_run)
    monkeypatch.setattr(reboot_module.time, "sleep", fake_sleep)

    exit_code = reboot_module.main()

    assert exit_code == 0
    assert call_log == [
        ("run", ["systemctl", "--user", "stop", "opencode-web.service"]),
        ("sleep", 10),
        ("run", ["systemctl", "--user", "start", "opencode-web.service"]),
    ]


def _make_success_result():
    """Build a CompletedProcess-like mock for the fake_run tracker."""
    from unittest.mock import MagicMock
    return MagicMock(returncode=0, stdout=b"", stderr=b"")
