#!/usr/bin/env bash
# Called by the root OpenChamber coordinator after validating system tools.
stage_unified_release() {
  local work=$1 release metadata node_path package_path pkg
  gh release download "v2-web-package-$APP_SHA" --repo "$APP_REPO" --pattern manifest.json --dir "$work" --clobber
  metadata="$(python3 - "$work/manifest.json" "$APP_SHA" "$EXPECTED_OPENCHAMBER_VERSION" <<'PY'
import json, re, sys

with open(sys.argv[1], encoding='utf-8') as stream:
    manifest = json.load(stream)
source = manifest.get('package_source_sha', '')
tag = f'v2-web-package-{source}'
asset = f'openchamber-web-{source}.tgz'
digest = manifest.get('sha256', '')
if (manifest.get('schema_version') != 1 or manifest.get('platform') != 'linux-x64'
        or manifest.get('source_sha') != sys.argv[2] or manifest.get('openchamber_version') != sys.argv[3]
        or not re.fullmatch(r'[a-f0-9]{40}', source) or manifest.get('package_tag') != tag or manifest.get('asset') != asset
        or not re.fullmatch(r'[a-f0-9]{64}', digest) or not re.fullmatch(r'[a-f0-9]{64}', manifest.get('runtime_fingerprint', ''))):
    raise SystemExit('OPENCHAMBER_UNIFIED_PACKAGE_MANIFEST_INVALID')
print(tag, asset, digest)
PY
)" || return 1
  local tag asset digest
  read -r tag asset digest <<< "$metadata"
  release="$OPENCHAMBER_RELEASES/$digest"
  pkg="$release/install/global/node_modules/@openchamber/web"
  if [[ ! -f "$pkg/build/bin/owner-approval.js" ]]; then
    gh release download "$tag" --repo "$APP_REPO" --pattern "$asset" --dir "$work" --clobber
    package_path="$work/$asset"
    printf '%s  %s\n' "$digest" "$package_path" | sha256sum -c - >/dev/null
    release="$(OPENCHAMBER_ROOT_ONLY=1 oc_stage_package "$package_path" "$digest" | tail -n 1)"
    [[ "$release" == "$OPENCHAMBER_RELEASES/$digest" ]] || return 1
  fi
  [[ -f "$pkg/build/bin/owner-approval.js" && -f "$pkg/build/bin/cli.js" && -f "$pkg/build/server/index.js" ]] || {
    echo 'OPENCHAMBER_UNIFIED_PACKAGE_ENTRYPOINT_MISSING' >&2; return 1;
  }
  node_path="$(readlink -f "$(command -v node)")"
  trusted_root_exec "$node_path" || return 1
  python3 - "$release" <<'PY'
import os, stat, sys
from pathlib import Path

release = Path(sys.argv[1])
for folder, dirs, files in os.walk(release, followlinks=False):
    os.chmod(folder, 0o755)
    for name in dirs + files:
        entry = Path(folder) / name
        attributes = entry.lstat()
        if attributes.st_uid != 0:
            raise SystemExit('OPENCHAMBER_RELEASE_OWNER_INVALID')
        if stat.S_ISLNK(attributes.st_mode):
            if not entry.resolve(strict=True).is_relative_to(release):
                raise SystemExit('OPENCHAMBER_RELEASE_SYMLINK_ESCAPE')
        elif stat.S_ISREG(attributes.st_mode):
            entry.chmod(0o755 if attributes.st_mode & stat.S_IXUSR else 0o644)
        elif not stat.S_ISDIR(attributes.st_mode):
            raise SystemExit('OPENCHAMBER_RELEASE_ENTRY_INVALID')
PY
  printf '%s\n' "$release"
}
