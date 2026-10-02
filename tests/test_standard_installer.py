#!/usr/bin/env python3
"""Contract tests for the thin OpenChamber/OpenCode 2.x installer."""
import io
import os
from pathlib import Path
import subprocess
import tarfile
import tempfile

CONFIG_SHA = "a" * 40
APP_SHA = "b" * 40
ROOT_REPO = Path(__file__).resolve().parents[1]


def executable(path: Path, content: str):
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(content)
    path.chmod(0o755)


def source_archive(path: Path):
    package = b'{"name":"@openchamber/web","version":"2.1.0"}\\n'
    with tarfile.open(path, "w:gz") as archive:
        info = tarfile.TarInfo("repo/packages/web/package.json")
        info.size = len(package)
        archive.addfile(info, io.BytesIO(package))


def run(env):
    return subprocess.run(
        ["bash", str(ROOT_REPO / "install-openchamber.sh")],
        env=env, text=True, capture_output=True,
    )


def fixture(tmp: Path):
    home = tmp / "home"
    fake = tmp / "fake"
    fake.mkdir()
    log = tmp / "calls.log"
    archive = tmp / "source.tar.gz"
    source_archive(archive)

    executable(fake / "node", "#!/bin/sh\\nexec /usr/bin/node \\"$@\\"\\n")
    executable(fake / "curl", "#!/bin/sh\\nexit 97\\n")
    executable(fake / "systemctl", "#!/bin/sh\\nprintf 'systemctl %s\\\\n' \\"$*\\" >> \\"$TEST_LOG\\"\\nexit 0\\n")
    executable(fake / "gh", r'''#!/bin/bash
set -Eeuo pipefail
printf 'gh %s\\n' "$*" >> "$TEST_LOG"
if [[ "$1 $2" == "auth status" ]]; then exit 0; fi
if [[ "$1" != api ]]; then exit 90; fi
shift
if [[ "${1:-}" == "-H" ]]; then shift 2; fi
target="$1"
case "$target" in
  repos/gest0r1/my-opencode/commits/*) echo "$CONFIG_SHA" ;;
  repos/gest0r1/openchamber-ru/commits/*) echo "$APP_SHA" ;;
  repos/gest0r1/my-opencode/contents/install.sh?ref=*)
    cat <<'SCRIPT'
#!/bin/bash
set -Eeuo pipefail
mkdir -p "$HOME/.opencode/bin"
cat > "$HOME/.opencode/bin/opencode" <<'OC'
#!/bin/sh
echo 2.0.21
OC
chmod 755 "$HOME/.opencode/bin/opencode"
SCRIPT
    ;;
  repos/gest0r1/openchamber-ru/tarball/*) cat "$TEST_ARCHIVE" ;;
  *) echo "unexpected gh target: $target" >&2; exit 91 ;;
esac
''')
    executable(fake / "bun", r'''#!/bin/bash
set -Eeuo pipefail
printf 'bun %s\\n' "$*" >> "$TEST_LOG"
case "$1 $2" in
  "install --frozen-lockfile") exit 0 ;;
  "run --cwd") exit 0 ;;
  "pm pack")
    dest=''
    while (($#)); do
      if [[ "$1" == --destination ]]; then dest="$2"; break; fi
      shift
    done
    mkdir -p "$dest"
    : > "$dest/openchamber-web-2.1.0.tgz"
    ;;
  "add -g")
    mkdir -p "$HOME/.bun/bin"
    cat > "$HOME/.bun/bin/openchamber" <<'OC'
#!/bin/bash
case "${1:-}" in
  --version) echo 2.1.0 ;;
  startup)
    printf 'openchamber %s\\n' "$*" >> "$TEST_LOG"
    exit 0
    ;;
  *) exit 0 ;;
esac
OC
    chmod 755 "$HOME/.bun/bin/openchamber"
    ;;
  *) exit 0 ;;
esac
''')

    env = os.environ.copy()
    env.update({
        "HOME": str(home),
        "XDG_STATE_HOME": str(home / ".local/state"),
        "PATH": f"{fake}:/usr/bin:/bin",
        "BUN_INSTALL": str(home / ".bun"),
        "TEST_LOG": str(log),
        "TEST_ARCHIVE": str(archive),
        "CONFIG_SHA": CONFIG_SHA,
        "APP_SHA": APP_SHA,
        "OPENCODE_CONFIG_REF": "upgrade/opencode-v2",
        "OPENCHAMBER_REF": "upgrade/openchamber-2.1.0",
    })
    return home, log, env


def main():
    with tempfile.TemporaryDirectory(prefix="openchamber-v2-installer-") as directory:
        tmp = Path(directory)
        home, log, env = fixture(tmp)

        result = run(env)
        assert result.returncode == 0, result.stdout + "\\n" + result.stderr
        assert "SUCCESS: OpenChamber 2.1.0" in result.stdout
        calls = log.read_text()
        assert "bun install --frozen-lockfile" in calls
        assert "bun run --cwd packages/web build" in calls
        assert "bun pm pack --destination" in calls
        assert "bun add -g" in calls
        assert "openchamber startup enable --host 127.0.0.1 --port 3000" in calls
        assert "openchamber startup status" in calls
        state = home / ".local/state/my-opencode/openchamber-v2-install.state"
        saved = state.read_text()
        assert f"openchamber_sha={APP_SHA}" in saved
        assert "openchamber_version=2.1.0" in saved
        assert "opencode_version=2.0.21" in saved
        print("PASS: fresh v2 fork build delegates service lifecycle to native startup")

        log.write_text("")
        result = run(env)
        assert result.returncode == 0, result.stdout + "\\n" + result.stderr
        calls = log.read_text()
        assert "bun install --frozen-lockfile" not in calls
        assert "bun pm pack --destination" not in calls
        assert "openchamber startup enable --host 127.0.0.1 --port 3000" in calls
        print("PASS: repeat install skips unchanged fork build")

        legacy = home / ".config/systemd/user/openchamber.service.d/90-openchamber-runtime.conf"
        legacy.parent.mkdir(parents=True, exist_ok=True)
        legacy.write_text("[Service]\\nExecStart=/usr/local/bin/openchamber\\n")
        before = legacy.read_text()
        result = run(env)
        assert result.returncode == 3
        assert "LEGACY_SERVICE_DETECTED" in result.stderr
        assert legacy.read_text() == before
        print("PASS: legacy 1.x service override blocks without being deleted")


if __name__ == "__main__":
    main()
