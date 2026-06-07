// opencode-web-reboot — plugin index (v1.16.2 API)
// Notifies the originating session when opencode-web is rebooted via marker.
// Uses a two-marker protocol:
//   reboot-marker.json   — triggers systemd path unit → reboot.py
//   notification-marker.json — written by reboot.py after stop, read by plugin on next start

import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { existsSync, appendFileSync, mkdirSync, unlinkSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";
import { tool } from "@opencode-ai/plugin";

const execFileP = promisify(execFile);

const CONFIG_DIR = join(homedir(), ".config", "opencode-web");
const MARKER_PATH = join(CONFIG_DIR, "reboot-marker.json");
const NOTIFICATION_MARKER_PATH = join(CONFIG_DIR, "notification-marker.json");
const PLUGIN_LOG = join(CONFIG_DIR, "plugin.log");
const HELPERS_PY = join(homedir(), "Opencode", "scripts", "opencode-web-reboot", "reboot_helpers.py");

// --- logging ---
function log(level, msg) {
  const line = `[${new Date().toISOString()}] [${level}] ${msg}\n`;
  try {
    mkdirSync(CONFIG_DIR, { recursive: true });
    appendFileSync(PLUGIN_LOG, line);
  } catch (e) {
    // best-effort
  }
}

// --- helpers (call into Python reboot_helpers.py) ---
async function readMarker() {
  const { stdout } = await execFileP("python3", [HELPERS_PY, "read", "--marker-path", MARKER_PATH]);
  const text = stdout.trim();
  if (!text) return null;
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}

async function consumeMarker() {
  const { stdout } = await execFileP("python3", [HELPERS_PY, "consume", "--marker-path", MARKER_PATH]);
  const text = stdout.trim();
  if (!text) return null;
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}

async function quarantineCorrupt() {
  try {
    const { stdout } = await execFileP("python3", [
      HELPERS_PY, "quarantine", "--marker-path", MARKER_PATH
    ]);
    const newPath = stdout.trim();
    if (newPath) log("WARN", `Corrupt marker moved to ${newPath}`);
  } catch (e) {
    log("ERROR", `Failed to quarantine corrupt marker: ${e.message}`);
  }
}

async function isProcessed(requestId) {
  try {
    await execFileP("python3", [HELPERS_PY, "processed-check", requestId]);
    return true;
  } catch (e) {
    return false;
  }
}

async function markProcessed(requestId) {
  try {
    await execFileP("python3", [HELPERS_PY, "processed-mark", requestId]);
  } catch (e) {
    log("WARN", `Failed to mark request as processed: ${e.message}`);
  }
}

// --- core init: handle pending markers ---
async function processPendingMarker(client) {
  log("INFO", "plugin loaded; checking for pending markers");

  // Phase 1: check notification-marker.json (written by reboot.py after stop)
  if (existsSync(NOTIFICATION_MARKER_PATH)) {
    log("INFO", "notification marker found");
    let notifMarker;
    try {
      const text = readFileSync(NOTIFICATION_MARKER_PATH, "utf-8");
      notifMarker = JSON.parse(text);
    } catch (e) {
      log("ERROR", `Failed to read notification marker: ${e.message}`);
      try { unlinkSync(NOTIFICATION_MARKER_PATH); } catch {}
      return;
    }

    const { request_id, session_id } = notifMarker;

    if (await isProcessed(request_id)) {
      log("INFO", `notification request_id=${request_id} already processed; removing marker`);
      try { unlinkSync(NOTIFICATION_MARKER_PATH); } catch {}
      return;
    }

    if (session_id) {
      const body = `✅ opencode-web reboot completed (request_id=${request_id})`;
      try {
        await client.session.prompt_async({
          path: { id: session_id },
          body: { parts: [{ type: "text", text: body }] },
        });
        log("INFO", `Notification sent to session_id=${session_id} request_id=${request_id}`);
      } catch (e) {
        log("ERROR", `Failed to send notification to session_id=${session_id}: ${e.message}`);
        log("ERROR", "Notification marker will be retried on next start");
        return;
      }
    }

    try { unlinkSync(NOTIFICATION_MARKER_PATH); } catch {}
    await markProcessed(request_id);
    log("INFO", `Notification marker consumed for request_id=${request_id}`);
    return;
  }

  // Phase 2: check old-style reboot-marker.json (backward compat)
  let marker;
  try {
    marker = await readMarker();
  } catch (e) {
    log("ERROR", `Failed to read reboot marker: ${e.message}`);
    return;
  }

  if (marker === null) {
    if (existsSync(MARKER_PATH)) {
      log("WARN", "Reboot marker exists but is corrupt; quarantining");
      await quarantineCorrupt();
    } else {
      log("INFO", "No pending markers");
    }
    return;
  }

  const { request_id, session_id } = marker;

  if (await isProcessed(request_id)) {
    log("INFO", `Reboot request_id=${request_id} already processed; removing marker without notification`);
    try { unlinkSync(MARKER_PATH); } catch {}
    return;
  }

  if (!session_id) {
    log("INFO", `Reboot marker request_id=${request_id} has no session_id; removing marker (no notification)`);
    try { unlinkSync(MARKER_PATH); } catch {}
    await markProcessed(request_id);
    return;
  }

  const body = `✅ opencode-web reboot completed (request_id=${request_id})`;
  try {
    await client.session.prompt_async({
      path: { id: session_id },
      body: { parts: [{ type: "text", text: body }] },
    });
    log("INFO", `Notification sent to session_id=${session_id} request_id=${request_id}`);
  } catch (e) {
    log("ERROR", `Failed to send notification to session_id=${session_id}: ${e.message}`);
    log("ERROR", "Marker will be retried on next opencode start");
    return;
  }

  try { unlinkSync(MARKER_PATH); } catch {}
  await markProcessed(request_id);
  log("INFO", `Reboot marker consumed for request_id=${request_id}`);
}

// --- plugin entry point (v1.16.2 API) ---
const OpencodeWebRebootPlugin = async (ctx) => {
  const client = ctx.client;
  log("INFO", "opencode-web-reboot plugin initializing");

  // Defer to next tick so opencode finishes its own bootstrap
  queueMicrotask(() => {
    processPendingMarker(client).catch((e) => {
      log("ERROR", `processPendingMarker crashed: ${e.message}\n${e.stack}`);
    });
  });

  return {
    tool: {
      reboot_opencode_web: tool({
        description: "Schedule a reboot of the opencode-web systemd service. The path unit will trigger reboot.py within ~1 second. The plugin will send a '✅ reboot completed' notification to this session when the reboot finishes. Use this when opencode-web is misbehaving (stuck, slow, unresponsive to new prompts).",
        args: {
          force_no_notify: tool.schema.boolean().optional().describe("If true, reboot runs without sending a notification. Default false (notification will be sent to this session)."),
        },
        async execute(args, toolCtx) {
          const sessionId = (args?.force_no_notify) ? "" : (toolCtx?.sessionID || "");
          try {
            mkdirSync(CONFIG_DIR, { recursive: true });
            const { stdout } = await execFileP("python3", [
              HELPERS_PY, "write",
              "--marker-path", MARKER_PATH,
              "--session-id", sessionId,
            ]);
            const marker = JSON.parse(stdout.trim());
            log("INFO", `Tool: wrote marker request_id=${marker.request_id} session_id='${sessionId}'`);
            return `Reboot scheduled. request_id=${marker.request_id}\n` +
              `The systemd path unit will trigger opencode-web-reboot.service within ~1 second.\n` +
              `You will receive a "✅ reboot completed" notification in this session when the reboot finishes.`;
          } catch (e) {
            log("ERROR", `Tool: failed to write marker: ${e.message}`);
            return `ERROR: failed to schedule reboot: ${e.message}`;
          }
        },
      }),
    },
  };
};

export default { id: "opencode-web-reboot", server: OpencodeWebRebootPlugin };
export { processPendingMarker, readMarker, consumeMarker };
