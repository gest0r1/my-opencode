#!/usr/bin/env bash
# Execute the sudo re-exec handover with fakes and assert the frozen refs.
set -Eeuo pipefail
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
TMP="$(mktemp -d)"; trap 'rm -rf -- "$TMP"' EXIT
BIN="$TMP/bin"; HOME_FAKE="$TMP/runtime-home"; TRACE="$TMP/trace.log"
CONFIG_SHA="aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"
APP_SHA="bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb"
mkdir -p "$BIN" "$HOME_FAKE"; : > "$TRACE"

fail(){ echo "FAIL: $*" >&2; exit 1; }

cat > "$BIN/id" <<'EOS'
#!/bin/sh
case "$1" in -un) echo owner;; -u) echo 1001;; *) exec /usr/bin/id "$@";; esac
EOS
cat > "$BIN/getent" <<EOS
#!/bin/sh
echo "opencode:x:1001:1001::\$HOME_FAKE:/bin/bash"
EOS
sed -i "s|\$HOME_FAKE|$HOME_FAKE|" "$BIN/getent"
cat > "$BIN/sudo" <<EOS
#!/bin/sh
printf '%s\\n' "\$*" >> "$TRACE"
exit 0
EOS
cat > "$BIN/gh" <<EOS
#!/bin/sh
if [ "\$1" = auth ]; then exit 0; fi
case "\$*" in
  *repos/*openchamber-ru/commits/*) echo "$APP_SHA" ;;
  *repos/*my-opencode/commits/*) echo "$CONFIG_SHA" ;;
  *contents/scripts/*) printf '#!/bin/sh\\nexit 0\\n' ;;
  *) echo "unexpected gh: \$*" >&2; exit 91 ;;
esac
EOS
chmod +x "$BIN"/*

PATH="$BIN:$PATH" HOME="$TMP/home" GH_TOKEN='super-secret-token' \
OPENCODE_CONFIG_REF='feature/test-ref' OPENCHAMBER_REF='feature/app-ref' \
  bash "$ROOT/install-openchamber.sh" >"$TMP/out" 2>&1 || { cat "$TMP/out" >&2; fail 'handover script failed'; }

grep -Fq "OPENCODE_CONFIG_REF=$CONFIG_SHA" "$TRACE" || fail 'pinned config SHA not passed'
grep -Fq 'OPENCODE_CONFIG_SOURCE_REF=feature/test-ref' "$TRACE" || fail 'requested config ref lost'
grep -Fq 'OPENCHAMBER_REF=feature/app-ref' "$TRACE" || fail 'requested app ref lost'
grep -Fq 'OPENCHAMBER_SOURCE_REF=feature/app-ref' "$TRACE" || fail 'app source ref lost'
if grep -Fq 'super-secret-token' "$TRACE"; then fail 'token leaked to re-exec argv'; fi
echo 'PASS: sudo handover preserves requested refs, pins SHAs and leaks no token'
