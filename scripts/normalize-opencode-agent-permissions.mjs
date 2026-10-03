#!/usr/bin/env node
import fs from 'node:fs'
import path from 'node:path'

const [configFile, agentsDir] = process.argv.slice(2)
if (!configFile || !agentsDir) {
  console.error('Usage: normalize-opencode-agent-permissions.mjs OPENCODE_JSON AGENTS_DIR')
  process.exit(2)
}

const aliases = new Map(Object.entries({
  contextscout: 'ContextScout',
  externalscout: 'ExternalScout',
  coderagent: 'CoderAgent',
  'coder-agent': 'CoderAgent',
  taskmanager: 'TaskManager',
  'task-manager': 'TaskManager',
  docwriter: 'DocWriter',
  documentation: 'DocWriter',
  testengineer: 'TestEngineer',
  tester: 'TestEngineer',
  'test-engineer': 'TestEngineer',
  codereviewer: 'CodeReviewer',
  reviewer: 'CodeReviewer',
  buildagent: 'BuildAgent',
  'build-agent': 'BuildAgent',
  batchexecutor: 'BatchExecutor',
  webresearcher: 'WebResearcher',
  'stage-orchestrator': 'StageOrchestrator',
  'devops-specialist': 'OpenDevopsSpecialist',
  'frontend-specialist': 'OpenFrontendSpecialist',
  agentgenerator: 'AgentGenerator',
  commandcreator: 'CommandCreator',
  domainanalyzer: 'DomainAnalyzer',
  workflowdesigner: 'WorkflowDesigner',
  contextorganizer: 'ContextOrganizer',
  'story-mapper': 'StoryMapper',
  'senior-story-reviewer': 'SeniorStoryReviewer',
  'architecture-analyzer': 'ArchitectureAnalyzer',
  'contract-manager': 'ContractManager',
  'prioritization-engine': 'PrioritizationEngine',
  'senior-technical-plan-reviewer': 'SeniorTechnicalPlanReviewer',
}))

function frontmatterLines(text) {
  const lines = text.split(/\r?\n/)
  if (lines[0] !== '---') return { lines, end: -1 }
  const end = lines.indexOf('---', 1)
  return { lines, end }
}

function readAgent(file) {
  const text = fs.readFileSync(file, 'utf8')
  const { lines, end } = frontmatterLines(text)
  if (end < 0) throw new Error(`Agent has no closed frontmatter: ${file}`)
  const head = lines.slice(1, end)
  const mode = head.map((line) => /^mode:\s*(\S+)\s*$/.exec(line)?.[1]).find(Boolean)
  const hasPermission = head.some((line) => /^permission:\s*$/.test(line))
  return { text, lines, end, mode, hasPermission }
}

const files = fs.readdirSync(agentsDir)
  .filter((name) => name.endsWith('.md'))
  .sort()

const catalog = new Map()
for (const name of files) {
  const id = name.slice(0, -3)
  const file = path.join(agentsDir, name)
  const info = readAgent(file)
  if (catalog.has(id)) throw new Error(`Duplicate managed agent ID: ${id}`)
  catalog.set(id, { id, file, ...info })
}

function parseTaskEntry(line) {
  const match = /^(\s{4,})(?:"([^"]+)"|'([^']+)'|([^:#]+)):\s*(allow|deny|ask)(\s*(?:#.*)?)$/.exec(line)
  if (!match) return undefined
  return {
    indent: match[1],
    resource: (match[2] ?? match[3] ?? match[4]).trim(),
    effect: match[5],
    suffix: match[6] ?? '',
  }
}

function renderTaskEntry(entry) {
  const key = entry.resource === '*' ? '"*"' : entry.resource
  return `${entry.indent}${key}: ${entry.effect}${entry.suffix}`
}

function normalizeTaskBlock(info) {
  const source = [...info.lines]
  const out = []
  let changed = false

  for (let index = 0; index < source.length;) {
    const line = source[index]
    if (index > 0 && index < info.end && /^  task:\s*$/.test(line)) {
      out.push(line)
      let end = index + 1
      while (end < info.end && !/^  \S/.test(source[end])) end++

      const block = source.slice(index + 1, end)
      const normalized = []
      const seen = new Set()
      for (const rawLine of block) {
        const entry = parseTaskEntry(rawLine)
        if (!entry) {
          normalized.push(rawLine)
          continue
        }

        const original = entry.resource
        entry.resource = aliases.get(entry.resource) ?? entry.resource
        if (entry.effect === 'allow' && catalog.get(entry.resource)?.mode === 'primary') {
          console.log(`Removed invalid subagent allow: ${path.basename(info.file)} -> ${entry.resource} (primary)`)
          changed = true
          continue
        }

        const key = `${entry.resource}\0${entry.effect}`
        if (seen.has(key)) {
          changed = true
          continue
        }
        seen.add(key)
        if (entry.resource !== original) {
          console.log(`Normalized subagent alias: ${path.basename(info.file)} ${original} -> ${entry.resource}`)
          changed = true
        }
        normalized.push(renderTaskEntry(entry))
      }

      // OpenCode 2.0.21 permission evaluation is last-match-wins. Catch-all
      // task rules therefore must precede specific allows/denies, otherwise a
      // trailing "*": deny silently revokes every allow above it.
      const firstEntry = normalized.findIndex((candidate) => parseTaskEntry(candidate))
      const wildcardIndex = normalized.findIndex((candidate) => parseTaskEntry(candidate)?.resource === '*')
      if (firstEntry >= 0 && wildcardIndex > firstEntry) {
        const [wildcard] = normalized.splice(wildcardIndex, 1)
        normalized.splice(firstEntry, 0, wildcard)
        changed = true
      }

      out.push(...normalized)
      index = end
      continue
    }

    out.push(line)
    index++
  }

  if (changed) fs.writeFileSync(info.file, `${out.join('\n').replace(/\n+$/, '')}\n`)
  return changed
}

let markdownChanges = 0
for (const info of catalog.values()) {
  if (normalizeTaskBlock(info)) markdownChanges++
}

function normalizeConfigPermissions(id, permissions) {
  if (!Array.isArray(permissions)) return { permissions, changed: false }
  const firstSubagent = permissions.findIndex((rule) => rule?.action === 'subagent')
  if (firstSubagent < 0) return { permissions, changed: false }

  let changed = false
  const subagent = []
  const seen = new Set()
  for (const rule of permissions.filter((candidate) => candidate?.action === 'subagent')) {
    const next = { ...rule }
    const original = next.resource
    next.resource = aliases.get(next.resource) ?? next.resource
    if (next.resource !== original) changed = true
    if (next.effect === 'allow' && catalog.get(next.resource)?.mode === 'primary') {
      console.log(`Removed invalid config subagent allow: ${id} -> ${next.resource} (primary)`)
      changed = true
      continue
    }
    const key = `${next.action}\0${next.resource}\0${next.effect}`
    if (seen.has(key)) {
      changed = true
      continue
    }
    seen.add(key)
    subagent.push(next)
  }

  const wildcard = subagent.filter((rule) => rule.resource === '*')
  const specific = subagent.filter((rule) => rule.resource !== '*')
  const ordered = [...wildcard, ...specific]
  if (JSON.stringify(ordered) !== JSON.stringify(permissions.filter((rule) => rule?.action === 'subagent'))) changed = true

  const before = permissions.slice(0, firstSubagent).filter((rule) => rule?.action !== 'subagent')
  const after = permissions.slice(firstSubagent).filter((rule) => rule?.action !== 'subagent')
  return { permissions: [...before, ...ordered, ...after], changed }
}

const config = JSON.parse(fs.readFileSync(configFile, 'utf8'))
let configChanges = 0
for (const [id, info] of catalog) {
  const entry = config.agents?.[id]
  if (!entry || typeof entry !== 'object' || Array.isArray(entry)) continue

  if (info.mode && entry.mode !== info.mode) {
    entry.mode = info.mode
    configChanges++
  }

  // Agent Markdown owns its permission policy when it declares permission:.
  // Keeping a second normalized ruleset in opencode.json caused stale aliases,
  // default-primary agents during activation, and last-match shadowing.
  if (info.hasPermission && Object.hasOwn(entry, 'permissions')) {
    delete entry.permissions
    configChanges++
    continue
  }

  if (Object.hasOwn(entry, 'permissions')) {
    const normalized = normalizeConfigPermissions(id, entry.permissions)
    if (normalized.changed) {
      entry.permissions = normalized.permissions
      configChanges++
    }
  }
}

if (configChanges) fs.writeFileSync(configFile, `${JSON.stringify(config, null, 2)}\n`)
console.log(`Agent permission normalization complete: agents=${catalog.size} markdown_changed=${markdownChanges} config_changes=${configChanges}`)
