import { Plugin } from "@opencode/plugin"
import fs from "node:fs"
import path from "node:path"
import crypto from "node:crypto"

const ELIGIBLE_ROLES = new Set([
  "CoderAgent", "coder-agent", "TestEngineer", "tester", "BuildAgent", "build-agent",
])
const CONTEXT_TTL_MS = 5 * 60 * 1000
const WORK_ITEM_RE = /^[A-Za-z0-9._:-]{1,128}$/
const WORK_ITEM_MARKER_RE = /<pipeline_work_item\s+id="([A-Za-z0-9._:-]{1,128})"\s*\/?\s*>/

type SessionHealth = "healthy" | "in_progress" | "error" | "cancelled" | "stale"

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
  state_revision: string
  previous_state_revision?: string
  evidence_path?: string
  changed_files: string[]
  diff_path?: string
  required_reread: string[]
}

type InvocationMeta = {
  ctx: RuntimeContext
  started_at: number
  decision: "fresh" | "reuse"
  fallback_reason?: string
  prompt_bytes: number
  packet_bytes?: number
  prior_files_read: string[]
}

type SessionStats = {
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
    "loop", "technical_fix", "state_revision",
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
function registryPath(root: string, runID: string) {
  return path.join(root, ".tmp", "pipelines", runID, "session-registry.json")
}
function metricsFile(root: string, runID: string) {
  return path.join(root, ".tmp", "pipelines", runID, "reuse-metrics", "events.jsonl")
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
  const evidence = resolveInsideRoot(root, ctx.evidence_path)
  if (!ctx.evidence_path || !evidence || !fs.existsSync(evidence)) return { ok: false as const, reason: "missing_delta" }
  if (!ctx.previous_state_revision || ctx.previous_state_revision !== previous.state_revision) {
    return { ok: false as const, reason: "stale_state" }
  }
  const diff = resolveInsideRoot(root, ctx.diff_path)
  if (!ctx.changed_files.length && !(diff && fs.existsSync(diff))) return { ok: false as const, reason: "missing_delta" }
  for (const item of ctx.required_reread) {
    const resolved = resolveInsideRoot(root, item)
    if (!resolved || !fs.existsSync(resolved)) return { ok: false as const, reason: "stale_evidence" }
  }
  const payload = {
    work_item_id: ctx.work_item_id,
    evidence_path: ctx.evidence_path,
    changed_files: ctx.changed_files,
    diff_path: ctx.diff_path ?? null,
    previous_state_revision: ctx.previous_state_revision,
    state_revision: ctx.state_revision,
    required_reread: ctx.required_reread,
  }
  return { ok: true as const, payload, bytes: byteLength(payload), hash: hashDelta(root, ctx) }
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
    value = { tool_calls: 0, read_calls: 0, grep_calls: 0, glob_calls: 0, edit_calls: 0, shell_calls: 0, files_read: new Set() }
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

export default Plugin.define({
  id: "pipeline-runtime",
  setup: async (plugin) => {
    const root = String(plugin.location.directory)
    const statsBySession = new Map<string, SessionStats>()
    const invocationByCallID = new Map<string, InvocationMeta>()

    await plugin.tool.transform((editor) => {
      editor.add({
        name: "pipeline_runtime_prepare",
        options: { codemode: false },
        description: "Prepare deterministic routing metadata for one pipeline work item before the next matching subagent call.",
        input: prepareInput,
        execute: async (args, context) => {
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
          const now = Date.now()
          const ctx: RuntimeContext = {
            nonce: crypto.randomUUID(), prepared_at: new Date(now).toISOString(),
            expires_at: new Date(now + CONTEXT_TTL_MS).toISOString(),
            parent_session_id: String(context.sessionID), run_id: args.run_id, pipeline_id: args.pipeline_id,
            stage: args.stage, role: args.role, work_item_id: args.work_item_id, loop: args.loop,
            technical_fix: args.technical_fix, state_revision: args.state_revision,
            previous_state_revision: args.previous_state_revision, evidence_path: args.evidence_path,
            changed_files: args.changed_files ?? [], diff_path: args.diff_path,
            required_reread: args.required_reread ?? [],
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
        if (!sessionID || event.tool === "pipeline_runtime_prepare") return
        const stats = getStats(statsBySession, sessionID)
        stats.tool_calls += 1
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
      const role = String(input.agent ?? "")
      const workItemID = extractWorkItemID(input.prompt)

      // V2's sessionID is only a transport handle. The model never chooses which
      // previous child may be resumed; the pipeline registry owns that decision.
      delete input.sessionID
      event.input = input

      if (!sessionID || !workItemID) return
      const ctx = consumeRuntimeContext(root, sessionID, workItemID)
      if (!ctx) return
      const promptBytes = byteLength(input.prompt ?? "")
      const rememberFresh = (reason: string, priorFiles: string[] = []) => {
        invocationByCallID.set(String(event.id), {
          ctx, started_at: Date.now(), decision: "fresh", fallback_reason: reason,
          prompt_bytes: promptBytes, prior_files_read: priorFiles,
        })
        appendJsonLine(metricsFile(root, ctx.run_id), decisionMetric(ctx, role, "fresh", reason))
      }

      if (!contextIsFresh(ctx)) return rememberFresh("stale_runtime_context")
      if (ctx.parent_session_id !== sessionID) return rememberFresh("parent_session_mismatch")
      if (ctx.work_item_id !== workItemID) return rememberFresh("work_item_mismatch")
      if (role !== ctx.role) return rememberFresh("role_mismatch")
      if (!ELIGIBLE_ROLES.has(role)) return rememberFresh("not_eligible")

      const registry = loadRegistry(root, ctx.run_id)
      const match = registry.find((item) =>
        item.run_id === ctx.run_id && item.pipeline_id === ctx.pipeline_id &&
        item.stage === ctx.stage && item.role === role && item.work_item_id === ctx.work_item_id)

      if (!ctx.technical_fix) return rememberFresh("baseline")
      if (!match) return rememberFresh("no_prior_session")
      if (match.status !== "healthy") return rememberFresh(match.status, match.files_read ?? [])

      const delta = validateReuseDelta(root, ctx, match)
      if (!delta.ok) {
        if (delta.reason === "stale_state") {
          match.status = "stale"; match.updated_at = new Date().toISOString(); saveRegistry(root, ctx.run_id, registry)
        }
        return rememberFresh(delta.reason, match.files_read ?? [])
      }

      input.sessionID = match.session_id
      input.prompt = [
        String(input.prompt ?? ""), "", "<session_reuse_delta>",
        JSON.stringify(delta.payload, null, 2), "</session_reuse_delta>",
        "Re-read the evidence and required paths above. Prior conversation memory is supplemental; repository state and evidence remain authoritative.",
      ].join("\n")
      event.input = input
      invocationByCallID.set(String(event.id), {
        ctx, started_at: Date.now(), decision: "reuse", prompt_bytes: byteLength(input.prompt),
        packet_bytes: delta.bytes, prior_files_read: match.files_read ?? [],
      })
      match.status = "in_progress"; match.updated_at = new Date().toISOString(); saveRegistry(root, ctx.run_id, registry)
      appendJsonLine(metricsFile(root, ctx.run_id), {
        ...decisionMetric(ctx, role, "reuse"), session_id: match.session_id,
        packet_bytes: delta.bytes, delta_hash: delta.hash, call_id: String(event.id),
      })
    })

    await plugin.tool.hook("execute.after", async (event) => {
      if (event.tool !== "subagent") return
      const callID = String(event.id)
      const invocation = invocationByCallID.get(callID)
      if (!invocation) return
      const ctx = invocation.ctx
      const role = String((event.input as any)?.agent ?? ctx.role)
      const reusedID = String((event.input as any)?.sessionID ?? "")
      const resultID = event.status === "completed" ? String(event.result?.metadata?.sessionID ?? "") : ""
      const childID = resultID || reusedID
      const registry = loadRegistry(root, ctx.run_id)
      const previous = registry.find((item) =>
        item.run_id === ctx.run_id && item.pipeline_id === ctx.pipeline_id &&
        item.stage === ctx.stage && item.role === role && item.work_item_id === ctx.work_item_id)
      const now = new Date().toISOString()
      const sessionStats = childID ? statsBySession.get(childID) : undefined
      const currentFiles = [...(sessionStats?.files_read ?? new Set<string>())]
      const priorFiles = new Set(invocation.prior_files_read)
      const rereadFiles = currentFiles.filter((file) => priorFiles.has(file))

      if (event.status === "completed" && childID) {
        const next: RegistryEntry = {
          run_id: ctx.run_id, pipeline_id: ctx.pipeline_id, stage: ctx.stage, role,
          work_item_id: ctx.work_item_id, session_id: childID, status: "healthy",
          state_revision: ctx.state_revision, evidence_path: ctx.evidence_path,
          last_delta_hash: hashDelta(root, ctx),
          files_read: currentFiles.length ? currentFiles : previous?.files_read ?? [], updated_at: now,
        }
        saveRegistry(root, ctx.run_id, [
          ...registry.filter((item) => !(item.run_id === next.run_id && item.pipeline_id === next.pipeline_id &&
            item.stage === next.stage && item.role === next.role && item.work_item_id === next.work_item_id)),
          next,
        ])
      } else if (previous && invocation.decision === "reuse") {
        previous.status = "error"; previous.updated_at = now; saveRegistry(root, ctx.run_id, registry)
      }

      appendJsonLine(metricsFile(root, ctx.run_id), {
        timestamp: now, event: "subagent_complete", identity: identity(ctx, role), call_id: callID,
        decision: invocation.decision, fallback_reason: invocation.fallback_reason ?? null,
        session_id: childID || null, session_health: event.status === "completed" ? "healthy" : "error",
        latency_ms: Date.now() - invocation.started_at,
        orientation_ms: sessionStats?.first_meaningful_at ? sessionStats.first_meaningful_at - invocation.started_at : null,
        prompt_bytes: invocation.prompt_bytes,
        response_bytes: event.status === "completed" ? byteLength(event.result?.content ?? event.result?.output ?? "") : 0,
        packet_bytes: invocation.packet_bytes ?? null,
        tool_calls: sessionStats?.tool_calls ?? null, read_calls: sessionStats?.read_calls ?? null,
        grep_calls: sessionStats?.grep_calls ?? null, glob_calls: sessionStats?.glob_calls ?? null,
        edit_calls: sessionStats?.edit_calls ?? null, shell_calls: sessionStats?.shell_calls ?? null,
        unique_files_read: currentFiles.length, reread_files: rereadFiles, reread_file_count: rereadFiles.length,
        context_reread_ratio: currentFiles.length ? rereadFiles.length / currentFiles.length : null,
      })
      invocationByCallID.delete(callID)
      if (childID) statsBySession.delete(childID)
    })
  },
})
