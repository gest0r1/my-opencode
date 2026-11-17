#!/usr/bin/env python3
"""User-local Node/npm/npx toolchain: polluted PATH is repaired, never trusted."""
import os
import shutil
import subprocess
import tempfile
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
BOOTSTRAP = ROOT / "scripts/bootstrap-runtime-tools.sh"
REAL_NODE = shutil.which("node")
assert REAL_NODE


def tool(path: Path, body: str):
    path.write_text("#!/bin/sh\n" + body)
    path.chmod(0o755)


def run(home: Path, tools: Path, path_prefix: str = "") -> subprocess.CompletedProcess:
    path = f"{path_prefix}{tools}:/usr/bin:/bin"
    script = (f'source "{BOOTSTRAP}"; export PATH="{path}"; '
              f'ensure_runtime_toolchain 22.0.0')
    return subprocess.run(["bash", "-c", script], capture_output=True, text=True,
                          env={**os.environ, "HOME": str(home)})


def main():
    system_npm = os.readlink("/usr/local/bin/npm") if os.path.islink("/usr/local/bin/npm") else None
    with tempfile.TemporaryDirectory() as tmp:
        home = Path(tmp) / "home"
        tools = Path(tmp) / "tools"
        home.mkdir(); tools.mkdir()
        (home / ".local/bin").mkdir(parents=True)
        tool(tools / "node", f'exec "{REAL_NODE}" "$@"\n')
        tool(tools / "npm", 'echo 11.19.0\n')
        tool(tools / "npx", 'echo 11.19.0\n')

        result = run(home, tools)
        assert result.returncode == 0, result.stderr
        for name in ("npm", "npx"):
            link = home / ".local/bin" / name
            assert link.is_symlink(), name
            assert os.readlink(link) == str(tools / name), os.readlink(link)
            assert subprocess.run([str(link), "--version"], capture_output=True).returncode == 0

        # Re-running the installer keeps working links idempotent.
        first = {name: os.readlink(home / ".local/bin" / name) for name in ("npm", "npx")}
        assert run(home, tools).returncode == 0
        assert first == {name: os.readlink(home / ".local/bin" / name) for name in ("npm", "npx")}

        # A stale root-owned link in the user bin must be replaced, not trusted.
        for name in ("npm", "npx"):
            (home / ".local/bin" / name).unlink()
            (home / ".local/bin" / name).symlink_to("/root/.nvm/versions/node/v22/bin/" + name)
        result = run(home, tools)
        assert result.returncode == 0, result.stderr
        for name in ("npm", "npx"):
            assert not os.readlink(home / ".local/bin" / name).startswith("/root/")

        # Polluted PATH with a root-only nvm entry must not win over the usable node dir.
        polluted = Path(tmp) / "root-nvm"
        polluted.mkdir()
        for name in ("node", "npm", "npx"):
            (polluted / name).symlink_to("/root/.nvm/versions/node/v22.23.2/bin/" + name)
        result = run(home, tools, str(polluted) + ":")
        assert result.returncode == 0, result.stderr
        assert os.readlink(home / ".local/bin/npm") == str(tools / "npm")

        # No usable npm and no network path: fail closed with a concrete diagnostic.
        bare = Path(tmp) / "bare"
        bare.mkdir()
        tool(bare / "node", f'exec "{REAL_NODE}" "$@"\n')
        tool(bare / "curl", 'exit 1\n')
        home2 = Path(tmp) / "home2"
        home2.mkdir()
        result = run(home2, bare)
        assert result.returncode != 0
        assert "RUNTIME_TOOLCHAIN_UNUSABLE" in result.stderr

        # The test never touches system paths.
        after = os.readlink("/usr/local/bin/npm") if os.path.islink("/usr/local/bin/npm") else None
        assert after == system_npm
    print("PASS: user-local Node/npm/npx repaired, root nvm PATH rejected, failure diagnosed")


if __name__ == "__main__":
    main()
