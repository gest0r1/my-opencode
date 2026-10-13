# OpenCode upgrade procedure

This distribution serves one already-migrated user. The first v1 migration and
custom reboot/Scheduler implementations are retired. Keep compatibility that is
still present in OpenChamber upstream; remove local migration-only branches when
their replacement is already in use. Existing sessions and credentials stay on
disk.

Before merging upstream or upgrading OpenCode:

1. Read the OpenChamber `.agents/skills/opencode-v2/SKILL.md` and compare the
   upstream changes to the current pin, including API, events and plugin hooks.
2. Choose one compatible OpenCode version for both repositories. Confirm the
   CLI, client, schema, protocol and plugin packages exist for that version.
3. In this repository, move the defaults in `install.sh`, `install-openchamber.sh`,
   `scripts/install-opencode-generation.sh` and
   `scripts/install-openchamber-v2-core.sh`, plus
   `config/opencode/package.json` and the README versions, together. When the
   OpenChamber RU release changes, move `OPENCHAMBER_EXPECTED_VERSION` in
   `install-openchamber.sh` (the single source) and the copies the pin check names. Regenerate the plugin lockfile with
   Bun; never change a package version while retaining its old integrity hash.
4. In OpenChamber, update the manifests, Electron CLI pin, Docker CLI and
   lockfile as required by its canonical OpenCode skill. The minimum supported
   version is a capability floor, not a pin: raise it only when a consumed API
   requires that change.
5. Run `node scripts/check-opencode-pins.mjs --openchamber /path/to/openchamber-ru`
   here and the OpenChamber checks required by its skill. Check the updated
   native plugin exports/hooks, frozen dependency installation and affected
   builds. Report actual results and any untested surfaces.

The two local pin checks also run in existing CI workflows. They detect drift
within each repository; the cross-repository command above detects different
pins between repositories. CI does not silently select or upgrade a version.
