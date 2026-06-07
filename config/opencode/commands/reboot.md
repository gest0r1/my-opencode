---
description: Reboot the opencode-web service (stop → 10s → start)
---

Trigger a reboot of the opencode-web systemd service using the reboot marker mechanism.

The script writes a marker file, systemd detects it within ~1 second, and runs:
  stop opencode-web.service → delete reboot-marker → write notification-marker → wait 10s → start opencode-web.service

After the service starts, the plugin sends a "✅ reboot completed" notification to the originating session (if available).

Usage:
  /reboot              — reboot with notification to current session
  /reboot --force-no-notify — reboot without notification

To run from CLI directly:
  ~/Opencode/scripts/opencode-web-reboot/cli/opencode-web-reboot-request
