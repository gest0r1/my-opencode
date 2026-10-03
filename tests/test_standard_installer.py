#!/usr/bin/env python3
"""Static contracts for the incremental OpenCode/OpenChamber V2 installer."""
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
wrapper = (ROOT / "install-openchamber.sh").read_text()
core = (ROOT / "scripts/install-openchamber-v2-core.sh").read_text()
runtime_store = (ROOT / "scripts/openchamber-runtime-store.sh").read_text()
config_bootstrap = (ROOT / "install.sh").read_text()
config_generation = (ROOT / "scripts/install-opencode-generation.sh").read_text()
cleanup = (ROOT / "scripts/cleanup-openchamber-v1-before-v2.sh").read_text()
installer = wrapper + "\n" + core
config_installer = config_bootstrap + "\n" + config_generation


def require(text: str, needle: str, label: str):
    assert needle in text, f"missing contract: {label}: {needle}"


def forbid(text: str, needle: str, label: str):
    assert needle not in text, f"forbidden regression: {label}: {needle}"


def main():
    # Version/network contract.
    require(core, 'OPENCODE_VERSION="${OPENCODE_INSTALL_VERSION:-2.0.21}"', "OpenCode pin")
    require(core, 'EXPECTED_OPENCHAMBER_VERSION="${OPENCHAMBER_EXPECTED_VERSION:-2.1.0}"',
            "OpenChamber pin")
    require(core, 'HOST="${OPENCHAMBER_BIND_HOST:-172.18.0.1}"', "NPM bridge default")
    require(core, 'PORT="${OPENCHAMBER_BIND_PORT:-3000}"', "default port")
    require(core, 'for attempt in {1..45}', "bounded readiness retry")
    forbid(installer, '2.0.22', "unapproved OpenCode version bump")

    # Outer transaction resolves branch refs once and all children use immutable SHAs.
    require(wrapper, 'CONFIG_SHA="$(gh api "repos/$CONFIG_REPO/commits/$CONFIG_REF" --jq .sha)"',
            "exact config SHA resolution")
    require(wrapper, 'APP_SHA="$(gh api "repos/$APP_REPO/commits/$APP_REF" --jq .sha)"',
            "exact OpenChamber SHA resolution")
    require(wrapper, 'install-openchamber-v2-core.sh?ref=$CONFIG_SHA', "exact core fetch")
    require(wrapper, 'openchamber-runtime-store.sh?ref=$CONFIG_SHA', "exact runtime helper fetch")
    require(wrapper, 'export OPENCODE_CONFIG_REF="$CONFIG_SHA"', "pinned config ref")
    require(wrapper, 'export OPENCHAMBER_REF="$APP_SHA"', "pinned app ref")
    assert wrapper.index('export OPENCHAMBER_REF="$APP_SHA"') < wrapper.index('bash +h "$CORE"')

    # 1.x-style independent incremental decisions.
    require(core, 'opencode_binary_changed=0', "OpenCode binary decision")
    forbid(core, 'GENERATION_RECEIPT=', 'no fingerprint config skip')
    require(core, 'OPENCODE_SKIP_BINARY_INSTALL=1', "config-only binary skip")
    require(core, 'Config-only update:', 'always refresh config')
    require(core, 'v2-web-package-$APP_SHA', "exact-SHA OpenChamber manifest")
    require(core, 'runtime_fingerprint', "runtime fingerprint")
    require(core, 'package_source_sha', "reusable package source")
    require(core, 'OpenChamber source/runtime metadata unchanged: release lookup skipped',
            "manifest lookup fast path")
    require(core, 'OpenChamber runtime fingerprint/package unchanged: package download skipped',
            "runtime package fast path")
    require(core, 'Using cached verified OpenChamber package', "verified package cache")
    require(core, 'sha256sum -c -', "package integrity")
    require(core, 'bun run --cwd packages/web build', "explicit source fallback")

    # Always refresh settings; unchanged binary remains independently reusable.
    require(config_bootstrap, 'GENERATION_PATH="scripts/install-opencode-generation.sh"', 'generation installer split')
    require(config_bootstrap, 'export OPENCODE_SKIP_BINARY_INSTALL=1', 'unchanged binary skip')
    require(config_bootstrap, 'contents/$GENERATION_PATH?ref=$CONFIG_SHA', 'exact generation fetch')
    forbid(config_bootstrap, 'generation_unchanged=', 'no fingerprint config skip')

    # Full generation installer remains the standalone/config-change path.
    require(config_generation, 'CONFIG_HOME="$HOME/.config/opencode"', "canonical config root")
    require(config_generation, 'mkdir -p "$STAGE_CONFIG/agents"', "canonical plural agents")
    require(config_generation, '"$STAGE_CONFIG/commands"', "canonical plural commands")
    require(config_generation, 'OPENCODE_SKIP_BINARY_INSTALL', "config-only support")
    require(config_generation, 'https://opencode.ai/v2/install', "full install official binary path")
    require(config_generation, 'rollback_transaction()', "config rollback")
    require(config_generation, 'rollback_binary()', "full-install binary rollback")
    require(config_generation, 'mv "$STAGE_CONFIG" "$CONFIG_HOME"', "atomic config commit")
    require(config_generation, 'install-opencode-dependencies.sh', 'bounded locked dependencies')
    require(config_generation, 'pipeline-runtime.ts is not a valid OpenCode V2 Plugin.define export',
            "plugin validation")
    require(config_generation, 'github-handoff.ts is not a native V2 plugin',
            "custom tool validation")
    require(config_generation, 'OpenCode V2 does not load config.instructions; use global AGENTS.md',
            "V2 instruction contract")
    require(config_generation, 'legacy singular command path still active', "legacy command rejection")

    # Atomic runtime/service transaction and self-preserving embedded-terminal mode.
    require(wrapper, 'TRANSACTION_LOCK="$STATE_ROOT/openchamber-v2-atomic.lock"',
            "outer transaction lock")
    require(wrapper, 'flock -x 8', "outer serialization")
    require(core, 'flock -x 9', "core lock")
    require(core, 'OPENCHAMBER_EMBEDDED_TERMINAL', "embedded terminal marker")
    require(core, 'effective_restart_mode=defer', "self-preserving defer")
    require(core, '--no-start', "deferred unit staging")
    require(core, 'PENDING APPLY: current OpenChamber terminal was preserved.', "pending apply handoff")
    require(wrapper, 'oc_snapshot_service', "service snapshot")
    require(wrapper, 'oc_rollback_service', "service rollback")
    require(wrapper, 'oc_activate_release', "runtime activation")
    require(wrapper, 'TRANSACTION_COMMITTED=1', "commit boundary")
    require(wrapper, 'oc_prune_releases', "bounded runtime retention")

    require(runtime_store, 'OPENCHAMBER_RELEASES="$OPENCHAMBER_RUNTIME_ROOT/releases"',
            "immutable releases root")
    require(runtime_store, 'OPENCHAMBER_CURRENT="$OPENCHAMBER_RUNTIME_ROOT/current"',
            "current symlink")
    require(runtime_store, 'mv -Tf "$link_tmp" "$OPENCHAMBER_CURRENT"', "atomic current publish")
    require(runtime_store, 'oc_rollback_activation()', "runtime rollback")
    require(runtime_store, 'oc_remove_legacy_bun_global()', "post-commit legacy Bun retirement")

    # Migration cleanup remains explicit/separate and keeps credentials/rollback source.
    require(cleanup, 'preserve_ui_password_only', "UI password migration")
    require(cleanup, 'OPENCHAMBER_CLEANUP_RUNTIME_MODE', "console-safe cleanup mode")
    require(cleanup, 'LEGACY_AGENT_ROOTS=(', "legacy agents")
    require(cleanup, 'LEGACY_SKILL_ROOTS=(', "legacy skills")
    require(cleanup, 'archive_lookup_root "$PLUGIN_ROOT"', "plugin lookup retirement")
    require(cleanup, 'archive_lookup_root "$LEGACY_TOOL_ROOT"', "tool lookup retirement")
    require(cleanup, 'retained as rollback source until atomic commit', "rollback source retention")
    forbid(cleanup, 'bun remove -g @openchamber/web', "pre-migration runtime destruction")

    print("PASS: V2 installer contract is incremental, ref-pinned, atomic and migration-safe")


if __name__ == "__main__":
    main()

