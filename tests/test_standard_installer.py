#!/usr/bin/env python3
"""Contract tests for cached installs, wildcard bind and explicit rollback host."""
import os
from pathlib import Path
import subprocess
import tempfile

SHA = "a" * 40
BUNDLE_SHA = "b" * 40
VERSION = "1.18.31"
ROOT_REPO = Path(__file__).resolve().parents[1]


def executable(path: Path, content: str):
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(content)
    path.chmod(0o755)


def run_installer(env):
    result = subprocess.run(["bash", str(ROOT_REPO / "install-openchamber.sh")],
                            env=env, text=True, capture_output=True)
    assert result.returncode == 0, result.stdout + "\n" + result.stderr
    assert "Already current:" in result.stdout, result.stdout


def main():
    installer_source = (ROOT_REPO / "install-openchamber.sh").read_text()
    assert '"$STATE.tmp.$"' not in installer_source
    assert '"$ROOT/.current-new.$"' not in installer_source

    with tempfile.TemporaryDirectory(prefix="opencode-install-test-") as directory:
        tmp = Path(directory)
        home = tmp / "home"
        root = home / ".local/share/openchamber"
        release = root / "releases" / BUNDLE_SHA
        (release / "packages/web/bin").mkdir(parents=True)
        (release / "packages/sdk/dist").mkdir(parents=True)
        (release / "packages/web/bin/cli.js").write_text("// existing bundle\n")
        (release / "packages/sdk/dist/index.js").write_text("// existing sdk\n")
        executable(release / "opencode-cli/node_modules/.bin/opencode", f"#!/bin/sh\necho {VERSION}\n")
        (root / "bin").mkdir(parents=True)
        (root / "current").symlink_to("releases/" + BUNDLE_SHA)
        executable(root / "bin/openchamber", "#!/bin/sh\nexit 0\n")
        (root / "bin/opencode").symlink_to("../current/opencode-cli/node_modules/.bin/opencode")
        executable(home / ".opencode/bin/opencode", f"#!/bin/sh\necho {VERSION}\n")
        state = home / ".local/state/my-opencode/openchamber-install.state"
        state.parent.mkdir(parents=True)
        state.write_text(
            f"config_sha={SHA}\nopenchamber_sha={SHA}\nbundle_source_sha={BUNDLE_SHA}\nopencode_version={VERSION}\n"
        )
        unit_dir = home / ".config/systemd/user"
        drop_dir = unit_dir / "openchamber.service.d"
        drop_dir.mkdir(parents=True)
        (unit_dir / "openchamber.service").write_text("[Service]\nExecStart=/usr/local/bin/openchamber\n")
        drop = drop_dir / "90-openchamber-runtime.conf"
        drop.write_text(
            "[Service]\nExecStart=/usr/local/bin/openchamber serve --foreground --host 127.0.0.1 --port 3000\n"
        )
        fake = tmp / "fake-bin"
        fake.mkdir()
        log = tmp / "gh.log"
        executable(fake / "gh", """#!/bin/bash
set -Eeuo pipefail
printf '%s\\n' "$*" >> "$TEST_GH_LOG"
if [[ "$1 $2" == 'auth status' ]]; then exit 0; fi
if [[ "$1" == api ]]; then echo "$TEST_SHA"; exit 0; fi
if [[ "$1 $2" == 'release download' ]]; then
  dir=''
  while (( $# )); do
    if [[ "$1" == --dir ]]; then dir="$2"; break; fi
    shift
  done
  [[ -n "$dir" ]]
  printf '{"schema_version":3,"platform":"linux-x64","source_sha":"%s","bundle_source_sha":"%s","bundle_tag":"linux-bundle-%s","asset":"openchamber-integration-linux-x64-%s.tar.gz","sha256":"%s","opencode_version":"1.18.31","bundle_fingerprint":"%s"}\\n' "$TEST_SHA" "$TEST_BUNDLE_SHA" "$TEST_BUNDLE_SHA" "$TEST_BUNDLE_SHA" "$(printf '%064d' 0)" "$(printf 'c%.0s' {1..64})" > "$dir/manifest.json"
  exit 0
fi
exit 96
""")
        executable(fake / "ip", "#!/bin/sh\nexit 0\n")
        executable(fake / "ss", "#!/bin/sh\nexit 0\n")
        executable(fake / "systemctl", "#!/bin/sh\nexit 0\n")
        env = os.environ.copy()
        env.update({
            "HOME": str(home), "XDG_DATA_HOME": str(home / ".local/share"),
            "XDG_STATE_HOME": str(home / ".local/state"),
            "PATH": str(fake) + ":" + env["PATH"],
            "OPENCODE_CONFIG_REF": "integration/test", "OPENCHAMBER_REF": "integration/test",
            "OPENCHAMBER_BIND_HOST": "127.0.0.1", "TEST_SHA": SHA,
            "TEST_BUNDLE_SHA": BUNDLE_SHA, "TEST_GH_LOG": str(log),
        })
        run_installer(env)
        assert sum("release download" in line for line in log.read_text().splitlines()) == 1
        print("PASS: repeat install fetched only manifest, no binary/archive/config downloads")

        # A new main SHA may point to the same verified bundle. Advancing source
        # identity must not download or restart an unchanged runtime.
        old_source = "d" * 40
        state.write_text(
            f"config_sha={SHA}\nopenchamber_sha={old_source}\nbundle_source_sha={BUNDLE_SHA}\nopencode_version={VERSION}\n"
        )
        result = subprocess.run(["bash", str(ROOT_REPO / "install-openchamber.sh")],
                                env=env, text=True, capture_output=True)
        assert result.returncode == 0, result.stdout + "\n" + result.stderr
        assert f"Advanced OpenChamber source to {SHA} using cached bundle {BUNDLE_SHA}" in result.stdout
        assert f"openchamber_sha={SHA}" in state.read_text()
        assert f"bundle_source_sha={BUNDLE_SHA}" in state.read_text()
        assert sum("release download" in line for line in log.read_text().splitlines()) == 2
        print("PASS: new source SHA reused cached verified bundle without large download")

        # A Docker bridge now selects the upstream-compatible wildcard listener.
        executable(fake / "ip", "#!/bin/sh\necho '    inet 172.18.0.1/16 scope global br-test'\n")
        drop.write_text(
            "[Service]\nExecStart=/usr/local/bin/openchamber serve --foreground --host 0.0.0.0 --port 3000\n"
        )
        env.pop("OPENCHAMBER_BIND_HOST")
        run_installer(env)
        assert sum("release download" in line for line in log.read_text().splitlines()) == 3
        print("PASS: Docker bridge selects wildcard bind with no unnecessary archive download")

        # The operator can explicitly restore the old interface-only bind.
        drop.write_text(
            "[Service]\nExecStart=/usr/local/bin/openchamber serve --foreground --host 172.18.0.1 --port 3000\n"
        )
        env["OPENCHAMBER_BIND_HOST"] = "172.18.0.1"
        run_installer(env)
        assert sum("release download" in line for line in log.read_text().splitlines()) == 4
        print("PASS: explicit bind override remains available for rollback")


if __name__ == "__main__":
    main()
