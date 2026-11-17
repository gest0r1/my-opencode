#!/usr/bin/env bash
# Run the complete staging path and prove timeout preserves active trees.
set -Eeuo pipefail
# The stub bun below must win: an inherited BUN_INSTALL would point the installer at a real bun.
unset BUN_INSTALL
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
TASK_TMP=$(mktemp -d)
trap 'rm -rf -- "$TASK_TMP"' EXIT
mkdir -p "$TASK_TMP/bin" "$TASK_TMP/home/.config/opencode" "$TASK_TMP/home/.agents/skills" "$TASK_TMP/home/.opencode/bin"
printf '{"plugins":[]}\n' > "$TASK_TMP/home/.config/opencode/opencode.json"
printf 'previous skill\n' > "$TASK_TMP/home/.agents/skills/previous"
cat > "$TASK_TMP/home/.opencode/bin/opencode" <<'BIN'
#!/usr/bin/env bash
echo 2.0.21
BIN
chmod +x "$TASK_TMP/home/.opencode/bin/opencode"
tar -czf "$TASK_TMP/source.tar.gz" -C "$(dirname "$ROOT")" "$(basename "$ROOT")/config" "$(basename "$ROOT")/scripts"
cat > "$TASK_TMP/bin/gh" <<'GH'
#!/usr/bin/env bash
if [[ "$1" == auth ]]; then exit 0; fi
if [[ "$*" == *tarball* ]]; then cat "$SOURCE_ARCHIVE"; exit 0; fi
echo "Unexpected gh: $*" >&2
exit 91
GH
cat > "$TASK_TMP/bin/bun" <<'BUN'
#!/usr/bin/env bash
echo 'stalled dependency download'
sleep 30
BUN
chmod +x "$TASK_TMP/bin/gh" "$TASK_TMP/bin/bun"
mkdir -p "$TASK_TMP/home/.local/bin"
cp "$TASK_TMP/bin/"* "$TASK_TMP/home/.local/bin/"
ln -s "$(command -v node)" "$TASK_TMP/home/.local/bin/node"
rc=0
env -u XDG_STATE_HOME -u XDG_CONFIG_HOME -u XDG_DATA_HOME \
  HOME="$TASK_TMP/home" PATH="$TASK_TMP/bin:$PATH" SOURCE_ARCHIVE="$TASK_TMP/source.tar.gz" \
  OPENCODE_RESOLVED_CONFIG_SHA=1111111111111111111111111111111111111111 OPENCODE_SKIP_BINARY_INSTALL=1 \
  OPENCODE_DEPENDENCY_TIMEOUT_SECONDS=1 bash "$ROOT/scripts/install-opencode-generation.sh" > "$TASK_TMP/output" 2>&1 || rc=$?
[[ "$rc" == 124 ]] || { cat "$TASK_TMP/output"; exit 1; }
grep -Fq 'timed out after 1s' "$TASK_TMP/output"
[[ "$(cat "$TASK_TMP/home/.config/opencode/opencode.json")" == '{"plugins":[]}' ]]
[[ "$(cat "$TASK_TMP/home/.agents/skills/previous")" == 'previous skill' ]]
[[ "$("$TASK_TMP/home/.opencode/bin/opencode" --version)" == 2.0.21 ]]
[[ -z "$(find "$TASK_TMP/home/.config" "$TASK_TMP/home/.agents" -maxdepth 1 -name '*-stage.*' -print -quit)" ]]
[[ -f "$TASK_TMP/home/.local/state/my-opencode/opencode-dependency-install.log" ]]
echo 'PASS: dependency timeout preserves active config/skills/binary and removes staging trees'
