import type { Plugin } from "@opencode-ai/plugin"
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
  last_diff_hash?: string
  files_read?: string[]
  updated_at: string
}

type RuntimeContext = {
  run_id?: string
  pipeline_id?: string
  stage?: string
  role?: string
  loop?: number
  technical_fix?: boolean
  state_revision?: string
  evidence_path?: string
  changed_files?: string[]
  required_reread?: string[]
}

type SessionStats = {
  started_at: number
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

function sha256(value: string) {
  return crypto.createHash("sha256").update(value).digest("hex")
}

function byteLength(value: unknown) {
  return Buffer.byteLength(typeof value === "string" ? value : JSON.stringify(value ?? null), "utf8")
}

function runtimeContextPath(root: string) {
  return path.join(root, ".tmp", "pipeline-runtime-context.json")
}

function loadRuntimeContext(root: string): RuntimeContext | undefined {
  return safeJson(runtimeContextPath(root))
}

function registryPath(root: string, runID: string) {
  return path.join(root, ".tmp", "pipelines", runID, "session-registry.json")
}

function loadRegistry(root: string, runID: string): RegistryEntry[] {
  return safeJson(registryPath(root, runID)) ?? []
}

function saveRegistry(root: string, runID: string, entries: RegistryEntry[]) {
  const file = registryPath(root, runID)
  ensureDir(path.dirname(file))
  fs.writeFileSync(file, JSON.stringify(entries, null, 2) + "\n", "utf8")
}

function metricsFile(root: string, runID: string) {
  return path.join(root, ".tmp", "pipelines", runID, "reuse-metrics", "events.jsonl")
}

function identity(ctx: RuntimeContext, role: string) {
  return [ctx.run_id, ctx.pipeline_id, ctx.stage, role].join(":")
}

function resolveInsideRoot(root: string, candidate?: string) {
  if (!candidate) return undefined
  return path.isAbsolute(candidate) ? candidate : path.resolve(root, candidate)
}

function validateDelta(root: string, ctx: RuntimeContext) {
  const evidence = resolveInsideRoot(root, ctx.evidence_path)
  if (!ctx.state_revision || !evidence || !fs.existsSync(evidence)) {
    return { ok: false as const, reason: "missing_delta" }
  }

  for (const item of ctx.required_reread ?? []) {
    const resolved = resolveInsideRoot(root, item)
    if (!resolved || !fs.existsSync(resolved)) {
      return { ok: false as const, reason: "stale_evidence" }
    }
  }

  const payload = {
    evidence_path: ctx.evidence_path,
    changed_files: ctx.changed_files ?? [],
    state_revision: ctx.state_revision,
    required_reread: ctx.required_reread ?? [],
  }

  return {
    ok: true as const,
    payload,
    bytes: byteLength(payload),
    hash: sha256(JSON.stringify(payload)),
  }
}

function fileFromArgs(args: any): string | undefined {
  const value = args?.filePath ?? args?.file_path ?? args?.path
  return typeof value === "string" ? value : undefined
}

function isMeaningfulTool(tool: string, args: any) {
  if (tool === "edit" || tool === "write") return true
  if (tool !== "bash") return false
  const command = String(args?.command ?? "").toLowerCase()
  return /(\btest\b|vitest|jest|pytest|playwright|typecheck|tsc\b|\bbuild\b)/.test(command)
}

function getStats(stats: Map<string, SessionStats>, sessionID: string) {
  let current = stats.get(sessionID)
  if (!current) {
    current = {
      started_at: Date.now(),
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

export const PipelineRuntimePlugin: Plugin = async ({ directory }) => {
  const root = directory
  const statsBySession = new Map<string, SessionStats>()
  const invocationByIdentity = new Map<string, InvocationMeta>()

  return {
    "tool.execute.before": async (input: any, output: any) => {
      const sessionID = String(input.sessionID ?? input.sessionId ?? "")

      if (input.tool !== "task") {
        if (!sessionID) return
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
        } else if (input.tool === "edit" || input.tool === "write") {
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
      const ctx = loadRuntimeContext(root)
      if (!ctx?.run_id || !ctx.pipeline_id || !ctx.stage) {
        delete args.task_id
        return
      }

      const role = String(args.subagent_type ?? ctx.role ?? "")
      const id = identity(ctx, role)
      const baseMetric = {
        timestamp: new Date().toISOString(),
        identity: id,
        run_id: ctx.run_id,
        pipeline_id: ctx.pipeline_id,
        stage: ctx.stage,
        role,
        loop: ctx.loop ?? null,
      }

      // Never trust a model-provided handle. Runtime owns all resume decisions.
      delete args.task_id

      if (!ctx.technical_fix || !ELIGIBLE_ROLES.has(role)) {
        invocationByIdentity.set(id, {
          started_at: Date.now(),
          decision: "fresh",
          fallback_reason: "not_eligible",
          prompt_bytes: byteLength(args.prompt ?? ""),
          prior_files_read: [],
        })
        appendJsonLine(metricsFile(root, ctx.run_id), {
          ...baseMetric,
          event: "reuse_decision",
          decision: "fresh",
          fallback_reason: "not_eligible",
        })
        return
      }

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

      if (!match) {
        invocationByIdentity.set(id, {
          started_at: Date.now(),
          decision: "fresh",
          fallback_reason: "no_prior_session",
          prompt_bytes: byteLength(args.prompt ?? ""),
          prior_files_read: [],
        })
        appendJsonLine(metricsFile(root, ctx.run_id), {
          ...baseMetric,
          event: "reuse_decision",
          decision: "fresh",
          fallback_reason: "no_prior_session",
        })
        return
      }

      if (match.status !== "healthy") {
        invocationByIdentity.set(id, {
          started_at: Date.now(),
          decision: "fresh",
          fallback_reason: match.status,
          prompt_bytes: byteLength(args.prompt ?? ""),
          prior_files_read: match.files_read ?? [],
        })
        appendJsonLine(metricsFile(root, ctx.run_id), {
          ...baseMetric,
          event: "reuse_decision",
          decision: "fresh",
          fallback_reason: match.status,
        })
        return
      }

      if (ctx.state_revision && match.state_revision && ctx.state_revision !== match.state_revision) {
        match.status = "stale"
        match.updated_at = new Date().toISOString()
        saveRegistry(root, ctx.run_id, registry)
        invocationByIdentity.set(id, {
          started_at: Date.now(),
          decision: "fresh",
          fallback_reason: "stale_state",
          prompt_bytes: byteLength(args.prompt ?? ""),
          prior_files_read: match.files_read ?? [],
        })
        appendJsonLine(metricsFile(root, ctx.run_id), {
          ...baseMetric,
          event: "reuse_decision",
          decision: "fresh",
          fallback_reason: "stale_state",
        })
        return
      }

      const delta = validateDelta(root, ctx)
      if (!delta.ok) {
        invocationByIdentity.set(id, {
          started_at: Date.now(),
          decision: "fresh",
          fallback_reason: delta.reason,
          prompt_bytes: byteLength(args.prompt ?? ""),
          prior_files_read: match.files_read ?? [],
        })
        appendJsonLine(metricsFile(root, ctx.run_id), {
          ...baseMetric,
          event: "reuse_decision",
          decision: "fresh",
          fallback_reason: delta.reason,
        })
        return
      }

      args.task_id = match.task_id
      args.prompt = [
        args.prompt ?? "",
        "\n\n<session_reuse_delta>",
        JSON.stringify(delta.payload, null, 2),
        "</session_reuse_delta>",
        "Re-read the evidence and required paths above. Treat prior conversation memory as supplemental context, not as the source of truth.",
      ].join("\n")

      invocationByIdentity.set(id, {
        started_at: Date.now(),
        decision: "reuse",
        prompt_bytes: byteLength(args.prompt),
        packet_bytes: delta.bytes,
        prior_files_read: match.files_read ?? [],
        expected_task_id: match.task_id,
      })

      // Mark busy before execution. If the call is cancelled/errors and after-hook never runs,
      // this entry cannot be reused on the next attempt.
      match.status = "in_progress"
      match.updated_at = new Date().toISOString()
      saveRegistry(root, ctx.run_id, registry)

      appendJsonLine(metricsFile(root, ctx.run_id), {
        ...baseMetric,
        event: "reuse_decision",
        decision: "reuse",
        task_id: match.task_id,
        packet_bytes: delta.bytes,
        delta_hash: delta.hash,
      })
    },

    "tool.execute.after": async (input: any, output: any) => {
      if (input.tool !== "task") return
      const ctx = loadRuntimeContext(root)
      if (!ctx?.run_id || !ctx.pipeline_id || !ctx.stage) return

      const role = String(input.args?.subagent_type ?? ctx.role ?? "")
      if (!role) return
      const id = identity(ctx, role)
      const invocation = invocationByIdentity.get(id)
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
      const priorFiles = new Set(invocation?.prior_files_read ?? previous?.files_read ?? [])
      const rereadFiles = currentFiles.filter((file) => priorFiles.has(file))

      if (taskID) {
        const next: RegistryEntry = {
          run_id: ctx.run_id,
          pipeline_id: ctx.pipeline_id,
          stage: ctx.stage,
          role,
          task_id: taskID,
          status: "healthy",
          state_revision: ctx.state_revision,
          evidence_path: ctx.evidence_path,
          last_diff_hash: sha256(JSON.stringify(ctx.changed_files ?? [])),
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
        identity: id,
        event: "task_complete",
        decision: invocation?.decision ?? "fresh",
        fallback_reason: invocation?.fallback_reason ?? null,
        task_id: taskID || null,
        latency_ms: invocation ? Date.now() - invocation.started_at : null,
        orientation_ms:
          invocation && sessionStats?.first_meaningful_at
            ? sessionStats.first_meaningful_at - invocation.started_at
            : null,
        prompt_bytes: invocation?.prompt_bytes ?? byteLength(input.args?.prompt ?? ""),
        response_bytes: byteLength(output?.output ?? ""),
        packet_bytes: invocation?.packet_bytes ?? null,
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
      const ctx = loadRuntimeContext(root)
      if (!ctx?.run_id) return
      if (event.type !== "session.compacted" && event.type !== "session.error") return

      const sessionID = String(event.properties?.sessionID ?? event.properties?.sessionId ?? "")
      if (!sessionID) return
      const registry = loadRegistry(root, ctx.run_id)
      let changed = false
      for (const entry of registry) {
        if (entry.task_id !== sessionID) continue
        entry.status = event.type === "session.compacted" ? "compacted" : "error"
        entry.updated_at = new Date().toISOString()
        changed = true
      }
      if (changed) saveRegistry(root, ctx.run_id, registry)
    },
  }
}

export default PipelineRuntimePlugin
