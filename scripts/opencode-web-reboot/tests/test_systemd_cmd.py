"""Tests for reboot.systemd_cmd().

systemd_cmd(action, timeout) runs `systemctl --user <action> <SERVICE>` and:
  - Returns silently on success
  - Re-raises subprocess.TimeoutExpired (after logging "timed out")
  - Re-raises subprocess.CalledProcessError (after logging rc + stderr)
  - Re-raises FileNotFoundError (after logging "systemctl not found on PATH")
  - In DRY_RUN mode, logs the would-be command and returns without executing
"""

import subprocess

import pytest


def test_systemd_cmd_success(reboot_module, tmp_paths, mock_systemd_success):
    """Successful subprocess.run: no exception raised, mock called once."""
    reboot_module.systemd_cmd("stop", 30)

    mock_systemd_success.assert_called_once()
    # Verify the command shape: list form, check=True, capture_output=True
    args, kwargs = mock_systemd_success.call_args
    assert args[0] == ["systemctl", "--user", "stop", "opencode-web.service"]
    assert kwargs.get("check") is True
    assert kwargs.get("timeout") == 30


def test_systemd_cmd_called_process_error(reboot_module, tmp_paths, mock_systemd_fail_stop):
    """CalledProcessError from subprocess.run: code re-raises, log contains stderr text."""
    with pytest.raises(subprocess.CalledProcessError) as exc_info:
        reboot_module.systemd_cmd("stop", 30)

    # The exception that bubbles up is the same one subprocess.run raised
    assert exc_info.value.returncode == 1

    log_content = (tmp_paths / "reboot.log").read_text()
    assert "unit not found" in log_content
    assert "failed" in log_content.lower()


def test_systemd_cmd_timeout(reboot_module, tmp_paths, mock_systemd_timeout):
    """TimeoutExpired from subprocess.run: code re-raises, log contains 'timed out'."""
    with pytest.raises(subprocess.TimeoutExpired):
        reboot_module.systemd_cmd("stop", 30)

    log_content = (tmp_paths / "reboot.log").read_text()
    assert "timed out" in log_content


def test_systemd_cmd_dry_run(reboot_module, tmp_paths, mock_systemd_success, dry_run):
    """DRY_RUN=True: subprocess.run is NOT called, log records the would-be command."""
    reboot_module.systemd_cmd("stop", 30)

    # Mock was set up but never invoked
    mock_systemd_success.assert_not_called()

    log_content = (tmp_paths / "reboot.log").read_text()
    assert "DRY_RUN: would run: systemctl --user stop opencode-web.service" in log_content
    assert "timeout=30s" in log_content
