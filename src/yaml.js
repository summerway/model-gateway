// yaml.js — minimal YAML subset parser (zero-dependency).
// Supports: nested maps by indentation, sequences ("- item", "- key: value"
// inline map start), quoted/plain scalars, numbers/bools/null, comments.
// NOT supported: flow collections ([a,b] / {k:v}), anchors, multi-line
// strings, tabs for indentation. Sufficient for config/ directory files.

export class YamlError extends Error {
  constructor(message) {
    super(message);
    this.name = 'YamlError';
  }
}

/** Strip a trailing comment: '#' at line start or preceded by whitespace, outside quotes. */
function stripComment(line) {
  let inS = false;
  let inD = false;
  for (let k = 0; k < line.length; k++) {
    const ch = line[k];
    if (ch === "'" && !inD) inS = !inS;
    else if (ch === '"' && !inS) inD = !inD;
    else if (ch === '#' && !inS && !inD && (k === 0 || /\s/.test(line[k - 1]))) {
      return line.slice(0, k);
    }
  }
  return line;
}

/**
 * Split "key: value" / "key:" mapping line. Returns null when the line is a
 * plain scalar (e.g. "env:VAR_NAME" — colon NOT followed by space/EOL is part
 * of the scalar, not a key separator).
 */
function splitKeyLine(text) {
  let inS = false;
  let inD = false;
  for (let k = 0; k < text.length; k++) {
    const ch = text[k];
    if (ch === "'" && !inD) inS = !inS;
    else if (ch === '"' && !inS) inD = !inD;
    else if (ch === ':' && !inS && !inD) {
      const after = text[k + 1];
      if (after === undefined || after === ' ') {
        return { key: text.slice(0, k).trim(), value: text.slice(k + 1).trim() };
      }
    }
  }
  return null;
}

function parseScalar(raw) {
  const v = raw.trim();
  if (v === '') return null;
  if (v.startsWith('"')) {
    try {
      return JSON.parse(v);
    } catch {
      return v.slice(1, -1);
    }
  }
  if (v.startsWith("'")) {
    return v.slice(1, -1).replace(/''/g, "'");
  }
  if (v === 'true' || v === 'True') return true;
  if (v === 'false' || v === 'False') return false;
  if (v === 'null' || v === '~' || v === 'Null') return null;
  if (/^[+-]?(\d+(\.\d+)?|\.\d+)([eE][+-]?\d+)?$/.test(v)) return Number(v);
  return v;
}

function parseKey(raw) {
  const v = raw.trim();
  if (v.startsWith('"') || v.startsWith("'")) return parseScalar(v);
  return v;
}

function isSeqLine(text) {
  return text === '-' || text.startsWith('- ');
}

function parseNode(lines, i, indent) {
  if (isSeqLine(lines[i].text)) return parseSeq(lines, i, indent);
  return parseMap(lines, i, indent);
}

function parseMap(lines, i, indent) {
  const obj = {};
  while (i < lines.length && lines[i].indent === indent) {
    const line = lines[i];
    if (isSeqLine(line.text)) break;
    const kv = splitKeyLine(line.text);
    if (!kv) throw new YamlError(`invalid mapping line: "${line.text}"`);
    const key = parseKey(kv.key);
    if (kv.value !== '') {
      obj[key] = parseScalar(kv.value);
      i += 1;
      continue;
    }
    // Empty value: nested block (deeper indent), sequence at same indent, or null.
    if (i + 1 < lines.length && lines[i + 1].indent > indent) {
      const [v, ni] = parseNode(lines, i + 1, lines[i + 1].indent);
      obj[key] = v;
      i = ni;
    } else if (i + 1 < lines.length && lines[i + 1].indent === indent && isSeqLine(lines[i + 1].text)) {
      const [v, ni] = parseSeq(lines, i + 1, indent);
      obj[key] = v;
      i = ni;
    } else {
      obj[key] = null;
      i += 1;
    }
  }
  return [obj, i];
}

function parseSeq(lines, i, indent) {
  const arr = [];
  while (i < lines.length && lines[i].indent === indent && isSeqLine(lines[i].text)) {
    const text = lines[i].text;
    const content = text === '-' ? '' : text.slice(2).trim();
    if (content === '') {
      if (i + 1 < lines.length && lines[i + 1].indent > indent) {
        const [v, ni] = parseNode(lines, i + 1, lines[i + 1].indent);
        arr.push(v);
        i = ni;
      } else {
        arr.push(null);
        i += 1;
      }
      continue;
    }
    if (splitKeyLine(content)) {
      // "- key: value" — inline map start; rewrite this line as the first map
      // entry at the content's column, then let parseMap consume siblings.
      const rest = text.slice(1);
      const lead = rest.length - rest.replace(/^ +/, '').length;
      const contentCol = indent + 1 + lead;
      lines[i] = { indent: contentCol, text: content };
      const [v, ni] = parseMap(lines, i, contentCol);
      arr.push(v);
      i = ni;
    } else {
      arr.push(parseScalar(content));
      i += 1;
    }
  }
  return [arr, i];
}

/** Parse a YAML subset document into a JS value (object root for our configs). */
export function parseYaml(text) {
  const lines = [];
  for (const raw of String(text).split(/\r?\n/)) {
    const stripped = stripComment(raw.replace(/\t/g, '    '));
    if (!stripped.trim()) continue;
    const indent = stripped.length - stripped.replace(/^ +/, '').length;
    lines.push({ indent, text: stripped.trim() });
  }
  if (lines.length === 0) return {};
  const [value, next] = parseNode(lines, 0, lines[0].indent);
  if (next !== lines.length) {
    throw new YamlError(`unexpected content at line ${next + 1}: "${lines[next]?.text ?? ''}"`);
  }
  return value ?? {};
}
