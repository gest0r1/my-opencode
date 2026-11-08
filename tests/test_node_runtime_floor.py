"""Exercise the existing user-local bootstrap and direct core runtime floor."""
import os
from pathlib import Path
import shutil
import subprocess
import tempfile

ROOT = Path(__file__).resolve().parents[1]
REAL_NODE = shutil.which("node")
assert REAL_NODE

with tempfile.TemporaryDirectory() as directory:
    root = Path(directory)
    tools = root / "bin"
    tools.mkdir()
    node = tools / "node"
    node.write_text(f"#!{REAL_NODE}\n" + """
const vm = require('node:vm');
Object.defineProperty(process.versions, 'node', { value: process.env.FIXTURE_NODE_VERSION });
const [mode, script, ...args] = process.argv.slice(2);
if (mode === '--version') { console.log('v' + process.versions.node); }
else if (mode === '-e') { process.argv = [process.argv[0], ...args]; vm.runInThisContext(script); }
else { process.exit(92); }
""")
    node.chmod(0o755)
    for command in ["curl", "gh"]:
        tool = tools / command
        auth = 'if [ "$1" = auth ]; then exit 0; fi\n' if command == 'gh' else ''
        tool.write_text('#!/bin/sh\n' + auth + 'printf "%s\\n" "' + command + '" >> "$FLOOR_TRACE"\nexit 91\n')
        tool.chmod(0o755)
    for version, minimum, retained in [
        ("22.20.0", "22.0.0", True),
        ("22.20.0", "24.14.0", False),
        ("24.13.9", "24.14.0", False),
        ("24.14.0", "24.14.0", True),
        ("25.0.0", "24.14.0", True),
    ]:
        trace = root / "trace"
        trace.unlink(missing_ok=True)
        env = {**os.environ, "HOME": str(root), "FIXTURE_NODE_VERSION": version,
               "FLOOR_TRACE": str(trace), "FLOOR_TOOLS": str(tools)}
        script = 'source "$1"; export PATH="$FLOOR_TOOLS:$PATH"; ensure_runtime_node "$2"'
        result = subprocess.run(["bash", "-c", script, "floor-test",
                                 str(ROOT / "scripts/bootstrap-runtime-tools.sh"), minimum],
                                env=env, capture_output=True, text=True, timeout=10)
        assert (result.returncode == 0) == retained, (version, minimum, result.stderr)
        assert trace.exists() != retained, (version, minimum, "bootstrap selection")

    trace = root / "core-trace"
    env = {**os.environ, "HOME": str(root), "PATH": str(tools) + ":" + os.environ["PATH"],
           "FIXTURE_NODE_VERSION": "22.20.0", "FLOOR_TRACE": str(trace)}
    result = subprocess.run(["bash", str(ROOT / "scripts/install-openchamber-v2-core.sh")],
                            env=env, capture_output=True, text=True, timeout=10)
    assert result.returncode != 0 and "Node.js 24.14.0+ is required" in result.stderr, result.stderr
    assert not trace.exists(), "an incompatible runtime reached GitHub/build/install work"
print("PASS: runtime floors retain compatible Node, select the existing bootstrap, and stop core early")
