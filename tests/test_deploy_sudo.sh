#!/usr/bin/env bash
# Verify the exact managed dev clone, fixed arguments, and unprivileged child process.
set -Eeuo pipefail
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
if [[ "$EUID" != 0 ]]; then echo 'SKIP: test_deploy_sudo needs root'; exit 0; fi
id opencode >/dev/null 2>&1 || useradd --system --no-create-home opencode
tmp="$(mktemp -d)"; trap 'rm -rf -- "$tmp"' EXIT
chmod 755 "$tmp"
OPENCODE_SUDO_PREFIX="$tmp/prefix" bash "$ROOT/scripts/setup-opencode-deploy-sudo.sh" >/dev/null
helper="$tmp/prefix/usr/local/sbin/opencode-deploy-target"
grep -Fq "opencode ALL=(root) NOPASSWD: $helper" "$tmp/prefix/etc/sudoers.d/opencode-deploy-opencode"
"$helper" --check | grep -Fq READY

git init -q --bare -b main "$tmp/origin.git"
git init -q -b main "$tmp/work"; git -C "$tmp/work" remote add origin "$tmp/origin.git"
git -C "$tmp/work" config user.email t@example.invalid; git -C "$tmp/work" config user.name T
cat > "$tmp/work/install.sh" <<'SH'
#!/usr/bin/env bash
if [[ "$1" == status ]]; then printf '{"version":"0.6.5","sha":"%s"}\n' "$(git rev-parse HEAD)"; exit 0; fi
[[ "$(id -un)" == opencode-dev && "$(awk '/^NoNewPrivs:/ { print $2 }' /proc/self/status)" == 1 ]] || exit 97
printf '%s\n' "$*" > .fixture-install
[[ "$*" != *fail* ]]
SH
git -C "$tmp/work" add install.sh; git -C "$tmp/work" commit -qm v1; git -C "$tmp/work" tag v0.6.5
git -C "$tmp/work" push -q origin main --tags
sha="$(git -C "$tmp/work" rev-parse HEAD)"
chown -R opencode-dev:opencode-dev "$tmp/origin.git"
repo="$tmp/prefix/var/lib/opencode-dev/targets/svd1"
install -d -o opencode-dev -g opencode-dev -m 700 "$(dirname "$repo")"
runuser -u opencode-dev -- git clone -q --no-local "$tmp/origin.git" "$repo"
conf="$tmp/prefix/etc/opencode/deploy-targets/svd1.conf"
printf 'REPO_DIR=%s\nINSTALLER=install.sh\nARGS=update --target dev --dev-key svd1\nVERSION_FLAG=--version\nSTATUS_ARGS=status --target dev --dev-key svd1 --json\n' "$repo" > "$conf"
chmod 644 "$conf"
"$helper" --check-isolation | grep -Fxq 'Dev deploy isolation: opencode-dev'

"$helper" svd1 "$sha" 2>/dev/null
[[ "$(cat "$repo/.fixture-install")" == "update --target dev --dev-key svd1 --version $sha" ]]
[[ "$(stat -c %U "$repo/.fixture-install")" == opencode-dev ]]
# The outcome is recorded for the pipeline, world-readable, with the installer status of that commit.
state="$tmp/prefix/var/lib/opencode/deploy-targets"
grep -Fq "\"sha\":\"$sha\",\"exit_code\":0" "$state/svd1.json"
grep -Fq "\"sha\":\"$sha\"" "$state/svd1.status.json"
[[ "$(stat -c %a "$state/svd1.json")" == 644 ]]
[[ "$(stat -c %U "$state/svd1.json")" == root ]]
"$helper" svd1 v0.6.5 2>/dev/null
[[ "$(cat "$repo/.fixture-install")" == "update --target dev --dev-key svd1 --version v0.6.5" ]]
# A failing install is recorded with its exit code and no status.
printf 'REPO_DIR=%s\nINSTALLER=install.sh\nARGS=update --fail\nSTATUS_ARGS=status --json\n' "$repo" > "$conf"
if "$helper" svd1 "$sha" 2>/dev/null; then echo 'failed install reported success' >&2; exit 1; fi
grep -Fq '"exit_code":1' "$state/svd1.json"; grep -Fq '"status_file":null' "$state/svd1.json"
printf 'REPO_DIR=%s\nINSTALLER=install.sh\nARGS=update --target dev --dev-key svd1\nVERSION_FLAG=--version\n' "$repo" > "$conf"

fails() { if "$helper" "$@" >/dev/null 2>&1; then echo "accepted: $*" >&2; exit 1; fi; }
fails svd1 'main'
fails svd1 "$sha; rm -rf /"
fails ../svd1 "$sha"
fails other "$sha"
fails svd1 "$(printf '%040d' 0)"
fails svd1 v0.6.5-rc.1
chmod 666 "$conf"; fails svd1 "$sha"; chmod 644 "$conf"
printf 'REPO_DIR=%s\nINSTALLER=install.sh\nARGS=update $(id)\n' "$repo" > "$conf"; fails svd1 "$sha"
printf 'REPO_DIR=%s\nINSTALLER=install.sh\n' "$tmp/work" > "$conf"; fails --check-isolation; fails svd1 "$sha"
echo 'PASS: fixed dev deployment, root-owned result and unprivileged candidate execution'
