#!/usr/bin/env python3
"""Static contract tests for the incremental, console-safe V2 installer."""
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
installer = (ROOT / "install-openchamber.sh").read_text()
config_installer = (ROOT / "install.sh").read_text()
cleanup = (ROOT / "scripts/cleanup-openchamber-v1-before-v2.sh").read_text()


def require(text: str, needle: str, label: str):
    assert needle in text, f"missing contract: {label}: {needle}"


def forbid(text: str, needle: str, label: str):
    assert needle not in text, f"forbidden regression: {label}: {needle}"


def main():
    # Network/NPM contract.
    require(installer, 'HOST="', "bind host variable")
    require(installer, '172.18.0.1', "NPM Docker bridge default")
    require(installer, 'OPENCHAMBER_BIND_PORT', "bind port override")
    require(installer, 'wait_for_service()', "readiness helper")
    require(installer, 'for attempt in {1..45}', "bounded startup readiness retry")

    # Incremental OpenCode behavior restored from 1.x.
    require(installer, 'opencode_binary_changed=0', "OpenCode binary decision")
    require(installer, 'config_changed=0', "config decision")
    require(installer, 'OPENCODE_SKIP_BINARY_INSTALL=1', "config-only binary skip")
    require(installer, 'OpenCode binary/config unchanged: downloads skipped', "no-op fast path")
    require(installer, 'FORCE_OPENCODE_UPDATE=1', "explicit OpenCode update")

    # Immutable/fingerprinted OpenChamber package behavior.
    require(installer, 'v2-web-package-$APP_SHA', "exact-SHA package manifest")
    require(installer, 'runtime_fingerprint', "runtime fingerprint validation")
    require(installer, 'package_source_sha', "reused package source SHA")
    require(installer, 'sha256sum -c -', "package integrity verification")
    require(installer, 'release lookup skipped', "unchanged runtime metadata fast path")
    require(installer, 'Using cached verified OpenChamber package', "verified package cache")
    require(installer, 'Using cached staged OpenChamber source package', "staged source cache")
    require(installer, 'bun run --cwd packages/web build', "source fallback remains available")

    # Concurrency and terminal self-preservation.
    require(installer, 'flock -x 9', "installer lock")
    require(installer, 'OPENCHAMBER_EMBEDDED_TERMINAL', "embedded terminal marker")
    require(installer, 'effective_restart_mode=defer', "automatic deferred restart")
    require(installer, '--no-start', "native startup staging without restart")
    require(installer, '--no-env-snapshot', "minimal native startup environment")
    require(installer, 'PENDING APPLY: current OpenChamber terminal was preserved.', "safe handoff")
    require(installer, 'runtime_pending=', "separate runtime pending state")
    require(installer, 'service_restart_pending=', "separate service pending state")

    # Startup environment must not persist build/session-local plugin paths.
    require(installer, 'sanitize_native_startup_env()', "startup env sanitizer")
    require(installer, 'removed transient/session variables', "sanitizer audit output")
    require(installer, 'OPENCHAMBER_UI_PASSWORD', "password preservation")
    require(installer, 'OPENCHAMBER_DATA_DIR', "data-dir preservation")

    # One-time legacy cleanup must remove active duplicate lookup roots while
    # retaining a rollback copy outside OpenCode discovery.
    require(cleanup, 'preserve_ui_password_only', "password-only migration")
    require(cleanup, 'rm -f -- "$NATIVE_STARTUP_ENV"', "old startup snapshot removal")
    require(cleanup, 'LEGACY_PLUGIN_ROOT="$HOME/.config/opencode/plugin"', "singular plugin root")
    require(cleanup, 'PLUGIN_ROOT="$HOME/.config/opencode/plugins"', "plural plugin root")
    require(cleanup, 'archive_lookup_root "$PLUGIN_ROOT"', "plugin root retirement")
    require(cleanup, 'archive_lookup_root "$LEGACY_PLUGIN_ROOT"', "legacy plugin root retirement")
    require(cleanup, 'LEGACY_SKILL_ROOTS=(', "legacy global skill roots")
    require(cleanup, '$HOME/.opencode/skills', "legacy plural global skill root")
    require(cleanup, '$HOME/.opencode/skill', "legacy singular global skill root")
    require(cleanup, 'LEGACY_COMMAND_ROOT="$HOME/.config/opencode/command"', "legacy singular command root")
    require(cleanup, 'LEGACY_TOOL_ROOT="$HOME/.config/opencode/tool"', "legacy singular tool root")
    require(cleanup, 'archive_lookup_root "$LEGACY_TOOL_ROOT"', "legacy tool root retirement")
    require(cleanup, 'OPENCHAMBER_CLEANUP_RUNTIME_MODE', "console-safe cleanup mode")
    require(cleanup, 'local pid="$$"', "cleanup process ancestry starts from current shell PID")
    forbid(cleanup, 'local pid="$"', "broken embedded-terminal PID detection")

    # Canonical OpenCode locations and atomic managed-config replacement.
    require(config_installer, 'CONFIG_HOME="$HOME/.config/opencode"', "canonical config root")
    require(config_installer, 'mkdir -p "$STAGE_CONFIG/agents"', "canonical plural agent path")
    require(config_installer, '"$STAGE_CONFIG/commands"', "canonical plural command path")
    require(config_installer, 'agent|command|tool) continue', "legacy source roots remapped")
    require(config_installer, 'legacy singular command path still active', "legacy command invariant")
    require(config_installer, 'STAGE_CONFIG=', "staged config tree")
    require(config_installer, 'mv "$STAGE_CONFIG" "$CONFIG_HOME"', "atomic config commit")
    require(config_installer, 'rollback_transaction()', "atomic config rollback")
    require(config_installer, 'rollback_binary()', "OpenCode binary rollback")
    require(config_installer, 'BINARY_BACKUP=', "OpenCode binary backup")
    require(config_installer, 'INSTALL_TRANSACTION_COMMITTED=1', "generation commit marker")
    assert config_installer.index('pipeline-runtime.ts is not a valid OpenCode V2 Plugin.define export') < \
        config_installer.index('https://opencode.ai/v2/install'), \
        "plugin validation must happen before OpenCode binary replacement"
    require(config_installer, 'bun install --production', "local plugin dependency install")
    require(config_installer, 'pipeline-runtime.ts is not a valid OpenCode V2 Plugin.define export',
            "plugin entrypoint validation")
    require(config_installer, 'github_handoff.ts did not export any custom tool definitions',
            "custom tool import validation")
    require(config_installer, 'shell-strategy must not live under plugins/ in V2',
            "retired plugin location rejection")
    require(config_installer, 'global AGENTS.md missing from staged OpenCode V2 config',
            "V2 active global instructions")
    require(config_installer, 'OpenCode V2 does not load config.instructions; use global AGENTS.md',
            "inactive V2 instructions rejection")
    require(config_installer, 'OPENCODE_SKIP_BINARY_INSTALL', "config-only install support")
    forbid(config_installer, 'Legacy agent directories were retained for rollback.',
           "active legacy agent roots must not remain")

    print("PASS: V2 installer contract is incremental, console-safe, and legacy-clean")


if __name__ == "__main__":
    main()
