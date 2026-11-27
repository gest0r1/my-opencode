#!/usr/bin/env bash
# Real root entrypoint, mocked GitHub resolution, exact-SHA child handoff.
set -Eeuo pipefail
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
TMP="$(mktemp -d)"; trap 'rm -rf -- "$TMP"' EXIT
BIN="$TMP/bin"; TRACE="$TMP/trace"; mkdir -p "$BIN"; : > "$TRACE"
CONFIG_SHA=aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa
cat > "$TMP/coordinator" <<'EOS'
#!/usr/bin/env bash
set -Eeuo pipefail
{
 printf 'pinned=%s\n' "$OPENCODE_CONFIG_REF"
 printf 'app=%s\n' "$OPENCHAMBER_REF"
 printf 'user=%s\n' "$(id -u)"
} >> "$TRACE"
EOS
cat > "$BIN/gh" <<'EOS'
#!/usr/bin/env bash
case "$*" in
  *"repos/gest0r1/my-opencode/commits/"*) printf '%s\n' 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa' ;;
  *"repos/gest0r1/openchamber-ru/commits/"*) printf '%s\n' 'bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb' ;;
  *"repos/gest0r1/my-opencode/contents/scripts/install-openchamber-unified.sh?ref=aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"*) cat "$COORDINATOR" ;;
  *) echo "unexpected gh: $*" >&2; exit 91 ;;
esac
EOS
chmod +x "$BIN/gh"
# Must run the actual new root dispatch, not the retired sudo-to-opencode path.
if [[ $EUID == 0 ]]; then
  env PATH="$BIN:$PATH" TRACE="$TRACE" COORDINATOR="$TMP/coordinator" \
    OPENCODE_CONFIG_REF=feature/secure OPENCHAMBER_REF=feature/oc \
    bash "$ROOT/install-openchamber.sh" > "$TMP/out" 2>&1
else
  sudo -n env PATH="$BIN:$PATH" TRACE="$TRACE" COORDINATOR="$TMP/coordinator" \
    OPENCODE_CONFIG_REF=feature/secure OPENCHAMBER_REF=feature/oc \
    bash "$ROOT/install-openchamber.sh" > "$TMP/out" 2>&1
fi
grep -Fxq "pinned=$CONFIG_SHA" "$TRACE"
grep -Fxq 'app=bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb' "$TRACE"
grep -Fxq 'user=0' "$TRACE"
# A malicious ref must be rejected without touching the protected coordinator.
cp "$TRACE" "$TMP/old"
rc=0
if [[ $EUID == 0 ]]; then
  env PATH="$BIN:$PATH" TRACE="$TRACE" COORDINATOR="$TMP/coordinator" \
    OPENCODE_CONFIG_REF=$'main\nx=1' bash "$ROOT/install-openchamber.sh" >"$TMP/bad" 2>&1 || rc=$?
else
  sudo -n env PATH="$BIN:$PATH" TRACE="$TRACE" COORDINATOR="$TMP/coordinator" \
    OPENCODE_CONFIG_REF=$'main\nx=1' bash "$ROOT/install-openchamber.sh" >"$TMP/bad" 2>&1 || rc=$?
fi
[[ "$rc" != 0 ]] && grep -Fq INSTALL_SOURCE_REF_INVALID "$TMP/bad"
cmp "$TRACE" "$TMP/old"
echo 'PASS: root coordinator resolves exact config SHA and rejects malicious refs'
