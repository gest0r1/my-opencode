// Normalize OpenCode subagent result shapes without coercing structured data to "[object Object]".
export function subagentResultContent(value) {
  const seen = new WeakSet();
  const convert = (item, depth) => {
    if (item == null) return '';
    if (typeof item === 'string') return item;
    if (typeof item !== 'object') return String(item);
    if (depth > 16 || seen.has(item)) return '[unavailable recursive result]';
    seen.add(item);
    try {
      if (Array.isArray(item)) return item.map(part => convert(part, depth + 1)).filter(Boolean).join('\n');
      if (item.type === 'text' && typeof item.text === 'string') return item.text;
      // Structured envelopes must retain status/diagnostics, not only human-readable text.
      if (Object.keys(item).length === 1 && Object.hasOwn(item, 'content')) return convert(item.content, depth + 1);
      if (Object.keys(item).length === 1 && Object.hasOwn(item, 'output')) return convert(item.output, depth + 1);
      return JSON.stringify(item, (_key, v) => typeof v === 'bigint' ? String(v) : v);
    } catch {
      return '[unserializable subagent result]';
    } finally { seen.delete(item); }
  };
  return convert(value, 0);
}

export function resultContentFromEvent(result) {
  const primary = subagentResultContent(result?.content);
  return primary || subagentResultContent(result?.output);
}
