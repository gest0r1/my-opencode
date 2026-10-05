#!/usr/bin/env python3
"""Static regression contract for the dedicated opencode runtime user."""
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
migration = (ROOT / "scripts/migrate-root-runtime-to-opencode.sh").read_text()
setup = (ROOT / "scripts/setup-opencode-package-sudo.sh").read_text()
config_installer = (ROOT / "install.sh").read_text()
combined_installer = (ROOT / "install-openchamber.sh").read_text()


def require(text: str, needle: str):
    assert needle in text, f"missing contract: {needle}"


def forbid(text: str, needle: str):
    assert needle not in text, f"forbidden regression: {needle}"


def main():
    # Migration must never kill the console/runtime that launched it.
    require(migration, "services were NOT stopped or disabled")
    forbid(migration, "ROOT_USER_ENV=")
    forbid(migration, 'systemctl --user stop "$unit"')
    forbid(migration, "Do not migrate from the embedded OpenChamber terminal")

    # Both public installers accept a sudo-capable caller and switch themselves
    # into the dedicated runtime user's HOME/user-manager.
    for installer in (config_installer, combined_installer):
        require(installer, 'sudo -v')
        require(installer, 'Switching installer runtime:')
        require(installer, 'sudo -H -u "$RUNTIME_USER" env')
        require(installer, 'loginctl enable-linger "$RUNTIME_USER"')
        forbid(installer, 'Use: sudo -iu $RUNTIME_USER')

    # OpenCode and OpenChamber must both survive reboot under user opencode.
    require(config_installer, 'systemctl --user enable opencode-web.service')
    require(combined_installer, 'systemctl --user is-enabled --quiet opencode-web.service')
    require(combined_installer, 'systemctl --user is-enabled --quiet openchamber.service')

    # Root legacy services are touched only at final activation and are
    # restorable until the new user services pass readiness.
    require(setup, 'opencode-runtime-cutover')
    require(setup, 'legacy-stop')
    require(setup, 'legacy-restore')
    require(setup, 'legacy-commit')
    require(combined_installer, 'opencode-runtime-cutover legacy-stop')
    require(combined_installer, 'opencode-runtime-cutover legacy-restore')
    require(combined_installer, 'opencode-runtime-cutover legacy-commit')

    print("PASS: runtime-user migration/install contract")


if __name__ == "__main__":
    main()
