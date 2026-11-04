// YAML-subset parser and canonical serializer for factory state files, plus the
// frontmatter helpers every `.md` state file uses. Internal to factory/lib/store.mjs.
//
// Accepted input (the top level is a mapping): block mappings at any consistent
// space indentation (keys may hold spaces: `error budget: 1`), block sequences
// (indented or zero-indented, including sequences of mappings and nested
// sequences), flow collections, plain scalars (continued on more-indented
// lines), double-quoted scalars (YAML escapes, may span lines), single-quoted
// scalars (may span lines), block scalars (| |- |+ > >- >+) and `#` comments.
// A leading byte-order mark is ignored. Anchors, aliases, tags and complex keys
// throw an Error that names the line. The serializer is canonical: same value
// in, same text out.

const PLAIN_STRING = /^[A-Za-z_][A-Za-z0-9_ .\/@+()-]*$/;
const RESERVED_WORDS = new Set(['null', 'true', 'false', 'yes', 'no', 'on', 'off', 'y', 'n', '~']);
const PLAIN_KEY_OUT = /^[A-Za-z0-9_][A-Za-z0-9_-]*$/;
const PLAIN_KEY_IN = /^([A-Za-z0-9_-](?:[A-Za-z0-9_.\/ -]*[A-Za-z0-9_.\/-])?)[ \t]*:(?=[ \t]|$)/;
const NUMBER = /^-?\d+(\.\d+)?([eE][-+]?\d+)?$/;
const FLOW_MAP_MAX = 72;

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Parse a YAML-subset document.
 * @param {string} text
 * @param {{lineOffset?: number}} [options] lineOffset shifts reported line numbers (frontmatter).
 * @returns {any} the parsed value; an empty document is `{}`.
 */
export function parseYaml(text, { lineOffset = 0 } = {}) {
  return new BlockParser(String(text ?? '').replace(/^\uFEFF/, ''), lineOffset).document();
}

/**
 * Serialize a JSON-like value to canonical YAML (insertion order, deterministic).
 * `parseYaml(stringifyYaml(v))` deep-equals `v` for any JSON-like `v`.
 * @param {any} value
 * @returns {string} text ending in a newline
 */
export function stringifyYaml(value) {
  const v = normalize(value);
  if (isScalar(v)) return `${formatScalar(v)}\n`;
  if (Array.isArray(v)) {
    if (v.length === 0 || v.every(isScalar)) return `${flowSequence(v)}\n`;
    return `${emitSequence(v, 0).join('\n')}\n`;
  }
  if (Object.keys(v).length === 0) return '{}\n';
  return `${emitMapping(v, 0).join('\n')}\n`;
}

/**
 * Split a state file into its YAML frontmatter and Markdown body.
 * The file must start with a `---` line (after an optional byte-order mark); the
 * frontmatter ends at the next line that is `---` (trailing whitespace allowed);
 * the body is the rest with one leading newline stripped.
 * @param {string} fileText
 * @returns {{data: object, body: string}}
 */
export function parseFrontmatter(fileText) {
  const text = String(fileText ?? '').replace(/^\uFEFF/, '').replace(/\r\n?/g, '\n');
  const open = /^---[ \t]*\n/.exec(text);
  if (!open) throw new Error('missing frontmatter: the file must start with a "---" line');
  const lines = text.slice(open[0].length).split('\n');
  // The closing line is `---`, trailing spaces or tabs allowed.
  const close = lines.findIndex((l) => l.replace(/[ \t]+$/, '') === '---');
  if (close < 0) throw new Error('unterminated frontmatter: no closing "---" line');
  const data = parseYaml(lines.slice(0, close).join('\n'), { lineOffset: 1 });
  if (!isPlainObject(data)) throw new Error('frontmatter must be a YAML mapping');
  let body = lines.slice(close + 1).join('\n');
  if (body.startsWith('\n')) body = body.slice(1);
  return { data, body };
}

/**
 * Build a state file: `---\n` + YAML + `---\n`, then a blank line and the body
 * (leading newlines trimmed, trailing newline ensured). An empty body writes
 * nothing after the closing `---\n`.
 * @param {object} data
 * @param {string} [body]
 * @returns {string}
 */
export function stringifyFrontmatter(data, body = '') {
  const yaml = stringifyYaml(data ?? {});
  const text = String(body ?? '').replace(/^\n+/, '');
  if (text === '') return `---\n${yaml}---\n`;
  return `---\n${yaml}---\n\n${text}${text.endsWith('\n') ? '' : '\n'}`;
}

// ---------------------------------------------------------------------------
// Serializer
// ---------------------------------------------------------------------------

function isPlainObject(v) {
  return v !== null && typeof v === 'object' && !Array.isArray(v);
}

function isScalar(v) {
  return v === null || typeof v === 'string' || typeof v === 'number' || typeof v === 'boolean';
}

/** JSON semantics: undefined/functions dropped from objects, null in arrays; Dates become ISO strings. */
function normalize(v) {
  if (v === undefined || typeof v === 'function' || typeof v === 'symbol') return null;
  if (typeof v === 'bigint') return Number(v);
  if (v instanceof Date) return v.toISOString();
  if (isScalar(v)) return v;
  if (Array.isArray(v)) return v.map(normalize);
  const out = {};
  for (const [k, x] of Object.entries(v)) {
    if (x === undefined || typeof x === 'function' || typeof x === 'symbol') continue;
    setKey(out, k, normalize(x));
  }
  return out;
}

function formatScalar(v) {
  if (v === null) return 'null';
  if (typeof v === 'boolean') return v ? 'true' : 'false';
  if (typeof v === 'number') return Number.isFinite(v) ? String(v) : 'null';
  return isPlainSafe(v) ? v : JSON.stringify(v);
}

function isPlainSafe(s) {
  return PLAIN_STRING.test(s) && !/\s$/.test(s) && !RESERVED_WORDS.has(s.toLowerCase());
}

function formatKey(k) {
  return PLAIN_KEY_OUT.test(k) ? k : JSON.stringify(k);
}

function flowSequence(arr) {
  return `[${arr.map(formatScalar).join(', ')}]`;
}

function flowMapping(obj) {
  return `{${Object.entries(obj).map(([k, v]) => `${formatKey(k)}: ${formatScalar(v)}`).join(', ')}}`;
}

function emitMapping(obj, indent) {
  const pad = ' '.repeat(indent);
  const lines = [];
  for (const [key, v] of Object.entries(obj)) {
    const k = formatKey(key);
    if (isScalar(v)) {
      lines.push(`${pad}${k}: ${formatScalar(v)}`);
    } else if (Array.isArray(v)) {
      if (v.length === 0 || v.every(isScalar)) lines.push(`${pad}${k}: ${flowSequence(v)}`);
      else lines.push(`${pad}${k}:`, ...emitSequence(v, indent + 2));
    } else if (Object.keys(v).length === 0) {
      lines.push(`${pad}${k}: {}`);
    } else {
      const flow = Object.values(v).every(isScalar) ? flowMapping(v) : null;
      if (flow !== null && flow.length <= FLOW_MAP_MAX) lines.push(`${pad}${k}: ${flow}`);
      else lines.push(`${pad}${k}:`, ...emitMapping(v, indent + 2));
    }
  }
  return lines;
}

function emitSequence(arr, indent) {
  const pad = ' '.repeat(indent);
  const lines = [];
  for (const item of arr) {
    if (isScalar(item)) {
      lines.push(`${pad}- ${formatScalar(item)}`);
    } else if (Array.isArray(item)) {
      if (item.length === 0 || item.every(isScalar)) lines.push(`${pad}- ${flowSequence(item)}`);
      else lines.push(...dashFirst(emitSequence(item, indent + 2), pad, indent + 2));
    } else if (Object.keys(item).length === 0) {
      lines.push(`${pad}- {}`);
    } else {
      lines.push(...dashFirst(emitMapping(item, indent + 2), pad, indent + 2));
    }
  }
  return lines;
}

/** Put the first line of a nested block on the parent's dash line. */
function dashFirst(nested, pad, nestedIndent) {
  nested[0] = `${pad}- ${nested[0].slice(nestedIndent)}`;
  return nested;
}

function setKey(obj, key, value) {
  if (key === '__proto__') {
    Object.defineProperty(obj, key, { value, enumerable: true, writable: true, configurable: true });
  } else {
    obj[key] = value;
  }
}

// ---------------------------------------------------------------------------
// Parser: scalars
// ---------------------------------------------------------------------------

function typePlain(s) {
  if (s === '' || s === '~' || s === 'null' || s === 'Null' || s === 'NULL') return null;
  if (s === 'true' || s === 'True' || s === 'TRUE') return true;
  if (s === 'false' || s === 'False' || s === 'FALSE') return false;
  if (NUMBER.test(s)) {
    const n = Number(s);
    if (Number.isFinite(n)) return n;
  }
  return s;
}

function clip(s, n = 40) {
  return s.length > n ? `${s.slice(0, n)}…` : s;
}

function unterminated(what, incomplete) {
  const e = new Error(`unterminated ${what}`);
  if (incomplete) e.incomplete = true;
  return e;
}

const SIMPLE_ESCAPES = {
  0: '\0', a: '\x07', b: '\b', t: '\t', '\t': '\t', n: '\n', v: '\v', f: '\f', r: '\r', e: '\x1b', ' ': ' ',
  '"': '"', '/': '/', '\\': '\\', N: '\u0085', _: '\u00a0', L: '\u2028', P: '\u2029',
};
const HEX_ESCAPES = { x: 2, u: 4, U: 8 };

/** Decode the inside of a double-quoted scalar (YAML 1.2 escapes; a raw line break folds to a space). */
function decodeDoubleQuoted(inner, shown) {
  let out = '';
  for (let i = 0; i < inner.length; i++) {
    const ch = inner[i];
    if (ch === '\n') {
      out += ' ';
      continue;
    }
    if (ch !== '\\') {
      out += ch;
      continue;
    }
    const e = inner[i + 1];
    if (e !== undefined && Object.prototype.hasOwnProperty.call(SIMPLE_ESCAPES, e)) {
      out += SIMPLE_ESCAPES[e];
      i += 1;
      continue;
    }
    const width = HEX_ESCAPES[e];
    const hex = width ? inner.slice(i + 2, i + 2 + width) : '';
    if (!width || hex.length !== width || !/^[0-9A-Fa-f]+$/.test(hex) || Number.parseInt(hex, 16) > 0x10ffff) {
      throw new Error(`invalid escape "\\${e ?? ''}" in double-quoted string ${clip(shown)}`);
    }
    const code = Number.parseInt(hex, 16);
    out += width === 4 ? String.fromCharCode(code) : String.fromCodePoint(code);
    i += 1 + width;
  }
  return out;
}

/**
 * Read a quoted scalar starting at s[pos]. Double quotes take YAML escapes
 * (the JSON ones plus \x \U \e \0 \a \v \N \_ \L \P and "\ ");
 * single quotes escape `'` as `''`.
 * @returns {{value: string, end: number}} end = index after the closing quote
 */
function readQuoted(s, pos, inFlow = false) {
  if (s[pos] === '"') {
    let i = pos + 1;
    while (i < s.length && s[i] !== '"') i += s[i] === '\\' ? 2 : 1;
    if (i >= s.length) throw unterminated('double-quoted string', inFlow);
    const raw = s.slice(pos, i + 1);
    return { value: decodeDoubleQuoted(raw.slice(1, -1), raw), end: i + 1 };
  }
  let out = '';
  for (let i = pos + 1; ; ) {
    if (i >= s.length) throw unterminated('single-quoted string', inFlow);
    if (s[i] === "'") {
      if (s[i + 1] === "'") {
        out += "'";
        i += 2;
        continue;
      }
      return { value: out, end: i + 1 };
    }
    out += s[i] === '\n' ? ' ' : s[i];
    i += 1;
  }
}

function stripComment(text) {
  const at = text.search(/[ \t]#/);
  return (at >= 0 ? text.slice(0, at) : text).trim();
}

function isSequenceItem(text) {
  return text === '-' || text.startsWith('- ') || text.startsWith('-\t');
}

/** `key: rest` → {key, rest}; null when the text is not a mapping entry. */
function readKey(text) {
  if (text[0] === '"' || text[0] === "'") {
    let q;
    try {
      q = readQuoted(text, 0);
    } catch {
      return null;
    }
    const m = /^[ \t]*:(?=[ \t]|$)/.exec(text.slice(q.end));
    if (!m) return null;
    return { key: q.value, rest: text.slice(q.end + m[0].length).trim() };
  }
  const m = PLAIN_KEY_IN.exec(text);
  if (!m) return null;
  return { key: m[1], rest: text.slice(m[0].length).trim() };
}

// ---------------------------------------------------------------------------
// Parser: flow collections
// ---------------------------------------------------------------------------

class FlowReader {
  constructor(src) {
    this.src = src;
    this.pos = 0;
  }

  incomplete() {
    return unterminated('flow collection', true);
  }

  skipSpace() {
    const s = this.src;
    while (this.pos < s.length) {
      const c = s[this.pos];
      if (c === ' ' || c === '\t' || c === '\n') {
        this.pos += 1;
      } else if (c === '#' && (this.pos === 0 || /\s/.test(s[this.pos - 1]))) {
        const nl = s.indexOf('\n', this.pos);
        this.pos = nl < 0 ? s.length : nl;
      } else {
        break;
      }
    }
  }

  value(ctx) {
    this.skipSpace();
    const s = this.src;
    if (this.pos >= s.length) throw this.incomplete();
    const c = s[this.pos];
    if (c === '[') return this.sequence();
    if (c === '{') return this.mapping();
    if (c === '"' || c === "'") {
      const q = readQuoted(s, this.pos, true);
      this.pos = q.end;
      return q.value;
    }
    if (c === ']' || c === '}' || c === ',') throw new Error(`unexpected "${c}" in a flow collection`);
    return typePlain(this.plain(ctx));
  }

  plain(ctx) {
    const s = this.src;
    const start = this.pos;
    while (this.pos < s.length) {
      const c = s[this.pos];
      if (c === ',' || c === '[' || c === ']' || c === '{' || c === '}' || c === '\n') break;
      if (c === '#' && /\s/.test(s[this.pos - 1])) break;
      if (ctx === 'key' && c === ':' && (this.pos + 1 >= s.length || /[\s,[\]{}]/.test(s[this.pos + 1]))) break;
      this.pos += 1;
    }
    return s.slice(start, this.pos).trim();
  }

  sequence() {
    const s = this.src;
    this.pos += 1;
    const out = [];
    for (;;) {
      this.skipSpace();
      if (this.pos >= s.length) throw this.incomplete();
      if (s[this.pos] === ']') {
        this.pos += 1;
        return out;
      }
      out.push(this.value('seq'));
      this.skipSpace();
      if (this.pos >= s.length) throw this.incomplete();
      const c = s[this.pos];
      this.pos += 1;
      if (c === ']') return out;
      if (c !== ',') throw new Error(`expected "," or "]" in a flow sequence, got "${c}"`);
    }
  }

  mapping() {
    const s = this.src;
    this.pos += 1;
    const out = {};
    for (;;) {
      this.skipSpace();
      if (this.pos >= s.length) throw this.incomplete();
      if (s[this.pos] === '}') {
        this.pos += 1;
        return out;
      }
      let key;
      if (s[this.pos] === '"' || s[this.pos] === "'") {
        const q = readQuoted(s, this.pos, true);
        this.pos = q.end;
        key = q.value;
      } else {
        key = this.plain('key');
        if (key === '') throw new Error('empty key in a flow mapping');
      }
      this.skipSpace();
      if (this.pos >= s.length) throw this.incomplete();
      let value = null;
      if (s[this.pos] === ':') {
        this.pos += 1;
        this.skipSpace();
        if (this.pos >= s.length) throw this.incomplete();
        if (s[this.pos] !== ',' && s[this.pos] !== '}') value = this.value('map');
      }
      if (Object.prototype.hasOwnProperty.call(out, key)) throw new Error(`duplicate key "${key}" in a flow mapping`);
      setKey(out, key, value);
      this.skipSpace();
      if (this.pos >= s.length) throw this.incomplete();
      const c = s[this.pos];
      this.pos += 1;
      if (c === '}') return out;
      if (c !== ',') throw new Error(`expected "," or "}" in a flow mapping, got "${c}"`);
    }
  }
}

// ---------------------------------------------------------------------------
// Parser: block structure
// ---------------------------------------------------------------------------

class BlockParser {
  constructor(text, lineOffset) {
    this.lines = text.replace(/\r\n?/g, '\n').split('\n');
    this.i = 0;
    this.lineOffset = lineOffset;
  }

  error(message, line = this.i) {
    return new Error(`YAML line ${line + 1 + this.lineOffset}: ${message}`);
  }

  /** The next significant line (blank and comment lines skipped), not consumed. */
  peek() {
    while (this.i < this.lines.length) {
      const raw = this.lines[this.i];
      const indent = raw.length - raw.replace(/^ +/, '').length;
      const rest = raw.slice(indent);
      const trimmed = rest.trim();
      if (trimmed === '' || trimmed.startsWith('#')) {
        this.i += 1;
        continue;
      }
      if (rest[0] === '\t') throw this.error('tabs are not allowed for indentation');
      return { indent, text: rest.replace(/[ \t]+$/, ''), line: this.i };
    }
    return null;
  }

  document() {
    const first = this.peek();
    if (!first) return {};
    const value = this.node();
    const extra = this.peek();
    if (extra) throw this.error(`unexpected "${clip(extra.text)}"; check the indentation`, extra.line);
    return value;
  }

  /** Parse the node that starts at the next significant line. */
  node() {
    const ln = this.peek();
    if (isSequenceItem(ln.text)) return this.sequence(ln.indent);
    if (readKey(ln.text)) return this.mapping(ln.indent);
    this.i = ln.line + 1;
    return this.scalar(ln.text, ln.indent - 1, ln.line);
  }

  mapping(indent) {
    const out = {};
    for (;;) {
      const ln = this.peek();
      if (!ln || ln.indent < indent) break;
      if (ln.indent > indent) throw this.error('unexpected indentation', ln.line);
      if (isSequenceItem(ln.text)) break;
      const entry = readKey(ln.text);
      if (!entry) throw this.error(`expected "key: value", got "${clip(ln.text)}"`, ln.line);
      if (Object.prototype.hasOwnProperty.call(out, entry.key)) throw this.error(`duplicate key "${entry.key}"`, ln.line);
      this.i = ln.line + 1;
      setKey(out, entry.key, this.value(entry.rest, indent, ln.line));
    }
    return out;
  }

  /** The value after `key:` — inline, or a nested block on the following lines. */
  value(rest, indent, line) {
    if (rest === '' || rest.startsWith('#')) {
      const next = this.peek();
      if (next && next.indent > indent) return this.node();
      if (next && next.indent === indent && isSequenceItem(next.text)) return this.sequence(indent);
      return null;
    }
    return this.scalar(rest, indent, line);
  }

  sequence(indent) {
    const out = [];
    for (;;) {
      const ln = this.peek();
      if (!ln || ln.indent < indent) break;
      if (ln.indent > indent) throw this.error('unexpected indentation', ln.line);
      if (!isSequenceItem(ln.text)) break;
      const after = ln.text.slice(1);
      const content = after.replace(/^[ \t]+/, '');
      const col = indent + 1 + (after.length - content.length);
      if (content === '' || content.startsWith('#')) {
        this.i = ln.line + 1;
        const next = this.peek();
        out.push(next && next.indent > indent ? this.node() : null);
      } else if (isSequenceItem(content) || readKey(content)) {
        // Compact nested collection ("- key: v" / "- - x"): re-read the item as a block at its column.
        this.lines[ln.line] = ' '.repeat(col) + content;
        out.push(this.node());
      } else {
        this.i = ln.line + 1;
        out.push(this.scalar(content, indent, ln.line));
      }
    }
    return out;
  }

  /** An inline value: block scalar header, quoted string, flow collection or plain scalar. */
  scalar(text, parentIndent, line) {
    const c = text[0];
    if (c === '|' || c === '>') return this.blockScalar(text, parentIndent, line);
    if (c === '"' || c === "'") {
      let src = text;
      let q;
      for (;;) {
        try {
          q = readQuoted(src, 0);
          break;
        } catch (e) {
          // A quoted scalar may continue on the following lines: each line
          // break folds to a space, a blank line to a newline.
          if (!/^unterminated/.test(e.message) || this.i >= this.lines.length) throw this.error(e.message, line);
          let blanks = 0;
          while (this.i < this.lines.length && this.lines[this.i].trim() === '') {
            blanks += 1;
            this.i += 1;
          }
          if (this.i >= this.lines.length) throw this.error(e.message, line);
          const nl = c === '"' ? '\\n' : '\n';
          src += (blanks ? nl.repeat(blanks) : ' ') + this.lines[this.i].trim();
          this.i += 1;
        }
      }
      const tail = src.slice(q.end);
      if (tail.trim() !== '' && !/^[ \t]+#/.test(tail)) throw this.error(`unexpected "${clip(tail.trim())}" after a quoted string`, line);
      return q.value;
    }
    if (c === '[' || c === '{') return this.flow(text, line);
    if (c === '&' || c === '*' || c === '!') throw this.error('anchors, aliases and tags are not supported', line);
    if (c === '?' && (text.length === 1 || text[1] === ' ')) throw this.error('complex keys are not supported', line);
    const first = stripComment(text);
    if (first !== text.trim()) return typePlain(first);
    return this.plainContinuation(first, parentIndent);
  }

  /**
   * A plain scalar continues on following lines indented deeper than its parent:
   * each line break folds to a space, blank lines to newlines; a comment ends it.
   */
  plainContinuation(first, parentIndent) {
    let out = first;
    let joined = false;
    let j = this.i;
    let blanks = 0;
    while (j < this.lines.length) {
      const raw = this.lines[j];
      if (raw.trim() === '') {
        blanks += 1;
        j += 1;
        continue;
      }
      const ind = raw.length - raw.replace(/^ +/, '').length;
      const trimmed = raw.trim();
      if (ind <= parentIndent || trimmed.startsWith('#') || raw[ind] === '\t') break;
      // A nested key or list item under a plain value is a mistake, not text.
      if (readKey(trimmed) || isSequenceItem(trimmed)) throw this.error('unexpected indentation', j);
      const piece = stripComment(trimmed);
      out += (blanks ? '\n'.repeat(blanks) : ' ') + piece;
      joined = true;
      blanks = 0;
      j += 1;
      this.i = j;
      if (piece !== trimmed) break;
    }
    return joined ? out : typePlain(first);
  }

  flow(text, line) {
    let src = text;
    for (;;) {
      const reader = new FlowReader(src);
      try {
        const value = reader.value('top');
        reader.skipSpace();
        if (reader.pos < src.length) throw new Error(`unexpected "${clip(src.slice(reader.pos))}" after a flow collection`);
        return value;
      } catch (e) {
        if (e.incomplete && this.i < this.lines.length) {
          src += `\n${this.lines[this.i]}`;
          this.i += 1;
          continue;
        }
        throw this.error(e.message, line);
      }
    }
  }

  blockScalar(header, parentIndent, line) {
    const m = /^([|>])([+-]?)([1-9]?)([+-]?)[ \t]*(#.*)?$/.exec(header);
    if (!m || (m[2] && m[4])) throw this.error(`bad block scalar header "${clip(header)}"`, line);
    const folded = m[1] === '>';
    const chomp = m[2] || m[4];
    let blockIndent = m[3] ? Math.max(parentIndent, 0) + Number(m[3]) : null;
    const raw = [];
    while (this.i < this.lines.length) {
      const l = this.lines[this.i];
      if (l.trim() === '') {
        raw.push('');
        this.i += 1;
        continue;
      }
      const ind = l.length - l.replace(/^ +/, '').length;
      if (blockIndent === null) {
        if (ind <= parentIndent) break;
        blockIndent = ind;
      }
      if (ind < blockIndent) break;
      raw.push(l.slice(blockIndent));
      this.i += 1;
    }
    let end = raw.length;
    while (end > 0 && raw[end - 1] === '') end -= 1;
    const content = raw.slice(0, end);
    const trailing = raw.length - end;
    if (content.length === 0) return chomp === '+' ? '\n'.repeat(trailing) : '';
    const text = folded ? fold(content) : content.join('\n');
    if (chomp === '-') return text;
    if (chomp === '+') return `${text}\n${'\n'.repeat(trailing)}`;
    return `${text}\n`;
  }
}

/** Folding for `>` scalars: adjacent normal lines join with a space; blank lines become newlines. */
function fold(lines) {
  let out = '';
  let prev = null;
  let blanks = 0;
  for (const l of lines) {
    if (l === '') {
      blanks += 1;
      continue;
    }
    const more = /^[ \t]/.test(l);
    if (prev === null) out += '\n'.repeat(blanks) + l;
    else if (!more && prev === 'text') out += (blanks === 0 ? ' ' : '\n'.repeat(blanks)) + l;
    else out += `\n${'\n'.repeat(blanks)}${l}`;
    blanks = 0;
    prev = more ? 'more' : 'text';
  }
  return out;
}
