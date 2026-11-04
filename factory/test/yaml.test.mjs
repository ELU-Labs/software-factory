// YAML subset + frontmatter.
import test from 'node:test';
import assert from 'node:assert/strict';
import { parseYaml, stringifyYaml, parseFrontmatter, stringifyFrontmatter } from '../lib/yaml.mjs';

const plain = (v) => (v === undefined ? undefined : JSON.parse(JSON.stringify(v)));

const NASTY_STRINGS = [
  '', ' ', '  ', 'plain', 'two words', 'a  b', ' leading', 'trailing ', ' both ',
  'a: b', 'a:b', 'key:', ':', ': x', 'x :', 'a #b', '#comment', 'x #', 'x#y', '# ',
  '"', '""', '"quoted"', "'", "''", "it's", 'say "hi"', 'back\\slash', 'C:\\path\\to',
  '\n', 'line1\nline2', 'trailing newline\n', '\nleading newline', 'tab\tinside', 'cr\rlf', '\r\n',
  'unicode é ü ß', '☃ snowman', '日本語', 'emoji 😀🎉', 'zero\u0000byte', 'bell\u0007',
  'true', 'false', 'True', 'FALSE', 'null', 'Null', 'NULL', '~', 'yes', 'No', 'ON', 'off', 'y', 'N',
  '123', '-1', '1.5', '-2.5e-3', '1e3', '0x1F', '1_000', '.5', '1.', '+1', '007', 'NaN', 'Infinity', '-Infinity',
  '- x', '-', '--', '---', '...', '- ', '-x', '[x]', '[]', '{}', '{a: 1}', '[a, b]', 'a, b', ',',
  '*alias', '&anchor', '!tag', '!!str', '%directive', '@at', '`tick`', '|', '|-', '>', '>-', '? key', '?',
  'http://example.com/a?b=c#d', 'factory/checkout/checkout-v2', '20261101T153012Z-fable-a3f9',
  '2026-11-01T15:30:12.345Z', '2026-11-01', 'Fix: retry loop', 'a\\nb literal backslash n', '\\u00e9 literal',
  'ends with colon:', 'percent 50%', '{{template}}', 'x'.repeat(200),
];

function roundTrip(value, label = 'value') {
  const text = stringifyYaml(value);
  assert.equal(typeof text, 'string', `${label}: stringifyYaml must return a string`);
  let back;
  try {
    back = parseYaml(text);
  } catch (e) {
    assert.fail(`${label}: parseYaml threw on serializer output: ${e.message}\n--- yaml ---\n${text}`);
  }
  assert.deepEqual(plain(back), value, `${label}: round trip changed the value\n--- yaml ---\n${text}`);
  assert.equal(stringifyYaml(back), text, `${label}: serializer output is not canonical (re-serialising differs)`);
  return text;
}

// ---------------------------------------------------------------------------
// Round-trip property
// ---------------------------------------------------------------------------

test('round-trips every nasty string as a top-level value', () => {
  for (const s of NASTY_STRINGS) roundTrip({ v: s }, `string ${JSON.stringify(s)}`);
});

test('round-trips nasty strings inside flow arrays, nested maps and sequences of maps', () => {
  roundTrip({ list: NASTY_STRINGS }, 'flow array of nasty strings');
  for (const s of NASTY_STRINGS) {
    roundTrip({ nested: { a: { b: s, c: [s, s] } } }, `nested ${JSON.stringify(s)}`);
    roundTrip({ points: [{ n: 1, severity: 'high', text: s }, { n: 2, severity: 'nit', text: s }] }, `seq of maps ${JSON.stringify(s)}`);
    roundTrip({ stances: [{ point: 1, stance: 'rejected', reason: s }] }, `stance ${JSON.stringify(s)}`);
  }
});

test('round-trips scalars of every type', () => {
  roundTrip({
    n: null, t: true, f: false, zero: 0, int: 42, neg: -7, dec: 3.25, small: 0.02, tiny: 1.5e-7, big: 1e21,
    long: 0.30000000000000004, safe: Number.MAX_SAFE_INTEGER, negdec: -0.5,
    s_true: 'true', s_null: 'null', s_num: '123', s_dec: '0.02', s_exp: '1e3', s_neg: '-7', s_tilde: '~', s_empty: '',
  }, 'scalars');
});

test('round-trips nested structures', () => {
  roundTrip({
    id: '20261101T153012Z-fable-a3f9',
    ts: '2026-11-01T15:30:12.345Z',
    thread: 'checkout-v2',
    to: ['openai'],
    cc: [],
    reply_to: null,
    refs: ['T-001', 'I-002'],
    internal: false,
    gates: {
      brief: { by: 'you', status: 'approved', at: '2026-11-01T15:30:12.345Z', ref: '20261101T153012Z-you-0a1b' },
      build: { by: 'fable', status: 'pending', at: null, ref: null },
    },
    thresholds: { error_rate: { max: 0.02 }, success_rate: { min: 0.98 } },
    points: [
      { n: 1, severity: 'high', text: 'Retry loop: no backoff # really' },
      { n: 2, severity: 'nit', text: 'multi\nline\n  indented' },
    ],
    deep: { a: { b: { c: { d: [1, 'x', null, true, { e: [] }] } } } },
    arrays: [[1, 2], [[3, [4]], []], [{}], [{ k: 'v' }, 'mixed', 7]],
    empties: { list: [], map: {}, nested: { list: [], map: {} } },
    event: { kind: 'phase', by: 'fable', from: 'design', to: 'design_review' },
  }, 'nested document');
  roundTrip({ a: [[[[1]]]], b: [[{ deep: [[{ deeper: 'yes' }]] }]] }, 'deep arrays');
  roundTrip({ a: [{}, [], { b: {} }, { c: [] }] }, 'empty containers as items');
});

test('round-trips awkward keys', () => {
  roundTrip({ 'with space': 1, 'a:b': 2, 'x#y': 3, 'é': 4, 'quote"s': 5, true: 6, 42: 7, '-dash': 8, 'k: v': 9 }, 'awkward keys');
  roundTrip({ nested: { 'with space': { 'a:b': [1] } } }, 'awkward nested keys');
  roundTrip({ '': 'empty key' }, 'empty key');
});

// Deterministic pseudo-random property test.
function rng(seed) {
  return () => {
    seed |= 0;
    seed = (seed + 0x6d2b79f5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
const CHARS = ['a', 'b', 'Z', '_', '0', '7', ' ', ' ', ':', '#', '-', '"', "'", '\n', '\t', '[', ']', '{', '}', ',', '|', '>',
  '&', '*', '!', '%', '@', '`', '\\', '/', '.', '?', 'é', '☃', '😀'];
const KEYS = ['id', 'name', 'n', 'severity', 'text', 'reply_to', 'a-b', 'x_1', 'k', 'v', 'data', 'items', 'DEEP'];
const pick = (r, list) => list[Math.floor(r() * list.length)];

function genString(r) {
  if (r() < 0.3) return pick(r, NASTY_STRINGS);
  const len = Math.floor(r() * 10);
  let s = '';
  for (let i = 0; i < len; i++) s += pick(r, CHARS);
  return s;
}
function genScalar(r) {
  const x = r();
  if (x < 0.1) return null;
  if (x < 0.2) return r() < 0.5;
  if (x < 0.35) return Math.floor(r() * 2000) - 1000 || 0;
  if (x < 0.45) {
    const n = Math.round((r() * 200 - 100) * 1000) / 1000;
    return n === 0 ? 0 : n;
  }
  return genString(r);
}
function genValue(r, depth) {
  if (depth >= 4 || r() < 0.45) return genScalar(r);
  if (r() < 0.5) {
    const len = Math.floor(r() * 5);
    return Array.from({ length: len }, () => genValue(r, depth + 1));
  }
  const obj = {};
  const len = Math.floor(r() * 5);
  for (let i = 0; i < len; i++) obj[pick(r, KEYS)] = genValue(r, depth + 1);
  return obj;
}

test('round-trip property holds for 400 generated JSON-like documents', () => {
  const r = rng(20261101);
  for (let i = 0; i < 400; i++) {
    const doc = { root: genValue(r, 0), other: genValue(r, 1), list: [genValue(r, 2), genValue(r, 2)] };
    roundTrip(doc, `generated #${i} ${JSON.stringify(doc)}`);
  }
});

// ---------------------------------------------------------------------------
// Serializer canonical forms
// ---------------------------------------------------------------------------

test('serializer: scalars and insertion order', () => {
  assert.equal(stringifyYaml({ a: null, b: true, c: false, d: 1.5, e: -3 }), 'a: null\nb: true\nc: false\nd: 1.5\ne: -3\n');
  assert.equal(stringifyYaml({ z: 1, a: 2, m: 3 }), 'z: 1\na: 2\nm: 3\n');
  assert.match(stringifyYaml({ x: 0.02 }), /^x: 0\.02$/m);
});

test('serializer: strings are plain only when safe, otherwise JSON-quoted', () => {
  const PLAIN = ['hello world', 'fable', 'factory/checkout/checkout-v2', 'a@b.c', 'Fix (retry)', 'x+y', '_x', 'nullable',
    'yesterday', 'Checkout v2', 'opus-1', 'trueish'];
  const QUOTED = ['true', 'TRUE', 'False', 'null', 'Null', 'yes', 'Yes', 'no', 'on', 'OFF', 'y', 'N', '~', 'trailing ', '123',
    '', 'a: b', "it's", '2026-11-01T15:30:12.345Z', '20261101T153012Z-fable-a3f9', 'a#b', '- x', ' lead', 'é', 'line\nbreak',
    'Fix: retry', '1abc'];
  for (const s of PLAIN) assert.equal(stringifyYaml({ k: s }), `k: ${s}\n`, `${JSON.stringify(s)} should be plain`);
  for (const s of QUOTED) assert.equal(stringifyYaml({ k: s }), `k: ${JSON.stringify(s)}\n`, `${JSON.stringify(s)} should be JSON-quoted`);
});

test('serializer: scalar arrays are flow, empty containers are [] and {}', () => {
  assert.equal(stringifyYaml({ m: ['you', 'fable', 'a: b', 1, null, true] }), 'm: [you, fable, "a: b", 1, null, true]\n');
  assert.equal(stringifyYaml({ a: [], b: {} }), 'a: []\nb: {}\n');
  assert.equal(stringifyYaml({ refs: ['T-001', '20261101T153012Z-fable-a3f9'] }), 'refs: [T-001, "20261101T153012Z-fable-a3f9"]\n');
});

test('serializer: arrays holding objects are block items, first key on the dash line, rest two deeper', () => {
  const text = stringifyYaml({ points: [{ n: 1, severity: 'high', text: 'x' }, { n: 2, severity: 'nit', text: 'y' }] });
  const lines = text.split('\n');
  assert.equal(lines[0], 'points:');
  const dash = lines.findIndex((l) => /^\s*- n: 1$/.test(l));
  assert.ok(dash > 0, `expected a "- n: 1" line:\n${text}`);
  const dashIndent = lines[dash].indexOf('-');
  const next = lines[dash + 1];
  assert.match(next, /^\s*severity: high$/);
  assert.equal(next.length - next.trimStart().length, dashIndent + 2, `keys after the first sit two deeper than the dash:\n${text}`);
  assert.ok(lines.some((l) => /^\s*- n: 2$/.test(l)));
  // a nested object with a non-scalar value is a block mapping
  assert.match(stringifyYaml({ a: { b: [{ x: 1 }] } }), /^a:$/m);
});

// ---------------------------------------------------------------------------
// Parser
// ---------------------------------------------------------------------------

test('parser: block mappings at any consistent indentation', () => {
  const want = { a: { b: 1, c: { d: 'x' } }, e: 'y' };
  assert.deepEqual(plain(parseYaml('a:\n  b: 1\n  c:\n    d: x\ne: y\n')), want);
  assert.deepEqual(plain(parseYaml('a:\n    b: 1\n    c:\n        d: x\ne: y\n')), want);
  assert.deepEqual(plain(parseYaml('a:\n   b: 1\n   c:\n      d: x\ne: y')), want, 'no trailing newline, 3-space indent');
});

test('parser: indented and zero-indented block sequences', () => {
  const want = { key: ['a', 'b'], next: 1 };
  assert.deepEqual(plain(parseYaml('key:\n  - a\n  - b\nnext: 1\n')), want);
  assert.deepEqual(plain(parseYaml('key:\n- a\n- b\nnext: 1\n')), want);
  assert.deepEqual(plain(parseYaml('key:\n  - 1\n  - "2"\n  - x\n  - null\n')), { key: [1, '2', 'x', null] });
});

test('parser: sequences of mappings, nested mappings and nested sequences', () => {
  assert.deepEqual(
    plain(parseYaml('points:\n  - n: 1\n    severity: high\n    text: "Retry: no backoff"\n  - n: 2\n    severity: nit\n    text: rename\n')),
    { points: [{ n: 1, severity: 'high', text: 'Retry: no backoff' }, { n: 2, severity: 'nit', text: 'rename' }] },
  );
  assert.deepEqual(
    plain(parseYaml('stances:\n- point: 1\n  stance: accepted\n- point: 2\n  stance: rejected\n  reason: "not needed"\nafter: x\n')),
    { stances: [{ point: 1, stance: 'accepted' }, { point: 2, stance: 'rejected', reason: 'not needed' }], after: 'x' },
  );
  assert.deepEqual(
    plain(parseYaml('items:\n  - id: x\n    meta:\n      a: 1\n      tags: [p, q]\n    list:\n      - 1\n      - 2\n  - id: y\n')),
    { items: [{ id: 'x', meta: { a: 1, tags: ['p', 'q'] }, list: [1, 2] }, { id: 'y' }] },
  );
  assert.deepEqual(plain(parseYaml('grid:\n  - [1, 2]\n  - [3]\n  - []\n  - {}\n')), { grid: [[1, 2], [3], [], {}] });
});

test('parser: flow sequences and mappings with nesting', () => {
  const doc = [
    'a: [a, "b c", {k: v}]',
    'b: {max: 0.02}',
    'c: []',
    'd: {}',
    'e: [[1, 2], {x: [3, {y: "c, d"}]}, [], {}]',
    'f: {by: you, status: pending, at: null, ref: null}',
    "g: ['single', \"double\", plain words]",
    'h: [1, -2.5, true, false, null, ~]',
    'i: [a, b] # trailing comment',
  ].join('\n');
  assert.deepEqual(plain(parseYaml(doc)), {
    a: ['a', 'b c', { k: 'v' }],
    b: { max: 0.02 },
    c: [],
    d: {},
    e: [[1, 2], { x: [3, { y: 'c, d' }] }, [], {}],
    f: { by: 'you', status: 'pending', at: null, ref: null },
    g: ['single', 'double', 'plain words'],
    h: [1, -2.5, true, false, null, null],
    i: ['a', 'b'],
  });
});

test('parser: double-quoted (JSON escapes) and single-quoted scalars', () => {
  const doc = String.raw`dq: "line\nnext \"q\" back\\slash \t tab \u00e9 \u2603 \ud83d\ude00 \/"
sq: 'it''s a ''test'''
sq2: 'a "b" \n c'
empty_dq: ""
empty_sq: ''
hash_dq: "x # not a comment"
`;
  assert.deepEqual(plain(parseYaml(doc)), {
    dq: 'line\nnext "q" back\\slash \t tab é ☃ 😀 /',
    sq: "it's a 'test'",
    sq2: 'a "b" \\n c',
    empty_dq: '',
    empty_sq: '',
    hash_dq: 'x # not a comment',
  });
});

test('parser: plain scalar typing', () => {
  const doc = [
    'n1: null', 'n2: ~', 'n3:', 'n4:    ', 't: true', 'f: false',
    'i: 42', 'neg: -7', 'fl: 3.25', 'ex: 1e3', 'ex2: -2.5E-3', 'zero: 0', 'lead0: 007',
    'ts: 2026-11-01T15:30:12.345Z', 'ver: 1.2.3', 'yes: yes', 'no_: no', 'hex: 0x1F', 'plus: +1', 'dot: .5',
    'words: hello world', 'url: http://example.com/x', 'id: 20261101T153012Z-fable-a3f9', 'spaced: hello   ',
  ].join('\n');
  const v = parseYaml(doc);
  assert.deepEqual(plain(v), {
    n1: null, n2: null, n3: null, n4: null, t: true, f: false,
    i: 42, neg: -7, fl: 3.25, ex: 1000, ex2: -0.0025, zero: 0, lead0: 7,
    ts: '2026-11-01T15:30:12.345Z', ver: '1.2.3', yes: 'yes', no_: 'no', hex: '0x1F', plus: '+1', dot: '.5',
    words: 'hello world', url: 'http://example.com/x', id: '20261101T153012Z-fable-a3f9', spaced: 'hello',
  });
  assert.equal(typeof v.ts, 'string', 'timestamps stay strings');
  assert.equal(typeof v.i, 'number');
  assert.equal(v.t, true);
  assert.equal(v.n3, null);
});

test('parser: block scalars | |- > >-', () => {
  const doc = [
    'keep: |',
    '  line one',
    '    indented more',
    '',
    '  line three',
    'strip: |-',
    '  alpha',
    '  beta',
    'fold: >',
    '  folded',
    '  together',
    'strip_fold: >-',
    '  one',
    '  two',
    'after: done',
    '',
  ].join('\n');
  assert.deepEqual(plain(parseYaml(doc)), {
    keep: 'line one\n  indented more\n\nline three\n',
    strip: 'alpha\nbeta',
    fold: 'folded together\n',
    strip_fold: 'one two',
    after: 'done',
  });
});

test('parser: folded block scalar keeps blank lines as paragraph breaks', () => {
  assert.deepEqual(plain(parseYaml('fold: >\n  para one\n  continues\n\n  para two\nend: x\n')), {
    fold: 'para one continues\npara two\n',
    end: 'x',
  });
});

test('parser: block scalars inside sequence items', () => {
  const doc = 'points:\n  - n: 1\n    text: |\n      first line\n      second line\n  - n: 2\n    text: short\n';
  assert.deepEqual(plain(parseYaml(doc)), {
    points: [{ n: 1, text: 'first line\nsecond line\n' }, { n: 2, text: 'short' }],
  });
});

test('parser: whole-line and trailing comments outside quotes', () => {
  const doc = [
    '# leading comment',
    'a: 1 # trailing',
    'b: "x # not a comment" # real comment',
    "c: 'y # also not' # real",
    'd: x#y',
    'e: plain value   # spaced comment',
    '   # indented comment line',
    'list:',
    '  # comment inside a sequence',
    '  - one # trailing on an item',
    '  - two',
    'nested:',
    '  # comment inside a mapping',
    '  k: v',
    '# trailing comment at the end',
  ].join('\n');
  assert.deepEqual(plain(parseYaml(doc)), {
    a: 1, b: 'x # not a comment', c: 'y # also not', d: 'x#y', e: 'plain value', list: ['one', 'two'], nested: { k: 'v' },
  });
});

test('parser: quoted keys', () => {
  assert.deepEqual(plain(parseYaml('"a key": 1\n\'b key\': 2\n"x: y": 3\nplain-key_1: 4\n')), {
    'a key': 1, 'b key': 2, 'x: y': 3, 'plain-key_1': 4,
  });
});

test('parser: the contract documents (team.md, project and watch threads, roster) parse as specified', () => {
  const team = [
    'id: checkout',
    'title: Checkout',
    'lead: fable',
    'eval_cmd: null          # shell command that prints a JSON object of metrics on its last stdout line',
    'grader: null            # who/what grades eval output: a member id or a command (informational)',
    'data_sources:',
    '  usage: null           # where usage numbers come from (e.g. "analytics: weekly checkout starts")',
    '  traces: null',
    '  latency: null',
    '  feedback: null        # e.g. "support tickets tagged checkout"',
    'repo_paths: []',
    'created: "2026-11-01T15:30:12.345Z"',
  ].join('\n');
  assert.deepEqual(plain(parseYaml(team)), {
    id: 'checkout', title: 'Checkout', lead: 'fable', eval_cmd: null, grader: null,
    data_sources: { usage: null, traces: null, latency: null, feedback: null },
    repo_paths: [], created: '2026-11-01T15:30:12.345Z',
  });

  const project = [
    'id: checkout-v2',
    'title: Checkout v2',
    'kind: project',
    'team: checkout',
    'phase: brief',
    'lead: fable',
    'members: [you, fable, opus-1, opus-2, openai, grok]',
    'gates:',
    '  brief: {by: you, status: pending, at: null, ref: null}',
    '  design_review: {by: openai, status: pending, at: null, ref: null}',
    'branch: factory/checkout/checkout-v2',
    'cadence: null',
    'thresholds: null',
  ].join('\n');
  assert.deepEqual(plain(parseYaml(project)), {
    id: 'checkout-v2', title: 'Checkout v2', kind: 'project', team: 'checkout', phase: 'brief', lead: 'fable',
    members: ['you', 'fable', 'opus-1', 'opus-2', 'openai', 'grok'],
    gates: {
      brief: { by: 'you', status: 'pending', at: null, ref: null },
      design_review: { by: 'openai', status: 'pending', at: null, ref: null },
    },
    branch: 'factory/checkout/checkout-v2', cadence: null, thresholds: null,
  });

  const watch = [
    'kind: watch',
    'phase: active            # active | paused',
    'cadence: daily           # hourly | daily | weekly | <n>h | <n>d',
    'thresholds:',
    '  error_rate: {max: 0.02}',
    '  success_rate: {min: 0.98}',
    'last_run: null',
  ].join('\n');
  assert.deepEqual(plain(parseYaml(watch)), {
    kind: 'watch', phase: 'active', cadence: 'daily',
    thresholds: { error_rate: { max: 0.02 }, success_rate: { min: 0.98 } }, last_run: null,
  });

  const roster = [
    'members:',
    '  - id: you',
    '    name: Product owner',
    '    short: PO',
    '    model: null',
    '    color: "#111827"',
    '  - id: openai',
    '    name: OpenAI',
    '    # Set this to the model you run',
    '    model: null',
    '    runs: "Codex CLI started in the repo root (reads AGENTS.md)"',
  ].join('\n');
  assert.deepEqual(plain(parseYaml(roster)), {
    members: [
      { id: 'you', name: 'Product owner', short: 'PO', model: null, color: '#111827' },
      { id: 'openai', name: 'OpenAI', model: null, runs: 'Codex CLI started in the repo root (reads AGENTS.md)' },
    ],
  });
});

test('parser: throws an Error carrying the line number on anything else', () => {
  const cases = [
    ['alpha: x\nbeta: y\ngamma: "never closed\n', 3],
    ['alpha: x\nbeta: y\nthis line is not yaml\n', 3],
    ['alpha: x\nbeta:\n    deep: x\n  shallow: y\n', 4],
  ];
  for (const [text, line] of cases) {
    assert.throws(
      () => parseYaml(text),
      (e) => e instanceof Error && new RegExp(`\\b${line}\\b`).test(e.message),
      `expected an Error mentioning line ${line} for ${JSON.stringify(text)}`,
    );
  }
  assert.throws(() => parseYaml('alpha: [x, y\n'), Error, 'unterminated flow sequence');
  assert.throws(() => parseYaml("alpha: 'never closed\n"), Error, 'unterminated single quote');
});

// ---------------------------------------------------------------------------
// Frontmatter
// ---------------------------------------------------------------------------

test('parseFrontmatter: data + body with exactly one leading newline stripped', () => {
  assert.deepEqual(plain(parseFrontmatter('---\nid: x\nn: 1\n---\n\n# Title\n\nBody text\n')), {
    data: { id: 'x', n: 1 }, body: '# Title\n\nBody text\n',
  });
  assert.deepEqual(plain(parseFrontmatter('---\na: 1\n---\n')), { data: { a: 1 }, body: '' }, 'empty body');
  assert.equal(parseFrontmatter('---\na: 1\n---\nBody').body, 'Body', 'no leading newline to strip');
  assert.equal(parseFrontmatter('---\na: 1\n---\n\n\nX\n').body, '\nX\n', 'only one leading newline is stripped');
  assert.equal(parseFrontmatter('---\na: 1\n---\n\nabove\n---\nbelow\n').body, 'above\n---\nbelow\n', 'frontmatter ends at the first --- line');
});

test('parseFrontmatter: a file that does not start with ---\\n is rejected', () => {
  assert.throws(() => parseFrontmatter('a: 1\n---\n'), Error);
  assert.throws(() => parseFrontmatter('\n---\na: 1\n---\n'), Error);
});

test('stringifyFrontmatter: canonical layout; empty body writes nothing after the closing ---', () => {
  assert.equal(stringifyFrontmatter({ a: 1, b: 'x y' }, 'Hello'), '---\na: 1\nb: x y\n---\n\nHello\n');
  assert.equal(stringifyFrontmatter({ a: 1 }, 'Hello\n'), '---\na: 1\n---\n\nHello\n');
  assert.equal(stringifyFrontmatter({ a: 1 }, '\n\nHello\n'), '---\na: 1\n---\n\nHello\n', 'leading newlines trimmed');
  assert.equal(stringifyFrontmatter({ a: 1 }, ''), '---\na: 1\n---\n');
});

test('frontmatter round trip', () => {
  const data = {
    id: '20261101T153012Z-fable-a3f9', ts: '2026-11-01T15:30:12.345Z', to: ['openai'], cc: [], reply_to: null,
    points: [{ n: 1, severity: 'high', text: 'a: b # c' }], nested: { k: { v: [1, 2] } },
  };
  for (const body of ['', 'x\n', '# H\n\n- a\n- b\n', '---\nnot frontmatter\n', 'Para one.\n\n## Section\n\ntext\n']) {
    const text = stringifyFrontmatter(data, body);
    assert.ok(text.startsWith('---\n'));
    const back = parseFrontmatter(text);
    assert.deepEqual(plain(back.data), data);
    assert.equal(back.body, body, `body ${JSON.stringify(body)}`);
  }
});

test('parser: plain and quoted scalars continued on more-indented lines', () => {
  assert.deepEqual(plain(parseYaml('eval_cmd: node scripts/eval.mjs\n  --format json\nnext: 1\n')), { eval_cmd: 'node scripts/eval.mjs --format json', next: 1 });
  assert.deepEqual(plain(parseYaml('a: "one\n  two"\nb: \'three\n  four\'\n')), { a: 'one two', b: 'three four' });
  assert.deepEqual(plain(parseYaml('a: "p1\n\n  p2"\n')), { a: 'p1\np2' });
  assert.deepEqual(plain(parseYaml('list:\n  - long item\n    continued\n  - b\n')), { list: ['long item continued', 'b'] });
  assert.throws(() => parseYaml('a: value\n  nested: x\n'), /line 2: unexpected indentation/);
});

test('parser: keys with spaces, YAML escapes, a byte-order mark', () => {
  assert.deepEqual(plain(parseYaml('error budget: 0.5\ntitle: Fix: the bug\n')), { 'error budget': 0.5, title: 'Fix: the bug' });
  assert.deepEqual(plain(parseYaml('a: "\\x41\\e\\U0001F680\\u00e9\\0\\_\\N\\ "\n')), { a: 'A\x1b🚀é\0\u00a0\u0085 ' });
  assert.throws(() => parseYaml('a: "\\q"\n'), /invalid escape "\\q"/);
  assert.deepEqual(plain(parseYaml('\uFEFFa: 1\n')), { a: 1 });
});

test('parseFrontmatter: a byte-order mark and trailing whitespace on the --- lines are accepted', () => {
  assert.deepEqual(plain(parseFrontmatter('\uFEFF--- \na: 1\n---\t \n\nbody\n')), { data: { a: 1 }, body: 'body\n' });
  assert.deepEqual(plain(parseFrontmatter('---\r\na: 1\r\n--- \r\nbody\r\n')), { data: { a: 1 }, body: 'body\n' });
});
