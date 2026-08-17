import type { Plugin } from "@opencode-ai/plugin"
import fs from "node:fs"
import path from "node:path"
import crypto from "node:crypto"

const ELIGIBLE_ROLES = new Set(["CoderAgent", "coder-agent", "TestEngineer", "tester", "BuildAgent", "build-agent"])

type RegistryEntry = {
  run_id: string
  pipeline_id: string
  stage: string
  role: string
  task_id: string
  status: "healthy" | "compacted" | "error" | "cancelled" | "stale"
  state_revision?: string
  evidence_path?: string
  last_diff_hash?: string
  updated_at: string
}

type RuntimeContext = {
  run_id?: string
  pipeline_id?: string
  stage?: string
  role?: string
  loop?: number
  technical_fix?: boolean
  project_root?: string
  state_revision?: string
  evidence_path?: string
  changed_files?: string[]
  required_reread?: string[]
}

function safeJson(file: string): any | undefined {
  try { return JSON.parse(fs.readFileSync(file, "utf8")) } catch { return undefined }
}

function ensureDir(dir: string) { fs.mkdirSync(dir, { recursive: true }) }

function appendJsonLine(file: string, value: unknown) {
  ensureDir(path.dirname(file))
  fs.appendFileSync(file, JSON.stringify(value) + "\n", "utf8")
}

function sha256(value: string) { return crypto.createHash("sha256").update(value).digest("hex") }

function loadRuntimeContext(projectRoot: string): RuntimeContext | undefined {
  const p = path.join(projectRoot, ".tmp", "pipeline-runtime-context.json")
  return safeJson(p)
}

function registryPath(projectRoot: string, runID: string) {
  return path.join(projectRoot, ".tmp", "pipelines", runID, "session-registry.json")
}

function loadRegistry(projectRoot: string, runID: string): RegistryEntry[] {
  return safeJson(registryPath(projectRoot, runID)) ?? []
}

function saveRegistry(projectRoot: string, runID: string, entries: RegistryEntry[]) {
  const p = registryPath(projectRoot, runID)
  ensureDir(path.dirname(p))
  fs.writeFileSync(p, JSON.stringify(entries, null, 2) + "\n")
}

function makeIdentity(ctx: RuntimeContext) {
  return [ctx.run_id, ctx.pipeline_id, ctx.stage, ctx.role].join(":")
}

function buildDelta(ctx: RuntimeContext) {
  const payload = {
    evidence_path: ctx.evidence_path ?? null,
    changed_files: ctx.changed_files ?? [],
    state_revision: ctx.state_revision ?? null,
    required_reread: ctx.required_reread ?? [],
  }
  return {
    payload,
    bytes: Buffer.byteLength(JSON.stringify(payload), "utf8"),
    hash: sha256(JSON.stringify(payload)),
  }
}

function metricsFile(projectRoot: string, runID: string) {
  return path.join(projectRoot, ".tmp", "pipelines", runID, "reuse-metrics", "events.jsonl")
}

export const PipelineRuntimePlugin: Plugin = async ({ directory }) => {
  const root = directory
  const started = new Map<string, number>()

  return {
    "tool.execute.before": async (input: any, output: any) => {
      if (input.tool !== "task") return
      const args = output.args ?? {}
      const ctx = loadRuntimeContext(root)
      if (!ctx?.run_id || !ctx.pipeline_id || !ctx.stage) return

      const role = args.subagent_type ?? ctx.role
      const runtimeCtx: RuntimeContext = { ...ctx, role }
      const identity = makeIdentity(runtimeCtx)
      started.set(identity, Date.now())

      const baseMetric: any = {
        timestamp: new Date().toISOString(),
        identity,
        run_id: ctx.run_id,
        pipeline_id: ctx.pipeline_id,
        stage: ctx.stage,
        role,
        loop: ctx.loop ?? null,
      }

      if (!ctx.technical_fix || !ELIGIBLE_ROLES.has(role)) {
        appendJsonLine(metricsFile(root, ctx.run_id), { ...baseMetric, decision: "fresh", fallback_reason: "not_eligible" })
        delete args.task_id
        return
      }

      const registry = loadRegistry(root, ctx.run_id)
      const match = registry
        .filter((r) => r.run_id === ctx.run_id && r.pipeline_id === ctx.pipeline_id && r.stage === ctx.stage && r.role === role)
        .sort((a, b) => b.updated_at.localeCompare(a.updated_at))[0]

      if (!match) {
        appendJsonLine(metricsFile(root, ctx.run_id), { ...baseMetric, decision: "fresh", fallback_reason: "no_prior_session" })
        delete args.task_id
        return
      }

      if (match.status !== "healthy") {
        appendJsonLine(metricsFile(root, ctx.run_id), { ...baseMetric, decision: "fresh", fallback_reason: match.status })
        delete args.task_id
        return
      }

      if (ctx.state_revision && match.state_revision && ctx.state_revision !== match.state_revision) {
        appendJsonLine(metricsFile(root, ctx.run_id), { ...baseMetric, decision: "fresh", fallback_reason: "stale_state" })
        delete args.task_id
        return
      }

      const delta = buildDelta(runtimeCtx)
      if (!delta.payload.evidence_path || !delta.payload.state_revision) {
        appendJsonLine(metricsFile(root, ctx.run_id), { ...baseMetric, decision: "fresh", fallback_reason: "missing_delta", packet_bytes: delta.bytes })
        delete args.task_id
        return
      }

      args.task_id = match.task_id
      args.prompt = [
        args.prompt ?? "",
        "\n\n<session_reuse_delta>",
        JSON.stringify(delta.payload, null, 2),
        "</session_reuse_delta>",
        "Re-read the listed evidence/paths and use conversation memory only as supplemental context.",
      ].join("\n")
      appendJsonLine(metricsFile(root, ctx.run_id), { ...baseMetric, decision: "reuse", task_id: match.task_id, packet_bytes: delta.bytes, delta_hash: delta.hash })
    },

    "tool.execute.after": async (input: any, output: any) => {
      if (input.tool !== "task") return
      const ctx = loadRuntimeContext(root)
      if (!ctx?.run_id || !ctx.pipeline_id || !ctx.stage) return
      const role = input.args?.subagent_type ?? ctx.role
      if (!role) return
      const identity = [ctx.run_id, ctx.pipeline_id, ctx.stage, role].join(":")
      const taskID = output?.metadata?.sessionId ?? output?.metadata?.jobId
      const registry = loadRegistry(root, ctx.run_id)
      const now = new Date().toISOString()
      const next: RegistryEntry = {
        run_id: ctx.run_id,
        pipeline_id: ctx.pipeline_id,
        stage: ctx.stage,
        role,
        task_id: taskID ?? input.args?.task_id ?? "unknown",
        status: "healthy",
        state_revision: ctx.state_revision,
        evidence_path: ctx.evidence_path,
        last_diff_hash: sha256(JSON.stringify(ctx.changed_files ?? [])),
        updated_at: now,
      }
      const filtered = registry.filter((r) => !(r.run_id === next.run_id && r.pipeline_id === next.pipeline_id && r.stage === next.stage && r.role === next.role))
      if (next.task_id !== "unknown") saveRegistry(root, ctx.run_id, [...filtered, next])
      const t0 = started.get(identity)
      appendJsonLine(metricsFile(root, ctx.run_id), {
        timestamp: now,
        identity,
        event: "task_complete",
        task_id: next.task_id,
        latency_ms: t0 ? Date.now() - t0 : null,
      })
      started.delete(identity)
    },

    event: async ({ event }: any) => {
      const ctx = loadRuntimeContext(root)
      if (!ctx?.run_id) return
      if (event.type === "session.compacted" || event.type === "session.error") {
        const sessionID = event.properties?.sessionID ?? event.properties?.sessionId
        if (!sessionID) return
        const registry = loadRegistry(root, ctx.run_id)
        let changed = false
        for (const entry of registry) {
          if (entry.task_id === sessionID) {
            entry.status = event.type === "session.compacted" ? "compacted" : "error"
            entry.updated_at = new Date().toISOString()
            changed = true
          }
        }
        if (changed) saveRegistry(root, ctx.run_id, registry)
      }
    },
  }
}

export default PipelineRuntimePlugin
