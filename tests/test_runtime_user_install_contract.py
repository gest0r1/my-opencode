#!/usr/bin/env python3
"""Canonical permanent runtime identities after P1 root OpenChamber split."""
from pathlib import Path

ROOT=Path(__file__).resolve().parents[1]
def src(name): return (ROOT/name).read_text()
provision=src('scripts/provision-runtime-user.sh')
config_installer=src('install.sh')
wrapper=src('install-openchamber.sh')
coordinator=src('scripts/install-openchamber-root.sh')
oc_unit=src('config/systemd/openchamber-root.service')
ocweb_unit=src('config/systemd/opencode-web.service')
broker_unit=src('config/systemd/opencode-owner-approval.service')
core=src('scripts/install-openchamber-v2-core.sh')
child=src('scripts/openchamber-child-boundary.cjs')
rekey=src('scripts/rekey-openchamber-ui.py')

def require(text, value): assert value in text, 'missing: '+value
def forbid(text, value): assert value not in text, 'forbidden: '+value

def main():
    require(provision,'useradd --create-home --shell /bin/bash opencode')
    require(config_installer,'OPENCODE_INSTALL_VERSION:-2.3.2')
    require(config_installer,'loginctl enable-linger "$RUNTIME_USER"')
    require(config_installer,'sudo -H -u "$RUNTIME_USER" env -i')
    require(ocweb_unit,'opencode serve --port ${OPENCODE_WEB_PORT} --hostname 127.0.0.1')
    forbid(ocweb_unit,'0.0.0.0')
    require(wrapper,'[[ $EUID == 0 ]]')
    require(wrapper,'install-openchamber-unified.sh?ref=$CONFIG_SHA')
    forbid(wrapper,'sudo -H -u "$RUNTIME_USER"')
    require(coordinator,'OPENCODE_USER=opencode')
    require(coordinator,'OPENCODE_CONFIG_REF="$CONFIG_SHA"')
    require(coordinator,'OPENCHAMBER_ROOT_ONLY=1')
    require(coordinator,'OPENCODE_BINARY=/usr/local/lib/my-opencode/opencode-unpriv-wrapper.sh')
    require(coordinator,'python3 "$TMP/migrate.py" stage --source "$OLD_OC_DATA_DIR" --quiescent yes')
    require(coordinator,'python3 "$TMP/rekey.py"')
    require(coordinator,'chmod 711 /etc/my-opencode')
    require(coordinator,'OPENCHAMBER_DATA_MIGRATION_UNSUPPORTED')
    require(coordinator,'OPENCHAMBER_PACKAGE_MODE=release')
    require(coordinator,'systemctl restart openchamber.service')
    require(coordinator,'install -o root -g root -m 644 /dev/null /etc/my-opencode/owner-broker-required')
    require(core,'OPENCHAMBER_ROOT_ONLY')
    require(oc_unit,'User=root')
    require(oc_unit,'OPENCODE_SKIP_START=true')
    require(oc_unit,'openchamber-child-boundary.cjs')
    # The root UI must traverse existing 0700 opencode project and Chats paths;
    # child processes and ambient caps must never inherit DAC override.
    require(oc_unit,'CapabilityBoundingSet=CAP_SETUID CAP_SETGID CAP_DAC_OVERRIDE CAP_CHOWN')
    require(oc_unit,'AmbientCapabilities=CAP_SETUID CAP_SETGID')
    forbid(oc_unit,'AmbientCapabilities=CAP_SETUID CAP_SETGID CAP_DAC_OVERRIDE')
    require(oc_unit,'NoNewPrivileges=true')
    require(broker_unit,'User=root')
    require(broker_unit,'ExecStart=/usr/bin/python3 /usr/local/lib/my-opencode/opencode-owner-approvald.py')
    require(child,'OPENCHAMBER_EXECUTION_UID')
    require(child,'uid, gid')
    require(rekey,'existing_ui_sessions_revoked')
    forbidden=('migrate-root-runtime-to-opencode.sh','migrate-runtime-state.py',
               'finalize-runtime-migration.py','opencode-runtime-cutover',
               'root-state-sync.pending','legacy-stop','legacy-restore','legacy-commit')
    for text in (provision,config_installer,wrapper,coordinator):
        for needle in forbidden: forbid(text,needle)
    print('PASS: OpenCode remains opencode, OpenChamber and P1 broker are root-owned')

if __name__=='__main__': main()
