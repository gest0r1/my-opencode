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

        # An executable placed by another user/tool is not ours to replace.
        # Preflight both links first: an npm conflict must not alter npx either.
        npm_link = home / ".local/bin/npm"
        npx_link = home / ".local/bin/npx"
        npm_link.unlink()
        npx_link.unlink()
        tool(npm_link, "echo user-owned-npm\\n")
        npx_link.symlink_to("/root/.nvm/versions/node/v22/bin/npx")
        original_npm = npm_link.read_bytes()
        original_npx = os.readlink(npx_link)
        blocked = run(home, tools)
        assert blocked.returncode != 0
        assert "RUNTIME_TOOLCHAIN_CONFLICT" in blocked.stderr, blocked.stderr
        assert npm_link.is_file() and not npm_link.is_symlink()
        assert npm_link.read_bytes() == original_npm
        assert os.readlink(npx_link) == original_npx
        npm_link.unlink()
        npx_link.unlink()

        # An unrelated *working* symlink is also preserved, never adopted.
        foreign_npx = Path(tmp) / "foreign-npx"
        tool(foreign_npx, "echo another-owner\\n")
        npx_link.symlink_to(foreign_npx)
        blocked = run(home, tools)
        assert blocked.returncode != 0
        assert "RUNTIME_TOOLCHAIN_CONFLICT" in blocked.stderr, blocked.stderr
        assert os.readlink(npx_link) == str(foreign_npx)
        assert not npm_link.exists(), "preflight must not partially install npm"
        npx_link.unlink()
        assert run(home, tools).returncode == 0

        # A stale root-owned link in the user bin must be replaced, not trusted.
        for name in ("npm", "npx"):
            (home / ".local/bin" / name).unlink()
            (home / ".local/bin" / name).symlink_to("/root/.nvm/versions/node/v22/bin/" + name)
        result = run(home, tools)
        assert result.returncode == 0, result.stderr
        for name in ("npm", "npx"):
            assert not os.readlink(home / ".local/bin" / name).startswith("/root/")

        # Polluted PATH with a root-only nvm entry must not win over the usable node dir.
        if os.geteuid() != 0:
            polluted = Path(tmp) / "root-nvm"
            polluted.mkdir()
            for name in ("node", "npm", "npx"):
                (polluted / name).symlink_to("/root/.nvm/versions/node/v22.23.2/bin/" + name)
            result = run(home, tools, str(polluted) + ":")
            assert result.returncode == 0, result.stderr
            assert os.readlink(home / ".local/bin/npm") == str(tools / "npm")

        # The pinned Node bootstrap uses the same non-overwrite rule. It must
        # not replace an unmanaged ~/.local/bin/node even when the PATH node fails.
        home_node = Path(tmp) / "home-node"
        home_node.mkdir()
        user_bin = home_node / ".local/bin"
        user_bin.mkdir(parents=True)
        tool(user_bin / "node", "echo user-owned-node\\n")
        original_node = (user_bin / "node").read_bytes()
        pinned_bin = home_node / ".local/share/my-opencode/node-v24.21.0/bin"
        pinned_bin.mkdir(parents=True)
        tool(pinned_bin / "node", f'exec "{REAL_NODE}" "$@"\\n')
        tool(pinned_bin / "npm", "echo pinned-npm\\n")
        tool(pinned_bin / "npx", "echo pinned-npx\\n")
        bad_tools = Path(tmp) / "bad-node"
        bad_tools.mkdir()
        tool(bad_tools / "node", "exit 1\\n")
        blocked = run(home_node, bad_tools)
        assert blocked.returncode != 0
        assert "RUNTIME_TOOLCHAIN_CONFLICT" in blocked.stderr, blocked.stderr
        assert (user_bin / "node").read_bytes() == original_node
        assert not (user_bin / "node").is_symlink()

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
