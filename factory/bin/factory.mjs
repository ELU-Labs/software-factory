#!/usr/bin/env node
// The software factory CLI: the only supported way for agents to change teams/.
// A thin layer over factory/lib/store.mjs: parse argv, call one store method,
// print compact text (or exactly one JSON document with --json).
//
// Exit codes: 0 ok, 1 a refusal or failure (stderr "factory: ..."), 2 a usage error.

import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { spawn, spawnSync } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';
import {
  openStore, FactoryError, summary, sectionText, pidAlive, PROJECT_PHASES, REVIEW_GATES, DATA_SOURCE_KEYS, CLI_BOOL_FLAGS, allowRuleRisk, fmtDuration,
} from '../lib/store.mjs';
import { rolesLines } from '../lib/roles.mjs';
import { startAutopilot, runningAutopilot, stopLeftoverRuns, autopilotDir, readSessions, setSession, SESSION_RE, SETTLE_MS, MAX_RUNS_PER_HOUR } from '../lib/autopilot.mjs';
import { loginItemLabel, loginItemPath, loginItemLog, loginItemPlist, loginEnv } from '../lib/login-item.mjs';

const BIN_DIR = path.dirname(fileURLToPath(import.meta.url));
const DEFAULT_ROOT = path.resolve(BIN_DIR, '../..');
const UI_SERVER = path.resolve(BIN_DIR, '../../tools/factory-ui/server.mjs');
const CLI_FILE = fileURLToPath(import.meta.url);
// Implicit stdin (no --body / --body-file) waits this long for a first byte, so
// an inherited pipe that never closes cannot hang the CLI: a FIFO (a shell
// pipeline) that sends nothing in time is refused, a socket (stdin inherited
// from a spawning process) counts as no stdin. `--body-file -` reads stdin to
// the end with no timeout.
const STDIN_FIRST_CHUNK_MS = 1000;

// ---------------------------------------------------------------------------
// Flags
// ---------------------------------------------------------------------------

const VALUE_FLAGS = new Set([
  'root', 'as', 'title', 'lead', 'owner', 'members', 'kind', 'cadence', 'threshold', 'section', 'body', 'body-file', 'type',
  'to', 'cc', 'reply-to', 'resolves', 'refs', 'verdict', 'point', 'points-file', 'review', 'stance', 'stances-file', 'outcome',
  'reason', 'severity', 'source', 'metric', 'action', 'note', 'gate', 'metrics', 'metrics-file', 'from', 'limit', 'status',
  'team', 'phase', 'port', 'host', 'allow-host', 'issue', 'thread', 'clear-threshold', 'eval-cmd', 'grader', 'data-source', 'repo-paths',
  'team-title', 'timeout', 'settle', 'session', 'allow', 'add-allow', 'remove-allow', 'eta',
]);
const BOOL_FLAGS = CLI_BOOL_FLAGS;
/** Flags that repeat, each occurrence one more item. */
const REPEATABLE = new Set(['point', 'stance', 'threshold', 'data-source', 'allow', 'add-allow', 'remove-allow']);
/** Comma-list flags: repeats add to the list (`--to a --to b` = `--to a,b`). */
const LIST_FLAGS = new Set(['to', 'cc', 'resolves', 'refs', 'members', 'clear-threshold', 'repo-paths', 'allow-host', 'eta']);
const GLOBAL_FLAGS = ['root', 'as', 'json', 'help'];
const BODY_FLAGS = ['body', 'body-file'];

const usage = (message) => new FactoryError('usage', message);
/** A repeatable flag's values as a list (absent → []). */
const asList = (v) => (v == null ? [] : Array.isArray(v) ? v : [v]).map((x) => String(x).trim()).filter(Boolean);
/** One "note:" line per added rule that reaches beyond reading (allowRuleRisk), so a risky grant never goes unnoticed. */
const riskNotes = (rules) => [...new Set(rules)].flatMap((x) => {
  const r = allowRuleRisk(x);
  return r ? [`note: ${x}: ${r.text}.`] : [];
});

/**
 * Split argv into positionals and flags (`--name value`, `--name=value`, `-h`).
 * @param {string[]} argv
 * @returns {{positionals: string[], flags: Record<string, string|string[]|boolean>}}
 */
export function parseArgv(argv) {
  const positionals = [];
  const flags = {};
  for (let i = 0; i < argv.length; i++) {
    const tok = argv[i];
    if (tok === '--') {
      positionals.push(...argv.slice(i + 1));
      break;
    }
    if (tok === '-h') {
      flags.help = true;
      continue;
    }
    if (!tok.startsWith('--') || tok === '--') {
      positionals.push(tok);
      continue;
    }
    const eq = tok.indexOf('=');
    const name = eq > 0 ? tok.slice(2, eq) : tok.slice(2);
    if (BOOL_FLAGS.has(name)) {
      if (eq > 0) throw usage(`--${name} takes no value`);
      flags[name] = true;
      continue;
    }
    if (!VALUE_FLAGS.has(name)) throw usage(`unknown option --${name}; see \`factory --help\``);
    let value;
    if (eq > 0) value = tok.slice(eq + 1);
    else {
      if (i + 1 >= argv.length) throw usage(`--${name} needs a value`);
      value = argv[++i];
    }
    if (REPEATABLE.has(name)) (flags[name] ||= []).push(value);
    else if (LIST_FLAGS.has(name)) flags[name] = flags[name] === undefined ? value : `${flags[name]},${value}`;
    else if (flags[name] !== undefined) throw usage(`--${name} was given twice ("${flags[name]}", then "${value}"); give it once`);
    else flags[name] = value;
  }
  return { positionals, flags };
}

// ---------------------------------------------------------------------------
// Small parsers for flag values
// ---------------------------------------------------------------------------

function parsePoint(text) {
  const m = /^\s*(high|medium|low|nit)\s*:\s*([\s\S]+)$/i.exec(text);
  if (!m) throw usage(`--point "${text}" must look like "<high|medium|low|nit>: <text>"`);
  return { severity: m[1].toLowerCase(), text: m[2].trim() };
}

function parseStance(text) {
  const m = /^\s*(\d+)\s*=\s*(accepted|rejected|deferred)\s*(?::\s*([\s\S]*))?$/.exec(text);
  if (!m) throw usage(`--stance "${text}" must look like "<n>=accepted[: task title]", "<n>=rejected: <reason>" or "<n>=deferred[: <reason>]"`);
  const out = { point: Number(m[1]), stance: m[2] };
  const rest = (m[3] ?? '').trim();
  if (rest) out[m[2] === 'accepted' ? 'action' : 'reason'] = rest;
  return out;
}

/**
 * `--threshold "metric<=v"` (a max) or `"metric>=v"` (a min), repeated. A metric
 * name is anything without spaces, <, > or =; numbers may be written .5 or +1.
 * Two maxes (or two mins) for one metric, or a min above its max, are refused.
 */
export function parseThresholds(list) {
  const out = {};
  for (const text of list || []) {
    const m = /^\s*([^\s<>=]+)\s*(<=|>=)\s*([-+]?(?:\d+(?:\.\d*)?|\.\d+)(?:[eE][-+]?\d+)?)\s*$/.exec(text);
    if (!m) throw usage(`--threshold "${text}" must look like "metric<=0.02" (a max) or "metric>=0.98" (a min)`);
    const [, metric, op, value] = m;
    const bound = op === '<=' ? 'max' : 'min';
    const cur = out[metric] || {};
    if (cur[bound] !== undefined) throw usage(`--threshold gives ${metric} two ${bound} values (${cur[bound]} and ${Number(value)}); give one`);
    out[metric] = { ...cur, [bound]: Number(value) };
    if (out[metric].min !== undefined && out[metric].max !== undefined && out[metric].min > out[metric].max) {
      throw usage(`--threshold for ${metric}: min ${out[metric].min} is above max ${out[metric].max}, so every run would breach`);
    }
  }
  return list && list.length ? out : undefined;
}

/** `--data-source usage="text"`, repeated → {usage: "text"}; an empty value clears it. */
function parseDataSources(list) {
  const out = {};
  for (const text of list || []) {
    const m = /^\s*([a-z]+)\s*=([\s\S]*)$/.exec(text);
    if (!m || !DATA_SOURCE_KEYS.includes(m[1])) throw usage(`--data-source "${text}" must look like "<${DATA_SOURCE_KEYS.join('|')}>=<where it comes from>"`);
    if (m[1] in out) throw usage(`--data-source gives ${m[1]} twice; give it once`);
    out[m[1]] = m[2].trim();
  }
  return out;
}

const stripBom = (text) => String(text).replace(/^\uFEFF/, '');

function readJsonFile(file, what) {
  let text;
  try {
    text = fs.readFileSync(file, 'utf8');
  } catch (e) {
    throw usage(`${what} ${file}: ${e.code === 'ENOENT' ? 'no such file' : e.message}`);
  }
  try {
    return JSON.parse(stripBom(text));
  } catch (e) {
    throw usage(`${what} ${file} is not valid JSON (${e.message})`);
  }
}

function readTextFile(file, what) {
  try {
    return stripBom(fs.readFileSync(file, 'utf8'));
  } catch (e) {
    throw usage(`${what} ${file}: ${e.code === 'ENOENT' ? 'no such file' : e.message}`);
  }
}

function positiveInt(v, what) {
  if (v === undefined) return undefined;
  if (!/^\d+$/.test(String(v)) || Number(v) < 1) throw usage(`${what} must be a positive whole number (got "${v}")`);
  return Number(v);
}

function portNumber(v) {
  if (v === undefined) return 4477;
  if (!/^\d+$/.test(String(v)) || Number(v) > 65535) throw usage(`--port must be 0-65535 (got "${v}")`);
  return Number(v);
}

// ---------------------------------------------------------------------------
// Bodies: --body, --body-file (- = stdin to the end), a trailing argument, or piped stdin
// ---------------------------------------------------------------------------

/**
 * Read piped stdin. With a first-byte window (implicit stdin) it gives up when
 * nothing arrives in time and reports that; without one it reads to EOF.
 * @returns {Promise<{text: string, timedOut: boolean}>}
 */
function readStdinChunks(firstChunkMs) {
  return new Promise((resolve) => {
    const chunks = [];
    let got = false;
    let done = false;
    let timer = null;
    const finish = (timedOut = false) => {
      if (done) return;
      done = true;
      if (timer) clearTimeout(timer);
      process.stdin.removeAllListeners();
      process.stdin.destroy();
      resolve({ text: Buffer.concat(chunks).toString('utf8'), timedOut });
    };
    if (firstChunkMs != null) {
      timer = setTimeout(() => {
        if (!got) finish(true);
      }, firstChunkMs);
    }
    process.stdin.on('data', (c) => {
      got = true;
      chunks.push(c);
    });
    process.stdin.on('end', () => finish(false));
    process.stdin.on('error', () => finish(false));
  });
}

/**
 * Piped stdin: {text, timedOut}, or null when stdin is a terminal or absent
 * (never blocks on a TTY). `toEof` waits for the end with no timeout.
 */
async function readStdin({ toEof = false } = {}) {
  if (process.stdin.isTTY) return null;
  let st;
  try {
    st = fs.fstatSync(0);
  } catch {
    return null;
  }
  if (st.isFile() || st.isCharacterDevice()) {
    try {
      return { text: fs.readFileSync(0, 'utf8'), timedOut: false };
    } catch {
      return null;
    }
  }
  if (st.isFIFO()) return readStdinChunks(toEof ? null : STDIN_FIRST_CHUNK_MS);
  if (st.isSocket()) {
    // A shell pipeline (`npm test | factory result ...`) is a FIFO. A socket is
    // what a spawning process hands down (an agent harness's shell, a Node
    // spawn): one that sends nothing within the window is not a body.
    if (toEof) return readStdinChunks(null);
    const got = await readStdinChunks(STDIN_FIRST_CHUNK_MS);
    return got.timedOut ? null : got;
  }
  return null;
}

// A trailing word that names a task, issue, message or an existing team's
// thread is a mistyped second ref (`task accept T-001 T-002`), not body text.
const ITEM_OR_MESSAGE_REF = [
  /^([a-z0-9][a-z0-9-]{0,40}\/)?[TI]-\d{3,}$/,
  /^\d{8}T\d{6}Z-[a-z0-9][a-z0-9-]*-[0-9a-f]{4}$/,
];
const THREAD_REF = /^([a-z0-9][a-z0-9-]{0,40})\/[a-z0-9][a-z0-9-]{0,40}$/;

function looksLikeRef(word, store) {
  if (ITEM_OR_MESSAGE_REF.some((re) => re.test(word))) return true;
  const m = THREAD_REF.exec(word);
  return Boolean(m && store && fs.existsSync(path.join(store.root, 'teams', m[1], 'team.md')));
}

/** Set when implicit stdin was a pipe that sent nothing in time (main prints a warning). */
let stdinIgnored = false;

async function resolveBody(cmd, flags, extra, store) {
  if (flags.body !== undefined && flags['body-file'] !== undefined) throw usage('give --body or --body-file, not both');
  if (flags.body !== undefined) return flags.body;
  if (flags['body-file'] === '-') {
    const piped = await readStdin({ toEof: true });
    if (piped === null) throw usage('--body-file - reads piped stdin, but stdin is a terminal; pipe the body in or use --body');
    return stripBom(piped.text);
  }
  if (flags['body-file'] !== undefined) return readTextFile(flags['body-file'], '--body-file');
  const ref = extra.find((w) => looksLikeRef(w, store));
  if (ref) throw usage(`unexpected argument "${ref}": \`factory ${cmd.words.join(' ')}\` takes one ${(cmd.args || [])[0] || 'ref'}; run it once per ref (give body text with --body)`);
  if (extra.length) return extra.join(' ');
  const piped = await readStdin();
  if (piped && piped.timedOut) stdinIgnored = true;
  return piped === null || piped.text === '' ? undefined : stripBom(piped.text);
}

// ---------------------------------------------------------------------------
// Text formatting
// ---------------------------------------------------------------------------

const plainText = (s) => summary(String(s ?? ''));
/** Verb agreement for a member subject: verb('you', 'holds', 'hold') → 'hold'. */
const verb = (member, third, base) => (member === 'you' ? base : third);
/** `<team>/<thread> is in <phase>` (project) or `<team>/<thread> is <active|paused>` (watch). */
const where = (th) => `${th.team}/${th.id} ${th.kind === 'project' ? 'is in' : 'is'} ${th.phase}`;
/** End text with one full stop unless it already ends in punctuation. */
const sentence = (s) => (/[.!?…]$/.test(String(s).trim()) ? String(s).trim() : `${String(s).trim()}.`);
const list = (xs) => (xs && xs.length ? xs.join(', ') : '—');
const pad = (s, n) => String(s ?? '').padEnd(n);

function age(seconds) {
  const s = Math.max(0, Math.floor(seconds));
  if (s < 60) return `${s}s`;
  if (s < 3600) return `${Math.floor(s / 60)}m`;
  if (s < 86400) return `${Math.floor(s / 3600)}h`;
  return `${Math.floor(s / 86400)}d`;
}

function when(ts) {
  return ts ? `${String(ts).slice(0, 10)} ${String(ts).slice(11, 19)}` : '—';
}

function addressLine(m) {
  const to = m.to && m.to.length ? ` → ${m.to.join(', ')}` : '';
  const cc = m.cc && m.cc.length ? ` (cc ${m.cc.join(', ')})` : '';
  return `${m.from}${to}${cc}`;
}

function typeDetail(m) {
  switch (m.type) {
    case 'review': return `${m.type} ${m.gate}: ${m.verdict}`;
    case 'result': return `result ${m.task}: ${m.outcome}`;
    case 'dispatch': return `dispatch ${m.task}`;
    case 'decision': return `decision ${m.decision}${m.gate ? ` (${m.gate} ${m.verdict})` : ''}`;
    case 'report': return `report ${m.status}`;
    case 'alert': return `alert ${m.metric} = ${m.value} (${m.issue})`;
    default: return m.type;
  }
}

function indent(text, n = 4) {
  const p = ' '.repeat(n);
  return String(text ?? '').replace(/\s+$/, '').split('\n').map((l) => (l ? p + l : '')).join('\n');
}

function messageExtras(m) {
  const lines = [];
  if (m.type === 'review') for (const p of m.points || []) lines.push(`${p.n}. [${p.severity}] ${p.text}`);
  if (m.type === 'review_response') {
    for (const s of m.stances || []) lines.push(`${s.point}. ${s.stance}${s.action ? ` → ${s.action}` : ''}${s.reason ? `: ${s.reason}` : ''}`);
  }
  return lines;
}

/** An event's body after its one-line sentence (the note given to advance, task accept, ...), or ''. */
function eventNote(m) {
  const lines = String(m.body ?? '').replace(/\s+$/, '').split('\n');
  const first = lines.findIndex((l) => l.trim() !== '');
  return first < 0 ? '' : lines.slice(first + 1).join('\n').replace(/^\s*\n/, '');
}

function formatMessage(m, { full = false, byId = null } = {}) {
  if (m.type === 'event') {
    const out = [`${when(m.ts)}  · ${plainText(m.body) || m.event?.kind}${full ? `  ${m.id}` : ''}`];
    if (full && m.to && m.to.length) out.push(`    to ${m.to.join(', ')}`);
    if (full && m.resolves && m.resolves.length) out.push(`    resolves ${m.resolves.join(', ')}`);
    if (full && m.refs && m.refs.length) out.push(`    refs ${m.refs.join(', ')}`);
    const note = eventNote(m);
    if (note.trim()) out.push(indent(note, full ? 4 : 6));
    return out.join('\n');
  }
  const head = `${when(m.ts)}  ${addressLine(m)}  ${typeDetail(m)}${m.internal ? '  [internal]' : ''}  ${m.id}`;
  const out = [head];
  if (m.reply_to) {
    const to = byId && byId.get(m.reply_to);
    out.push(`    ↪ reply to ${to ? `${to.from} · ${to.type === 'event' ? `event ${to.event?.kind ?? ''}`.trim() : to.type}  ` : ''}${m.reply_to}`);
  }
  if (full && m.resolves && m.resolves.length) out.push(`    resolves ${m.resolves.join(', ')}`);
  if (full && m.refs && m.refs.length) out.push(`    refs ${m.refs.join(', ')}`);
  for (const l of messageExtras(m)) out.push(`    ${l}`);
  if (String(m.body ?? '').trim()) out.push(indent(m.body));
  return out.join('\n');
}

function eventLines(events) {
  return (events || []).map((e) => `  · ${plainText(e.body) || e.event?.kind}`);
}

const INBOX_FOOTER = 'A turn closes when its recipient replies (--reply-to <id>; review, respond, result and answer reply by default) or a message names it in --resolves. Event, alert and report turns close by themselves on your next write in that thread, and so does everything addressed to you (the board can also Dismiss one).';

/**
 * How to run this CLI in a printed hint: the path from the repo root, plus
 * --root when the store is not the default one (so a copied hint targets the
 * same root, never the real repo's teams/).
 */
function cli(store) {
  const rootArg = store && path.resolve(store.root) !== DEFAULT_ROOT ? ` --root ${shellWord(store.root)}` : '';
  return `node factory/bin/factory.mjs${rootArg}`;
}

function shellWord(s) {
  return /^[A-Za-z0-9_./@%+=:,-]+$/.test(String(s)) ? String(s) : `'${String(s).replace(/'/g, "'\\''")}'`;
}

/** Who moves a project thread next when nobody holds a turn. */
function nextMover(th) {
  if (th.kind !== 'project' || th.phase === 'done') return null;
  if (['brief', 'design', 'plan', 'build'].includes(th.phase)) return th.lead;
  return th.gates?.[th.phase]?.by ?? null;
}

function nextStep(th, ref, store) {
  const f = cli(store);
  if (th.kind === 'watch') return th.phase === 'active' ? `${th.owner} runs it when \`${f} watch due\` lists it` : `paused; \`${f} watch resume ${ref} --as <lead>\` restarts it`;
  if (th.kind === 'solo') return `${th.owner} works when someone asks it here: \`${f} post ${ref} --type question --to ${th.owner} --body "<what to do>" --as you\` (the autopilot starts it)`;
  const who = nextMover(th);
  if (!who) return null;
  switch (th.phase) {
    case 'brief': return `${who} writes ## Brief (\`${f} thread edit ${ref} --section Brief --body-file <file> --as ${who}\`) and proposes it to you; you review the brief gate`;
    case 'design': return `${who} writes ## Design, then \`${f} advance ${ref} --as ${who}\` asks ${th.gates.design_review.by} to review it`;
    case 'plan': return `${who} creates the tasks (\`${f} task new ${ref} --title <t> --as ${who}\`), then \`${f} advance ${ref} --as ${who}\``;
    case 'build': return `${who} dispatches the open tasks and accepts results; the last \`${f} task accept\` opens code_review`;
    default: return `${who} reviews the ${th.phase} gate: \`${f} review ${ref} --verdict approve|changes_requested|blocked --as ${who}\``;
  }
}

/** True when a section holds nothing but the template's italic placeholder lines. */
function placeholderOnly(text) {
  const lines = String(text ?? '').split('\n').map((l) => l.trim()).filter(Boolean);
  return lines.every((l) => /^_.*_$/.test(l));
}

function turnLine(x, { showMember = false, showThread = true } = {}) {
  const who = showMember ? `${pad(x.member, 13)} ` : '';
  const where = showThread ? `${x.team}/${x.thread}  ` : '';
  return `${who}${where}${x.message.type} from ${x.message.from}, ${age(x.age_seconds)} ago  ${x.message.id}\n    ${x.message.summary}`;
}

function gateLine(th) {
  if (!th.gates) return null;
  return Object.entries(th.gates).map(([g, v]) => `${g} ${v.status} (${v.by})`).join(' · ');
}

function taskLine(x) {
  const eta = x.eta && (x.status === 'todo' || x.status === 'doing') ? `  eta ${taskEtaText(x)}` : '';
  return `${pad(`${x.team}/${x.id}`, 18)} ${pad(x.status, 7)} ${pad(x.owner || '—', 13)} ${pad(x.thread, 18)} ${x.title}${x.issue ? `  (from ${x.issue})` : ''}${eta}`;
}

/** Minutes until (positive) or since (negative) `dueMs`, as "20m left" or "5m over". */
function leftText(dueMs) {
  const left = Math.round((dueMs - Date.now()) / 60000);
  return left >= 0 ? `${fmtDuration(left)} left` : `${fmtDuration(-left)} over`;
}

function taskEtaText(x) {
  return x.status === 'doing' ? `${fmtDuration(x.eta.minutes)}, ${leftText(Date.parse(x.eta.at) + x.eta.minutes * 60000)} (${x.eta.by})` : `${fmtDuration(x.eta.minutes)} once started (${x.eta.by})`;
}

/** A project thread's estimates for its current and later phases (PROTOCOL §7, "Estimates"). */
function etaLine(th, messages) {
  if (th.kind !== 'project' || !th.eta) return null;
  const here = PROJECT_PHASES.indexOf(th.phase);
  const since = Date.parse((messages || []).filter((m) => m.type === 'event' && m.event?.kind === 'phase').at(-1)?.ts ?? th.created);
  const parts = Object.entries(th.eta).filter(([p]) => PROJECT_PHASES.indexOf(p) >= here).map(([p, e]) => (p === th.phase
    ? `${p} ${leftText(Math.max(since, Date.parse(e.at)) + e.minutes * 60000)}`
    : `${p} ${fmtDuration(e.minutes)}`));
  return parts.length ? `estimates: ${parts.join(' · ')}` : null;
}

function issueLine(x) {
  const where = x.gate || (x.metric ? `metric ${x.metric}` : 'manual');
  return `${pad(`${x.team}/${x.id}`, 18)} ${pad(x.status, 9)} ${pad(x.severity, 7)} ${pad(where, 20)} ${x.title}${x.task ? `  → ${x.task}` : ''}`;
}

function threadLine(th) {
  return `${pad(`${th.team}/${th.id}`, 32)} ${pad(th.kind, 8)} ${pad(th.phase, 14)} lead ${pad(th.lead, 13)} ${th.title}`;
}

// ---------------------------------------------------------------------------
// Commands
// ---------------------------------------------------------------------------

/**
 * Each command: words, usage, about, who (may run it), args (positional names,
 * `?` optional), flags (allowed besides the globals), body (accepts a body),
 * run(ctx) → result, text(result, ctx) → string.
 */
const COMMANDS = [
  // ---- read ----
  {
    words: ['members'], usage: 'members', about: 'The roster: ids, roles, vendors and models.',
    run: ({ store }) => store.members(),
    text: (ms) => ms.map((m) => `${pad(m.id, 13)} ${pad(m.short, 3)} ${pad(m.role, 11)} ${pad(`${m.vendor}${m.model ? ` · ${m.model}` : ''}`, 28)} ${m.name}`).join('\n'),
  },
  {
    words: ['team', 'list'], usage: 'team list', about: 'Every team, its lead and thread count (a team whose team.md cannot be read is listed as broken).',
    run: ({ store }) => store.teams(),
    text: (teams, { store }) => {
      const broken = store.brokenTeams();
      const out = teams.map((t) => `${pad(t.id, 20)} lead ${pad(t.lead, 13)} ${pad(`${store.threads({ team: t.id }).length} threads`, 11)} ${t.title}`);
      for (const b of broken) out.push(`${pad(b.id, 20)} BROKEN ${b.path}: ${b.error} (report it to the owner)`);
      return out.length ? out.join('\n') : `No teams yet. Start one: ${cli(store)} team new <team> --title "<Title>" --as you`;
    },
  },
  {
    words: ['team', 'archived'], usage: 'team archived', about: 'Teams moved off the board with `team archive`, newest first, with the folder name `team restore` takes.',
    run: ({ store }) => store.archivedTeams(),
    text: (list, { store }) => (list.length
      ? list.map((t) => `${pad(t.name, 36)} ${pad(`${t.threads} threads`, 11)} ${t.title}`).join('\n')
      : `No archived teams. Archive one: ${cli(store)} team archive <team> --as you`),
  },
  {
    words: ['thread', 'list'], usage: 'thread list [--team t] [--kind project|watch] [--phase p]', about: 'Threads across teams, filtered.',
    flags: ['team', 'kind', 'phase'],
    run: ({ store, flags }) => store.threads({ team: flags.team, kind: flags.kind, phase: flags.phase }),
    text: (ths) => (ths.length ? ths.map(threadLine).join('\n') : 'No threads match.'),
  },
  {
    words: ['thread', 'show'], usage: 'thread show <thread-ref> [--section <name>]', about: 'One thread: summary, body, tasks, issues and open turns (--section prints just that section).',
    args: ['thread-ref'], flags: ['section'],
    run: ({ store, args, flags }) => {
      const view = store.threadView(args[0]);
      if (flags.section === undefined) return view;
      const text = sectionText(view.thread.body, flags.section);
      if (text === null) throw new FactoryError('not_found', `${view.team}/${view.thread.id} has no "## ${flags.section}" section`);
      return { ref: `${view.team}/${view.thread.id}`, section: flags.section, text };
    },
    text: (r, { store }) => (r.section !== undefined ? `## ${r.section}\n\n${r.text}` : threadShowText(r, store)),
  },
  {
    words: ['log'], usage: 'log <thread-ref> [--brief] [--no-internal] [--limit n]', about: 'The thread transcript, oldest first; events are one-liners. --brief: one line per message, without events (read a full message with show <msg-id>); agents read the thread this way.',
    args: ['thread-ref'], flags: ['brief', 'no-internal', 'limit'],
    run: ({ store, args, flags }) => {
      const limit = positiveInt(flags.limit, '--limit');
      let msgs = store.messages(args[0], { internal: !flags['no-internal'] });
      if (flags.brief) msgs = msgs.filter((m) => m.type !== 'event');
      if (limit) msgs = msgs.slice(-limit);
      if (!flags.brief) return msgs;
      return msgs.map((m) => ({ id: m.id, ts: m.ts, from: m.from, to: m.to ?? [], type: m.type, reply_to: m.reply_to ?? null, summary: summary(m) }));
    },
    text: (msgs, { store, args, flags }) => {
      if (!msgs.length) return 'No messages.';
      if (flags.brief) {
        const lines = msgs.map((m) => `${m.ts.slice(5, 16).replace('T', ' ')}  ${m.id}  ${m.from}${m.to.length ? ` → ${m.to.join(',')}` : ''}  ${m.type}${m.reply_to ? ` ↩ ${m.reply_to}` : ''}: ${m.summary}`);
        return [...lines, 'Full text of one message: node factory/bin/factory.mjs show <msg-id>'].join('\n');
      }
      const byId = new Map(store.messages(args[0]).map((m) => [m.id, m]));
      // events print their note (an advance or task accept body) indented under the line
      return msgs.map((m) => formatMessage(m, { byId })).join('\n');
    },
  },
  {
    words: ['show'], usage: 'show <msg-id>', about: 'One message in full.', args: ['msg-id'],
    run: ({ store, args }) => store.message(args[0]),
    text: (m, { store }) => {
      let byId = null;
      if (m.reply_to) {
        try {
          const target = store.message(m.reply_to);
          byId = new Map([[target.id, target]]);
        } catch {
          byId = null;
        }
      }
      return `${m.team}/${m.thread}\n${formatMessage(m, { full: true, byId })}`;
    },
  },
  {
    words: ['inbox'], usage: 'inbox [<member>]', about: 'Open turns waiting on a member (default: --as / $FACTORY_AS), oldest first.',
    args: ['member?'],
    run: ({ store, args, as }) => {
      const member = args[0] || as;
      if (!member) throw usage('whose inbox? name a member (factory inbox fable) or pass --as');
      store.member(member);
      return store.openTurns({ member });
    },
    text: (turns, { args, as }) => {
      const member = args[0] || as;
      return turns.length ? [`${member} ${verb(member, 'has', 'have')} ${turns.length} open turn${turns.length === 1 ? '' : 's'}:`, ...turns.map((x) => turnLine(x)), '', INBOX_FOOTER].join('\n') : `No open turns for ${member}.`;
    },
  },
  {
    words: ['turns'], usage: 'turns [<thread-ref>]', about: 'Every open turn (in one thread, or everywhere): who is waited on, for what.',
    args: ['thread-ref?'],
    run: ({ store, args }) => store.openTurns({ thread: args[0] }),
    text: (turns) => (turns.length ? turns.map((x) => turnLine(x, { showMember: true })).join('\n') : 'No open turns.'),
  },
  {
    words: ['task', 'list'], usage: 'task list [<thread-ref>] [--status s] [--owner m]', about: 'Tasks, filtered.',
    args: ['thread-ref?'], flags: ['status', 'owner', 'team'],
    run: ({ store, args, flags }) => store.tasks({ thread: args[0], team: flags.team, status: flags.status, owner: flags.owner }),
    text: (xs) => (xs.length ? xs.map(taskLine).join('\n') : 'No tasks match.'),
  },
  {
    words: ['task', 'show'], usage: 'task show <task-ref>', about: 'One task with its body.', args: ['task-ref'],
    run: ({ store, args }) => store.task(args[0]),
    text: (x) => `${taskLine(x)}\n${x.refs?.length ? `refs ${x.refs.join(', ')}\n` : ''}\n${x.body}`,
  },
  {
    words: ['issue', 'list'], usage: 'issue list [<thread-ref>] [--status s]', about: 'Issues, filtered.',
    args: ['thread-ref?'], flags: ['status', 'team'],
    run: ({ store, args, flags }) => store.issues({ thread: args[0], team: flags.team, status: flags.status }),
    text: (xs) => (xs.length ? xs.map(issueLine).join('\n') : 'No issues match.'),
  },
  {
    words: ['issue', 'show'], usage: 'issue show <issue-ref>', about: 'One issue with its history.', args: ['issue-ref'],
    run: ({ store, args }) => store.issue(args[0]),
    text: (x) => `${issueLine(x)}\nsource ${x.source ?? '—'}${x.reason ? ` · reason: ${x.reason}` : ''}\n\n${x.body}`,
  },
  {
    words: ['board'], usage: 'board', about: 'Every team and thread at a glance.',
    run: ({ store }) => store.board(),
    text: (b, { store }) => boardText(b, store),
  },
  {
    words: ['watch', 'due'], usage: 'watch due', about: 'Active watch threads whose cadence says they should run now.',
    run: ({ store }) => store.watchDue(),
    text: (xs) => (xs.length ? xs.map((x) => `${pad(x.ref, 32)} ${pad(x.cadence, 8)} owner ${pad(x.owner, 13)} ${x.last_run ? `last run ${when(x.last_run)}, ${age(x.overdue_seconds)} overdue` : 'never run'}`).join('\n') : 'Nothing is due.'),
  },
  {
    words: ['worktree'], usage: 'worktree <thread-ref>', about: 'Print the git commands that create the thread\'s worktree (never runs git).',
    args: ['thread-ref'],
    run: ({ store, args }) => store.worktreeCommands(args[0]),
    text: (w) => [`branch   ${w.branch}${w.exists ? ' (exists)' : w.remote ? ' (on origin only: the worktree tracks it)' : ''}`, `worktree ${w.path}`, '', ...w.commands, '', `# ${w.note}`].join('\n'),
  },
  {
    words: ['validate'], usage: 'validate', about: 'Check every file against the contract (exit 1 on any error).',
    run: ({ store }) => store.validate(),
    text: (v) => {
      const out = [];
      for (const e of v.errors) out.push(`error   ${e.file}: ${e.message}`);
      for (const w of v.warnings) out.push(`warning ${w.file}: ${w.message}`);
      out.push(`${v.ok ? 'ok' : 'FAILED'}: ${v.errors.length} error${v.errors.length === 1 ? '' : 's'}, ${v.warnings.length} warning${v.warnings.length === 1 ? '' : 's'}`);
      return out.join('\n');
    },
    exitCode: (v) => (v.ok ? 0 : 1),
  },
  {
    words: ['wait'], usage: 'wait <thread-ref> [--timeout 6h]',
    about: 'Block until a new message in the thread is for --as: addressed to them (to or cc), a reply to one of their messages, or, for the thread lead, anything the owner writes. Without --as, any new message. Ends at --timeout (s, m or h; default 6h). Prints what arrived. While it runs, the board shows --as as watching. Run it in the background after handing a turn to someone else.',
    args: ['thread-ref'], flags: ['timeout'],
    run: waitThread,
    text: (r) => {
      if (r.timed_out) return `Nothing new in ${r.ref} after ${r.waited}; phase ${r.phase}.`;
      const out = [`New in ${r.ref} (phase ${r.phase}):`];
      for (const m of r.messages) out.push(`  ${m.id}  ${pad(m.from, 13)} ${pad(m.type, 15)} ${m.summary}`);
      if (r.waiting_on_you.length) out.push(`${r.as} holds ${r.waiting_on_you.length} turn${r.waiting_on_you.length === 1 ? '' : 's'} here: run \`node factory/bin/factory.mjs inbox ${r.as}\`.`);
      return out.join('\n');
    },
  },
  // ---- write ----
  {
    words: ['init'], usage: 'init', about: 'Create teams/ and copy the roster and templates into the root when missing, and start a new factory with its Triage thread (idempotent; no --as).',
    run: ({ store }) => store.init({ triage: true }),
    text: (r) => (r.created.length ? `Initialised ${r.root}:\n${r.created.map((f) => `  + ${f}`).join('\n')}` : `${r.root} is already initialised.`),
  },
  {
    words: ['team', 'new'], usage: 'team new <team> --title <t> [--lead m]', about: 'Create a team from factory/templates/team.md.', who: 'you, or a lead',
    args: ['team'], flags: ['title', 'lead'], write: true,
    run: ({ store, as, args, flags }) => store.createTeam({ as, id: args[0], title: flags.title, lead: flags.lead }),
    text: (r) => `Created team ${r.team.id} (${r.team.title}), lead ${r.team.lead}: ${r.team.path}`,
  },
  {
    words: ['thread', 'new'], write: true, who: 'the team lead or you',
    usage: 'thread new <team>/<thread> --title <t> [--team-title <t>] [--kind project|watch|solo] [--lead m] [--owner m] [--members a,b] [--cadence c] [--threshold "metric<=v" | "metric>=v"]... [--allow "<rule>"]...',
    about: 'Start a project thread (phase brief), a watch thread (phase active) or a single-agent thread (--kind solo: one agent, --owner, that leads the thread itself and works when you ask it; no --lead; each --allow adds a command its runs may use, as a Claude Code permission rule). A team that does not exist yet is created first (folder teams/<team>, title from --team-title or the id) when you or a lead runs it.',
    args: ['team/thread'], flags: ['title', 'team-title', 'kind', 'lead', 'owner', 'members', 'cadence', 'threshold', 'allow'],
    run: ({ store, as, args, flags }) => store.createThread({
      as, ref: args[0], title: flags.title, kind: flags.kind || 'project', lead: flags.lead, owner: flags.owner,
      members: flags.members, cadence: flags.cadence, thresholds: parseThresholds(flags.threshold), teamTitle: flags['team-title'], allow: flags.allow,
    }),
    text: (r) => `${r.team_created ? `Created team ${r.thread.team} (new folder teams/${r.thread.team}).\n` : ''}Created ${r.thread.team}/${r.thread.id} (${r.thread.kind}, phase ${r.thread.phase}, lead ${r.thread.lead}${r.thread.owner ? `, owner ${r.thread.owner}` : ''}): ${r.thread.path}`,
  },
  {
    words: ['thread', 'edit'], usage: 'thread edit <thread-ref> --section <name> (--body|--body-file|stdin)', write: true, who: 'the thread lead or you',
    about: 'Replace the content of one `## <name>` section (adds it when missing).',
    args: ['thread-ref'], flags: ['section'], body: true,
    run: ({ store, as, args, flags, body }) => {
      if (flags.section === undefined) throw usage('name the section: --section <name> (Brief, Design, Plan, Notes, ...)');
      if (body === undefined) throw usage(`give the new content of ## ${flags.section}: --body <text>, --body-file <path>, or piped stdin`);
      return store.editSection({ as, ref: args[0], section: flags.section, body });
    },
    text: (r, { flags }) => `Updated ## ${flags.section} in ${r.thread.team}/${r.thread.id}.`,
  },
  {
    words: ['thread', 'eta'], write: true, who: 'the thread lead or you; a gate\'s owner for its own gate',
    usage: 'thread eta <thread-ref> --eta <phase>=<time>[,<phase>=<time>...]',
    about: 'Estimate a project thread\'s phases (45m, 2h, 1h30m): for the current phase the time left from now, for a later phase its length. The lead sets every phase to final_review when it takes the thread and again when one moves; a reviewer may set its own gate. Posts an eta event.',
    args: ['thread-ref'], flags: ['eta'],
    run: ({ store, as, args, flags }) => store.setThreadEta({ as, ref: args[0], eta: flags.eta }),
    text: (r) => `Estimated ${r.thread.team}/${r.thread.id}: ${Object.entries(r.event.event.estimates).map(([p, m]) => `${p} ${fmtDuration(m)}`).join(' · ')}.`,
  },
  {
    words: ['merge'], write: true, who: 'the thread lead or you',
    usage: 'merge <thread-ref>',
    about: 'Merge a project thread\'s PR into main once you signed it off (phase done): checks the PR is the thread branch\'s, targets main and has no commit from after the sign-off, marks a draft ready, merges it with a merge commit (never --admin), and posts a merged event. Already merged: says so.',
    args: ['thread-ref'],
    run: mergeThread,
    text: (r) => (r.already ? `PR #${r.pr} is already merged${r.recorded ? '; recorded it on the thread' : ''}: ${r.url}` : `Merged PR #${r.pr} into main${r.commit ? ` as ${r.commit.slice(0, 9)}` : ''}: ${r.url}`),
  },
  {
    words: ['thread', 'set'], write: true, who: 'the thread lead or you',
    usage: 'thread set <thread-ref> [--cadence c] [--threshold "metric<=v" | "metric>=v"]... [--clear-threshold m] [--owner m] [--members a,b] [--add-allow "<rule>"]... [--remove-allow "<rule>"]... [--allow "<rule>"]... [--clear-allow]',
    about: 'Change a thread\'s configuration: a watch thread\'s cadence, thresholds (each named metric\'s bounds are replaced) and owner; a single-agent thread\'s owner and allowed commands (--add-allow and --remove-allow change the list; --allow replaces it); any thread\'s members. Posts a thread_config event.',
    args: ['thread-ref'], flags: ['cadence', 'threshold', 'clear-threshold', 'owner', 'members', 'allow', 'add-allow', 'remove-allow', 'clear-allow'],
    run: ({ store, as, args, flags }) => store.setThreadConfig({
      as, ref: args[0], cadence: flags.cadence, thresholds: parseThresholds(flags.threshold), clearThresholds: flags['clear-threshold'], owner: flags.owner, members: flags.members,
      allow: flags.allow, allowAdd: flags['add-allow'], allowRemove: flags['remove-allow'], clearAllow: flags['clear-allow'],
    }),
    text: (r, { flags }) => [`Changed ${r.thread.team}/${r.thread.id}: ${r.changes.join('; ')}.`, ...riskNotes([...asList(flags.allow), ...asList(flags['add-allow'])])].join('\n'),
  },
  {
    words: ['team', 'archive'], write: true, who: 'you',
    usage: 'team archive <team>',
    about: 'Move the whole team folder to teams/.archive/<team>-<stamp>: it leaves the board, the inbox and the autopilot, nothing is deleted, and the id is free for a new team. Refused while an agent run works in the team. Bring it back with `team restore`.',
    args: ['team'],
    run: ({ store, as, args }) => store.archiveTeam({ as, id: args[0] }),
    text: (r) => `Archived team ${r.team.id} (${r.team.title}, ${r.threads} thread${r.threads === 1 ? '' : 's'}) to ${r.path}${r.sessions_dropped ? `; dropped ${r.sessions_dropped} saved agent session${r.sessions_dropped === 1 ? '' : 's'}` : ''}.`,
  },
  {
    words: ['team', 'restore'], write: true, who: 'you',
    usage: 'team restore <archived-folder>',
    about: 'Bring an archived team (a folder name from `team archived`) back to the board as it was. Refused while a team with the same id is on the board.',
    args: ['archived-folder'],
    run: ({ store, as, args }) => store.restoreTeam({ as, name: args[0] }),
    text: (r) => `Restored team ${r.team.id} (${r.team.title}, ${r.threads} thread${r.threads === 1 ? '' : 's'}) from ${r.from}.`,
  },
  {
    words: ['team', 'edit'], write: true, who: 'you or the team lead',
    usage: 'team edit <team> [--eval-cmd <cmd>] [--grader <text>] [--data-source "usage|traces|latency|feedback=<text>"]... [--repo-paths a,b] [--add-allow "<rule>"]... [--remove-allow "<rule>"]... [--allow "<rule>"]... [--clear-allow]',
    about: 'Change team.md configuration (an empty value clears a field). --add-allow, --remove-allow, --allow (replaces) and --clear-allow set the commands every single-agent thread of the team may run, on top of each thread\'s own. Teams have no thread, so this posts no event; the change is in team.md.',
    args: ['team'], flags: ['eval-cmd', 'grader', 'data-source', 'repo-paths', 'allow', 'add-allow', 'remove-allow', 'clear-allow'],
    run: ({ store, as, args, flags }) => store.editTeam({
      as, id: args[0], eval_cmd: flags['eval-cmd'], grader: flags.grader, dataSources: parseDataSources(flags['data-source']), repoPaths: flags['repo-paths'],
      allow: flags.allow, allowAdd: flags['add-allow'], allowRemove: flags['remove-allow'], clearAllow: flags['clear-allow'],
    }),
    text: (r, { flags }) => [`Updated team ${r.team.id}: ${r.changed.join(', ')} (${r.team.path}).`, ...riskNotes([...asList(flags.allow), ...asList(flags['add-allow'])])].join('\n'),
  },
  {
    words: ['task', 'edit'], write: true, who: 'the thread lead or you',
    usage: 'task edit <task-ref> [--title <t>] [--section <name> (--body|--body-file|stdin)]',
    about: 'Change a task\'s title, or replace one `## <name>` section of its body (for example Acceptance on a task respond or issue accept created).',
    args: ['task-ref'], flags: ['title', 'section'], body: true,
    run: ({ store, as, args, flags, body }) => store.editTask({ as, task: args[0], title: flags.title, section: flags.section, body }),
    text: (r) => `Edited ${r.task.team}/${r.task.id} (${r.changed.join(', ')}).`,
  },
  {
    words: ['post'], write: true, who: 'thread members, the lead or owner, and you',
    usage: 'post <thread-ref> --type <type> [--to a,b] [--cc a,b] [--reply-to id] [--resolves a,b] [--refs a,b] [--internal] [body]',
    about: 'Post a kickoff, proposal, question, answer, escalation or note (a decision goes through `decide`).',
    args: ['thread-ref'], flags: ['type', 'to', 'cc', 'reply-to', 'resolves', 'refs', 'internal'], body: true,
    run: ({ store, as, args, flags, body }) => store.post({
      as, ref: args[0], type: flags.type, to: flags.to, cc: flags.cc, reply_to: flags['reply-to'], resolves: flags.resolves, refs: flags.refs,
      internal: Boolean(flags.internal), body,
    }),
    text: (r) => (r.decision ? decideText(r) : `Posted ${r.message.type} ${r.message.id}${r.message.to.length ? ` to ${r.message.to.join(', ')}` : ''}${r.message.reply_to ? ` (reply to ${r.message.reply_to})` : ''}${r.message.resolves.length ? `; resolves ${r.message.resolves.join(', ')}` : ''}.${r.relayed ? ` Relayed to ${r.relayed.team}/${r.relayed.thread} as ${r.relayed.id}.` : ''}`),
  },
  {
    words: ['tell'], write: true, who: 'the lead or owner of the --from thread, and you',
    usage: 'tell <team | team/thread> --from <thread-ref> [--type question|note] [body]',
    about: 'Talk to another team: post into its thread (a team name picks its one open thread), addressed to that thread\'s lead (a single-agent thread\'s agent), with a copy in your --from thread. A reply on either side is relayed to the other, addressed to whoever wrote there. --type question (default) wants an answer; note is for their information (PROTOCOL §9, "Between teams").',
    args: ['target'], flags: ['from', 'type'], body: true,
    run: ({ store, as, args, flags, body }) => store.tell({ as, from: flags.from, target: args[0], type: flags.type, body }),
    text: (r) => `Told ${r.thread}: ${r.message.type} ${r.message.id} to ${r.message.to.join(', ')}; the copy in ${r.from} is ${r.copy.id}. Their reply comes back to ${r.from}.`,
  },
  {
    words: ['review'], write: true, who: 'the current gate owner',
    usage: 'review <thread-ref> --verdict approve|changes_requested|blocked [--point "<severity>: <text>"]... [--points-file f.json] [--reply-to id] [body]',
    about: `Review the current gate (${REVIEW_GATES.join(', ')}). Each point becomes an issue; approve allows only low/nit points.`,
    args: ['thread-ref'], flags: ['verdict', 'point', 'points-file', 'reply-to'], body: true,
    run: ({ store, as, args, flags, body }) => {
      let points = (flags.point || []).map(parsePoint);
      if (flags['points-file'] !== undefined) {
        const fromFile = readJsonFile(flags['points-file'], '--points-file');
        if (!Array.isArray(fromFile)) throw usage('--points-file must hold a JSON array of {severity, text}');
        points = [...fromFile, ...points];
      }
      return store.review({ as, ref: args[0], verdict: flags.verdict, points, reply_to: flags['reply-to'], body });
    },
    text: (r) => [
      `Reviewed ${r.thread.team}/${r.thread.id} at ${r.message.gate}: ${r.message.verdict}, ${r.message.points.length} point${r.message.points.length === 1 ? '' : 's'}; phase ${r.thread.phase}.`,
      ...r.issues.map((i) => `  ${i.id} [${i.severity}] ${i.title}`),
    ].join('\n'),
  },
  {
    words: ['respond'], write: true, who: 'the thread lead',
    usage: 'respond <thread-ref> [--review <msg-id>] --stance "<n>=accepted[: action]" | "<n>=rejected: <reason>" | "<n>=deferred[: <reason>]" ... [--stances-file f.json] [body]',
    about: 'Answer a review with one stance per point (default: the latest review awaiting a response).',
    args: ['thread-ref'], flags: ['review', 'stance', 'stances-file'], body: true,
    run: ({ store, as, args, flags, body }) => {
      let stances = (flags.stance || []).map(parseStance);
      if (flags['stances-file'] !== undefined) {
        const fromFile = readJsonFile(flags['stances-file'], '--stances-file');
        if (!Array.isArray(fromFile)) throw usage('--stances-file must hold a JSON array of {point, stance, reason?, action?}');
        stances = [...fromFile, ...stances];
      }
      return store.respond({ as, ref: args[0], review: flags.review, stances, body });
    },
    text: (r) => [
      `Responded to ${r.message.reply_to}: ${r.message.stances.map((s) => `${s.point}=${s.stance}`).join(', ')}; phase ${r.thread.phase}.`,
      ...r.tasks.map((x) => `  + ${x.id} ${x.title}`),
    ].join('\n'),
  },
  {
    words: ['advance'], usage: 'advance <thread-ref> [body]', write: true, who: 'the thread lead or you',
    about: 'Move design → design_review, plan → build or build → code_review when the tasks allow it.',
    args: ['thread-ref'], body: true,
    run: ({ store, as, args, body }) => store.advance({ as, ref: args[0], body }),
    text: (r, { store, as }) => {
      const ref = `${r.thread.team}/${r.thread.id}`;
      const out = [`${ref} is now in ${r.thread.phase}.`];
      if (r.thread.phase === 'design_review' && placeholderOnly(sectionText(r.thread.body, 'Design'))) {
        out.push(`note: ## Design still holds only the template text; fill it in now: ${cli(store)} thread edit ${ref} --section Design --body-file <file> --as ${as}`);
      }
      return out.join('\n');
    },
  },
  {
    words: ['task', 'new'], usage: 'task new <thread-ref> --title <t> [--owner m] [--issue I-###] [body]', write: true, who: 'the thread lead or you',
    about: 'Create a task (status todo); --issue links and accepts a manual or watch issue.',
    args: ['thread-ref'], flags: ['title', 'owner', 'issue'], body: true,
    run: ({ store, as, args, flags, body }) => store.createTask({ as, ref: args[0], title: flags.title, owner: flags.owner, issue: flags.issue, body }),
    text: (r) => `Created ${r.task.team}/${r.task.id} ${r.task.title} (${r.task.status}): ${r.task.path}${r.thread && r.thread.kind === 'project' ? `; ${where(r.thread)}` : ''}`,
  },
  {
    words: ['dispatch'], usage: 'dispatch <task-ref> --to <member> [--eta <time>] [body]', write: true, who: 'the thread lead or you',
    about: 'Hand a task to a builder (or the lead): owner set, status doing. --eta is your estimate (45m, 2h, 1h30m); the builder may set its own with `task eta`. Without it, an estimate the task has restarts now.',
    args: ['task-ref'], flags: ['to', 'eta'], body: true,
    run: ({ store, as, args, flags, body }) => store.dispatch({ as, task: args[0], to: flags.to, body, eta: flags.eta }),
    text: (r) => `Dispatched ${r.task.team}/${r.task.id} to ${r.task.owner} (${r.message.id})${r.task.eta ? `; estimate ${fmtDuration(r.task.eta.minutes)}` : ''}.`,
  },
  {
    words: ['result'], usage: 'result <task-ref> --outcome done|blocked|failed [body]', write: true, who: 'the task owner or the lead',
    about: 'Report a task outcome; done goes to review for the lead to accept.',
    args: ['task-ref'], flags: ['outcome'], body: true,
    run: ({ store, as, args, flags, body }) => store.result({ as, task: args[0], outcome: flags.outcome, body }),
    text: (r) => {
      const ref = `${r.task.team}/${r.task.id}`;
      if (r.task.status === 'review') return `Reported ${ref} done; it waits in review until ${r.thread.lead} runs \`factory task accept ${ref}\` (or task reject).`;
      return `Reported ${ref} ${r.message.outcome}; the task is ${r.task.status}${r.message.to.length ? `, waiting on ${r.message.to.join(', ')}` : ''}.`;
    },
  },
  {
    words: ['task', 'accept'], usage: 'task accept <task-ref> [body]', write: true, who: 'the thread lead or you',
    about: 'Accept a task: done; its issue becomes fixed; the last done task in build opens code review.',
    args: ['task-ref'], body: true,
    run: ({ store, as, args, body }) => store.acceptTask({ as, task: args[0], body }),
    text: (r) => `Accepted ${r.task.team}/${r.task.id} (done); ${where(r.thread)}.`,
  },
  {
    words: ['task', 'eta'], usage: 'task eta <task-ref> --eta <time>', write: true, who: 'the task owner, the thread lead or you',
    about: 'Estimate a task: for one in progress the time left from now, for one still to do its length once started (45m, 2h, 1h30m). Set it when you take the task and again when it moves. Posts an eta event.',
    args: ['task-ref'], flags: ['eta'],
    run: ({ store, as, args, flags }) => store.setTaskEta({ as, task: args[0], eta: flags.eta }),
    text: (r) => `Estimated ${r.task.team}/${r.task.id}: ${taskEtaText(r.task)}.`,
  },
  {
    words: ['task', 'reject'], usage: 'task reject <task-ref> --reason <text>', write: true, who: 'the thread lead or you',
    about: 'Send a task back to its owner with the reason (status doing).',
    args: ['task-ref'], flags: ['reason'],
    run: ({ store, as, args, flags }) => store.rejectTask({ as, task: args[0], reason: flags.reason }),
    text: (r) => `Sent ${r.task.team}/${r.task.id} back to ${r.task.owner} (${r.message.id}).`,
  },
  {
    words: ['issue', 'new'], usage: 'issue new <thread-ref> --severity high|medium|low|nit --title <t> [--source <text>] [--metric <name>] [body]', write: true, who: 'any thread member',
    about: 'Raise a manual issue (status open).',
    args: ['thread-ref'], flags: ['severity', 'title', 'source', 'metric'], body: true,
    run: ({ store, as, args, flags, body }) => store.createIssue({ as, ref: args[0], severity: flags.severity, title: flags.title, source: flags.source, metric: flags.metric, body }),
    text: (r) => `Raised ${r.issue.team}/${r.issue.id} (${r.issue.severity}) ${r.issue.title}`,
  },
  {
    words: ['issue', 'accept'], usage: 'issue accept <issue-ref> [--action <task title>] [--thread <project-thread>]', write: true, who: 'the thread lead or you',
    about: 'Accept a manual or watch issue: creates its task (review issues awaiting a response are answered with `respond`). A watch issue needs --thread: its fix is built and reviewed on that project thread.',
    args: ['issue-ref'], flags: ['action', 'thread'],
    run: ({ store, as, args, flags }) => store.acceptIssue({ as, issue: args[0], action: flags.action, thread: flags.thread }),
    text: (r) => `Accepted ${r.issue.team}/${r.issue.id} → ${r.task.id} ${r.task.title}; ${where(r.thread)}.`,
  },
  {
    words: ['issue', 'reject'], usage: 'issue reject <issue-ref> --reason <text>', write: true, who: 'the thread lead or you',
    about: 'Reject an issue with a reason.', args: ['issue-ref'], flags: ['reason'],
    run: ({ store, as, args, flags }) => store.rejectIssue({ as, issue: args[0], reason: flags.reason }),
    text: (r) => sentence(`${r.issue.team}/${r.issue.id} is rejected: ${r.issue.reason}`),
  },
  {
    words: ['issue', 'defer'], usage: 'issue defer <issue-ref> [--reason <text>]', write: true, who: 'the thread lead or you',
    about: 'Defer an issue.', args: ['issue-ref'], flags: ['reason'],
    run: ({ store, as, args, flags }) => store.deferIssue({ as, issue: args[0], reason: flags.reason }),
    text: (r) => sentence(`${r.issue.team}/${r.issue.id} is deferred${r.issue.reason ? `: ${r.issue.reason}` : ''}`),
  },
  {
    words: ['verify'], usage: 'verify <issue-ref> --pass|--fail [--note <text>]', write: true, who: 'the watch owner, the lead or you',
    about: 'Record a production check of a fixed issue: pass → verified, fail → open.',
    args: ['issue-ref'], flags: ['pass', 'fail', 'note'],
    run: ({ store, as, args, flags }) => {
      if (flags.pass && flags.fail) throw usage('give --pass or --fail, not both');
      if (!flags.pass && !flags.fail) throw usage('say whether it held in production: --pass or --fail');
      return store.verifyIssue({ as, issue: args[0], pass: Boolean(flags.pass), note: flags.note });
    },
    text: (r) => `${r.issue.team}/${r.issue.id} is ${r.issue.status}.`,
  },
  {
    words: ['decide'], write: true, who: 'you or the lead (--gate: you only)',
    usage: 'decide <thread-ref> --title <t> [--reply-to id] [--resolves a,b] [--refs a,b] [--gate g --verdict approve|changes_requested] [body]',
    about: 'Record a decision (decisions.md + a decision message); with --gate, override the current gate (it also settles your open escalations in the thread).',
    args: ['thread-ref'], flags: ['title', 'reply-to', 'resolves', 'refs', 'gate', 'verdict'], body: true,
    run: ({ store, as, args, flags, body }) => store.decide({
      as, ref: args[0], title: flags.title, body, reply_to: flags['reply-to'], resolves: flags.resolves, refs: flags.refs, gate: flags.gate, verdict: flags.verdict,
    }),
    text: decideText,
  },
  {
    words: ['watch', 'run'], write: true, who: 'the watch owner or the lead',
    usage: "watch run <thread-ref> (--metrics '<json>' | --metrics-file f | --exec) [--from iso] [--to iso] [--note text]",
    about: 'Measure, append metrics.jsonl, write the report, open issues on breaches, verify or reopen fixed issues.',
    args: ['thread-ref'], flags: ['metrics', 'metrics-file', 'exec', 'from', 'to', 'note'],
    run: ({ store, as, args, flags }) => {
      if (flags.metrics !== undefined && flags['metrics-file'] !== undefined) throw usage('give --metrics or --metrics-file, not both');
      const metrics = flags['metrics-file'] !== undefined ? readTextFile(flags['metrics-file'], '--metrics-file') : flags.metrics;
      return store.watchRun({ as, ref: args[0], metrics, exec: Boolean(flags.exec), from: flags.from, to: flags.to, note: flags.note });
    },
    text: (r) => {
      const out = [`${r.thread.team}/${r.thread.id}: ${r.report.status}${r.run.breaches.length ? ` (${r.run.breaches.join(', ')})` : ''} — report ${r.report.path}`];
      for (const i of r.issues.opened) out.push(`  + ${i.id} [${i.severity}] ${i.title}`);
      for (const i of r.issues.reopened) out.push(`  ! reopened ${i.id} ${i.title}`);
      for (const i of r.issues.verified) out.push(`  ✓ verified ${i.id} ${i.title}`);
      for (const i of r.issues.tracked) out.push(`  = already tracked ${i.id} (${i.status}) ${i.title}`);
      for (const i of r.issues.recovered || []) out.push(`  ~ ${i.id} (${i.status}) recovered without a verified fix — triage: ${i.title}`);
      const measured = r.run?.metrics || {};
      const missing = Object.keys(r.thread.thresholds || {}).filter((k) => !(k in measured));
      if (missing.length) out.push(`  ? not measured (reported as missing, not a breach): ${missing.join(', ')}`);
      return out.join('\n');
    },
  },
  {
    words: ['watch', 'pause'], usage: 'watch pause <thread-ref>', write: true, who: 'the thread lead or you',
    about: 'Pause a watch thread (runs are refused, nothing is due).', args: ['thread-ref'],
    run: ({ store, as, args }) => store.setWatchState({ as, ref: args[0], state: 'paused' }),
    text: (r) => `${r.thread.team}/${r.thread.id} is paused.`,
  },
  {
    words: ['watch', 'resume'], usage: 'watch resume <thread-ref>', write: true, who: 'the thread lead or you',
    about: 'Resume a paused watch thread.', args: ['thread-ref'],
    run: ({ store, as, args }) => store.setWatchState({ as, ref: args[0], state: 'active' }),
    text: (r) => `${r.thread.team}/${r.thread.id} is active.`,
  },
  {
    words: ['ui'], usage: 'ui [--detach] [--open] [--thread <thread-ref>] [--stop [--runs]] [--at-login | --no-at-login] [--port 4477] [--host 127.0.0.1] [--allow-host a,b]',
    about: 'Serve the board UI (tools/factory-ui) on the same root. When a board for this root already runs on the port, just print its link. --detach runs it in the background and returns; --open opens the link in the browser; --thread links straight to that thread\'s chat; --stop stops the background board and its autopilot, leaving agent runs going (--runs stops them too). --at-login (macOS) also starts this board, and so its autopilot, every time you log in, so a restart of the machine leaves no agent waiting: a launchd login item in ~/Library/LaunchAgents, then the board in the background now; --no-at-login removes it. It has no sign-in and every write acts as you; a --host other than loopback prints a warning, and the board answers only to this machine\'s names plus --allow-host ones.',
    flags: ['port', 'host', 'allow-host', 'thread', 'detach', 'open', 'stop', 'runs', 'at-login', 'no-at-login'], serve: true,
    run: startUi,
  },
  {
    words: ['autopilot'], usage: 'autopilot [--detach] [--stop [--runs]] [--dry-run] [--once] [--settle 20s] [--session <thread-ref>=<session-id>]',
    about: 'Start agents by themselves when they hold a turn, so the owner does not relay prompts (PROTOCOL §16, "Autopilot"). Today that is openai, through the Codex CLI (`codex exec`), and the agent of each single-agent thread, through Claude Code (`claude -p`); grok has no headless mode and stays on the board. It reads the thread files every few seconds and calls no model while idle. --detach runs it in the background (once per root); --stop stops it and leaves the runs going, so a restart never interrupts an agent (the next autopilot takes them over, keeps their time limit and records how they end); --stop --runs stops them too; --dry-run prints what it would start now; --once makes one pass and waits for the runs it started. --settle is how long a new turn waits first, so several messages get one run. Each agent keeps one session per thread: the first run starts it and later runs resume it; --session <thread-ref>=<id> makes a thread use an existing session, and --session <thread-ref>= forgets it.',
    flags: ['detach', 'stop', 'runs', 'dry-run', 'once', 'settle', 'session'], serve: true,
    run: autopilotCmd,
  },
];

const READ_COUNT = COMMANDS.findIndex((c) => c.words[0] === 'init');

function decideText(r) {
  return `Recorded ${r.decision.id}: ${r.decision.title}${r.decision.gate ? ` (${r.decision.gate} ${r.decision.verdict})` : ''}; ${where(r.thread)}.`;
}

/** When a watch run with no --from would start: the previous run's `to`, else the thread's creation. */
function nextWindowStart(v) {
  const prev = (v.metrics || []).at(-1);
  return prev?.window?.to || v.thread.created;
}

function threadShowText(v, store) {
  const th = v.thread;
  const out = [`${v.team}/${th.id} · ${th.title}`];
  out.push(th.kind === 'solo'
    ? `single-agent · ${th.phase} · agent ${th.owner} (its lead)`
    : `${th.kind} · phase ${th.phase} · lead ${th.lead}${th.owner ? ` · owner ${th.owner}` : ''} · branch ${th.branch}`);
  if (th.kind === 'solo') {
    const teamRules = (v.allowRules || []).filter((x) => x.scope === 'team').map((x) => x.rule);
    out.push(`allowed commands beyond the factory CLI and read-only tools: ${list(th.allow)}${teamRules.length ? `; for the whole team: ${list(teamRules)}` : ''}`);
  }
  const gates = gateLine(th);
  if (gates) out.push(`gates: ${gates}`);
  const eta = etaLine(th, v.messages);
  if (eta) out.push(eta);
  if (th.kind === 'watch') {
    const ths = Object.entries(th.thresholds || {}).map(([k, t]) => `${k}${t.max != null ? ` ≤ ${t.max}` : ''}${t.min != null ? ` ≥ ${t.min}` : ''}`);
    out.push(`cadence ${th.cadence} · last run ${when(th.last_run)} · thresholds ${list(ths)}`);
    out.push(`created ${when(th.created)} · the next run's window starts ${when(nextWindowStart(v))} (the previous run's end, else the creation)`);
  }
  out.push(`members: ${list(th.members)}`);
  out.push(...rolesLines(th));
  for (const x of v.openTurns) out.push(`waiting on ${x.member}: ${x.message.type} from ${x.message.from}, ${age(x.age_seconds)} ago — ${x.message.summary}  ${x.message.id}`);
  if (!v.openTurns.length) {
    const step = nextStep(th, `${v.team}/${th.id}`, store);
    if (step) out.push(`next: ${step}`);
  }
  out.push('', String(th.body ?? '').replace(/\s+$/, ''), '');
  out.push(`Tasks (${v.tasks.length})`);
  for (const x of v.tasks) out.push(`  ${taskLine(x)}`);
  out.push(`Issues (${v.issues.length})`);
  for (const x of v.issues) out.push(`  ${issueLine(x)}`);
  if (v.decisions.length) {
    out.push(`Decisions (${v.decisions.length})`);
    for (const d of v.decisions) out.push(`  ${d.id} ${d.title} (${d.by})`);
  }
  return out.join('\n');
}

function boardText(b, store) {
  const out = [`Factory board · ${when(b.generated)} UTC`];
  const broken = b.brokenTeams || [];
  if (!b.teams.length && !broken.length) out.push('', `No teams yet. Start one: ${cli(store)} team new <team> --title "<Title>" --as you`);
  for (const x of broken) out.push('', `${x.id} · BROKEN: ${x.path} cannot be read (${x.error}); its threads are not shown. Report it to the owner.`);
  for (const t of b.teams) {
    out.push('', `${t.id} · ${t.title} (lead ${t.lead})`);
    const projects = t.threads.filter((x) => x.kind === 'project');
    for (const phase of PROJECT_PHASES) {
      for (const x of projects.filter((p) => p.phase === phase)) {
        const gate = x.gates && x.gates[phase] ? ` ${x.gates[phase].status}` : '';
        const mover = nextMover(x);
        const waiting = x.openTurns.length ? `  waiting on ${[...new Set(x.openTurns.map((o) => o.member))].join(', ')}` : mover ? `  next ${mover}` : '';
        out.push(`  ${pad(phase + gate, 24)} ${pad(x.id, 24)} tasks ${x.tasks.done}/${x.tasks.total}  issues ${x.issues.open} open${waiting}  ${x.title}`);
      }
    }
    for (const x of t.threads.filter((w) => w.kind === 'watch')) {
      const last = x.lastMetrics ? `${x.lastMetrics.breaches.length ? `breach ${x.lastMetrics.breaches.join(', ')}` : 'ok'} at ${when(x.lastMetrics.ts)}` : 'never run';
      out.push(`  ${pad(`watch ${x.phase}`, 24)} ${pad(x.id, 24)} ${x.cadence}, ${last}  issues ${x.issues.open} open  ${x.title}`);
    }
    for (const x of t.threads.filter((w) => w.kind === 'solo')) {
      const waiting = x.openTurns.length ? `waiting on ${[...new Set(x.openTurns.map((o) => o.member))].join(', ')}` : 'idle';
      out.push(`  ${pad('single agent', 24)} ${pad(x.id, 24)} ${x.owner}, ${waiting}  ${x.title}`);
    }
    const tasks = t.tasks.filter((x) => x.status !== 'done');
    if (tasks.length) out.push(`  open tasks: ${tasks.map((x) => `${x.id} ${x.status}${x.owner ? ` (${x.owner})` : ''}`).join(', ')}`);
  }
  return out.join('\n');
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/** "90s" / "15m" / "6h" → milliseconds. */
function durationMs(v, fallback, flag = '--timeout') {
  if (v === undefined) return fallback;
  const m = /^(\d+)(s|m|h)$/.exec(String(v).trim());
  if (!m || (Number(m[1]) < 1 && flag === '--timeout')) throw usage(`${flag} must look like 90s, 15m or 6h (got "${v}")`);
  return Number(m[1]) * { s: 1000, m: 60000, h: 3600000 }[m[2]];
}

/**
 * Block until a new message in a thread is for the caller: addressed to them
 * (to or cc), a reply to one of their messages, or, when they lead the thread,
 * anything the owner writes. Messages the caller wrote, and factory events their
 * own actions produced, never count. Without --as, any new message counts.
 * While it runs, the caller's presence is `watching` (the board's badge).
 */
/**
 * `factory merge`: the lead (or you) merges a signed-off thread's PR. The store
 * checks who and the sign-off; this checks the PR with gh ($FACTORY_GH_BIN in
 * tests) and merges exactly the head that was signed off (--match-head-commit).
 */
function mergeThread({ store, as, args }) {
  const ref = args[0];
  const c = store.mergeCheck({ as, ref });
  const conflict = (message) => new FactoryError('conflict', message);
  const gh = (argv) => {
    const r = spawnSync(process.env.FACTORY_GH_BIN || 'gh', argv, { cwd: store.root, encoding: 'utf8', timeout: 120000 });
    if (r.error || r.status !== 0) throw conflict(`gh ${argv.slice(0, 2).join(' ')} failed: ${String(r.stderr || r.stdout || r.error?.message || '').trim().replace(/\s+/g, ' ').slice(0, 400)}`);
    return r.stdout;
  };
  const view = () => {
    try {
      return JSON.parse(gh(['pr', 'view', c.branch, '--json', 'number,url,state,isDraft,mergeable,baseRefName,headRefName,headRefOid,mergeCommit,commits']));
    } catch (e) {
      if (e instanceof FactoryError) throw e;
      throw conflict(`gh pr view ${c.branch} did not return JSON`);
    }
  };
  let pr = view();
  if (pr.headRefName !== c.branch) throw conflict(`the PR gh found is for ${pr.headRefName}, not ${c.branch}`);
  if (pr.baseRefName !== 'main') throw conflict(`PR #${pr.number} targets ${pr.baseRefName}, not main; retarget it before merging`);
  if (pr.state === 'MERGED') {
    // Merged some other way: record it once, so the thread says where its code went.
    const commit = pr.mergeCommit?.oid ?? null;
    const recorded = store.messages(`${c.team}/${c.id}`).some((m) => m.type === 'event' && m.event?.kind === 'merged' && m.event?.pr === pr.number);
    const rec = recorded ? null : store.recordMerge({ as, ref, pr: pr.number, url: pr.url, commit, outside: true });
    return { pr: pr.number, url: pr.url, commit, already: true, recorded: Boolean(rec), ...(rec ? { event: rec.event.id } : {}) };
  }
  if (pr.state !== 'OPEN') throw conflict(`PR #${pr.number} is ${String(pr.state).toLowerCase()}; reopen it first`);
  const last = (pr.commits || []).at(-1);
  const lastAt = Date.parse(last?.committedDate || '');
  if (!Number.isFinite(lastAt) || lastAt > Date.parse(c.signedOffAt)) {
    throw conflict(`PR #${pr.number} has a commit from after the sign-off (${String(last?.oid || '?').slice(0, 9)}, ${last?.committedDate || 'no date'}); ask you to sign it off again`);
  }
  if (pr.mergeable === 'CONFLICTING') throw conflict(`PR #${pr.number} has merge conflicts with main; resolve them on ${c.branch}, then ask you to sign it off again`);
  const readied = Boolean(pr.isDraft);
  if (readied) gh(['pr', 'ready', String(pr.number)]);
  try {
    gh(['pr', 'merge', String(pr.number), '--merge', '--match-head-commit', pr.headRefOid]);
  } catch (e) {
    // Leave the PR as it was: a draft stays a draft when the merge fails.
    if (readied) { try { gh(['pr', 'ready', String(pr.number), '--undo']); } catch { /* the merge error is the one to report */ } }
    throw e;
  }
  pr = view();
  const commit = pr.mergeCommit?.oid ?? null;
  const rec = store.recordMerge({ as, ref, pr: pr.number, url: pr.url, commit });
  return { pr: pr.number, url: pr.url, commit, event: rec.event.id };
}

async function waitThread({ store, as, args, flags }) {
  const ref = args[0];
  const th = store.thread(ref);
  const key = `${th.team}/${th.id}`;
  const lead = th.lead ?? th.owner ?? null;
  const limit = durationMs(flags.timeout, 6 * 3600000);
  const known = store.messages(key);
  const seen = new Set(known.map((m) => m.id));
  const fromOf = new Map(known.map((m) => [m.id, m.from]));
  const list = (v) => (Array.isArray(v) ? v : v == null ? [] : [v]);
  const mine = (m) => as && (m.from === as || (m.from === 'factory' && m.event && m.event.by === as));
  const forMe = (m) => !as
    || list(m.to).includes(as) || list(m.cc).includes(as)
    || (m.reply_to != null && fromOf.get(m.reply_to) === as)
    || (as === lead && m.from === 'you');
  const done = (state, activity) => as && store.notePresence(as, { state, thread: key, activity });
  if (as) store.notePresence(as, { state: 'watching', thread: key, activity: 'waiting for a message', pid: process.pid });
  const started = Date.now();
  for (;;) {
    await sleep(Math.min(3000, Math.max(250, limit / 20)));
    const fresh = openStore({ root: store.root });
    const now = fresh.messages(key).filter((m) => !seen.has(m.id));
    for (const m of now) {
      seen.add(m.id);
      fromOf.set(m.id, m.from);
    }
    const theirs = now.filter((m) => !mine(m) && forMe(m));
    const phase = fresh.thread(key).phase;
    if (theirs.length) {
      done('working', `reading ${theirs.length === 1 ? 'a new message' : `${theirs.length} new messages`}`);
      return {
        ref: key, as: as || null, timed_out: false, phase,
        messages: theirs.map((m) => ({ id: m.id, ts: m.ts, from: m.from, type: m.type, summary: summary(m) })),
        waiting_on_you: as ? fresh.openTurns({ member: as, thread: key }) : [],
      };
    }
    if (Date.now() - started >= limit) {
      done('idle', `stopped waiting after ${flags.timeout || '6h'}`);
      return { ref: key, as: as || null, timed_out: true, waited: flags.timeout || '6h', phase, messages: [], waiting_on_you: [] };
    }
  }
}

// Commands that say nothing about what an agent is doing.
const NO_PRESENCE = new Set(['ui', 'autopilot', 'wait', 'help', 'validate', 'init']);
const THREAD_REF_RE = /^[a-z0-9][a-z0-9-]*\/[a-z0-9][a-z0-9-]*$/;

/**
 * After a command succeeds, record that its actor is working (the board's badge):
 * the message it wrote when there is one ("note: On it: ..."), else the command.
 */
function notePresenceFor(cmd, { store, as, args }, result) {
  if (NO_PRESENCE.has(cmd.words[0])) return;
  const inbox = cmd.words[0] === 'inbox';
  const who = as || (inbox ? args[0] : undefined);
  if (!who) return;
  const target = inbox ? undefined : args[0];
  const msg = result && typeof result === 'object' && result.message && typeof result.message === 'object' ? result.message : null;
  const thread = msg && msg.thread && typeof target === 'string' && target.includes('/')
    ? `${target.split('/')[0]}/${msg.thread}`
    : typeof target === 'string' && THREAD_REF_RE.test(target) ? target : null;
  const activity = msg && msg.type ? `${msg.type}: ${summary(msg)}` : [...cmd.words, ...(typeof target === 'string' ? [target] : [])].join(' ');
  store.notePresence(who, { state: 'working', thread, activity });
}

/** Ask a port whether a factory board answers there: null (nothing), {foreign} or {root, pid, url}. */
function probeBoard(host, port) {
  const h = !host || host === '0.0.0.0' || host === '::' ? '127.0.0.1' : host.includes(':') && !host.startsWith('[') ? `[${host}]` : host;
  return new Promise((resolve) => {
    const req = http.get({ host: h.replace(/^\[(.*)\]$/, '$1'), port, path: '/api/info', timeout: 1000, headers: { Host: `${h}:${port}` } }, (res) => {
      let text = '';
      res.setEncoding('utf8');
      res.on('data', (c) => { text += c; });
      res.on('end', () => {
        try {
          const info = JSON.parse(text);
          resolve(info && info.app === 'factory-board' ? info : { foreign: true });
        } catch {
          resolve({ foreign: true });
        }
      });
    });
    req.on('timeout', () => req.destroy(new Error('timeout')));
    req.on('error', (err) => resolve(err.code === 'ECONNREFUSED' ? null : { foreign: true }));
  });
}

/** Open a link in the default browser; best effort, never fails the command. */
function openBrowser(url) {
  const [cmd, args] = process.platform === 'darwin' ? ['open', [url]] : process.platform === 'win32' ? ['cmd', ['/c', 'start', '', url]] : ['xdg-open', [url]];
  try {
    const child = spawn(cmd, args, { detached: true, stdio: 'ignore' });
    child.on('error', () => {});
    child.unref();
  } catch {
    // no browser available: the link is printed anyway
  }
}

async function startUi({ store, flags, json }) {
  if (!fs.existsSync(UI_SERVER)) {
    throw new FactoryError('not_found', `the board UI is not installed: ${path.relative(process.cwd(), UI_SERVER) || UI_SERVER} is missing`);
  }
  const host = flags.host || '127.0.0.1';
  const port = portNumber(flags.port);
  const allowHosts = flags['allow-host'] === undefined ? [] : String(flags['allow-host']).split(',').map((x) => x.trim()).filter(Boolean);
  const linkTo = (url) => {
    if (!flags.thread) return url;
    const th = store.thread(String(flags.thread));
    return `${url.replace(/\/$/, '')}/#/t/${encodeURIComponent(th.team)}/${encodeURIComponent(th.id)}`;
  };
  if (flags.thread) linkTo('http://x'); // a bad --thread fails before anything starts
  const say = (obj, text) => process.stdout.write(json ? `${JSON.stringify(obj)}\n` : `${text}\n`);
  const atLogin = Boolean(flags['at-login']);
  if (atLogin && flags['no-at-login']) throw usage('--at-login adds the login item and --no-at-login removes it: give one');
  if ((atLogin || flags['no-at-login']) && flags.stop) throw usage('--stop stops the board now; --at-login and --no-at-login change what starts at login: give them apart');
  if (atLogin && process.platform !== 'darwin') throw new FactoryError('invalid', '--at-login adds a macOS login item (launchd); on this system, start `node factory/bin/factory.mjs ui --detach` from your session\'s startup instead');
  if ((atLogin || flags['no-at-login']) && !port) throw usage('--at-login and --no-at-login need a fixed --port (not 0)');
  const home = process.env.HOME || os.homedir();
  if (flags['no-at-login']) {
    const file = loginItemPath(home, port);
    const had = fs.existsSync(file);
    fs.rmSync(file, { force: true });
    // launchd keeps the job loaded until logout; with the file gone it never runs again. A board running now keeps running.
    return say({ removed: had, plist: file, port }, had
      ? `The board on port ${port} no longer starts at login (removed ${file}). A board running now keeps running.`
      : `Nothing to remove: no login item for port ${port} (${file}).`);
  }
  /** Write the login item that runs this board (foreground: launchd owns it) at every login. */
  const installLoginItem = () => {
    const file = loginItemPath(home, port);
    const log = loginItemLog(home, port);
    const argv = [process.execPath, CLI_FILE, 'ui', '--root', store.root, '--port', String(port), '--host', host, ...(allowHosts.length ? ['--allow-host', allowHosts.join(',')] : [])];
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.mkdirSync(path.dirname(log), { recursive: true });
    fs.writeFileSync(file, loginItemPlist({ label: loginItemLabel(port), argv, cwd: store.root, env: loginEnv(process.env), log }), { mode: 0o644 });
    return { plist: file, log };
  };
  const loginText = (item) => (item ? ` It starts at every login (${item.plist}; output in ${item.log}; remove it: node factory/bin/factory.mjs ui --no-at-login${port === 4477 ? '' : ` --port ${port}`}).` : '');
  const running = port ? await probeBoard(host, port) : null;
  const stopHint = `stop it: node factory/bin/factory.mjs ui --stop${port === 4477 ? '' : ` --port ${port}`}`;

  if (flags.stop) {
    if (!running) return say({ stopped: false, running: false, port }, `No factory board is running on port ${port}.`);
    if (running.foreign) throw new FactoryError('conflict', `port ${port} is not a factory board; nothing stopped`);
    if (running.root !== store.root) throw new FactoryError('conflict', `the board on port ${port} serves another root (${running.root}); nothing stopped`);
    process.kill(running.pid, 'SIGTERM');
    // The board keeps the autopilot running, so stopping the board stops it too.
    const ap = runningAutopilot(store.root);
    // Agent runs keep going (the next autopilot takes them over), unless --runs.
    if (ap || flags.runs) spawnSync(process.execPath, [CLI_FILE, 'autopilot', '--stop', ...(flags.runs ? ['--runs'] : []), '--root', store.root], { stdio: 'ignore', timeout: 30000 });
    return say({ stopped: true, pid: running.pid, port, autopilot_stopped: Boolean(ap) }, `Stopped the factory board on port ${port} (pid ${running.pid})${ap ? ' and its autopilot' : ''}${flags.runs ? ', and its agent runs' : '; agent runs keep going'}.`);
  }
  if (running) {
    if (running.foreign) throw new FactoryError('conflict', `port ${port} is in use by something that is not a factory board; pass --port <n>`);
    if (running.root !== store.root) throw new FactoryError('conflict', `port ${port} already serves another factory root (${running.root}); pass --port <n>`);
    const url = linkTo(running.url);
    const item = atLogin ? installLoginItem() : null;
    if (flags.open) openBrowser(url);
    return say({ url, root: store.root, pid: running.pid, already_running: true, ...(item ? { at_login: item.plist } : {}) }, `Factory board: ${url}  (already running; ${stopHint})${loginText(item)}`);
  }
  // At login, launchd runs the board; now, it runs in the background as --detach does.
  if (flags.detach || atLogin) {
    if (!port) throw usage('--detach needs a fixed --port (not 0) so later calls can find the board');
    const log = path.join(os.tmpdir(), `factory-ui-${port}.log`);
    const fd = fs.openSync(log, 'a');
    const argv = [CLI_FILE, 'ui', '--root', store.root, '--port', String(port), '--host', host];
    if (allowHosts.length) argv.push('--allow-host', allowHosts.join(','));
    const child = spawn(process.execPath, argv, { detached: true, stdio: ['ignore', fd, fd], cwd: store.root });
    child.unref();
    fs.closeSync(fd);
    let up = null;
    for (let i = 0; i < 60 && (!up || up.foreign); i++) {
      await sleep(150);
      up = await probeBoard(host, port);
    }
    if (!up || up.foreign || up.root !== store.root) throw new FactoryError('invalid', `the board did not start on port ${port}; see ${log}`);
    const url = linkTo(up.url);
    const item = atLogin ? installLoginItem() : null;
    if (flags.open) openBrowser(url);
    return say({ url, root: store.root, pid: up.pid, log, detached: true, ...(item ? { at_login: item.plist } : {}) }, `Factory board: ${url}  (running in the background; ${stopHint})${loginText(item)}`);
  }
  const mod = await import(pathToFileURL(UI_SERVER).href);
  if (typeof mod.startServer !== 'function') throw new FactoryError('invalid', `${UI_SERVER} does not export startServer({root, port, host})`);
  const { url, bind, warning } = await mod.startServer({ root: store.root, port, host, allowHosts });
  keepAutopilot(store.root);
  const link = linkTo(url);
  if (flags.open) openBrowser(link);
  if (json) process.stdout.write(`${JSON.stringify({ url: link, root: store.root, bind, warning: warning || null })}\n`);
  else process.stdout.write(`Factory board: ${link}  (root ${store.root}${warning ? `; listening on ${bind}` : ''}) — Ctrl-C to stop\n`);
  return undefined;
}

/** How often the board checks that its autopilot still runs. */
const AUTOPILOT_CHECK_MS = 30000;

/**
 * The autopilot is the factory's default: while a board runs, it keeps this
 * root's autopilot running, starting it now and again whenever it has stopped.
 * $FACTORY_NO_AUTOPILOT=1 turns that off (the test suite sets it).
 */
function keepAutopilot(root) {
  if (process.env.FACTORY_NO_AUTOPILOT === '1') return;
  const ensure = () => {
    if (runningAutopilot(root)) return;
    const r = spawnSync(process.execPath, [CLI_FILE, 'autopilot', '--detach', '--root', root], { cwd: root, encoding: 'utf8', timeout: 30000 });
    const said = String(r.stdout || r.stderr || '').trim().split('\n').pop();
    process.stderr.write(`${new Date().toISOString()} board: autopilot ${r.status === 0 ? 'started' : 'did not start'}: ${said}\n`);
  };
  ensure();
  setInterval(ensure, AUTOPILOT_CHECK_MS).unref();
}

const PLAN_TEXT = {
  idle: 'nothing to do',
  stuck: 'waiting for the owner: its last run left these turns open',
  running: 'a run is going',
  manual: 'a session the owner started is working on it',
  settling: 'a new turn is settling',
  capped: `hit ${MAX_RUNS_PER_HOUR} runs this hour; waiting for the owner`,
};

async function autopilotCmd({ store, flags, json }) {
  const root = store.root;
  const say = (obj, text) => process.stdout.write(json ? `${JSON.stringify(obj)}\n` : `${text}\n`);
  const settleMs = durationMs(flags.settle, SETTLE_MS, '--settle');
  const running = runningAutopilot(root);
  if (flags.session !== undefined) {
    const m = /^([^=\s]+)=(\S*)$/.exec(String(flags.session).trim());
    if (!m) throw usage('--session must look like <thread-ref>=<codex-session-id> (or <thread-ref>= to forget it)');
    const th = store.thread(m[1]);
    const ref = `${th.team}/${th.id}`;
    // A single-agent thread's session is its agent's; on any other thread it is openai's (the reviewer).
    const member = th.kind === 'solo' ? th.owner : 'openai';
    if (m[2] && !SESSION_RE.test(m[2])) throw usage(`--session: "${m[2]}" is not a session id (a UUID: Codex prints "session id: ...", Claude Code shows it in /status)`);
    setSession(root, member, ref, m[2] || null);
    return say({ member, thread: ref, session: m[2] || null }, m[2]
      ? `${member}'s next run on ${ref} resumes session ${m[2]}. Do not also type into that session yourself.`
      : `${member}'s next run on ${ref} starts a new session.`);
  }
  if (flags.stop) {
    // A stop leaves agent runs going (the next autopilot takes them over); --runs stops them too.
    const runsText = (list) => list.map((x) => `${x.member} on ${x.ref} (pid ${x.pid})`).join(', ');
    if (running) {
      try {
        process.kill(running, 'SIGTERM');
      } catch {
        // it stopped on its own just now
      }
      for (let i = 0; i < 100 && pidAlive(running); i++) await sleep(100);
    }
    if (flags.runs) {
      const left = stopLeftoverRuns(root);
      const what = left.length ? `stopped ${runsText(left)}` : 'no run was going';
      return say({ stopped: Boolean(running), running: Boolean(running), ...(running ? { pid: running } : {}), leftover_runs: left }, running ? `Stopped the autopilot (pid ${running}); ${what}.` : `No autopilot is running for this root; ${what}.`);
    }
    const going = store.autopilot().leftover_runs;
    const tail = going.length ? ` ${going.length === 1 ? 'A run keeps' : `${going.length} runs keep`} going: ${runsText(going)}. The next autopilot takes ${going.length === 1 ? 'it' : 'them'} over; --stop --runs stops ${going.length === 1 ? 'it' : 'them'}.` : '';
    if (!running) return say({ stopped: false, running: false, runs_going: going }, `No autopilot is running for this root.${tail}`);
    return say({ stopped: true, pid: running, runs_going: going }, `Stopped the autopilot (pid ${running}).${tail}`);
  }
  if (flags['dry-run']) {
    const { plans, members } = await startAutopilot({ root, dryRun: true, settleMs }).done;
    const lines = Object.entries(members).map(([id, m]) => {
      if (!m.enabled) return `${id}: off (${m.reason})`;
      const p = plans.find((x) => x.member === id);
      return p.launch ? `${id}: would start on ${p.launch.ref} for ${p.launch.turnIds.join(', ')}` : `${id}: ${PLAN_TEXT[p.reason] || p.reason}`;
    });
    const sessions = readSessions(root);
    for (const [member, refs] of Object.entries(sessions)) {
      for (const [ref, id] of Object.entries(refs || {})) lines.push(`${member} session on ${ref}: ${id} (resumed on its next turn there)`);
    }
    return say({ running: running || null, plans, members, sessions }, `${running ? `Autopilot is running (pid ${running}).` : 'Autopilot is not running.'}\n${lines.join('\n')}`);
  }
  if (running) return say({ pid: running, already_running: true }, `The autopilot is already running (pid ${running}); stop it: node factory/bin/factory.mjs autopilot --stop`);
  if (flags.detach && flags.once) throw usage('--once runs in the foreground; drop --detach (a detached autopilot runs until --stop)');
  if (flags.detach) {
    const dir = autopilotDir(root);
    fs.mkdirSync(dir, { recursive: true });
    const log = path.join(dir, 'autopilot.log');
    const fd = fs.openSync(log, 'a');
    const argv = [CLI_FILE, 'autopilot', '--root', root];
    if (flags.settle !== undefined) argv.push('--settle', String(flags.settle));
    const child = spawn(process.execPath, argv, { detached: true, stdio: ['ignore', fd, fd], cwd: root, env: process.env });
    child.unref();
    fs.closeSync(fd);
    let up = null;
    for (let i = 0; i < 50 && !up; i++) {
      await sleep(100);
      up = runningAutopilot(root);
    }
    if (!up) throw new FactoryError('invalid', `the autopilot did not start; see ${log}`);
    // Two sessions starting at once: the other one's autopilot won the lock, and this child exited.
    if (up !== child.pid) return say({ pid: up, already_running: true }, `The autopilot is already running (pid ${up}); stop it: node factory/bin/factory.mjs autopilot --stop`);
    const on = Object.entries(store.autopilot().members).map(([id, m]) => (m.enabled ? `${id} on` : `${id} off: ${m.reason}`)).join('; ');
    return say({ pid: child.pid, log, detached: true }, `Autopilot running in the background (pid ${child.pid}; ${on}). Stop it: node factory/bin/factory.mjs autopilot --stop`);
  }
  const stamp = (line) => process.stdout.write(json ? '' : `${new Date().toISOString()} ${line}\n`);
  const ap = startAutopilot({ root, once: Boolean(flags.once), settleMs, log: stamp });
  // Every way a terminal or `--stop` ends it, more than once included. Its runs keep going: the next autopilot takes them over.
  const stopOn = () => ap.stop();
  const SIGNALS = ['SIGTERM', 'SIGINT', 'SIGHUP'];
  for (const sig of SIGNALS) process.on(sig, stopOn);
  const end = await ap.done;
  for (const sig of SIGNALS) process.off(sig, stopOn);
  if (json) process.stdout.write(`${JSON.stringify(end)}\n`);
  return undefined;
}

// ---------------------------------------------------------------------------
// Help
// ---------------------------------------------------------------------------

function globalHelp() {
  const line = (c) => `  ${c.usage}`;
  return [
    'factory — the software factory CLI. State lives in teams/; the protocol is factory/PROTOCOL.md.',
    '',
    'Usage: node factory/bin/factory.mjs <command> [args] [--as <member>] [--root <dir>] [--json]',
    '',
    'Read:',
    ...COMMANDS.slice(0, READ_COUNT).map(line),
    '',
    'Write (--as required except init):',
    ...COMMANDS.slice(READ_COUNT).filter((c) => !c.serve).map(line),
    '',
    'Board UI:',
    ...COMMANDS.filter((c) => c.serve).map(line),
    '',
    'Global options:',
    '  --as <member>   who is acting (default $FACTORY_AS); every write needs it',
    '  --root <dir>    factory root (default $FACTORY_ROOT, else the repo holding this CLI)',
    '  --json          print exactly one JSON document (the store result)',
    '  --help, -h      help; also per command: factory <command> --help',
    '  $FACTORY_ROOT / $FACTORY_AS / $FACTORY_NOW  defaults for --root, --as and the clock',
    'Bodies: --body <text>, --body-file <path> (- reads stdin to the end), a trailing argument, or piped stdin.',
    'Refs: threads <team>/<thread>; tasks/issues <team>/T-001, <team>/I-001 (bare when unique). Lists take commas: --to openai,grok.',
    'Exit codes: 0 ok · 1 refused or failed (stderr "factory: ...") · 2 usage error.',
  ].join('\n');
}

/** Help as one JSON document (with --json). */
function helpJson(c) {
  if (!c) {
    return {
      usage: 'node factory/bin/factory.mjs <command> [args] [--as <member>] [--root <dir>] [--json]',
      commands: COMMANDS.map((x) => ({ command: x.words.join(' '), usage: x.usage, about: x.about, write: Boolean(x.write) })),
      global: ['as', 'root', 'json', 'help'],
    };
  }
  return { command: c.words.join(' '), usage: `factory ${c.usage}`, about: c.about, who: c.who ?? null, flags: [...(c.flags || []), ...(c.body ? BODY_FLAGS : [])], global: ['as', 'root', 'json', 'help'], write: Boolean(c.write) };
}

function commandHelp(c) {
  const flags = c.flags || [];
  const out = [`Usage: factory ${c.usage}`, '', c.about];
  if (c.who) out.push(`Who: ${c.who}.`);
  if (c.body) out.push('Body: --body <text>, --body-file <path> (- reads stdin to the end), a trailing argument, or piped stdin.');
  if (flags.length) out.push(`Options: ${flags.map((f) => `--${f}`).join(' ')}`);
  out.push(`Global: --as <member> --root <dir> --json --help${c.write ? ' (this command needs --as)' : ''}`);
  return out.join('\n');
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

function findCommand(positionals) {
  const two = positionals.slice(0, 2).join(' ');
  const one = positionals[0];
  return COMMANDS.find((c) => c.words.length === 2 && c.words.join(' ') === two)
    || COMMANDS.find((c) => c.words.length === 1 && c.words[0] === one)
    || null;
}

function unknownCommand(positionals) {
  const word = positionals[0];
  const group = COMMANDS.filter((c) => c.words.length === 2 && c.words[0] === word);
  if (group.length) return usage(`\`factory ${word}\` needs a subcommand: ${group.map((c) => c.words[1]).join(', ')}`);
  return usage(`unknown command "${positionals.join(' ')}"; run \`factory --help\``);
}

function checkFlags(cmd, flags) {
  const allowed = new Set([...GLOBAL_FLAGS, ...(cmd.flags || []), ...(cmd.body ? BODY_FLAGS : [])]);
  for (const name of Object.keys(flags)) {
    if (!allowed.has(name)) throw usage(`\`factory ${cmd.words.join(' ')}\` does not take --${name}; see \`factory ${cmd.words.join(' ')} --help\``);
  }
}

function splitArgs(cmd, rest) {
  const specs = cmd.args || [];
  const required = specs.filter((a) => !a.endsWith('?')).length;
  if (rest.length < required) throw usage(`missing <${specs[rest.length].replace(/\?$/, '')}>: factory ${cmd.usage}`);
  const args = rest.slice(0, specs.length);
  const extra = rest.slice(specs.length);
  if (extra.length && !cmd.body) throw usage(`unexpected argument "${extra[0]}": factory ${cmd.usage}`);
  return { args, extra };
}

function clockFromEnv() {
  const raw = process.env.FACTORY_NOW;
  if (!raw) return undefined;
  const ms = Date.parse(raw);
  if (!Number.isFinite(ms)) throw usage(`FACTORY_NOW="${raw}" is not an ISO-8601 timestamp`);
  return () => new Date(ms);
}

function print(text) {
  if (text !== undefined && text !== null && text !== '') process.stdout.write(`${String(text).replace(/\s+$/, '')}\n`);
}

function report(err, json) {
  const known = err instanceof FactoryError;
  const code = known ? err.code : 'internal';
  if (json) process.stdout.write(`${JSON.stringify({ error: err.message, code })}\n`);
  process.stderr.write(`factory: ${known ? err.message : `internal error: ${err.stack || err.message}`}\n`);
  return known && code === 'usage' ? 2 : 1;
}

/**
 * Run the CLI on argv (without node and script). Resolves to the exit code.
 * @param {string[]} argv
 * @returns {Promise<number>}
 */
export async function main(argv) {
  let json = argv.includes('--json');
  stdinIgnored = false;
  const showHelp = (cmd) => {
    if (json) process.stdout.write(`${JSON.stringify(helpJson(cmd), null, 2)}\n`);
    else print(cmd ? commandHelp(cmd) : globalHelp());
    return 0;
  };
  try {
    const { positionals, flags } = parseArgv(argv);
    json = Boolean(flags.json);
    if (positionals[0] === 'help') return showHelp(positionals.length > 1 ? findCommand(positionals.slice(1)) : null);
    if (!positionals.length) {
      if (flags.help) return showHelp(null);
      if (json) throw usage('name a command; run `node factory/bin/factory.mjs --help` for the list');
      print(globalHelp());
      return 2;
    }
    const cmd = findCommand(positionals);
    if (!cmd) {
      if (flags.help) return showHelp(null);
      throw unknownCommand(positionals);
    }
    if (flags.help) return showHelp(cmd);
    checkFlags(cmd, flags);
    const { args, extra } = splitArgs(cmd, positionals.slice(cmd.words.length));
    const store = openStore({ root: flags.root, now: clockFromEnv() });
    // The autopilot starts each agent run with FACTORY_ACTOR set: that session
    // writes as its own member only, never as you or another agent. A lead run's
    // value is a list: the lead first, then the builders and monitor it starts as subagents.
    const actors = String(process.env.FACTORY_ACTOR || '').split(',').map((x) => x.trim()).filter(Boolean);
    const bound = actors[0];
    if (bound && flags.as !== undefined && !actors.includes(flags.as)) {
      throw new FactoryError('permission', `this session was started by the autopilot as ${bound}; it cannot write --as ${flags.as}`);
    }
    // Nor may it run the factory's controls: the board, the autopilot (it would
    // rebind or stop runs) or init, or point the CLI at another root.
    if (bound) {
      const control = cmd.words[0] === 'ui' || cmd.words[0] === 'init' || (cmd.words[0] === 'autopilot' && !flags['dry-run']);
      if (control) throw new FactoryError('permission', `this session was started by the autopilot as ${bound}; \`${cmd.words.join(' ')}\` is for the owner`);
      // A run waits for nothing: it stops when its inbox is empty and the autopilot starts it again on its next turn.
      if (cmd.words[0] === 'wait') throw new FactoryError('permission', `this session was started by the autopilot as ${bound}; stop instead of waiting: the autopilot starts you again on your next turn`);
      const home = openStore({ now: clockFromEnv() }).root; // $FACTORY_ROOT, which the autopilot sets for its runs
      const real = (p) => { try { return fs.realpathSync(p); } catch { return path.resolve(p); } };
      if (real(store.root) !== real(home)) throw new FactoryError('permission', `this session was started by the autopilot as ${bound} for ${home}; it cannot use --root ${flags.root}`);
    }
    const as = flags.as ?? bound ?? (process.env.FACTORY_AS || undefined);
    const body = cmd.body ? await resolveBody(cmd, flags, extra, store) : undefined;
    // A slow producer (`npm test | tail | factory result ...`) must not lose its
    // evidence to a default body; an inherited pipe that never closes must not hang.
    if (stdinIgnored) {
      throw usage(`stdin is a pipe that sent nothing within ${STDIN_FIRST_CHUNK_MS / 1000} s, so nothing was written; pass the body with --body, --body-file <path> or --body-file - (reads stdin to the end), or give stdin </dev/null to use the default body`);
    }
    const ctx = { store, as, args, flags, body, json };
    const result = await cmd.run(ctx);
    notePresenceFor(cmd, ctx, result);
    if (cmd.serve) return 0;
    if (json) process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
    else {
      print(cmd.text(result, ctx));
      if (result && Array.isArray(result.events)) print(eventLines(result.events).join('\n'));
    }
    const wall = wallOfText(body);
    if (wall) process.stderr.write(`note: this body has a ${wall}-character paragraph, which the owner reads as a wall of text on the board. Next time start with a one-line outcome, then short bullets, paths in backticks (PROTOCOL §9, "Format"); pass a multi-line body with --body-file.\n`);
    return cmd.exitCode ? cmd.exitCode(result) : 0;
  } catch (err) {
    return report(err, json);
  }
}

/** Paragraphs past this many characters read as a wall of text on the board. */
const WALL_CHARS = 600;

/** The length of a body's longest prose paragraph when it is over WALL_CHARS (code blocks and tables aside), else 0. */
export function wallOfText(body) {
  const text = String(body ?? '').replace(/\r\n?/g, '\n').replace(/^(```|~~~)[^\n]*\n[\s\S]*?^\1[^\n]*$/gm, '');
  let longest = 0;
  for (const para of text.split(/\n\s*\n/)) {
    for (const line of para.split('\n')) {
      if (/^\s*\|/.test(line)) continue;
      longest = Math.max(longest, line.replace(/^\s*([-*+]|\d+[.)])\s+/, '').trim().length);
    }
  }
  return longest > WALL_CHARS ? longest : 0;
}

function invokedDirectly() {
  if (!process.argv[1]) return false;
  try {
    return fs.realpathSync(process.argv[1]) === fs.realpathSync(fileURLToPath(import.meta.url));
  } catch {
    return false;
  }
}

if (invokedDirectly()) {
  // A reader that stops early (`factory log x | head`) closes the pipe; the
  // write already happened, so stop quietly instead of printing a stack trace.
  for (const stream of [process.stdout, process.stderr]) {
    stream.on('error', (err) => {
      if (err.code === 'EPIPE') process.exit(process.exitCode ?? 0);
      throw err;
    });
  }
  main(process.argv.slice(2)).then((code) => {
    process.exitCode = code;
  });
}
