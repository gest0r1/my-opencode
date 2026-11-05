import { dispatchPacket } from "../skills/task-management/scripts/pipeline-dispatch.ts"
import { Plugin } from "@opencode/plugin"
import fs from "node:fs"
import path from "node:path"
import crypto from "node:crypto"
import { fileURLToPath } from "node:url"
import { assertPipelineCapabilities } from "../skills/task-management/scripts/capability-preflight.mjs"
import { RUN_PROMPT, WAKE_MARKER, runningGates, wakeDecision, wakeText } from "../skills/task-management/scripts/orchestrator-wake.mjs"
import { readLeases, removeLease, updateLease, writeLease } from "../skills/task-management/scripts/dispatch-leases.mjs"
import { processAlive } from "../skills/task-management/scripts/runtime-locks.mjs"
import { computeRunnable } from "../skills/task-management/scripts/stage-cli-core.ts"

const ELIGIBLE_ROLES = new Set([
  "CoderAgent", "TestEngineer", "BuildAgent",
])
const CONTEXT_TTL_MS = 5 * 60 * 1000
const WORK_ITEM_RE = /^[A-Za-z0-9._:-]{1,128}$/
const WORK_ITEM_MARKER_RE = /<pipeline_work_item\s+id="([A-Za-z0-9._:-]{1,128})"\s*\/?\s*>/
// OpenCode 2.x subagent tool: background=true returns this acknowledgement immediately.
const BACKGROUND_ACK_RE = /working in the background \(sessionID:\s*([^)\s]+)\)/
const CHILD_IDLE_PROBE_MS = 1500
const ORCHESTRATOR_CLI_RE = /(?:stage-cli|stage-complete-cli)\.ts\s+(?:next|advance|waves|status|start)\s+([A-Za-z0-9._-]+)/
// Grace period after an OpenStage turn ends before it counts as a stall.
const wakeDelayMs = () => Number(process.env.PIPELINE_WAKE_DELAY_MS) || 90_000

// "background": a background child acknowledged the dispatch and is still working; it becomes
// "healthy" once OpenCode reports the child session idle (session.wait).
type SessionHealth = "healthy" | "in_progress" | "background" | "error" | "cancelled" | "stale"

type RegistryEntry = {
  run_id: string
  pipeline_id: string
  stage: string
  role: string
  work_item_id: string
  session_id: string
  status: SessionHealth
  state_revision?: string
  evidence_path?: string
  last_delta_hash?: string
  continuity_key?: string
  result_path?: string
  result_sha256?: string
  files_read?: string[]
  updated_at: string
}

type RuntimeContext = {
  nonce: string
  prepared_at: string
  expires_at: string
  parent_session_id: string
  run_id: string
  pipeline_id: string
  stage: string
  role: string
  work_item_id: string
  loop: number
  technical_fix: boolean
  continuity_key: string
  state_revision: string
  previous_state_revision?: string
  evidence_path?: string
  changed_files: string[]
  diff_path?: string
  required_reread: string[]
  no_session_reuse?: boolean
}

type InvocationMeta = {
  ctx: RuntimeContext
  started_at: number
  decision: "fresh" | "reuse"
  fallback_reason?: string
  prompt_bytes: number
  packet_bytes?: number
  prior_files_read: string[]
  no_session_reuse?: boolean
}

type SessionStats = {
  context_bytes: number
  model_requests: number
  model?: unknown
  tool_calls: number
  read_calls: number
  grep_calls: number
  glob_calls: number
  edit_calls: number
  shell_calls: number
  files_read: Set<string>
  first_meaningful_at?: number
}

const prepareInput = {
  type: "object",
  properties: {
    run_id: { type: "string" },
    pipeline_id: { type: "string" },
    stage: { type: "string" },
    role: { type: "string" },
    work_item_id: { type: "string" },
    no_session_reuse: { type: "boolean" },
    loop: { type: "integer", minimum: 0 },
    technical_fix: { type: "boolean" },
    state_revision: { type: "string" },
    previous_state_revision: { type: "string" },
    evidence_path: { type: "string" },
    changed_files: { type: "array", items: { type: "string" } },
    diff_path: { type: "string" },
    required_reread: { type: "array", items: { type: "string" } },
  },
  required: [
    "run_id", "pipeline_id", "stage", "role", "work_item_id",

  ],
  additionalProperties: false,
} as const

function safeJson(file: string): any | undefined {
  try { return JSON.parse(fs.readFileSync(file, "utf8")) } catch { return undefined }
}
function ensureDir(dir: string) { fs.mkdirSync(dir, { recursive: true }) }
function appendJsonLine(file: string, value: unknown) {
  ensureDir(path.dirname(file))
  fs.appendFileSync(file, JSON.stringify(value) + "\n", "utf8")
}
function sha256(value: string | Buffer) { return crypto.createHash("sha256").update(value).digest("hex") }
function byteLength(value: unknown) {
  return Buffer.byteLength(typeof value === "string" ? value : JSON.stringify(value ?? null), "utf8")
}
function runtimeContextPath(root: string, parentSessionID: string, workItemID: string) {
  return path.join(root, ".tmp", "pipeline-runtime", sha256(parentSessionID).slice(0, 24), `${sha256(workItemID).slice(0, 24)}.json`)
}
function runRoot(root: string, runID: string) {
  return path.join(root, ".tmp", "pipelines", runID)
}
let dispatchLock: Promise<unknown> = Promise.resolve()
function withDispatchLock<T>(work: () => Promise<T>): Promise<T> {
  const next = dispatchLock.then(work, work)
  dispatchLock = next.catch(() => undefined)
  return next
}
function registryPath(root: string, runID: string) {
  return path.join(root, ".tmp", "pipelines", runID, "session-registry.json")
}
function metricsFile(root: string, runID: string) {
  return path.join(root, ".tmp", "pipelines", runID, "reuse-metrics", "events.jsonl")
}
type UsageTotals = { input: number; output: number; reasoning: number; cache_read: number; cache_write: number; cost: number }
// OpenCode reports a session's tokens and cost as running totals. A resumed child keeps adding to
// the same totals, so the run stores the last totals seen per session and each event carries only
// the difference: summing events per role never counts a resumed session twice.
function usageDelta(root: string, runID: string, sessionID: string, info: any) {
  const tokens = info?.tokens
  if (!tokens || typeof tokens.input !== "number") return null
  const totals: UsageTotals = { input: tokens.input, output: tokens.output ?? 0, reasoning: tokens.reasoning ?? 0,
    cache_read: tokens.cache?.read ?? 0, cache_write: tokens.cache?.write ?? 0, cost: Number(info.cost ?? 0) }
  const file = path.join(root, ".tmp", "pipelines", runID, "reuse-metrics", "usage-baseline.json")
  let seen: Record<string, UsageTotals> = {}
  try { seen = JSON.parse(fs.readFileSync(file, "utf8")) } catch {}
  const key = sha256(sessionID).slice(0, 24)
  const before = seen[key]
  seen[key] = totals
  ensureDir(path.dirname(file)); fs.writeFileSync(file, JSON.stringify(seen))
  const delta = Object.fromEntries(Object.entries(totals).map(([name, value]) =>
    [name, Math.max(0, value - (before?.[name as keyof UsageTotals] ?? 0))])) as UsageTotals
  return { model: info.model ? `${info.model.providerID}/${info.model.id}` : null, ...delta }
}
function safeHandoffPart(value: string) {
  const normalized = value.replace(/[^A-Za-z0-9._-]+/g, "_").replace(/^_+|_+$/g, "")
  return (normalized || "item").slice(0, 96)
}
function handoffPath(root: string, runID: string, kind: string, name: string) {
  return path.join(root, ".tmp", "pipelines", runID, "handoffs", kind, `${safeHandoffPart(name)}.json`)
}
function relativePath(root: string, file: string) {
  return path.relative(root, file).split(path.sep).join("/")
}
function writeJsonHandoff(root: string, runID: string, kind: string, name: string, value: unknown) {
  const file = handoffPath(root, runID, kind, name)
  ensureDir(path.dirname(file))
  fs.writeFileSync(file, JSON.stringify(value, null, 2) + "\n", "utf8")
  return relativePath(root, file)
}
function handoffIdentity(ctx: Pick<RuntimeContext, "pipeline_id" | "stage" | "work_item_id">, suffix: string) {
  return `${ctx.pipeline_id}--${ctx.stage}--${ctx.work_item_id}--${suffix}`
}
function reportedStatus(raw: string, transportStatus: string) {
  const json = /"status"\s*:\s*"([A-Za-z0-9_-]+)"/i.exec(raw)?.[1]
  if (json) return json.toLowerCase()
  const line = /(?:^|\n)\s*status\s*:\s*([A-Za-z0-9_-]+)/i.exec(raw)?.[1]
  if (line) return line.toLowerCase()
  if (/\bblocked\b/i.test(raw)) return "blocked"
  if (/\bpartial\b/i.test(raw)) return "partial"
  if (/\bneeds_revision\b/i.test(raw)) return "needs_revision"
  return transportStatus === "completed" ? "completed" : "error"
}
function artifactPaths(raw: string) {
  const found = raw.match(/\.tmp\/pipelines\/[A-Za-z0-9._\-\/]+/g) ?? []
  return [...new Set(found)].slice(0, 8)
}
function compactSubagentResult(raw: string, transportStatus: string, resultPath: string,
  extra: { session_reuse?: string; child_running?: boolean; runtime_reload_required?: boolean } = {}) {
  // A background acknowledgement is not a result: the child keeps working and OpenCode notifies
  // the parent when it finishes.
  const status = extra.child_running ? "running" : reportedStatus(raw, transportStatus)
  const detailRequired = new Set([
    "blocked", "partial", "needs_revision", "replan", "security_stop", "scope_stop",
    "secret_stop", "destructive_stop", "failed", "fail", "error",
  ]).has(status)
  return JSON.stringify({
    status,
    result_path: resultPath,
    artifacts: artifactPaths(raw),
    detail_required: detailRequired,
    ...extra,
  })
}
function compactDispatchShellResult(root: string, event: any, runtimeState: (runID: string) => RuntimeVersionState) {
  if (event.status !== "completed" || event.tool !== "shell") return
  const command = String(event.input?.command ?? "")
  if (!/stage-cli\.ts\s+dispatch\b/.test(command)) return
  const raw = String(event.result?.content ?? event.result?.output ?? "")
  let packet: any
  try { packet = JSON.parse(raw) } catch { return }
  if (!packet?.run_id || !packet?.pipeline_id || !packet?.stage || !packet?.work_item_id || !packet?.state_revision) return
  const ctx = packet as Pick<RuntimeContext, "pipeline_id" | "stage" | "work_item_id">
  const packetPath = writeJsonHandoff(
    root,
    String(packet.run_id),
    "dispatch",
    handoffIdentity(ctx, sha256(String(packet.state_revision)).slice(0, 12)),
    packet,
  )
  const compact = JSON.stringify({
    status: "ready",
    run_id: packet.run_id,
    pipeline_id: packet.pipeline_id,
    stage: packet.stage,
    work_item_id: packet.work_item_id,
    role: packet.role ?? null,
    state_revision: packet.state_revision,
    advisory_required: Array.isArray(packet.advisory_checks) && packet.advisory_checks.length > 0,
    packet_path: packetPath,
    work_item_marker: `<pipeline_work_item id="${packet.work_item_id}"/>`,
    dispatch_marker: `<pipeline_dispatch run="${packet.run_id}" pipeline="${packet.pipeline_id}" stage="${packet.stage}"/>`,
    parent_action: "dispatch with markers; runtime injects file-backed packet",
    ...runtimeFlags(runtimeState(String(packet.run_id))),
  })
  event.result = { ...event.result, content: compact, output: compact }
}
function loadRegistry(root: string, runID: string): RegistryEntry[] {
  const value = safeJson(registryPath(root, runID))
  return Array.isArray(value) ? value : []
}
function saveRegistry(root: string, runID: string, entries: RegistryEntry[]) {
  const file = registryPath(root, runID)
  ensureDir(path.dirname(file))
  fs.writeFileSync(file, JSON.stringify(entries, null, 2) + "\n", "utf8")
}
function consumeRuntimeContext(root: string, parentSessionID: string, workItemID: string) {
  const file = runtimeContextPath(root, parentSessionID, workItemID)
  const value = safeJson(file) as RuntimeContext | undefined
  try { fs.unlinkSync(file) } catch {}
  return value
}
function identity(ctx: RuntimeContext, role = ctx.role) {
  return [ctx.run_id, ctx.pipeline_id, ctx.stage, role, ctx.work_item_id].join(":")
}
function resolveInsideRoot(root: string, candidate?: string) {
  if (!candidate) return undefined
  return path.isAbsolute(candidate) ? candidate : path.resolve(root, candidate)
}
function contextIsFresh(ctx: RuntimeContext) {
  const expires = Date.parse(ctx.expires_at)
  return Number.isFinite(expires) && Date.now() <= expires
}
function extractWorkItemID(prompt: unknown) {
  return typeof prompt === "string" ? WORK_ITEM_MARKER_RE.exec(prompt)?.[1] : undefined
}
function hashDelta(root: string, ctx: RuntimeContext) {
  const diff = resolveInsideRoot(root, ctx.diff_path)
  const diffHash = diff && fs.existsSync(diff) ? sha256(fs.readFileSync(diff)) : null
  return sha256(JSON.stringify({
    work_item_id: ctx.work_item_id,
    evidence_path: ctx.evidence_path ?? null,
    changed_files: ctx.changed_files,
    diff_path: ctx.diff_path ?? null,
    diff_hash: diffHash,
    state_revision: ctx.state_revision,
    previous_state_revision: ctx.previous_state_revision ?? null,
    required_reread: ctx.required_reread,
  }))
}
function validateReuseDelta(root: string, ctx: RuntimeContext, previous: RegistryEntry) {
  if (!previous.continuity_key || previous.continuity_key !== ctx.continuity_key) {
    return { ok: false as const, reason: "contract_changed" }
  }
  const evidence = resolveInsideRoot(root, ctx.evidence_path)
  if (!ctx.evidence_path || !evidence || !fs.existsSync(evidence)) return { ok: false as const, reason: "missing_delta" }
  if (!ctx.technical_fix && ctx.evidence_path === previous.result_path &&
      (!previous.result_sha256 || sha256(fs.readFileSync(evidence)) !== previous.result_sha256)) {
    return { ok: false as const, reason: "stale_evidence" }
  }
  if (!ctx.previous_state_revision || ctx.previous_state_revision !== previous.state_revision) {
    return { ok: false as const, reason: "stale_state" }
  }
  const diff = resolveInsideRoot(root, ctx.diff_path)
  // Fresh authoritative review/gate evidence can request a repair before any source change.
  for (const item of ctx.required_reread) {
    const resolved = resolveInsideRoot(root, item)
    if (!resolved || !fs.existsSync(resolved)) return { ok: false as const, reason: "stale_evidence" }
  }
  const payload = {
    work_item_id: ctx.work_item_id,
    continuation_kind: ctx.technical_fix ? "automatic_repair" : "same_work_item",
    evidence_path: ctx.evidence_path,
    changed_files: ctx.changed_files,
    diff_path: ctx.diff_path ?? null,
    previous_state_revision: ctx.previous_state_revision,
    state_revision: ctx.state_revision,
    required_reread: [...new Set([...ctx.required_reread, ctx.evidence_path])],
  }
  return { ok: true as const, payload, bytes: byteLength(payload), hash: hashDelta(root, ctx) }
}
function continuityKey(packet: Awaited<ReturnType<typeof dispatchPacket>>) {
  // Frozen contract/scope, not mutable stage status or repair-cycle counters.
  return sha256(JSON.stringify({
    work_item_sha256: packet.work_item_sha256,
    effective_scope: packet.effective_scope,
    work_item_scope: packet.work_item_scope,
    authoritative_files: packet.authoritative_paths.map(file => [file, sha256(fs.readFileSync(file))]),
  }))
}
function fileFromInput(input: any) {
  const value = input?.filePath ?? input?.file_path ?? input?.path
  return typeof value === "string" ? value : undefined
}
function isMeaningfulTool(toolName: string, input: any) {
  if (["edit", "write", "patch", "apply_patch"].includes(toolName)) return true
  if (toolName !== "shell") return false
  return /(\btest\b|vitest|jest|pytest|playwright|typecheck|tsc\b|\bbuild\b)/i.test(String(input?.command ?? ""))
}
function getStats(map: Map<string, SessionStats>, sessionID: string) {
  let value = map.get(sessionID)
  if (!value) {
    value = { context_bytes: 0, model_requests: 0, tool_calls: 0, read_calls: 0, grep_calls: 0, glob_calls: 0, edit_calls: 0, shell_calls: 0, files_read: new Set() }
    map.set(sessionID, value)
  }
  return value
}
function decisionMetric(ctx: RuntimeContext, role: string, decision: "fresh" | "reuse", reason?: string) {
  return {
    timestamp: new Date().toISOString(), event: "reuse_decision", identity: identity(ctx, role),
    run_id: ctx.run_id, pipeline_id: ctx.pipeline_id, stage: ctx.stage, role,
    work_item_id: ctx.work_item_id, loop: ctx.loop, decision, fallback_reason: reason ?? null,
  }
}

// The plugin and the RUN instructions are loaded once, when OpenCode starts. A distribution
// update during a RUN changes the files on disk but not the running hooks, so the new rules
// would apply only "on paper". Fingerprint what was loaded and compare it with the disk.
const RUNTIME_FILES = [
  fileURLToPath(import.meta.url),
  fileURLToPath(new URL("../skills/task-management/scripts/pipeline-dispatch.ts", import.meta.url)),
  fileURLToPath(new URL("../command/pipeline-run.md", import.meta.url)),
  fileURLToPath(new URL("../agent/core/openstage-orchestrator.md", import.meta.url)),
]
function runtimeFingerprint() {
  return sha256(RUNTIME_FILES.map((file) => {
    try { return `${path.basename(file)}:${sha256(fs.readFileSync(file))}` } catch { return `${path.basename(file)}:missing` }
  }).join("\n"))
}
type RuntimeVersionState = { reload_required: boolean; changed_during_run: boolean; loaded: string }
function runtimeFlags(state: RuntimeVersionState) {
  return {
    ...(state.reload_required ? { runtime_reload_required: true } : {}),
    ...(state.changed_during_run ? { runtime_changed_during_run: true } : {}),
  }
}

export default Plugin.define({
  id: "pipeline-runtime",
  setup: async (plugin) => {
    const root = String(plugin.location.directory)
    const loadedRuntime = runtimeFingerprint()
    const runtimeState = (runID: string): RuntimeVersionState => {
      const file = path.join(root, ".tmp", "pipelines", runID, "runtime-version.json")
      let recorded = safeJson(file)
      if (!recorded?.loaded) {
        recorded = { loaded: loadedRuntime, recorded_at: new Date().toISOString() }
        try { ensureDir(path.dirname(file)); fs.writeFileSync(file, JSON.stringify(recorded, null, 2) + "\n", "utf8") } catch {}
      }
      const state = { loaded: loadedRuntime, reload_required: runtimeFingerprint() !== loadedRuntime, changed_during_run: recorded.loaded !== loadedRuntime }
      if (state.reload_required || state.changed_during_run) {
        appendJsonLine(metricsFile(root, runID), { timestamp: new Date().toISOString(), event: "runtime_version",
          run_id: runID, runtime_reload_required: state.reload_required, runtime_changed_during_run: state.changed_during_run })
      }
      return state
    }
    // Background children: registry entries wait in "background" until the child session is idle.
    const childIdle = async (sessionID: string, timeoutMs?: number): Promise<boolean> => {
      const wait = (plugin.session as any).wait
      if (typeof wait !== "function") return false // no authoritative completion signal
      const done = Promise.resolve(wait({ sessionID })).then(() => true, () => false)
      if (timeoutMs === undefined) return done
      return Promise.race([done, new Promise<boolean>((resolve) => setTimeout(() => resolve(false), timeoutMs))])
    }
    // Only a resolved wait proves idle; failure to inspect or wait is unknown, never a completed child.
    const probeChild = async (sessionID: string): Promise<"idle" | "running" | "gone" | "unknown"> => {
      const wait = (plugin.session as any).wait
      if (typeof wait !== "function") return "unknown"
      try { await plugin.session.get({ sessionID: sessionID as any }) } catch { return "unknown" } // transient/read/location failure is not completion
      const outcome = Promise.resolve(wait({ sessionID })).then(() => "idle" as const, () => "unknown" as const)
      let timer: ReturnType<typeof setTimeout> | undefined
      const result = await Promise.race([outcome, new Promise<"running">((resolve) => { timer = setTimeout(() => resolve("running"), CHILD_IDLE_PROBE_MS) })])
      clearTimeout(timer)
      return result
    }
    const settleBackground = async (runID: string, key: string, childID: string, idle: boolean) => {
      const registry = loadRegistry(root, runID)
      const entry = registry.find((item) => identity(item as RuntimeContext) === key && item.session_id === childID)
      if (!entry || entry.status !== "background") return
      removeLease(runRoot(root, runID), entry)
      entry.status = idle ? "healthy" : "error"; entry.updated_at = new Date().toISOString()
      saveRegistry(root, runID, registry)
      let info: any
      try { info = await plugin.session.get({ sessionID: childID as any }); info = info?.data ?? info } catch {}
      appendJsonLine(metricsFile(root, runID), { timestamp: entry.updated_at, event: "background_child_settled",
        identity: key, run_id: runID, role: entry.role, session_health: entry.status, usage: usageDelta(root, runID, childID, info) })
    }
    // Orchestrator wake: OpenStage sessions running a RUN, their running background children and
    // the state fingerprint at the last wake (one wake per fingerprint).
    const orchestratorRun = new Map<string, string>()
    const pendingChildren = new Map<string, Set<string>>()
    const lastWake = new Map<string, string>()
    const wakeTimers = new Map<string, ReturnType<typeof setTimeout>>()
    const unknownProbes = new Map<string, number>()
    const wakeInFlight = new Set<string>()
    const wakeFailures = new Map<string, { fingerprint: string; attempts: number }>()
    const unresolvedNoticeInFlight = new Set<string>()
    const trackChild = (parentID: string, childID: string) => {
      const set = pendingChildren.get(parentID) ?? new Set<string>()
      if (set.has(childID)) return // one authoritative waiter per background child
      set.add(childID); pendingChildren.set(parentID, set)
      void childIdle(childID).then(idle => {
        if (!idle) return // unknown completion retains lease and pending child
        set.delete(childID)
        // A child's completion need not emit session.execution.succeeded for its
        // idle parent. Reconcile leases and wake independently of parent events.
        if (!orchestratorRun.has(parentID)) return
        const previous = wakeTimers.get(parentID)
        if (previous) clearTimeout(previous)
        wakeTimers.set(parentID, setTimeout(() => { void checkWake(parentID) }, wakeDelayMs()))
      }).catch(() => {})
    }
    const checkWake = async (sessionID: string) => {
      wakeTimers.delete(sessionID)
      const runID = orchestratorRun.get(sessionID)
      if (!runID) return
      const statePath = path.join(root, ".tmp/pipelines", runID, "state.json")
      let stateRaw = ""
      try { stateRaw = fs.readFileSync(statePath, "utf8") } catch {}
      let manifest: any = null
      try { manifest = JSON.parse(fs.readFileSync(String(JSON.parse(stateRaw).manifest_file), "utf8")) } catch {}
      let state: any = null
      try { state = JSON.parse(stateRaw) } catch {}
      // The orchestrator's turn ended: its foreground children are done, and a force-stopped background
      // worker must not hold its lease forever.
      const unknownChildren: any[] = []
      let noticeDelivered = false
      for (const lease of readLeases(runRoot(root, runID), { state })) {
        if (lease.parent_session_id !== sessionID) continue
        // A lease without child_session_id can be in the reservation->ack crash window.
        // After the owning process dies, a resumed parent must not infer completion.
        let health: "idle" | "running" | "gone" | "unknown" =
          !lease.child_session_id && !processAlive(lease.owner_pid, lease.owner_pid_start) ? "unknown" : "idle"
        if (lease.child_session_id) health = await probeChild(String(lease.child_session_id))
        if (health === "unknown") { unknownChildren.push(lease); continue }
        if (health === "running") continue
        if (lease.child_session_id) await settleBackground(runID, identity(lease as RuntimeContext), String(lease.child_session_id), health === "idle")
        if (lease.child_session_id) pendingChildren.get(sessionID)?.delete(String(lease.child_session_id))
        removeLease(runRoot(root, runID), lease)
      }
      if (unknownChildren.length) {
        const count = (unknownProbes.get(sessionID) ?? 0) + 1
        unknownProbes.set(sessionID, count)
        if (count <= 3) wakeTimers.set(sessionID, setTimeout(() => { void checkWake(sessionID) }, Math.min(wakeDelayMs(), 5_000)))
        else {
          const key = sha256(JSON.stringify(unknownChildren.map(lease => [lease.child_session_id, lease.pipeline_id, lease.stage, lease.work_item_id, lease.created_at]).sort()))
          const file = metricsFile(root, runID)
          let alreadyNotified = false
          try { alreadyNotified = fs.readFileSync(file, 'utf8').split('\n').some(line => { try { const item = JSON.parse(line); return item.event === 'child_liveness_unresolved' && item.notice_key === key } catch { return false } }) } catch {}
          if (!alreadyNotified && !unresolvedNoticeInFlight.has(key)) {
            unresolvedNoticeInFlight.add(key)
            try {
              await (plugin.session as any).synthetic({ sessionID, text: `Child session liveness for RUN \`${runID}\` remains unknown after repeated checks. Its lease is retained: do not redispatch that work or assume the child is gone. Check the existing session and continue any independently runnable work.`, description: 'pipeline child liveness unknown', delivery: 'queue', resume: true })
              noticeDelivered = true
              appendJsonLine(file, { timestamp: new Date().toISOString(), event: "child_liveness_unresolved", run_id: runID, session_id: sessionID, probes: count, notice_key: key })
            } catch (error) {
              appendJsonLine(file, { timestamp: new Date().toISOString(), event: "child_liveness_notice_failed", run_id: runID, session_id: sessionID, error: String((error as Error)?.message ?? error) })
            } finally { unresolvedNoticeInFlight.delete(key) }
          }
        }
      } else unknownProbes.delete(sessionID)
      const runningWork = readLeases(runRoot(root, runID), { state }).length + runningGates(path.join(root, ".tmp/pipelines"), runID)
      let runnableCount: number | null = null
      try { if (state) runnableCount = computeRunnable(state).length } catch {}
      const decision = wakeDecision({ stateRaw, manifest, runnableCount, pendingChildren: pendingChildren.get(sessionID)?.size ?? 0, runningWork, lastFingerprint: lastWake.get(sessionID) ?? null })
      if (!decision.wake) return
      if (noticeDelivered) {
        lastWake.set(sessionID, decision.fingerprint) // a separate successful notice resumed the parent
        return
      }
      if (wakeInFlight.has(sessionID)) return
      wakeInFlight.add(sessionID)
      try {
        await (plugin.session as any).synthetic({ sessionID, text: wakeText(runID), description: "pipeline wake", delivery: "queue", resume: true })
        lastWake.set(sessionID, decision.fingerprint)
        wakeFailures.delete(sessionID)
        appendJsonLine(metricsFile(root, runID), { timestamp: new Date().toISOString(), event: "orchestrator_wake", run_id: runID, session_id: sessionID })
      } catch (error) {
        const previous = wakeFailures.get(sessionID)
        const count = previous?.fingerprint === decision.fingerprint ? previous.attempts + 1 : 1
        wakeFailures.set(sessionID, { fingerprint: decision.fingerprint, attempts: count })
        appendJsonLine(metricsFile(root, runID), { timestamp: new Date().toISOString(), event: "orchestrator_wake_failed", run_id: runID, session_id: sessionID,
          attempts: count, error: String((error as Error)?.message ?? error) })
        // A rejected synthetic message was NOT delivered: retry only a bounded
        // number of times. Failed delivery must not poison lastWake.
        if (count <= 3) wakeTimers.set(sessionID, setTimeout(() => { void checkWake(sessionID) }, wakeDelayMs()))
      } finally {
        wakeInFlight.delete(sessionID)
      }
    }
    void (async () => {
      const subscribe = (plugin as any).event?.subscribe
      if (typeof subscribe !== "function") return
      for (;;) {
        try {
          for await (const event of subscribe.call((plugin as any).event)) {
            const sessionID = String((event as any)?.data?.sessionID ?? "")
            if (!sessionID || !orchestratorRun.has(sessionID)) continue
            const type = String((event as any)?.type ?? "")
            if (type === "session.execution.started") {
              unknownProbes.delete(sessionID)
              wakeFailures.delete(sessionID)
              const timer = wakeTimers.get(sessionID); if (timer) clearTimeout(timer); wakeTimers.delete(sessionID)
            } else if (type === "session.execution.succeeded") {
              const timer = wakeTimers.get(sessionID); if (timer) clearTimeout(timer)
              wakeTimers.set(sessionID, setTimeout(() => { void checkWake(sessionID) }, wakeDelayMs()))
            }
          }
        } catch {}
        await new Promise((resolve) => setTimeout(resolve, 5_000))
      }
    })()
    const statsBySession = new Map<string, SessionStats>()
    const invocationByCallID = new Map<string, InvocationMeta>()
    const optionFile = (id: string) => path.join(root, '.tmp/pipeline-runtime', sha256(id).slice(0, 24), 'options.json')
    const reuseDisabled = (id: string) => safeJson(optionFile(id))?.no_session_reuse === true
    const runBySession = new Map<string, string>()
    const parentFiles = new Map<string, Set<string>>()
    await plugin.session.hook("prompt", (event) => {
      const text = JSON.stringify(event.prompt)
      const prompt = typeof event.prompt === "string" ? event.prompt : (event.prompt as any)?.text
      const invocation = typeof prompt === "string" ? RUN_PROMPT.exec(prompt) : null
      const runID = invocation?.[1]
      if (runID) orchestratorRun.set(String(event.sessionID), runID)
      // An owner prompt reopens waking; our own wake does not.
      if (!text.includes(WAKE_MARKER)) lastWake.delete(String(event.sessionID))
      if (invocation) {
        // Only the owner's invocation line counts; the expanded command body documents the flag in its usage template.
        const optedOut = /(?:^|\s)--no-session-reuse(?=\s|$)/.test(invocation[2])
        const file = optionFile(String(event.sessionID)); ensureDir(path.dirname(file))
        fs.writeFileSync(file, JSON.stringify({ no_session_reuse: optedOut }))
      }
    })
    await plugin.session.hook("compaction", (event) => {
      const run = runBySession.get(String(event.sessionID))
      if (run) appendJsonLine(metricsFile(root, run), { event: "parent_compaction", timestamp: new Date().toISOString() })
    })
    const visibleBySession = new Map<string, string[]>()
    await plugin.session.hook("context", (context) => {
      const stats = getStats(statsBySession, String(context.sessionID))
      stats.context_bytes += byteLength({ system: context.system, messages: context.messages })
      stats.model_requests++; stats.model = context.model
      const run = runBySession.get(String(context.sessionID))
      if (run) appendJsonLine(metricsFile(root, run), { event: 'parent_context', timestamp: new Date().toISOString(), context_bytes: byteLength({ system: context.system, messages: context.messages }), model: context.model })
      if (String(context.agent) === "OpenStageOrchestrator") {
        visibleBySession.set(String(context.sessionID), Object.keys(context.tools))
      }
    })

    const capabilityPreflight = async (sessionID: string, researchAgents: string[] = []) => {
      const [tools, agentResult, skillResult, modelResult] = await Promise.all([
        plugin.tool.list(), plugin.agent.list(), plugin.skill.list(), plugin.model.list(),
      ])
      const agents = agentResult.data
      const parent = agents.find((x) => String(x.id) === "OpenStageOrchestrator")
      if (!parent) throw new Error("PIPELINE_CAPABILITY_UNAVAILABLE: primary OpenStageOrchestrator")
      return assertPipelineCapabilities({ tools, agents, skills: skillResult.data,
        visibleTools: visibleBySession.get(sessionID), permissions: parent.permissions, models: modelResult.data, researchAgents })
    }

    await plugin.tool.transform((editor) => {
      editor.add({
        name: "pipeline_runtime_preflight",
        options: { codemode: false },
        description: "Check live pipeline tools, skills, exact subagent IDs and delegation permissions before PLAN/RUN. BLOCKED is authoritative; never widen write permissions as fallback.",
        input: { type: "object", properties: { research_agents: { type: "array", uniqueItems: true,
          items: { type: "string", enum: ["ExternalScout", "WebResearcher", "ArchitectureAnalyzer", "CoderAgent", "CodeReviewer", "SeniorTechnicalPlanReviewer"] } } }, additionalProperties: false },
        execute: async (args, context) => ({ content: JSON.stringify(await capabilityPreflight(String(context.sessionID), args.research_agents)) }),
      })
      editor.add({
        name: "pipeline_runtime_prepare",
        options: { codemode: false },
        description: "Prepare deterministic routing metadata for one pipeline work item before the next matching subagent call.",
        input: prepareInput,
        execute: async (args, context) => {
          await capabilityPreflight(String(context.sessionID))
          if (!ELIGIBLE_ROLES.has(args.role)) {
            return { content: "rejected: role is not eligible for session reuse; next subagent must run fresh" }
          }
          if (!WORK_ITEM_RE.test(args.work_item_id)) {
            return { content: "rejected: work_item_id must match [A-Za-z0-9._:-]{1,128}" }
          }
          const file = runtimeContextPath(root, String(context.sessionID), args.work_item_id)
          const existing = safeJson(file) as RuntimeContext | undefined
          if (existing && contextIsFresh(existing)) {
            return { content: `rejected: outstanding prepare already exists for work_item_id=${args.work_item_id}` }
          }
          const packet = await dispatchPacket(root, args.run_id, args.pipeline_id, args.stage, args.work_item_id, args.role)
          runBySession.set(String(context.sessionID), args.run_id)
          const previous = loadRegistry(root, args.run_id).find(item => identity(item as RuntimeContext) === identity(packet as RuntimeContext))
          const now = Date.now()
          const ctx: RuntimeContext = {
            ...packet, nonce: crypto.randomUUID(), prepared_at: new Date(now).toISOString(),
            expires_at: new Date(now + CONTEXT_TTL_MS).toISOString(), parent_session_id: String(context.sessionID),
            technical_fix: packet.loop > 0, continuity_key: continuityKey(packet), previous_state_revision: previous?.state_revision,
            evidence_path: packet.loop === 0 && args.role === "CoderAgent" ? previous?.result_path : packet.evidence_paths.at(-1), changed_files: packet.repair_paths,
            required_reread: [packet.work_item_path, ...packet.authoritative_paths, ...packet.evidence_paths],
            no_session_reuse: args.no_session_reuse === true || reuseDisabled(String(context.sessionID)),
          }
          ensureDir(path.dirname(file))
          fs.writeFileSync(file, JSON.stringify(ctx, null, 2) + "\n", "utf8")
          return { content: `prepared ${ctx.nonce} for ${identity(ctx)}; marker=<pipeline_work_item id="${ctx.work_item_id}"/>` }
        },
      })
    })

    await plugin.tool.hook("execute.before", async (event) => {
      const sessionID = String(event.sessionID)
      if (event.tool !== "subagent") {
        // The session that drives the RUN CLI is its orchestrator. After an OpenCode restart the owner's
        // next message rarely repeats `/pipeline-run <id>`, so waking must not depend on that prompt.
        const driven = event.tool === "shell" ? ORCHESTRATOR_CLI_RE.exec(String((event.input as any)?.command ?? ""))?.[1] : undefined
        if (sessionID && driven && !orchestratorRun.has(sessionID) && fs.existsSync(path.join(root, ".tmp/pipelines", driven, "state.json"))) orchestratorRun.set(sessionID, driven)
        if (!sessionID || event.tool === "pipeline_runtime_prepare") return
        const stats = getStats(statsBySession, sessionID)
        stats.tool_calls += 1
        const run = runBySession.get(sessionID)
        if (run) {
          const file = fileFromInput(event.input)
          const files = parentFiles.get(sessionID) ?? new Set<string>()
          if (event.tool === "read" && file) files.add(path.resolve(root, file))
          parentFiles.set(sessionID, files)
          appendJsonLine(metricsFile(root, run), { event: "parent_tool", timestamp: new Date().toISOString(), tool: event.tool,
            read_calls: event.tool === "read" ? 1 : 0, unique_files_read: files.size })
        }
        if (event.tool === "read") {
          stats.read_calls += 1
          const file = fileFromInput(event.input)
          if (file) stats.files_read.add(path.resolve(root, file))
        } else if (event.tool === "grep") stats.grep_calls += 1
        else if (event.tool === "glob") stats.glob_calls += 1
        else if (["edit", "write", "patch", "apply_patch"].includes(event.tool)) stats.edit_calls += 1
        else if (event.tool === "shell") stats.shell_calls += 1
        if (!stats.first_meaningful_at && isMeaningfulTool(event.tool, event.input)) stats.first_meaningful_at = Date.now()
        return
      }

      const input = (event.input && typeof event.input === "object" ? event.input : {}) as Record<string, any>
      // A session that dispatches pipeline work or a gate run is that RUN's orchestrator: register it before
      // the child starts, so a background child is tracked even without a /pipeline-run prompt.
      const dispatchedRun = /<pipeline_dispatch run="([A-Za-z0-9._-]+)"/.exec(String(input.prompt ?? ""))?.[1] ?? /gate-runner-cli\.ts\s+([A-Za-z0-9._-]+)/.exec(String(input.prompt ?? ""))?.[1]
      if (sessionID && dispatchedRun && !orchestratorRun.has(sessionID) && fs.existsSync(path.join(root, ".tmp/pipelines", dispatchedRun, "state.json"))) orchestratorRun.set(sessionID, dispatchedRun)
      const role = String(input.agent ?? "")
      const workItemID = extractWorkItemID(input.prompt)

      // V2's sessionID is only a transport handle. The model never chooses which
      // previous child may be resumed; the pipeline registry owns that decision.
      delete input.sessionID
      event.input = input

      if (!sessionID || !workItemID) return
      let ctx = consumeRuntimeContext(root, sessionID, workItemID)
      // Preparation is enforced here; the LLM need not remember a helper call.
      const marker = /<pipeline_dispatch run="([A-Za-z0-9._-]+)" pipeline="([^"]+)" stage="([^"]+)"\s*\/>/.exec(String(input.prompt))
      if (!ctx && marker) {
        const packet = await dispatchPacket(root, marker[1], marker[2], marker[3], workItemID, role)
        const previous = loadRegistry(root, packet.run_id).find(item => identity(item as RuntimeContext) === identity(packet as RuntimeContext))
        ctx = { ...packet, nonce: crypto.randomUUID(), prepared_at: new Date().toISOString(), expires_at: new Date(Date.now() + CONTEXT_TTL_MS).toISOString(),
          parent_session_id: sessionID, technical_fix: packet.loop > 0, continuity_key: continuityKey(packet), previous_state_revision: previous?.state_revision,
          evidence_path: packet.loop === 0 && role === "CoderAgent" ? previous?.result_path : packet.evidence_paths.at(-1), changed_files: packet.repair_paths, required_reread: [packet.work_item_path, ...packet.authoritative_paths, ...packet.evidence_paths],
          no_session_reuse: reuseDisabled(sessionID) }
      }
      if (!ctx) return
      // Check and lease under one lock: two workers of a wave started in one message must not both
      // pass the overlap check before either holds its lease.
      const current = await withDispatchLock(async () => {
        const packet = await dispatchPacket(root, ctx!.run_id, ctx!.pipeline_id, ctx!.stage, ctx!.work_item_id, role)
        if (packet.state_revision !== ctx!.state_revision) throw new Error("STALE_DISPATCH_STATE")
        if (continuityKey(packet) !== ctx!.continuity_key) throw new Error("STALE_DISPATCH_CONTRACT")
        // A reviewer writes nothing: its lease holds no paths and only marks a child at work (waking, waves).
        if (["agent", "review"].includes(packet.executor)) writeLease(runRoot(root, packet.run_id), { run_id: packet.run_id, pipeline_id: packet.pipeline_id,
          stage: packet.stage, work_item_id: packet.work_item_id, role, writes: packet.executor === "agent", scope: packet.executor === "agent" ? packet.write_scope : [], parent_session_id: sessionID })
        return packet
      })
      runBySession.set(sessionID, ctx.run_id)
      const dispatchPath = writeJsonHandoff(
        root,
        ctx.run_id,
        "dispatch",
        handoffIdentity(ctx, sha256(current.state_revision).slice(0, 12)),
        current,
      )
      input.prompt = [
        String(input.prompt),
        `<pipeline_dispatch_packet path="${dispatchPath}"/>`,
        "Read the dispatch packet file before work. Authoritative files and machine evidence stay in files; conversation history is supplemental. Return only the concise role result required by the pipeline.",
      ].join("\n")
      event.input = input
      const promptBytes = byteLength(input.prompt ?? "")
      const rememberFresh = (reason: string, priorFiles: string[] = []) => {
        invocationByCallID.set(String(event.id), {
          ctx, started_at: Date.now(), decision: "fresh", fallback_reason: reason,
          prompt_bytes: promptBytes, packet_bytes: byteLength(current), prior_files_read: priorFiles,
        })
        appendJsonLine(metricsFile(root, ctx.run_id), {
          ...decisionMetric(ctx, role, "fresh", reason), dispatch_path: dispatchPath, packet_bytes: byteLength(current),
        })
      }

      if (runtimeState(ctx.run_id).reload_required) return rememberFresh("runtime_reload_required")
      if (!contextIsFresh(ctx)) return rememberFresh("stale_runtime_context")
      if (ctx.parent_session_id !== sessionID) return rememberFresh("parent_session_mismatch")
      if (ctx.work_item_id !== workItemID) return rememberFresh("work_item_mismatch")
      if (role !== ctx.role) return rememberFresh("role_mismatch")
      if (!ELIGIBLE_ROLES.has(role)) return rememberFresh("not_eligible")

      const registry = loadRegistry(root, ctx.run_id)
      const match = registry.find((item) =>
        item.run_id === ctx.run_id && item.pipeline_id === ctx.pipeline_id &&
        item.stage === ctx.stage && item.role === role && item.work_item_id === ctx.work_item_id)

      if (ctx.no_session_reuse) return rememberFresh("disabled_by_owner")
      if (!ctx.technical_fix && role !== "CoderAgent") return rememberFresh("baseline")
      if (!match) return rememberFresh("no_prior_session")
      if (match.status === "background") {
        // The previous child was launched in the background. Resume only once it is idle; a
        // missed notification (restart, lost watcher) is recovered here instead of going fresh.
        // Redispatching while the first child still works starts a second worker on the same files.
        if (!(await childIdle(match.session_id, CHILD_IDLE_PROBE_MS))) {
          throw new Error(`CHILD_STILL_RUNNING: ${match.session_id} is still working on ${ctx.work_item_id}; wait for its completion notification instead of dispatching again`)
        }
        settleBackground(ctx.run_id, identity(match as RuntimeContext), match.session_id, true)
        match.status = "healthy"
      }
      if (match.status !== "healthy") return rememberFresh(match.status, match.files_read ?? [])

      const delta = validateReuseDelta(root, ctx, match)
      if (!delta.ok) {
        if (delta.reason === "stale_state") {
          match.status = "stale"; match.updated_at = new Date().toISOString(); saveRegistry(root, ctx.run_id, registry)
        }
        return rememberFresh(delta.reason, match.files_read ?? [])
      }

      try { await plugin.session.get({ sessionID: match.session_id as any }) }
      catch { return rememberFresh("session_unavailable", match.files_read ?? []) }
      const deltaPath = writeJsonHandoff(
        root,
        ctx.run_id,
        "reuse",
        handoffIdentity(ctx, sha256(`${ctx.state_revision}:${delta.hash}`).slice(0, 12)),
        delta.payload,
      )
      input.sessionID = match.session_id
      input.prompt = [
        String(input.prompt ?? ""),
        `<session_reuse_delta path="${deltaPath}"/>`,
        "Read the reuse delta file and every required path listed there. Prior conversation memory is supplemental; repository state and evidence remain authoritative.",
      ].join("\n")
      event.input = input
      invocationByCallID.set(String(event.id), {
        ctx, started_at: Date.now(), decision: "reuse", prompt_bytes: byteLength(input.prompt),
        packet_bytes: delta.bytes, prior_files_read: match.files_read ?? [],
      })
      match.status = "in_progress"; match.updated_at = new Date().toISOString(); saveRegistry(root, ctx.run_id, registry)
      appendJsonLine(metricsFile(root, ctx.run_id), {
        ...decisionMetric(ctx, role, "reuse"), session_id: match.session_id,
        packet_bytes: delta.bytes, delta_hash: delta.hash, delta_path: deltaPath, dispatch_path: dispatchPath, call_id: String(event.id),
      })
    })

    await plugin.tool.hook("execute.after", async (event) => {
      if (event.tool !== "subagent") {
        compactDispatchShellResult(root, event, runtimeState)
        const run = runBySession.get(String(event.sessionID))
        if (run && event.status === "completed" && event.tool === "read") appendJsonLine(metricsFile(root, run), {
          event: "parent_read", timestamp: new Date().toISOString(), bytes_read: byteLength(event.result.content) })
        return
      }
      const callID = String(event.id)
      // Any background child of an OpenStage session (worker, reviewer, GateRunner) keeps the wake
      // timer quiet until it settles: its completion notification is the parent's next event.
      if (event.status === "completed") {
        const ack = BACKGROUND_ACK_RE.exec(String(event.result?.content ?? event.result?.output ?? ""))?.[1]
        if (ack && orchestratorRun.has(String(event.sessionID))) trackChild(String(event.sessionID), ack)
      }
      const invocation = invocationByCallID.get(callID)
      if (!invocation) return
      const ctx = invocation.ctx
      const role = String((event.input as any)?.agent ?? ctx.role)
      const reusedID = String((event.input as any)?.sessionID ?? "")
      const rawContent = event.status === "completed" ? String(event.result?.content ?? event.result?.output ?? "") : ""
      const ackID = BACKGROUND_ACK_RE.exec(rawContent)?.[1] ?? ""
      const resultID = event.status === "completed" ? String(event.result?.metadata?.sessionID ?? "") || ackID : ""
      const childID = resultID || reusedID
      const background = event.status === "completed" && ((event.input as any)?.background === true || Boolean(ackID))
      const registry = loadRegistry(root, ctx.run_id)
      const previous = registry.find((item) =>
        item.run_id === ctx.run_id && item.pipeline_id === ctx.pipeline_id &&
        item.stage === ctx.stage && item.role === role && item.work_item_id === ctx.work_item_id)
      const now = new Date().toISOString()
      const sessionStats = childID ? statsBySession.get(childID) : undefined
      const currentFiles = [...(sessionStats?.files_read ?? new Set<string>())]
      const priorFiles = new Set(invocation.prior_files_read)
      const rereadFiles = currentFiles.filter((file) => priorFiles.has(file))
      const rawResult = event.status === "completed"
        ? String(event.result?.content ?? event.result?.output ?? "")
        : String(event.error?.message ?? "")
      const resultPath = writeJsonHandoff(
        root,
        ctx.run_id,
        "results",
        handoffIdentity(ctx, sha256(`${callID}:${now}`).slice(0, 12)),
        {
          run_id: ctx.run_id,
          pipeline_id: ctx.pipeline_id,
          stage: ctx.stage,
          role,
          work_item_id: ctx.work_item_id,
          transport_status: event.status,
          session_id: childID || null,
          recorded_at: now,
          content: rawResult,
        },
      )

      // The worker stopped writing unless it continues in the background; then its lease is released
      // when the child settles.
      if (background && childID) updateLease(runRoot(root, ctx.run_id), ctx, { child_session_id: childID })
      else removeLease(runRoot(root, ctx.run_id), ctx)
      if (event.status === "completed" && childID) {
        const next: RegistryEntry = {
          run_id: ctx.run_id, pipeline_id: ctx.pipeline_id, stage: ctx.stage, role,
          work_item_id: ctx.work_item_id, session_id: childID, status: background ? "background" : "healthy",
          state_revision: ctx.state_revision, evidence_path: ctx.evidence_path,
          last_delta_hash: hashDelta(root, ctx),
          continuity_key: ctx.continuity_key,
          result_path: resultPath,
          result_sha256: sha256(fs.readFileSync(path.resolve(root, resultPath))),
          files_read: currentFiles.length ? currentFiles : previous?.files_read ?? [], updated_at: now,
        }
        saveRegistry(root, ctx.run_id, [
          ...registry.filter((item) => !(item.run_id === next.run_id && item.pipeline_id === next.pipeline_id &&
            item.stage === next.stage && item.role === next.role && item.work_item_id === next.work_item_id)),
          next,
        ])
        if (background) {
          void childIdle(childID).then((idle) => settleBackground(ctx.run_id, identity(next as RuntimeContext), childID, idle))
        }
      } else if (previous && invocation.decision === "reuse") {
        previous.status = "error"; previous.updated_at = now; saveRegistry(root, ctx.run_id, registry)
      }

      const sessionInfo = async (sessionID: string) => {
        try { const info: any = await plugin.session.get({ sessionID: sessionID as any }); return info?.data ?? info } catch { return undefined }
      }
      // A background child is still working at this point; its usage is recorded when it settles.
      const usage = childID && !background ? usageDelta(root, ctx.run_id, childID, await sessionInfo(childID)) : null
      const parentUsage = event.sessionID ? usageDelta(root, ctx.run_id, String(event.sessionID), await sessionInfo(String(event.sessionID))) : null
      appendJsonLine(metricsFile(root, ctx.run_id), {
        timestamp: now, event: "subagent_complete", identity: identity(ctx, role), call_id: callID, background, role, usage, parent_usage: parentUsage,
        decision: invocation.decision, fallback_reason: invocation.fallback_reason ?? null,
        session_id: childID || null, session_health: event.status !== "completed" ? "error" : background ? "background" : "healthy",
        latency_ms: Date.now() - invocation.started_at,
        orientation_ms: sessionStats?.first_meaningful_at ? sessionStats.first_meaningful_at - invocation.started_at : null,
        prompt_bytes: invocation.prompt_bytes,
        context_bytes: sessionStats?.context_bytes ?? null, model_requests: sessionStats?.model_requests ?? null, model: sessionStats?.model ?? null,
        response_bytes: byteLength(rawResult),
        parent_response_bytes: byteLength(compactSubagentResult(rawResult, event.status, resultPath)),
        result_path: resultPath,
        packet_bytes: invocation.packet_bytes ?? null,
        tool_calls: sessionStats?.tool_calls ?? null, read_calls: sessionStats?.read_calls ?? null,
        grep_calls: sessionStats?.grep_calls ?? null, glob_calls: sessionStats?.glob_calls ?? null,
        edit_calls: sessionStats?.edit_calls ?? null, shell_calls: sessionStats?.shell_calls ?? null,
        unique_files_read: currentFiles.length, reread_files: rereadFiles, reread_file_count: rereadFiles.length,
        context_reread_ratio: currentFiles.length ? rereadFiles.length / currentFiles.length : null,
      })
      if (event.status === "completed") {
        // The parent sees what the runtime actually decided; it never infers "continuation".
        const compact = compactSubagentResult(rawResult, event.status, resultPath, {
          session_reuse: invocation.decision === "reuse" ? "resumed" : `fresh:${invocation.fallback_reason ?? "unknown"}`,
          ...(background ? { child_running: true } : {}),
          ...runtimeFlags(runtimeState(ctx.run_id)),
        })
        event.result = { ...event.result, content: compact, output: compact }
      }
      invocationByCallID.delete(callID)
      if (childID) statsBySession.delete(childID)
    })
  },
})
