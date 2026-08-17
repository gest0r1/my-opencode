import { type Plugin, tool } from "@opencode-ai/plugin"
import fs from "node:fs"
import path from "node:path"
import crypto from "node:crypto"

const ELIGIBLE_ROLES = new Set([
  "CoderAgent",
  "coder-agent",
  "TestEngineer",
  "tester",
  "BuildAgent",
  "build-agent",
])

const CONTEXT_TTL_MS = 5 * 60 * 1000

type SessionHealth = "healthy" | "in_progress" | "compacted" | "error" | "cancelled" | "stale"

type RegistryEntry = {
  run_id: string
  pipeline_id: string
  stage: string
  role: string
  task_id: string
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
  pilot_pipeline_id: string
  run_id: string
  pipeline_id: string
  stage: string
  role: string
  loop: number
  technical_fix: boolean
  state_revision: string
  previous_state_revision?: string
  evidence_path?: string
  changed_files: string[]
  diff_path?: string
  required_reread: string[]
}

type SessionStats = {
  tool_calls: number
  read_calls: number
  grep_calls: number
  glob_calls: number
  edit_calls: number
  bash_calls: number
  files_read: Set<string>
  first_meaningful_at?: number
}

type InvocationMeta = {
  ctx: RuntimeContext
  started_at: number
  decision: "fresh" | "reuse"
  fallback_reason?: string
  prompt_bytes: number
  packet_bytes?: number
  prior_files_read: string[]
  expected_task_id?: string
}

function safeJson(file: string): any | undefined {
  try {
    return JSON.parse(fs.readFileSync(file, "utf8"))
  } catch {
    return undefined
  }
}

function ensureDir(dir: string) {
  fs.mkdirSync(dir, { recursive: true })
}

function appendJsonLine(file: string, value: unknown) {
  ensureDir(path.dirname(file))
  fs.appendFileSync(file, JSON.stringify(value) + "\n", "utf8")
}

function sha256(value: string | Buffer) {
  return crypto.createHash("sha256").update(value).digest("hex")
}

function byteLength(value: unknown) {
  return Buffer.byteLength(typeof value === "string" ? value : JSON.stringify(value ?? null), "utf8")
}

function runtimeContextPath(root: string) {
  return path.join(root, ".tmp", "pipeline-runtime-context.json")
}

function registryPath(root: string, runID: string) {
  return path.join(root, ".tmp", "pipelines", runID, "session-registry.json")
}

function metricsFile(root: string, runID: string) {
  return path.join(root, ".tmp", "pipelines", runID, "reuse-metrics", "events.jsonl")
}

function loadRegistry(root: string, runID: string): RegistryEntry[] {
  return safeJson(registryPath(root, runID)) ?? []
}

function saveRegistry(root: string, runID: string, entries: RegistryEntry[]) {
  const file = registryPath(root, runID)
  ensureDir(path.dirname(file))
  fs.writeFileSync(file, JSON.stringify(entries, null, 2) + "\n", "utf8")
}

function consumeRuntimeContext(root: string): RuntimeContext | undefined {
  const file = runtimeContextPath(root)
  const ctx = safeJson(file) as RuntimeContext | undefined
  try {
    fs.unlinkSync(file)
  } catch {
    // One-shot context: absence is a safe fresh-session fallback.
  }
  return ctx
}

function identity(ctx: RuntimeContext, role = ctx.role) {
  return [ctx.run_id, ctx.pipeline_id, ctx.stage, role].join(":")
}

function resolveInsideRoot(root: string, candidate?: string) {
  if (!candidate) return undefined
  return path.isAbsolute(candidate) ? candidate : path.resolve(root, candidate)
}

function contextIsFresh(ctx: RuntimeContext) {
  const expires = Date.parse(ctx.expires_at)
  return Number.isFinite(expires) && Date.now() <= expires
}

function hashDelta(root: string, ctx: RuntimeContext) {
  let diffHash: string | null = null
  if (ctx.diff_path) {
    const diff = resolveInsideRoot(root, ctx.diff_path)
    if (diff && fs.existsSync(diff)) diffHash = sha256(fs.readFileSync(diff))
  }
  return sha256(
    JSON.stringify({
      evidence_path: ctx.evidence_path ?? null,
      changed_files: ctx.changed_files,
      diff_path: ctx.diff_path ?? null,
      diff_hash: diffHash,
      state_revision: ctx.state_revision,
      previous_state_revision: ctx.previous_state_revision ?? null,
      required_reread: ctx.required_reread,
    }),
  )
}

function validateReuseDelta(root: string, ctx: RuntimeContext, previous: RegistryEntry) {
  const evidence = resolveInsideRoot(root, ctx.evidence_path)
  if (!ctx.evidence_path || !evidence || !fs.existsSync(evidence)) {
    return { ok: false as const, reason: "missing_delta" }
  }
  if (!ctx.previous_state_revision || ctx.previous_state_revision !== previous.state_revision) {
    return { ok: false as const, reason: "stale_state" }
  }

  const diff = resolveInsideRoot(root, ctx.diff_path)
  const hasDiff = Boolean(diff && fs.existsSync(diff))
  if (!ctx.changed_files.length && !hasDiff) {
    return { ok: false as const, reason: "missing_delta" }
  }

  for (const item of ctx.required_reread) {
    const resolved = resolveInsideRoot(root, item)
    if (!resolved || !fs.existsSync(resolved)) {
      return { ok: false as const, reason: "stale_evidence" }
    }
  }

  const payload = {
    evidence_path: ctx.evidence_path,
    changed_files: ctx.changed_files,
    diff_path: ctx.diff_path ?? null,
    previous_state_revision: ctx.previous_state_revision,
    state_revision: ctx.state_revision,
    required_reread: ctx.required_reread,
  }

  return {
    ok: true as const,
    payload,
    bytes: byteLength(payload),
    hash: hashDelta(root, ctx),
  }
}

function fileFromArgs(args: any): string | undefined {
  const value = args?.filePath ?? args?.file_path ?? args?.path
  return typeof value === "string" ? value : undefined
}

function isMeaningfulTool(toolName: string, args: any) {
  if (toolName === "edit" || toolName === "write" || toolName === "patch" || toolName === "apply_patch") return true
  if (toolName !== "bash") return false
  const command = String(args?.command ?? "").toLowerCase()
  return /(\btest\b|vitest|jest|pytest|playwright|typecheck|tsc\b|\bbuild\b)/.test(command)
}

function getStats(stats: Map<string, SessionStats>, sessionID: string) {
  let current = stats.get(sessionID)
  if (!current) {
    current = {
      tool_calls: 0,
      read_calls: 0,
      grep_calls: 0,
      glob_calls: 0,
      edit_calls: 0,
      bash_calls: 0,
      files_read: new Set<string>(),
    }
    stats.set(sessionID, current)
  }
  return current
}

function decisionMetric(ctx: RuntimeContext, role: string, decision: "fresh" | "reuse", fallbackReason?: string) {
  return {
    timestamp: new Date().toISOString(),
    event: "reuse_decision",
    identity: identity(ctx, role),
    run_id: ctx.run_id,
    pipeline_id: ctx.pipeline_id,
    stage: ctx.stage,
    role,
    loop: ctx.loop,
    decision,
    fallback_reason: fallbackReason ?? null,
  }
}

export const PipelineRuntimePlugin: Plugin = async ({ directory }) => {
  const root = directory
  const statsBySession = new Map<string, SessionStats>()
  const invocationByIdentity = new Map<string, InvocationMeta>()
  const invalidatedSessions = new Map<string, SessionHealth>()

  return {
    tool: {
      pipeline_runtime_prepare: tool({
        description:
          "Prepare one-shot runtime metadata for the next CoderAgent/TestEngineer/BuildAgent task in the explicitly enabled session-reuse pilot. Call immediately before task().",
        args: {
          pilot_pipeline_id: tool.schema.string(),
          run_id: tool.schema.string(),
          pipeline_id: tool.schema.string(),
          stage: tool.schema.string(),
          role: tool.schema.string(),
          loop: tool.schema.number(),
          technical_fix: tool.schema.boolean(),
          state_revision: tool.schema.string(),
          previous_state_revision: tool.schema.string().optional(),
          evidence_path: tool.schema.string().optional(),
          changed_files: tool.schema.array(tool.schema.string()).optional(),
          diff_path: tool.schema.string().optional(),
          required_reread: tool.schema.array(tool.schema.string()).optional(),
        },
        async execute(args) {
          if (args.pilot_pipeline_id !== args.pipeline_id) {
            return "rejected: pilot_pipeline_id does not match pipeline_id; next task will run fresh"
          }
          if (!ELIGIBLE_ROLES.has(args.role)) {
            return "rejected: role is not eligible for session reuse; next task will run fresh"
          }

          const now = Date.now()
          const ctx: RuntimeContext = {
            nonce: crypto.randomUUID(),
            prepared_at: new Date(now).toISOString(),
            expires_at: new Date(now + CONTEXT_TTL_MS).toISOString(),
            pilot_pipeline_id: args.pilot_pipeline_id,
            run_id: args.run_id,
            pipeline_id: args.pipeline_id,
            stage: args.stage,
            role: args.role,
            loop: args.loop,
            technical_fix: args.technical_fix,
            state_revision: args.state_revision,
            previous_state_revision: args.previous_state_revision,
            evidence_path: args.evidence_path,
            changed_files: args.changed_files ?? [],
            diff_path: args.diff_path,
            required_reread: args.required_reread ?? [],
          }

          const file = runtimeContextPath(root)
          ensureDir(path.dirname(file))
          fs.writeFileSync(file, JSON.stringify(ctx, null, 2) + "\n", "utf8")
          return `prepared ${ctx.nonce} for ${identity(ctx)}; technical_fix=${ctx.technical_fix}`
        },
      }),
    },

    "tool.execute.before": async (input: any, output: any) => {
      const sessionID = String(input.sessionID ?? input.sessionId ?? "")

      if (input.tool !== "task") {
        if (!sessionID || input.tool === "pipeline_runtime_prepare") return
        const stats = getStats(statsBySession, sessionID)
        stats.tool_calls += 1
        if (input.tool === "read") {
          stats.read_calls += 1
          const file = fileFromArgs(output.args)
          if (file) stats.files_read.add(path.resolve(root, file))
        } else if (input.tool === "grep") {
          stats.grep_calls += 1
        } else if (input.tool === "glob") {
          stats.glob_calls += 1
        } else if (["edit", "write", "patch", "apply_patch"].includes(input.tool)) {
          stats.edit_calls += 1
        } else if (input.tool === "bash") {
          stats.bash_calls += 1
        }
        if (!stats.first_meaningful_at && isMeaningfulTool(input.tool, output.args)) {
          stats.first_meaningful_at = Date.now()
        }
        return
      }

      const args = output.args ?? {}
      const role = String(args.subagent_type ?? "")

      // A model-supplied handle is never trusted. Runtime owns task_id completely.
      delete args.task_id

      const ctx = consumeRuntimeContext(root)
      if (!ctx) return
      const id = identity(ctx, role)
      const promptBytesBeforeDelta = byteLength(args.prompt ?? "")

      const rememberFresh = (reason: string, priorFiles: string[] = []) => {
        invocationByIdentity.set(id, {
          ctx,
          started_at: Date.now(),
          decision: "fresh",
          fallback_reason: reason,
          prompt_bytes: promptBytesBeforeDelta,
          prior_files_read: priorFiles,
        })
        appendJsonLine(metricsFile(root, ctx.run_id), decisionMetric(ctx, role, "fresh", reason))
      }

      if (!contextIsFresh(ctx)) return rememberFresh("stale_runtime_context")
      if (ctx.pilot_pipeline_id !== ctx.pipeline_id) return rememberFresh("cross_pipeline_reject")
      if (role !== ctx.role) return rememberFresh("handle_mismatch")
      if (!ELIGIBLE_ROLES.has(role)) return rememberFresh("not_eligible")

      const registry = loadRegistry(root, ctx.run_id)
      const match = registry
        .filter(
          (item) =>
            item.run_id === ctx.run_id &&
            item.pipeline_id === ctx.pipeline_id &&
            item.stage === ctx.stage &&
            item.role === role,
        )
        .sort((a, b) => b.updated_at.localeCompare(a.updated_at))[0]

      // Baseline/first fix calls are intentionally fresh but are registered after completion.
      if (!ctx.technical_fix) return rememberFresh("baseline")
      if (!match) return rememberFresh("no_prior_session")
      if (match.status !== "healthy") return rememberFresh(match.status, match.files_read ?? [])

      const delta = validateReuseDelta(root, ctx, match)
      if (!delta.ok) {
        if (delta.reason === "stale_state") {
          match.status = "stale"
          match.updated_at = new Date().toISOString()
          saveRegistry(root, ctx.run_id, registry)
        }
        return rememberFresh(delta.reason, match.files_read ?? [])
      }

      args.task_id = match.task_id
      args.prompt = [
        args.prompt ?? "",
        "\n\n<session_reuse_delta>",
        JSON.stringify(delta.payload, null, 2),
        "</session_reuse_delta>",
        "Re-read the evidence and required paths above. Treat prior conversation memory as supplemental context, never as the source of truth.",
      ].join("\n")

      invocationByIdentity.set(id, {
        ctx,
        started_at: Date.now(),
        decision: "reuse",
        prompt_bytes: byteLength(args.prompt),
        packet_bytes: delta.bytes,
        prior_files_read: match.files_read ?? [],
        expected_task_id: match.task_id,
      })

      match.status = "in_progress"
      match.updated_at = new Date().toISOString()
      saveRegistry(root, ctx.run_id, registry)
      appendJsonLine(metricsFile(root, ctx.run_id), {
        ...decisionMetric(ctx, role, "reuse"),
        task_id: match.task_id,
        packet_bytes: delta.bytes,
        delta_hash: delta.hash,
      })
    },

    "tool.execute.after": async (input: any, output: any) => {
      if (input.tool !== "task") return
      const role = String(input.args?.subagent_type ?? "")
      if (!role) return

      const invocation = [...invocationByIdentity.values()]
        .filter((item) => item.ctx.role === role)
        .sort((a, b) => b.started_at - a.started_at)[0]
      if (!invocation) return

      const ctx = invocation.ctx
      const id = identity(ctx, role)
      const taskID = String(output?.metadata?.sessionId ?? output?.metadata?.jobId ?? input.args?.task_id ?? "")
      const now = new Date().toISOString()
      const registry = loadRegistry(root, ctx.run_id)
      const previous = registry.find(
        (item) =>
          item.run_id === ctx.run_id &&
          item.pipeline_id === ctx.pipeline_id &&
          item.stage === ctx.stage &&
          item.role === role,
      )
      const sessionStats = taskID ? statsBySession.get(taskID) : undefined
      const currentFiles = [...(sessionStats?.files_read ?? new Set<string>())]
      const priorFiles = new Set(invocation.prior_files_read)
      const rereadFiles = currentFiles.filter((file) => priorFiles.has(file))
      const finalHealth = taskID ? invalidatedSessions.get(taskID) ?? "healthy" : "error"

      if (taskID) {
        const next: RegistryEntry = {
          run_id: ctx.run_id,
          pipeline_id: ctx.pipeline_id,
          stage: ctx.stage,
          role,
          task_id: taskID,
          status: finalHealth,
          state_revision: ctx.state_revision,
          evidence_path: ctx.evidence_path,
          last_delta_hash: hashDelta(root, ctx),
          files_read: currentFiles.length ? currentFiles : previous?.files_read ?? [],
          updated_at: now,
        }
        const filtered = registry.filter(
          (item) =>
            !(
              item.run_id === next.run_id &&
              item.pipeline_id === next.pipeline_id &&
              item.stage === next.stage &&
              item.role === next.role
            ),
        )
        saveRegistry(root, ctx.run_id, [...filtered, next])
      }

      appendJsonLine(metricsFile(root, ctx.run_id), {
        timestamp: now,
        event: "task_complete",
        identity: id,
        decision: invocation.decision,
        fallback_reason: invocation.fallback_reason ?? null,
        task_id: taskID || null,
        session_health: finalHealth,
        latency_ms: Date.now() - invocation.started_at,
        orientation_ms: sessionStats?.first_meaningful_at
          ? sessionStats.first_meaningful_at - invocation.started_at
          : null,
        prompt_bytes: invocation.prompt_bytes,
        response_bytes: byteLength(output?.output ?? ""),
        packet_bytes: invocation.packet_bytes ?? null,
        tool_calls: sessionStats?.tool_calls ?? null,
        read_calls: sessionStats?.read_calls ?? null,
        grep_calls: sessionStats?.grep_calls ?? null,
        glob_calls: sessionStats?.glob_calls ?? null,
        edit_calls: sessionStats?.edit_calls ?? null,
        bash_calls: sessionStats?.bash_calls ?? null,
        unique_files_read: currentFiles.length,
        reread_files: rereadFiles,
        reread_file_count: rereadFiles.length,
        context_reread_ratio: currentFiles.length ? rereadFiles.length / currentFiles.length : null,
      })

      invocationByIdentity.delete(id)
      if (taskID) statsBySession.delete(taskID)
    },

    event: async ({ event }: any) => {
      if (event.type !== "session.compacted" && event.type !== "session.error") return
      const sessionID = String(event.properties?.sessionID ?? event.properties?.sessionId ?? "")
      if (!sessionID) return
      const health: SessionHealth = event.type === "session.compacted" ? "compacted" : "error"
      invalidatedSessions.set(sessionID, health)

      // Update every known run registry conservatively. In-progress reuse must never survive
      // compaction/error as healthy even if the task after-hook is skipped.
      const pipelinesRoot = path.join(root, ".tmp", "pipelines")
      if (!fs.existsSync(pipelinesRoot)) return
      for (const runID of fs.readdirSync(pipelinesRoot)) {
        const registry = loadRegistry(root, runID)
        let changed = false
        for (const entry of registry) {
          if (entry.task_id !== sessionID) continue
          entry.status = health
          entry.updated_at = new Date().toISOString()
          changed = true
        }
        if (changed) saveRegistry(root, runID, registry)
      }
    },
  }
}

export default PipelineRuntimePlugin
