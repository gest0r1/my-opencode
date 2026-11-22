#!/usr/bin/env python3
"""Installed root OpenChamber contract, pinned delivery and independent rollback."""
from pathlib import Path

R=Path(__file__).resolve().parents[1]
read=lambda p:(R/p).read_text()
wrapper=read('install-openchamber.sh')
root=read('scripts/install-openchamber-root.sh')
core=read('scripts/install-openchamber-v2-core.sh')
store=read('scripts/openchamber-runtime-store.sh')
broker=read('scripts/opencode-owner-approvald.py')
ledger=read('scripts/opencode-owner-approval.py')
ocunit=read('config/systemd/openchamber-root.service')
brunit=read('config/systemd/opencode-owner-approval.service')

def req(txt,value):
    assert value in txt, 'missing required installed contract: '+value
def deny(txt,value):
    assert value not in txt, 'unsafe installed contract: '+value

def main():
    for text in (wrapper,root):
        req(text,'CONFIG_SHA="$(gh api')
        req(text,'APP_SHA="$(gh api')
        req(text,'^[a-f0-9]{40}$')
    req(wrapper,'install-openchamber-root.sh?ref=$CONFIG_SHA')
    req(wrapper,'OPENCHAMBER_REF="$APP_SHA"')
    req(wrapper,'OPENCODE_CONFIG_SOURCE_REF="$REQUESTED_CONFIG_REF"')
    req(wrapper,'OPENCHAMBER_SOURCE_REF="$REQUESTED_APP_REF"')
    req(root,'contents/$path?ref=$CONFIG_SHA')
    req(root,'OPENCHAMBER_ROOT_ONLY=1')
    req(root,'install-openchamber-v2-core.sh')
    req(root,'openchamber-runtime-store.sh')
    req(core,'OPENCODE_VERSION="${OPENCODE_INSTALL_VERSION:-2.2.7}"')
    req(core,'EXPECTED_OPENCHAMBER_VERSION="${OPENCHAMBER_EXPECTED_VERSION:-2.7.1}"')
    req(core,'opencode_binary_changed=0')
    req(core,'v2-web-package-$APP_SHA')
    req(core,'package_source_sha')
    req(core,'runtime_fingerprint')
    req(core,'sha256sum -c -')
    req(core,'bun run --cwd packages/web build')
    req(store,'mv -Tf "$link_tmp" "$OPENCHAMBER_CURRENT"')
    req(store,'oc_rollback_activation()')
    req(root,'oc_activate_release')
    req(root,'oc_rollback_activation')
    req(root,'oc_commit_activation')
    req(root,'flock -x 9')
    req(root,'OPENCHAMBER_RESTART_MODE:-auto')
    req(root,'OPENCHAMBER_CUTOVER_QUIESCENT')
    req(root,'PENDING APPLY:')
    req(root,'migration_status')
    req(root,'python3 "$TMP/rekey.py"')
    req(root,'opencode-owner-approval.service')
    req(root,'owner-broker-required')
    req(ocunit,'User=root')
    req(ocunit,'--foreground')
    req(ocunit,'OPENCODE_SKIP_START=true')
    req(ocunit,'NODE_OPTIONS=--require /usr/local/lib/my-opencode/openchamber-child-boundary.cjs')
    req(brunit,'User=root')
    req(broker,'SO_PEERCRED')
    req(ledger,'BEGIN IMMEDIATE')
    req(ledger,"'plan.final_manifest.approve', 'owner.accept'")
    deny(root,'systemctl --user restart opencode-web.service openchamber.service')
    deny(wrapper,'sudo -H -u "$RUNTIME_USER"')
    assert root.index('oc_validate_release "$RELEASE_DIR"') < root.index('oc_activate_release "$RELEASE_DIR"')
    print('PASS: root-owned OpenChamber delivery is SHA-pinned, isolated and rollback-aware')

if __name__=='__main__': main()
