export class WorkflowYamlError extends Error {}

function stripComment(line) {
  let single = false;
  let double = false;
  let square = 0;
  let curly = 0;
  for (let i = 0; i < line.length; i += 1) {
    const ch = line[i];
    if (ch === "'" && !double) single = !single;
    else if (ch === '"' && !single && line[i - 1] !== '\\') double = !double;
    else if (!single && !double) {
      if (ch === '[') square += 1;
      else if (ch === ']') square -= 1;
      else if (ch === '{') curly += 1;
      else if (ch === '}') curly -= 1;
      else if (ch === '#' && square === 0 && curly === 0 && (i === 0 || /\s/.test(line[i - 1]))) {
        return line.slice(0, i).trimEnd();
      }
    }
  }
  return line.trimEnd();
}

function splitTopLevel(value, separator = ',') {
  const out = [];
  let start = 0, single = false, double = false, square = 0, curly = 0;
  for (let i = 0; i < value.length; i += 1) {
    const ch = value[i];
    if (ch === "'" && !double) single = !single;
    else if (ch === '"' && !single && value[i - 1] !== '\\') double = !double;
    else if (!single && !double) {
      if (ch === '[') square += 1;
      else if (ch === ']') square -= 1;
      else if (ch === '{') curly += 1;
      else if (ch === '}') curly -= 1;
      else if (ch === separator && square === 0 && curly === 0) {
        out.push(value.slice(start, i).trim());
        start = i + 1;
      }
    }
  }
  out.push(value.slice(start).trim());
  return out.filter(Boolean);
}

function splitKeyValue(value) {
  let single = false, double = false, square = 0, curly = 0;
  for (let i = 0; i < value.length; i += 1) {
    const ch = value[i];
    if (ch === "'" && !double) single = !single;
    else if (ch === '"' && !single && value[i - 1] !== '\\') double = !double;
    else if (!single && !double) {
      if (ch === '[') square += 1;
      else if (ch === ']') square -= 1;
      else if (ch === '{') curly += 1;
      else if (ch === '}') curly -= 1;
      else if (ch === ':' && square === 0 && curly === 0) {
        return [value.slice(0, i).trim(), value.slice(i + 1).trim()];
      }
    }
  }
  return undefined;
}

function unquote(value) {
  if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
    return value.slice(1, -1);
  }
  return value;
}

function parseScalar(value) {
  const v = value.trim();
  if (!v) return {};
  if (v.startsWith('[') && v.endsWith(']')) return splitTopLevel(v.slice(1, -1)).map(parseScalar);
  if (v.startsWith('{') && v.endsWith('}')) {
    const obj = {};
    for (const item of splitTopLevel(v.slice(1, -1))) {
      const pair = splitKeyValue(item);
      if (!pair) throw new WorkflowYamlError('invalid inline mapping: ' + item);
      obj[unquote(pair[0])] = parseScalar(pair[1]);
    }
    return obj;
  }
  if (/^(true|false)$/i.test(v)) return v.toLowerCase() === 'true';
  if (/^(null|~)$/i.test(v)) return null;
  if (/^-?\d+(?:\.\d+)?$/.test(v)) return Number(v);
  return unquote(v);
}

function normalizeLines(text) {
  if (typeof text !== 'string') throw new WorkflowYamlError('workflow YAML must be text');
  const raw = text.replace(/^\uFEFF/, '').split(/\r?\n/);
  const lines = [];
  for (let index = 0; index < raw.length; index += 1) {
    if (/\t/.test(raw[index].match(/^\s*/)?.[0] ?? '')) {
      throw new WorkflowYamlError('tabs are not supported in YAML indentation');
    }
    const stripped = stripComment(raw[index]);
    if (!stripped.trim()) continue;
    const indent = (stripped.match(/^ */)?.[0] ?? '').length;
    lines.push({ indent, content: stripped.slice(indent), sourceLine: index + 1 });
  }
  return lines;
}

export function parseWorkflowYaml(text) {
  const lines = normalizeLines(text);
  if (!lines.length) return {};

  function parseBlock(start, indent) {
    if (start >= lines.length || lines[start].indent < indent) return [{}, start];
    const sequence = lines[start].indent === indent && lines[start].content.startsWith('- ');
    const container = sequence ? [] : {};
    let i = start;

    while (i < lines.length) {
      const line = lines[i];
      if (line.indent < indent) break;
      if (line.indent > indent) {
        throw new WorkflowYamlError(`unexpected indentation at line ${line.sourceLine}`);
      }

      if (sequence) {
        if (!line.content.startsWith('- ')) break;
        const itemText = line.content.slice(2).trim();
        if (!itemText) {
          const nextIndent = lines[i + 1]?.indent;
          if (!(nextIndent > indent)) { container.push(null); i += 1; continue; }
          const [nested, next] = parseBlock(i + 1, nextIndent);
          container.push(nested); i = next; continue;
        }
        const pair = splitKeyValue(itemText);
        if (!pair) {
          container.push(parseScalar(itemText)); i += 1; continue;
        }
        const item = {};
        const key = unquote(pair[0]);
        if (pair[1] === '|' || pair[1] === '>') {
          const parts = [];
          i += 1;
          while (i < lines.length && lines[i].indent > indent) {
            parts.push(lines[i].content);
            i += 1;
          }
          item[key] = parts.join(pair[1] === '|' ? '\n' : ' ');
          container.push(item);
          continue;
        }
        item[key] = pair[1] ? parseScalar(pair[1]) : {};
        i += 1;
        if (i < lines.length && lines[i].indent > indent) {
          const childIndent = lines[i].indent;
          const [nested, next] = parseBlock(i, childIndent);
          if (pair[1]) {
            if (nested && typeof nested === 'object' && !Array.isArray(nested)) Object.assign(item, nested);
          } else {
            item[key] = nested;
          }
          i = next;
        }
        container.push(item);
        continue;
      }

      if (line.content.startsWith('- ')) break;
      const pair = splitKeyValue(line.content);
      if (!pair) throw new WorkflowYamlError(`expected mapping at line ${line.sourceLine}`);
      const key = unquote(pair[0]);
      if (!key) throw new WorkflowYamlError(`empty key at line ${line.sourceLine}`);
      if (Object.prototype.hasOwnProperty.call(container, key)) {
        throw new WorkflowYamlError(`duplicate key at line ${line.sourceLine}: ${key}`);
      }
      if (pair[1] === '|' || pair[1] === '>') {
        const parts = [];
        i += 1;
        while (i < lines.length && lines[i].indent > indent) {
          parts.push(lines[i].content);
          i += 1;
        }
        container[key] = parts.join(pair[1] === '|' ? '\n' : ' ');
        continue;
      }
      if (pair[1]) {
        container[key] = parseScalar(pair[1]);
        i += 1;
        continue;
      }
      const next = lines[i + 1];
      if (!next || next.indent <= indent) {
        container[key] = {};
        i += 1;
        continue;
      }
      const [nested, nextIndex] = parseBlock(i + 1, next.indent);
      container[key] = nested;
      i = nextIndex;
    }
    return [container, i];
  }

  const [result, next] = parseBlock(0, lines[0].indent);
  if (next !== lines.length) throw new WorkflowYamlError('could not parse complete workflow YAML');
  if (!result || typeof result !== 'object' || Array.isArray(result)) throw new WorkflowYamlError('workflow root must be a mapping');
  return result;
}

export function workflowJob(workflow, jobId) {
  return workflow?.jobs && typeof workflow.jobs === 'object' && !Array.isArray(workflow.jobs)
    ? workflow.jobs[jobId]
    : undefined;
}

export function workflowEvents(workflow) {
  const on = workflow?.on;
  if (typeof on === 'string') return [on];
  if (Array.isArray(on)) return on.map(String);
  if (on && typeof on === 'object') return Object.keys(on);
  return [];
}

export function workflowPermissions(value) {
  if (typeof value === 'string') return { '*': value };
  if (!value || typeof value !== 'object' || Array.isArray(value)) return undefined;
  return Object.fromEntries(Object.entries(value).map(([key, val]) => [key, String(val)]));
}
