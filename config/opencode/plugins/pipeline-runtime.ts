import { type Plugin, tool } from "@opencode-ai/plugin"
import fs from "node:fs"
import path from "node:path"
import crypto from "node:crypto"

const ELIGIBLE_ROLES = new Set(["CoderAgent", "TestEngineer", "BuildAgent"])
const CONTEXT_TTL_MS = 5 * 60 * 1000
const WORK_ITEM_RE = /^[A-Za-z0-9._:-]{1,128}$/
const WORK_ITEM_MARKER_RE = /<pipeline_work_item\s+id="([A-Za-z0-9._:-]{1,128})"\s*\/?\s*>/

type SessionHealth = "healthy" | "in_progress" | "compacted" | "error" | "cancelled" | "stale"

type RegistryEntry = {
  run_id: string
  pipeline_id: string
  stage: string
  role: string
  work_item_id: string
  task_id: string
  status: SessionHealth
  state_revision: string
  updated_at: string
}

type PreparedContext = {
  expires_at: string
  parent_session_id: string
  run_id: string
  pipeline_id: string
  stage: string
  role: string
  work_item_id: string
  technical_fix: boolean
  state_revision: string
  previous_state_revision?: string
  evidence_path?: string
  changed_files: string[]
  diff_path?: string
  required_reread: string[]
}

type PendingInvocation = {
  ctx: PreparedContext
  decision: "fresh" | "reuse"
  reason: string
}

function readJson<T>(file: string): T | undefined {
  try {
    return JSON.parse(fs.readFileSync(file, "utf8")) as T
  } catch {
    return undefined
  }
}

function ensureDir(dir: string) {
  fs.mkdirSync(dir, { recursive: true })
}

function hash(value: string) {
  return crypto.createHash("sha256").update(value).digest("hex").slice(0, 24)
}

function preparedPath(root: string, parentSessionID: string, workItemID: string) {
  return path.join(root, ".tmp", "pipeline-runtime", hash(parentSessionID), `${hash(workItemID)}.json`)
}

function registryPath(root: string, runID: string) {
  return path.join(root, ".tmp", "pipelines", runID, "session-registry.json")
}

function eventPath(root: string, runID: string) {
  return path.join(root, ".tmp", "pipelines", runID, "session-routing.jsonl")
}

function loadRegistry(root: string, runID: string): RegistryEntry[] {
  const value = readJson<unknown>(registryPath(root, runID))
  return Array.isArray(value) ? (value as RegistryEntry[]) : []
}

function saveRegistry(root: string, runID: string, entries: RegistryEntry[]) {
  const file = registryPath(root, runID)
  ensureDir(path.dirname(file))
  fs.writeFileSync(file, JSON.stringify(entries, null, 2) + "\n", "utf8")
}

function logDecision(root: string, ctx: PreparedContext, decision: "fresh" | "reuse", reason: string, taskID?: string) {
  const file = eventPath(root, ctx.run_id)
  ensureDir(path.dirname(file))
  fs.appendFileSync(
    file,
    JSON.stringify({
      timestamp: new Date().toISOString(),
      run_id: ctx.run_id,
      pipeline_id: ctx.pipeline_id,
      stage: ctx.stage,
      role: ctx.role,
      work_item_id: ctx.work_item_id,
      decision,
      reason,
      task_id: taskID ?? null,
    }) + "\n",
    "utf8",
  )
}

function consumePrepared(root: string, parentSessionID: string, workItemID: string) {
  const file = preparedPath(root, parentSessionID, workItemID)
  const value = readJson<PreparedContext>(file)
  try {
    fs.unlinkSync(file)
  } catch {
    // One-shot metadata. Missing metadata safely means a fresh child.
  }
  return value
}

function isFresh(ctx: PreparedContext) {
  const expires = Date.parse(ctx.expires_at)
  return Number.isFinite(expires) && Date.now() <= expires
}

function extractWorkItemID(prompt: unknown) {
  return typeof prompt === "string" ? WORK_ITEM_MARKER_RE.exec(prompt)?.[1] : undefined
}

function resolveProjectPath(root: string, candidate?: string) {
  if (!candidate) return undefined
  const resolved = path.resolve(root, candidate)
  const projectRoot = path.resolve(root)
  if (resolved !== projectRoot && !resolved.startsWith(projectRoot + path.sep)) return undefined
  return resolved
}

function validateDelta(root: string, ctx: PreparedContext, previous: RegistryEntry) {
  if (!ctx.previous_state_revision || ctx.previous_state_revision !== previous.state_revision) {
    return { ok: false as const, reason: "stale_state" }
  }

  const evidence = resolveProjectPath(root, ctx.evidence_path)
  if (!evidence || !fs.existsSync(evidence)) return { ok: false as const, reason: "missing_evidence" }

  const diff = resolveProjectPath(root, ctx.diff_path)
  const hasDiff = Boolean(diff && fs.existsSync(diff))
  if (!ctx.changed_files.length && !hasDiff) return { ok: false as const, reason: "missing_delta" }

  for (const item of ctx.required_reread) {
    const resolved = resolveProjectPath(root, item)
    if (!resolved || !fs.existsSync(resolved)) return { ok: false as const, reason: "stale_reread_path" }
  }

  return {
    ok: true as const,
    payload: {
      evidence_path: ctx.evidence_path,
      changed_files: ctx.changed_files,
      diff_path: ctx.diff_path ?? null,
      previous_state_revision: ctx.previous_state_revision,
      state_revision: ctx.state_revision,
      required_reread: ctx.required_reread,
    },
  }
}

function sameIdentity(entry: RegistryEntry, ctx: PreparedContext) {
  return (
    entry.run_id === ctx.run_id &&
    entry.pipeline_id === ctx.pipeline_id &&
    entry.stage === ctx.stage &&
    entry.role === ctx.role &&
    entry.work_item_id === ctx.work_item_id
  )
}

function upsertRegistry(root: string, ctx: PreparedContext, taskID: string, status: SessionHealth) {
  const registry = loadRegistry(root, ctx.run_id)
  const next: RegistryEntry = {
    run_id: ctx.run_id,
    pipeline_id: ctx.pipeline_id,
    stage: ctx.stage,
    role: ctx.role,
    work_item_id: ctx.work_item_id,
    task_id: taskID,
    status,
    state_revision: ctx.state_revision,
    updated_at: new Date().toISOString(),
  }
  saveRegistry(root, ctx.run_id, [...registry.filter((item) => !sameIdentity(item, ctx)), next])
}

export const PipelineRuntimePlugin: Plugin = async ({ directory }) => {
  const root = directory
  const pendingByCallID = new Map<string, PendingInvocation>()
  const invalidatedSessions = new Map<string, SessionHealth>()

  return {
    tool: {
      pipeline_runtime_prepare: tool({
        description:
          "Prepare one-shot logical identity for a pipeline child. OpenCode owns session resume; this router only decides whether the exact work item may receive a native task_id.",
        args: {
          run_id: tool.schema.string(),
          pipeline_id: tool.schema.string(),
          stage: tool.schema.string(),
          role: tool.schema.string(),
          work_item_id: tool.schema.string(),
          technical_fix: tool.schema.boolean(),
          state_revision: tool.schema.string(),
          previous_state_revision: tool.schema.string().optional(),
          evidence_path: tool.schema.string().optional(),
          changed_files: tool.schema.array(tool.schema.string()).optional(),
          diff_path: tool.schema.string().optional(),
          required_reread: tool.schema.array(tool.schema.string()).optional(),
        },
        async execute(args, context) {
          if (!ELIGIBLE_ROLES.has(args.role)) return "rejected: role is always fresh"
          if (!WORK_ITEM_RE.test(args.work_item_id)) return "rejected: invalid work_item_id"

          const file = preparedPath(root, context.sessionID, args.work_item_id)
          const current = readJson<PreparedContext>(file)
          if (current && isFresh(current)) return `rejected: work_item_id=${args.work_item_id} already prepared`

          const ctx: PreparedContext = {
            expires_at: new Date(Date.now() + CONTEXT_TTL_MS).toISOString(),
            parent_session_id: context.sessionID,
            run_id: args.run_id,
            pipeline_id: args.pipeline_id,
            stage: args.stage,
            role: args.role,
            work_item_id: args.work_item_id,
            technical_fix: args.technical_fix,
            state_revision: args.state_revision,
            previous_state_revision: args.previous_state_revision,
            evidence_path: args.evidence_path,
            changed_files: args.changed_files ?? [],
            diff_path: args.diff_path,
            required_reread: args.required_reread ?? [],
          }

          ensureDir(path.dirname(file))
          fs.writeFileSync(file, JSON.stringify(ctx, null, 2) + "\n", "utf8")
          return `prepared; next matching task prompt must include <pipeline_work_item id=\"${args.work_item_id}\"/>`
        },
      }),
    },

    "tool.execute.before": async (input: any, output: any) => {
      if (input.tool !== "task") return

      const args = output.args ?? {}
      const workItemID = extractWorkItemID(args.prompt)
      if (!workItemID) return // Non-pipeline task: leave stock OpenCode task_id behavior untouched.

      // A model never selects a session for a pipeline work item. Only this router may inject one.
      delete args.task_id

      const parentSessionID = String(input.sessionID ?? "")
      if (!parentSessionID) return
      const ctx = consumePrepared(root, parentSessionID, workItemID)
      if (!ctx) return

      const callID = String(input.callID ?? "")
      const fresh = (reason: string) => {
        pendingByCallID.set(callID, { ctx, decision: "fresh", reason })
        logDecision(root, ctx, "fresh", reason)
      }

      if (!isFresh(ctx)) return fresh("expired_prepare")
      if (ctx.parent_session_id !== parentSessionID) return fresh("parent_mismatch")
      if (ctx.work_item_id !== workItemID) return fresh("work_item_mismatch")
      if (String(args.subagent_type ?? "") !== ctx.role) return fresh("role_mismatch")
      if (!ELIGIBLE_ROLES.has(ctx.role)) return fresh("role_always_fresh")
      if (!ctx.technical_fix) return fresh("baseline")

      const registry = loadRegistry(root, ctx.run_id)
      const match = registry.find((item) => sameIdentity(item, ctx))
      if (!match) return fresh("no_prior_session")
      if (match.status !== "healthy") return fresh(`prior_${match.status}`)

      const delta = validateDelta(root, ctx, match)
      if (!delta.ok) {
        if (delta.reason === "stale_state") {
          match.status = "stale"
          match.updated_at = new Date().toISOString()
          saveRegistry(root, ctx.run_id, registry)
        }
        return fresh(delta.reason)
      }

      args.task_id = match.task_id
      args.prompt = [
        args.prompt,
        "\n<session_reuse_delta>",
        JSON.stringify(delta.payload),
        "</session_reuse_delta>",
        "Repository state and evidence are authoritative. Re-read the listed evidence/paths before editing.",
      ].join("\n")

      match.status = "in_progress"
      match.updated_at = new Date().toISOString()
      saveRegistry(root, ctx.run_id, registry)
      pendingByCallID.set(callID, { ctx, decision: "reuse", reason: "exact_identity" })
      logDecision(root, ctx, "reuse", "exact_identity", match.task_id)
    },

    "tool.execute.after": async (input: any, output: any) => {
      if (input.tool !== "task") return
      const callID = String(input.callID ?? "")
      const pending = pendingByCallID.get(callID)
      if (!pending) return

      const taskID = String(output?.metadata?.sessionId ?? output?.metadata?.jobId ?? "")
      if (taskID) {
        const status = invalidatedSessions.get(taskID) ?? "healthy"
        upsertRegistry(root, pending.ctx, taskID, status)
      }
      pendingByCallID.delete(callID)
    },

    event: async ({ event }: any) => {
      if (!["session.compacted", "session.error", "session.deleted"].includes(event.type)) return
      const sessionID = String(event.properties?.sessionID ?? event.properties?.sessionId ?? "")
      if (!sessionID) return

      const health: SessionHealth =
        event.type === "session.compacted" ? "compacted" : event.type === "session.deleted" ? "cancelled" : "error"
      invalidatedSessions.set(sessionID, health)

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

export default {
  id: "pipeline-runtime",
  server: PipelineRuntimePlugin,
}
