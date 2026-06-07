# opencode-web-reboot

Self-restart `opencode-web` (the systemd-managed OpenCode web server) and notify the originating LLM session when the reboot is complete. Triggered by a marker file picked up by a systemd path unit, the reboot itself runs in a one-shot service, and a bundled OpenCode plugin sends the "✅ reboot completed" reply to whichever session asked for it.

## What it does

A LLM (or a shell user) wants `opencode-web` to come back fresh — it's stuck, slow, or refusing new prompts. Calling the `reboot_opencode_web` tool (or running `opencode-web-reboot-request` from the shell) writes a small JSON marker to `~/.config/opencode-web/reboot-marker.json`. Within ~1 second, a systemd path unit notices the marker, fires a one-shot service that runs `reboot.py` (stop → 10s wait → start), and on the next `opencode-web` startup the plugin reads the marker and posts a completion message back to the session that asked for the reboot.

## Architecture

```
┌────────────────────┐
│  LLM (or shell)    │
│  calls tool/CLI    │
└─────────┬──────────┘
          │ writes
          ▼
┌────────────────────────────────────┐
│ ~/.config/opencode-web/            │
│   reboot-marker.json               │
│     {request_id, session_id, ts}   │
└─────────┬──────────────────────────┘
          │ PathExists triggers
          ▼
┌────────────────────────────────────┐
│ opencode-web-reboot.path           │
│ → opencode-web-reboot.service      │
│   → python3 reboot.py              │
│     • systemctl --user stop ...    │
│     • sleep 10s                    │
│     • systemctl --user start ...   │
└─────────┬──────────────────────────┘
          │ opencode-web restarts
          ▼
┌────────────────────────────────────┐
│ opencode plugin (init)             │
│   reads marker                     │
│   sends "✅ reboot completed"      │
│   via POST /session/:id/prompt_async│
│   deletes marker                   │
└────────────────────────────────────┘
```

## Install

```bash
cd /home/guber/Opencode/scripts/opencode-web-reboot
bash install.sh
```

The installer is idempotent — safe to re-run. It also removes v1 leftovers if any are present (template service, two old path units, stale plugin symlink).

After install, the path unit should report `active (waiting)`. If it does, dropping a marker into `~/.config/opencode-web/reboot-marker.json` will fire the service within ~1 second.

## Uninstall

```bash
bash uninstall.sh
```

Stops and disables the path unit, removes the unit files, the plugin symlink, and the CLI. **Does not** remove `reboot-marker.json` — if a reboot is pending, the file is needed. Delete it manually if stale.

## Usage

### From the LLM (in OpenCode)

The plugin exposes one tool: `reboot_opencode_web`. Call it; the tool returns the new `request_id` and explains the upcoming notification. Within ~30 seconds you should see a `✅ opencode-web reboot completed` message land in your session.

Pass `force_no_notify: true` if you want the reboot to happen silently.

### From the shell

```bash
opencode-web-reboot-request                          # uses $OPENCODE_SESSION if set
opencode-web-reboot-request --session-id ses_abc     # explicit session id
opencode-web-reboot-request --force-no-notify        # no notification
opencode-web-reboot-request --dry-run                # safe test, writes to /tmp
opencode-web-reboot-request --help                   # full options
```

## Testing

```bash
cd /home/guber/Opencode/scripts/opencode-web-reboot
bash tests/run_tests.sh
```

15 tests cover `read_marker`, `systemd_cmd` (success / CalledProcessError / TimeoutExpired / DRY_RUN), and `main()` (full success, missing marker, stop fails, start fails, DRY_RUN, and the stop→sleep→start call order). The full suite runs in ~0.08s.

## Troubleshooting

### Linger is disabled

If `loginctl show-user $USER` shows `Linger=no`, the path unit only runs while you're logged in. Reboots triggered while logged out will not fire until the next login. To make the trigger survive logout:

```bash
sudo loginctl enable-linger $USER
```

### Marker stuck (no reboot happens)

Inspect:

```bash
cat ~/.config/opencode-web/reboot-marker.json
```

If the file is old and stale (e.g. the reboot already happened in a prior session), just delete it:

```bash
rm ~/.config/opencode-web/reboot-marker.json
```

If the JSON is corrupt, the plugin will move it to `reboot-marker.json.corrupt-<unix_ts>` on next opencode start.

### Plugin not loading

Check that the path is registered:

```bash
grep web-reboot ~/.config/opencode/opencode.json
# should show:    "./plugins/opencode-web-reboot"
```

Check the symlink:

```bash
ls -la ~/.config/opencode/plugins/opencode-web-reboot
# should resolve to: /home/guber/Opencode/scripts/opencode-web-reboot/plugin
```

If the symlink is missing, run `bash install.sh` again — it will recreate it.

### No notification arriving

```bash
cat ~/.config/opencode-web/plugin.log
```

Look for `ERROR` lines. The plugin also records every processed `request_id` in `~/.config/opencode-web/last-processed-request` — if your `request_id` is already there, the plugin silently dropped the marker as a duplicate. Use a fresh request (the CLI generates a new uuid4 each run).

### Reboot never happens (path unit is dead)

```bash
systemctl --user status opencode-web-reboot.path
# expected: active (waiting)
```

If it's failed or inactive:

```bash
systemctl --user restart opencode-web-reboot.path
journalctl --user -u opencode-web-reboot.service -n 50
```

The service's own log lives at `~/.config/opencode-web/reboot.log`.

## Lessons learned from v1

v1 used a template `opencode-web-reboot@.service` plus **two** separate path units: `opencode-web-reboot-stop.path` and `opencode-web-reboot-start.path`, each watching the same `reboot-marker.json`. The intent was that `stop.path` would fire the `stop` instance and `start.path` would fire the `start` instance, with the marker file persisting between the two events.

The reality: **both path units fired on the same file appearance**. systemd scheduled both jobs against the same `opencode-web.service` unit within a few milliseconds. The second job's `systemctl stop` collided with the first job's in-flight `systemctl start`, producing cascading `Job canceled` errors. The marker was never cleared, the path units kept re-firing, and the whole loop wedged the user's opencode session.

v2 collapses the two phases into one: a single `opencode-web-reboot.service` (oneshot) that runs `reboot.py` (which does `stop` → 10s sleep → `start` internally), and a single `opencode-web-reboot.path` that fires it. The path unit can only fire the one service, so there is no cascade to race.

Any v1 entries in `~/.config/opencode-web/reboot.log` timestamped before 2026-06-07 are the original disaster — the `Job canceled` lines are the smoking gun.

## Files

```
opencode-web-reboot/
├── reboot.py              # stop + 10s + start (DRY_RUN aware, 15-test covered)
├── reboot_helpers.py      # marker write/read/consume/quarantine/ledger
├── install.sh             # idempotent installer
├── uninstall.sh           # reverses install
├── units/
│   ├── opencode-web-reboot.service   # oneshot, fires reboot.py
│   └── opencode-web-reboot.path      # PathExists → service
├── cli/
│   └── opencode-web-reboot-request   # shell-friendly trigger
├── plugin/
│   ├── package.json
│   └── index.js                       # init() reads marker, tool boots reboot
├── tests/
│   ├── conftest.py
│   ├── test_main.py                   # 6 tests
│   ├── test_read_marker.py            # 5 tests
│   ├── test_systemd_cmd.py            # 4 tests
│   └── run_tests.sh
└── README.md
```
