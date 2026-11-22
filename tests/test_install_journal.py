#!/usr/bin/env python3
"""Install audit journal: bounded rotation, private permissions, no secret dumps."""
import os
import stat
import subprocess
import tempfile
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
HELPER = ROOT / "scripts/install-journal.sh"
wrapper = (ROOT / "install-openchamber.sh").read_text()
core = (ROOT / "scripts/install-openchamber-v2-core.sh").read_text()


def run(home: Path, event: str, extra_env: dict | None = None) -> subprocess.CompletedProcess:
    env = {**os.environ, "HOME": str(home), "XDG_STATE_HOME": str(home / ".local/state"),
           **(extra_env or {})}
    return subprocess.run(["bash", "-c", f'source "{HELPER}"; {event}'], env=env,
                          capture_output=True, text=True)


def main():
    with tempfile.TemporaryDirectory() as tmp:
        home = Path(tmp)
        state = home / ".local/state/my-opencode"
        result = run(home, 'install_journal_event install start "config_ref=main" "config_sha='
                           + "a" * 40 + '" "openchamber_ref=feature/x" "openchamber_sha='
                           + "b" * 40 + '"')
        assert result.returncode == 0, result.stderr
        journal = state / "openchamber-install.log"
        assert journal.is_file()
        assert stat.S_IMODE(state.stat().st_mode) == 0o700, oct(state.stat().st_mode)
        assert stat.S_IMODE(journal.stat().st_mode) == 0o600, oct(journal.stat().st_mode)
        line = journal.read_text().strip()
        assert "phase=install" in line and "status=start" in line
        assert "config_ref=main" in line and "openchamber_ref=feature/x" in line
        assert "token" not in line.lower() and "password" not in line.lower()

        # Newlines and tabs cannot forge extra journal records or fields.
        run(home, "install_journal_event activation activated $'config_ref=main\nstatus=fake' $'note=a\tb'")
        lines = journal.read_text().splitlines()
        assert len(lines) == 2, lines
        assert "status=fake" not in lines[1] and "\t" not in lines[1]

        # Bounded rotation keeps the previous file under a private name.
        journal.write_text("x" * 2048)
        run(home, 'install_journal_event activation activated "config_ref=main"',
            {"INSTALL_JOURNAL_MAX_BYTES": "1024"})
        rotated = state / "openchamber-install.log.1"
        assert rotated.is_file() and rotated.stat().st_size == 2048
        assert journal.stat().st_size < 1024
        assert stat.S_IMODE(rotated.stat().st_mode) == 0o600

    # The pinned root coordinator stores source provenance and journals
    # root-owned activation/rollback; its agent-facing OpenCode installation
    # remains an independent unprivileged transaction.
    root = (ROOT / 'scripts/install-openchamber-root.sh').read_text()
    assert 'OPENCODE_CONFIG_SOURCE_REF="$REQUESTED_CONFIG_REF"' in wrapper
    assert 'OPENCHAMBER_SOURCE_REF="$REQUESTED_APP_REF"' in wrapper
    assert 'OPENCHAMBER_REF="$APP_SHA"' in wrapper
    assert 'install_journal_event install start' in root
    assert 'install_journal_event activation pending_restart' in root
    assert 'install_journal_event activation activated' in root
    assert 'install_journal_event install failed' in root
    assert '"config_ref=$CONFIG_SOURCE_REF"' in core
    assert '"openchamber_ref=$APP_SOURCE_REF"' in core
    assert '"installed_at=$(date -u' in core
    assert '"installation_status=delivered"' in core
    assert 'activation_status=$activation_status' in core
    print("PASS: install journal is bounded, private, injection-safe and ref-provenance is preserved")


if __name__ == "__main__":
    main()
