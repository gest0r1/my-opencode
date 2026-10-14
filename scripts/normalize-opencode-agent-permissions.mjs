#!/usr/bin/env node
import fs from 'node:fs'
import path from 'node:path'

const [configFile, agentsDir, managedSourceRoot] = process.argv.slice(2)
if (!configFile || !agentsDir) {
  console.error('Usage: normalize-opencode-agent-permissions.mjs OPENCODE_JSON AGENTS_DIR [MANAGED_SOURCE_ROOT]')
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
  gaterunner: 'GateRunner',
  'gate-runner': 'GateRunner',
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

const builtinSubagents = new Set(['explore', 'general'])
const managedSkillNames = new Set(['task-management', 'context7'])

function walkMarkdown(root) {
  if (!root || !fs.existsSync(root)) return []
  const out = []
  const stack = [root]
  while (stack.length) {
    const current = stack.pop()
    for (const entry of fs.readdirSync(current, { withFileTypes: true })) {
      const full = path.join(current, entry.name)
      if (entry.isDirectory()) stack.push(full)
      else if (entry.isFile() && entry.name.endsWith('.md')) out.push(full)
    }
  }
  return out.sort()
}

function frontmatterLines(text) {
  const lines = text.split(/\r?\n/)
  if (lines[0] !== '---') return { lines, end: -1 }
  const end = lines.indexOf('---', 1)
  return { lines, end }
}

function frontmatterValue(lines, end, key) {
  for (let i = 1; i < end; i++) {
    const match = new RegExp(`^${key}:\\s*(.+?)\\s*$`).exec(lines[i])
    if (!match) continue
    let value = match[1].replace(/\s+#.*$/, '').trim()
    if (
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) value = value.slice(1, -1)
    return value
  }
  return undefined
}

function readAgent(file) {
  const text = fs.readFileSync(file, 'utf8')
  const { lines, end } = frontmatterLines(text)
  if (end < 0) throw new Error(`Agent has no closed frontmatter: ${file}`)
  const mode = frontmatterValue(lines, end, 'mode')
  const name = frontmatterValue(lines, end, 'name')
  const hasPermission = lines.slice(1, end).some((line) => /^permission:\s*$/.test(line))
  return { text, lines, end, mode, name, hasPermission, file }
}

const files = fs.readdirSync(agentsDir)
  .filter((name) => name.endsWith('.md'))
  .sort()

const catalog = new Map()
for (const name of files) {
  const id = name.slice(0, -3)
  const file = path.join(agentsDir, name)
  const info = readAgent(file)
  if (catalog.has(id)) throw new Error(`Duplicate agent ID: ${id}`)
  catalog.set(id, { id, ...info })
}

const managedIDs = new Set()
if (managedSourceRoot) {
  for (const file of walkMarkdown(managedSourceRoot)) {
    const info = readAgent(file)
    if (!info.name) throw new Error(`Managed agent has no frontmatter name: ${file}`)
    if (managedIDs.has(info.name)) throw new Error(`Duplicate managed agent name: ${info.name}`)
    managedIDs.add(info.name)
  }
} else {
  for (const id of catalog.keys()) managedIDs.add(id)
}

for (const id of managedIDs) {
  if (!catalog.has(id)) throw new Error(`Managed agent missing from staged target: ${id}`)
}

function parsePermissionEntry(line) {
  const match = /^(\s{4,})(?:"([^"]+)"|'([^']+)'|([^:#]+)):\s*(?:"(allow|deny|ask)"|'(allow|deny|ask)'|(allow|deny|ask))(\s*(?:#.*)?)$/.exec(line)
  if (!match) return undefined
  return {
    indent: match[1],
    resource: (match[2] ?? match[3] ?? match[4]).trim(),
    effect: match[5] ?? match[6] ?? match[7],
    suffix: match[8] ?? '',
  }
}

function renderPermissionEntry(entry) {
  const safeKey = /^[A-Za-z0-9_.\/$?-]+$/.test(entry.resource) && entry.resource !== '*'
    ? entry.resource
    : JSON.stringify(entry.resource)
  return `${entry.indent}${safeKey}: ${entry.effect}${entry.suffix}`
}

function normalizeTrustedSkillResource(resource) {
  let next = resource

  // Old generated agents embedded either the build user's absolute home or a
  // project-local .opencode/skills path. Both are wrong trust boundaries for a
  // global managed installation: deterministic CLIs and Context7 data must be
  // loaded from the installer-owned global config tree.
  next = next.replace(
    /\/(?:root|home\/[^/\s]+)\/\.config\/opencode\/skills\/(task-management|context7)\//g,
    '$HOME/.config/opencode/skills/$1/',
  )
  for (const skill of managedSkillNames) {
    next = next.split(`.opencode/skills/${skill}/`).join(`$HOME/.config/opencode/skills/${skill}/`)
  }
  return next
}

function hasUntrustedManagedSkillPath(resource) {
  if (/\/(?:root|home\/[^/\s]+)\/\.config\/opencode\/skills\//.test(resource)) return true
  for (const skill of managedSkillNames) {
    if (resource.includes(`.opencode/skills/${skill}/`)) return true
  }
  return false
}

function permissionRange(info) {
  const start = info.lines.findIndex((line, index) => index > 0 && index < info.end && /^permission:\s*$/.test(line))
  if (start < 0) return undefined
  let end = info.end
  for (let i = start + 1; i < info.end; i++) {
    if (/^[^ \t#][^:]*:\s*/.test(info.lines[i])) {
      end = i
      break
    }
  }
  return { start, end }
}

function normalizePermissionBlocks(info) {
  const source = [...info.lines]
  const range = permissionRange(info)
  if (!range) return false

  const out = []
  let changed = false

  for (let index = 0; index < source.length;) {
    const line = source[index]
    const actionMatch =
      index > range.start &&
      index < range.end &&
      /^  ([^:#]+):\s*$/.exec(line)

    if (!actionMatch) {
      out.push(line)
      index++
      continue
    }

    const action = actionMatch[1].trim()
    out.push(line)
    let end = index + 1
    while (end < range.end && !/^  \S/.test(source[end])) end++

    const block = source.slice(index + 1, end)
    const normalized = []
    const seen = new Map()

    for (const rawLine of block) {
      const entry = parsePermissionEntry(rawLine)
      if (!entry) {
        normalized.push(rawLine)
        continue
      }

      const original = entry.resource
      if (action === 'task') entry.resource = aliases.get(entry.resource) ?? entry.resource
      entry.resource = normalizeTrustedSkillResource(entry.resource)

      if (action === 'task' && entry.effect === 'allow') {
        const target = catalog.get(entry.resource)
        if (target?.mode === 'primary') {
          console.log(`Removed invalid subagent allow: ${path.basename(info.file)} -> ${entry.resource} (primary)`)
          changed = true
          continue
        }
      }

      const previous = seen.get(entry.resource)
      if (previous) {
        if (previous.effect !== entry.effect) {
          throw new Error(
            `${path.basename(info.file)} permission.${action} has conflicting duplicate resource '${entry.resource}': ${previous.effect} vs ${entry.effect}`,
          )
        }
        changed = true
        continue
      }
      seen.set(entry.resource, entry)

      if (entry.resource !== original) {
        console.log(`Normalized permission resource: ${path.basename(info.file)} ${original} -> ${entry.resource}`)
        changed = true
      }
      normalized.push(renderPermissionEntry(entry))
    }

    // OpenCode 2.0.21 permission evaluation is last-match-wins. A catch-all
    // must precede specific rules so those specific rules can override it.
    const entryIndexes = normalized
      .map((candidate, i) => (parsePermissionEntry(candidate) ? i : -1))
      .filter((i) => i >= 0)
    const firstEntry = entryIndexes[0]
    const wildcardIndex = normalized.findIndex((candidate) => parsePermissionEntry(candidate)?.resource === '*')
    if (firstEntry !== undefined && wildcardIndex > firstEntry) {
      const [wildcard] = normalized.splice(wildcardIndex, 1)
      normalized.splice(firstEntry, 0, wildcard)
      console.log(`Moved permission catch-all before specifics: ${path.basename(info.file)} permission.${action}`)
      changed = true
    }

    out.push(...normalized)
    index = end
  }

  if (changed) fs.writeFileSync(info.file, `${out.join('\n').replace(/\n+$/, '')}\n`)
  return changed
}

let markdownChanges = 0
for (const id of managedIDs) {
  const info = catalog.get(id)
  if (normalizePermissionBlocks(info)) {
    markdownChanges++
    catalog.set(id, { id, ...readAgent(info.file) })
  }
}

function normalizeConfigPermissions(id, permissions) {
  if (!Array.isArray(permissions)) return { permissions, changed: false }
  const firstSubagent = permissions.findIndex((rule) => rule?.action === 'subagent')
  if (firstSubagent < 0) return { permissions, changed: false }

  let changed = false
  const subagent = []
  const seen = new Map()
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

    const previous = seen.get(next.resource)
    if (previous) {
      if (previous.effect !== next.effect) {
        throw new Error(
          `opencode.json agent ${id} has conflicting subagent rules for '${next.resource}': ${previous.effect} vs ${next.effect}`,
        )
      }
      changed = true
      continue
    }
    seen.set(next.resource, next)
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
for (const id of managedIDs) {
  const info = catalog.get(id)
  const entry = config.agents?.[id]
  if (!entry || typeof entry !== 'object' || Array.isArray(entry)) continue

  if (info.mode && entry.mode !== info.mode) {
    entry.mode = info.mode
    configChanges++
  }

  // Markdown owns permissions when it declares permission:. Avoid a second,
  // stale ruleset in opencode.json for the same managed agent.
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

// Fail closed on unresolved delegation mistakes and unsafe managed-skill trust
// paths in managed Markdown.
const errors = []
for (const id of managedIDs) {
  const info = catalog.get(id)
  const range = permissionRange(info)
  if (!range) continue

  for (let index = range.start + 1; index < range.end;) {
    const actionMatch = /^  ([^:#]+):\s*$/.exec(info.lines[index])
    if (!actionMatch) {
      index++
      continue
    }
    const action = actionMatch[1].trim()
    let end = index + 1
    while (end < range.end && !/^  \S/.test(info.lines[end])) end++

    const entries = info.lines.slice(index + 1, end)
      .map(parsePermissionEntry)
      .filter(Boolean)

    const wildcardIndex = entries.findIndex((entry) => entry.resource === '*')
    if (wildcardIndex > 0) {
      errors.push(`${id}: permission.${action} catch-all appears after specific rules`)
    }

    for (const entry of entries) {
      if (entry.effect === 'allow' && hasUntrustedManagedSkillPath(entry.resource)) {
        errors.push(`${id}: permission.${action} allows non-canonical managed skill path '${entry.resource}'`)
      }
    }

    if (action === 'task') {
      for (const entry of entries) {
        if (entry.effect !== 'allow' || entry.resource === '*' || /[*?]/.test(entry.resource)) continue
        if (aliases.has(entry.resource)) {
          errors.push(`${id}: legacy subagent alias remains: ${entry.resource}`)
          continue
        }
        const target = catalog.get(entry.resource)
        if (target) {
          if (target.mode === 'primary') errors.push(`${id}: delegates to primary agent ${entry.resource}`)
          continue
        }
        if (!builtinSubagents.has(entry.resource)) {
          errors.push(`${id}: delegates to unknown exact agent ${entry.resource}`)
        }
      }
    }
    index = end
  }
}

if (errors.length) {
  throw new Error(`Managed agent permission audit failed:\n- ${errors.join('\n- ')}`)
}

console.log(
  `Agent permission normalization complete: agents=${catalog.size} managed=${managedIDs.size} markdown_changed=${markdownChanges} config_changes=${configChanges}`,
)
