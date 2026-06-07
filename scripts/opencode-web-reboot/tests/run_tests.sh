#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "$0")/.."

# Install pytest if missing (no venv — --user site)
if ! python3 -c "import pytest" 2>/dev/null; then
    echo "[run_tests] Installing pytest via pip --user..."
    python3 -m pip install --user --quiet pytest
fi

# Run tests
mkdir -p tests
python3 -m pytest tests/ -v --tb=short --log-cli-level=INFO 2>&1 | tee tests/.last-run.log
