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

function normalizeTaskBlock(info) {
  const lines = [...info.lines]
  let inTask = false
  const seen = new Set()
  let changed = false
  const out = []

  for (let index = 0; index < lines.length; index++) {
    const line = lines[index]
    if (index === 0 || index > info.end) {
      out.push(line)
      continue
    }

    if (/^  task:\s*$/.test(line)) {
      inTask = true
      seen.clear()
      out.push(line)
      continue
    }
    if (inTask && /^  \S/.test(line)) inTask = false
    if (!inTask) {
      out.push(line)
      continue
    }

    const match = /^(\s{4,})(?:"([^"]+)"|'([^']+)'|([^:#]+)):\s*(allow|deny|ask)(\s*(?:#.*)?)$/.exec(line)
    if (!match) {
      out.push(line)
      continue
    }

    const indent = match[1]
    const raw = (match[2] ?? match[3] ?? match[4]).trim()
    const effect = match[5]
    const suffix = match[6] ?? ''
    const resource = aliases.get(raw) ?? raw

    if (effect === 'allow' && catalog.get(resource)?.mode === 'primary') {
      console.log(`Removed invalid subagent allow: ${path.basename(info.file)} -> ${resource} (primary)`)
      changed = true
      continue
    }

    const key = `${resource}\0${effect}`
    if (seen.has(key)) {
      changed = true
      continue
    }
    seen.add(key)

    if (resource !== raw) {
      console.log(`Normalized subagent alias: ${path.basename(info.file)} ${raw} -> ${resource}`)
      changed = true
    }
    const rendered = resource === '*' ? `${indent}"*": ${effect}${suffix}` : `${indent}${resource}: ${effect}${suffix}`
    out.push(rendered)
  }

  if (changed) fs.writeFileSync(info.file, `${out.join('\n').replace(/\n+$/, '')}\n`)
  return changed
}

let markdownChanges = 0
for (const info of catalog.values()) {
  if (normalizeTaskBlock(info)) markdownChanges++
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
  }
}

if (configChanges) fs.writeFileSync(configFile, `${JSON.stringify(config, null, 2)}\n`)
console.log(`Agent permission normalization complete: agents=${catalog.size} markdown_changed=${markdownChanges} config_changes=${configChanges}`)
