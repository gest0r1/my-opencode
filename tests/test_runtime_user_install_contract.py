#!/usr/bin/env python3
"""Static regression contract for the permanent opencode runtime installation."""
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
setup = (ROOT / "scripts/setup-opencode-package-sudo.sh").read_text()
provision = (ROOT / "scripts/provision-runtime-user.sh").read_text()
config_installer = (ROOT / "install.sh").read_text()
combined_installer = (ROOT / "install-openchamber.sh").read_text()
core = (ROOT / "scripts/install-openchamber-v2-core.sh").read_text()


def require(text: str, needle: str):
    assert needle in text, f"missing contract: {needle}"


def forbid(text: str, needle: str):
    assert needle not in text, f"forbidden regression: {needle}"


def main():
    require(provision, 'if ! id opencode >/dev/null 2>&1; then useradd --create-home --shell /bin/bash opencode; fi')
    require(provision, 'setup-opencode-package-sudo.sh')
    require(setup, 'opencode-install-packages')

    forbidden = (
        'migrate-root-runtime-to-opencode.sh',
        'migrate-runtime-state.py',
        'finalize-runtime-migration.py',
        'opencode-runtime-cutover',
        'root-state-sync.pending',
        'migration-plan',
        'legacy-stop',
        'legacy-restore',
        'legacy-commit',
    )
    for text in (setup, provision, config_installer, combined_installer):
        for needle in forbidden:
            forbid(text, needle)

    for installer in (config_installer, combined_installer):
        require(installer, 'sudo -v')
        require(installer, 'Switching installer runtime:')
        require(installer, 'sudo -H -u "$RUNTIME_USER" env -i')
        require(installer, 'loginctl enable-linger "$RUNTIME_USER"')
        require(installer, 'bash -c \'cd "$HOME"; exec bash "$@"\'')
        require(installer, 'XDG_RUNTIME_DIR="/run/user/$runtime_uid"')
        require(installer, 'XDG_CONFIG_HOME="$HOME/.config"')

    require(config_installer, 'OPENCODE_INSTALL_VERSION:-2.0.27')
    require(config_installer, 'contents/config/systemd/opencode-web.service?ref=$CONFIG_SHA')
    unit = (ROOT / 'config/systemd/opencode-web.service').read_text()
    require(unit, 'opencode serve --port ${OPENCODE_WEB_PORT} --hostname 127.0.0.1')
    forbid(unit, '0.0.0.0')
    require(config_installer, 'systemctl --user enable opencode-web.service')
    require(config_installer, 'ensure_claude_cli')
    require(config_installer, 'configure_server_browser')

    require(combined_installer, 'OPENCHAMBER_EXPECTED_VERSION:-2.3.1')
    # --no-env-snapshot keeps OPENCODE_BINARY out of startup.env; the managed binary is pinned in the drop-in.
    require(combined_installer, 'Environment="OPENCODE_BINARY=$OPENCODE_BINARY"')
    require(combined_installer, 'systemctl --user is-enabled --quiet opencode-web.service')
    require(combined_installer, 'systemctl --user is-enabled --quiet openchamber.service')
    require(combined_installer, 'systemctl --user restart opencode-web.service openchamber.service')
    require(combined_installer, 'configure_server_browser')

    require(core, 'OPENCHAMBER_EMBEDDED_TERMINAL')
    require(core, 'effective_restart_mode=defer')

    print("PASS: permanent runtime-user install contract")


if __name__ == "__main__":
    main()

