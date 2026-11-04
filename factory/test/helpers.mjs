// Shared fixtures for the factory node:test suites.
//
// Every test gets its own temp root under os.tmpdir() (never the repo's teams/),
// a controllable clock, and helpers that drive the store through the contract's
// phase machine. Store calls are always awaited so the suites work whether the
// store API is synchronous or returns promises.

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { openStore, FactoryError } from '../lib/store.mjs';
import { parseFrontmatter, stringifyFrontmatter } from '../lib/yaml.mjs';

export { openStore, FactoryError };

// A board started by a test (`factory ui`) never keeps an autopilot running: no
// test may start agents. The one test of that behaviour clears this for its own call.
process.env.FACTORY_NO_AUTOPILOT = '1';

export const TEST_DIR = path.dirname(fileURLToPath(import.meta.url));
export const FACTORY_DIR = path.resolve(TEST_DIR, '..');
export const CLI_PATH = path.join(FACTORY_DIR, 'bin', 'factory.mjs');

export const ISO_RE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/;
export const MSG_ID_RE = /^\d{8}T\d{6}Z-[a-z0-9][a-z0-9-]*-[0-9a-f]{4}$/;

export const PHASE_ORDER = [
  'brief', 'design', 'design_review', 'plan', 'build', 'code_review', 'security_review', 'final_review', 'signoff', 'done',
];
export const GATE_ORDER = ['brief', 'design_review', 'build', 'code_review', 'final_review', 'signoff'];
export const REVIEW_GATE_NAMES = ['brief', 'design_review', 'code_review', 'final_review', 'signoff'];
export const ROSTER_IDS = ['you', 'fable', 'opus-1', 'opus-2', 'opus-monitor', 'opus-solo', 'openai', 'grok', 'security', 'factory'];
export const DEFAULT_MEMBERS = ['you', 'fable', 'opus-1', 'opus-2', 'openai', 'grok'];
export const GATE_OWNERS = {
  brief: 'you', design_review: 'openai', build: 'fable', code_review: 'openai', final_review: 'grok', signoff: 'you',
};
export const MESSAGE_KEYS = ['id', 'ts', 'thread', 'from', 'to', 'cc', 'type', 'reply_to', 'resolves', 'refs', 'internal'];

export const TEAM = 'checkout';
export const PROJECT = 'checkout/checkout-v2';
export const WATCH = 'checkout/checkout-health';
export const DEFAULT_THRESHOLDS = { error_rate: { max: 0.02 }, success_rate: { min: 0.98 } };

/** JSON-normalise a value read from the implementation (drops prototypes, keeps data). */
export const plain = (v) => (v === undefined ? undefined : JSON.parse(JSON.stringify(v)));

/** '2026-11-01T15:30:12.345Z' → '20261101T153012Z' (the message-id stamp). */
export function stamp(ts) {
  return `${String(ts).slice(0, 19).replace(/[-:]/g, '')}Z`;
}

// ---------------------------------------------------------------------------
// Clock
// ---------------------------------------------------------------------------

// Each default clock starts in its own 30-day window so that, inside one test
// process, a later root never starts earlier than an earlier root's clock ended.
// (The contract's "ts strictly increasing within a process" bump could otherwise
// leak from one test into the next.)
const CLOCK_BASE = Date.parse('2026-11-01T09:00:00.000Z');
const CLOCK_WINDOW = 30 * 24 * 3600 * 1000;
let clocksMade = 0;

export function makeClock(start) {
  let t;
  if (start === undefined) t = CLOCK_BASE + CLOCK_WINDOW * clocksMade++;
  else t = typeof start === 'number' ? start : Date.parse(start);
  if (!Number.isFinite(t)) throw new Error(`makeClock: bad start ${start}`);
  const clock = {
    /** The function handed to openStore({ now }). Returns a fresh Date. */
    now: () => new Date(t),
    ms: () => t,
    iso: () => new Date(t).toISOString(),
    advance(ms) { t += ms; return clock; },
    seconds(n) { return clock.advance(n * 1000); },
    minutes(n) { return clock.advance(n * 60 * 1000); },
    hours(n) { return clock.advance(n * 3600 * 1000); },
    days(n) { return clock.advance(n * 24 * 3600 * 1000); },
    set(v) {
      const next = typeof v === 'number' ? v : Date.parse(v);
      if (!Number.isFinite(next)) throw new Error(`clock.set: bad time ${v}`);
      t = next;
      return clock;
    },
  };
  return clock;
}

// ---------------------------------------------------------------------------
// Roots
// ---------------------------------------------------------------------------

export function makeTempDir(prefix = 'factory-test-') {
  return fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), prefix)));
}

/**
 * Create a temp root, run init() on it (copies members.yaml + templates from the
 * code's own factory dir), and return { root, store, clock, reopen, cleanup }.
 */
export async function makeRoot({ clock = makeClock(), prefix = 'factory-test-' } = {}) {
  const root = makeTempDir(prefix);
  const store = openStore({ root, now: clock.now });
  await store.init();
  return {
    root,
    store,
    clock,
    reopen: () => openStore({ root, now: clock.now }),
    cleanup: () => fs.rmSync(root, { recursive: true, force: true }),
  };
}

/** makeRoot + automatic cleanup when the test ends. */
export async function useRoot(t, opts) {
  const ctx = await makeRoot(opts);
  t.after(ctx.cleanup);
  return ctx;
}

export async function setupTeam(ctx, { id = TEAM, title = 'Checkout', lead = 'fable', as = 'you' } = {}) {
  ctx.clock.seconds(1);
  await ctx.store.createTeam({ as, id, title, lead });
  return id;
}

export async function setupProject(ctx, { team = TEAM, thread = 'checkout-v2', title = 'Checkout v2', as = 'fable', ...rest } = {}) {
  const ref = `${team}/${thread}`;
  ctx.clock.seconds(1);
  await ctx.store.createThread({ as, ref, title, ...rest });
  return ref;
}

export async function setupWatch(ctx, {
  team = TEAM, thread = 'checkout-health', title = 'Checkout health', as = 'fable',
  owner = 'opus-monitor', cadence = 'daily', thresholds = DEFAULT_THRESHOLDS, ...rest
} = {}) {
  const ref = `${team}/${thread}`;
  ctx.clock.seconds(1);
  await ctx.store.createThread({ as, ref, title, kind: 'watch', owner, cadence, thresholds, ...rest });
  return ref;
}

/** Root + team `checkout` (lead fable) + project thread `checkout/checkout-v2`. */
export async function projectCtx(t, opts) {
  const ctx = await useRoot(t);
  await setupTeam(ctx);
  const ref = await setupProject(ctx, opts);
  return { ...ctx, ref };
}

/** Root + team `checkout` + watch thread `checkout/checkout-health` (owner opus-monitor). */
export async function watchCtx(t, opts) {
  const ctx = await useRoot(t);
  await setupTeam(ctx);
  const ref = await setupWatch(ctx, opts);
  return { ...ctx, ref };
}

// ---------------------------------------------------------------------------
// Reading state
// ---------------------------------------------------------------------------

export function splitRef(ref) {
  const parts = String(ref).split('/');
  return parts.length === 2 ? { team: parts[0], id: parts[1] } : { team: undefined, id: parts[0] };
}

export async function threadMessages(store, ref, opts) {
  return opts === undefined ? await store.messages(ref) : await store.messages(ref, opts);
}

/** Run fn and return { result, added } where added = thread messages that fn created (in store order). */
export async function since(ctx, ref, fn) {
  let before = new Set();
  try {
    before = new Set((await ctx.store.messages(ref)).map((m) => m.id));
  } catch {
    // the thread may not exist yet (createThread)
  }
  const result = await fn();
  const added = (await ctx.store.messages(ref)).filter((m) => !before.has(m.id));
  return { result, added };
}

export function eventsIn(list, kind) {
  return list.filter((m) => m.type === 'event' && (kind === undefined || (m.event && m.event.kind === kind)));
}

export function describeMessages(list) {
  return list
    .map((m) => `${m.type}${m.event ? `:${m.event.kind}` : ''} from=${m.from} to=${JSON.stringify(m.to)} cc=${JSON.stringify(m.cc)}`)
    .join('\n  ');
}

export function single(list, pred, what = 'message') {
  const found = list.filter(pred);
  assert.equal(found.length, 1, `expected exactly one ${what}, found ${found.length}:\n  ${describeMessages(list)}`);
  return found[0];
}

export async function lastOfType(store, ref, type) {
  const ms = (await store.messages(ref)).filter((m) => m.type === type);
  assert.ok(ms.length > 0, `no ${type} message in ${ref}`);
  return ms[ms.length - 1];
}

const byId = (a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0);

export async function threadTasks(store, ref) {
  const th = await store.thread(ref);
  return (await store.tasks()).filter((x) => x.team === th.team && x.thread === th.id).sort(byId);
}

export async function threadIssues(store, ref) {
  const th = await store.thread(ref);
  return (await store.issues()).filter((x) => x.team === th.team && x.thread === th.id).sort(byId);
}

export const taskRef = (task) => `${task.team}/${task.id}`;
export const issueRef = (issue) => `${issue.team}/${issue.id}`;

export async function openTurnIds(store, member) {
  return (await store.openTurns({ member })).map((x) => x.message.id);
}

export function assertGate(th, gate, status, ref) {
  const g = th.gates && th.gates[gate];
  assert.ok(g, `thread ${th.id} has no gate ${gate}`);
  assert.equal(g.status, status, `gate ${gate} status`);
  if (ref !== undefined) assert.equal(g.ref, ref, `gate ${gate} ref`);
  if (status !== 'pending') assert.match(String(g.at), ISO_RE, `gate ${gate} at`);
}

/** A factory event addressed to `owner` (gate entry / back to build). Returns the last such event. */
export function assertEventTo(added, owner) {
  const evs = eventsIn(added).filter((e) => (e.to || []).includes(owner));
  assert.ok(evs.length >= 1, `expected a factory event addressed to ${owner}; got:\n  ${describeMessages(eventsIn(added))}`);
  for (const e of evs) assert.equal(e.from, 'factory');
  return evs[evs.length - 1];
}

/** A `phase` event, optionally checking event.by. Returns the last one. */
export function assertPhaseEvent(added, by) {
  const evs = eventsIn(added, 'phase');
  assert.ok(evs.length >= 1, `expected a phase event; got:\n  ${describeMessages(eventsIn(added))}`);
  for (const e of evs) assert.equal(e.from, 'factory');
  if (by !== undefined) {
    assert.ok(evs.some((e) => e.event.by === by), `phase event by ${by}; got ${evs.map((e) => e.event.by).join(', ')}`);
  }
  return evs[evs.length - 1];
}

// ---------------------------------------------------------------------------
// Driving the phase machine (happy path)
// ---------------------------------------------------------------------------

/** dispatch (if unowned) → result done → task accept, as the contract's build loop does. */
export async function completeTask(ctx, ref, { builder = 'opus-1' } = {}) {
  const { store, clock } = ctx;
  const task = await store.task(ref);
  if (task.status === 'done') return;
  const th = await store.thread(`${task.team}/${task.thread}`);
  let owner = task.owner;
  if (!owner) {
    clock.seconds(1);
    await store.dispatch({ as: th.lead, task: ref, to: builder, body: `Please take ${task.id}.` });
    owner = builder;
  }
  clock.seconds(1);
  await store.result({ as: owner, task: ref, outcome: 'done', body: `${task.id} is done; tests pass.` });
  clock.seconds(1);
  await store.acceptTask({ as: th.lead, task: ref, body: 'Accepted.' });
}

export async function finishOpenTasks(ctx, threadRef, opts) {
  for (const task of await threadTasks(ctx.store, threadRef)) {
    if (task.status !== 'done') await completeTask(ctx, taskRef(task), opts);
  }
}

/** Drive a project thread forward along the happy path until it is in `target`. */
export async function driveTo(ctx, ref, target) {
  const { store, clock } = ctx;
  if (!PHASE_ORDER.includes(target)) throw new Error(`driveTo: unknown phase ${target}`);
  for (let guard = 0; guard < 40; guard++) {
    const th = await store.thread(ref);
    if (th.phase === target) return th;
    if (PHASE_ORDER.indexOf(th.phase) > PHASE_ORDER.indexOf(target)) {
      throw new Error(`driveTo: ${ref} is already at ${th.phase}, past ${target}`);
    }
    clock.seconds(1);
    switch (th.phase) {
      case 'brief':
      case 'design_review':
      case 'code_review':
      case 'security_review':
      case 'final_review':
      case 'signoff':
        await store.review({ as: th.gates[th.phase].by, ref, verdict: 'approve', points: [], body: `Approved at ${th.phase}.` });
        break;
      case 'design':
        await finishOpenTasks(ctx, ref);
        clock.seconds(1);
        await store.advance({ as: th.lead, ref, body: 'Design is ready for review.' });
        break;
      case 'plan': {
        const tasks = await threadTasks(store, ref);
        if (!tasks.some((x) => x.status !== 'done')) {
          await store.createTask({
            as: th.lead, ref, title: 'Add retry to payment call',
            body: 'Wrap the payment call in a retry.\n\n## Acceptance\n- retries 3 times\n',
          });
        }
        clock.seconds(1);
        await store.advance({ as: th.lead, ref, body: 'Plan is ready.' });
        break;
      }
      case 'build':
        await finishOpenTasks(ctx, ref);
        break;
      default:
        throw new Error(`driveTo: cannot move ${ref} out of ${th.phase}`);
    }
    const after = await store.thread(ref);
    if (after.phase === th.phase) throw new Error(`driveTo: ${ref} stuck in ${th.phase}`);
  }
  throw new Error(`driveTo: gave up reaching ${target}`);
}

/**
 * Fix a watch issue the way PROTOCOL says: accept it onto a project thread (in
 * plan or later), build the task, and review it through signoff. The issue
 * becomes `fixed` when that thread reaches done; a watch run verifies it.
 */
export async function fixWatchIssue(ctx, issueRef, { thread = 'watch-fix', action, done = true, as = 'fable' } = {}) {
  const { store } = ctx;
  const team = issueRef.split('/')[0];
  const ref = `${team}/${thread}`;
  let th = null;
  try {
    th = await store.thread(ref);
  } catch {
    th = null;
  }
  if (!th) await setupProject(ctx, { team, thread, title: `Fix ${thread}` });
  if (PHASE_ORDER.indexOf((await store.thread(ref)).phase) < PHASE_ORDER.indexOf('plan')) await driveTo(ctx, ref, 'plan');
  ctx.clock.seconds(1);
  const accepted = await store.acceptIssue({ as, issue: issueRef, action, thread: ref });
  if (done) await driveTo(ctx, ref, 'done');
  return { ref, task: accepted.task };
}

// ---------------------------------------------------------------------------
// Errors
// ---------------------------------------------------------------------------

/** Await fn; assert it throws a FactoryError (optionally with code and message pattern). */
export async function expectError(fn, code, pattern) {
  let err = null;
  try {
    await fn();
  } catch (e) {
    err = e;
  }
  assert.ok(err, `expected a FactoryError${code ? ` (${code})` : ''}, but the call succeeded`);
  assert.ok(
    err instanceof FactoryError,
    `expected FactoryError, got ${err && err.constructor ? err.constructor.name : typeof err}: ${err && err.message}`,
  );
  if (code) assert.equal(err.code, code, `expected code ${code}, got ${err.code}: ${err.message}`);
  if (pattern) assert.match(err.message, pattern);
  return err;
}

/** expectError + no message file was written by the refused call. */
export async function expectRefused(ctx, fn, code = 'permission', pattern) {
  const before = listCommsFiles(ctx.root).length;
  const err = await expectError(fn, code, pattern);
  assert.equal(listCommsFiles(ctx.root).length, before, `a refused write posted messages (${err.message})`);
  return err;
}

// ---------------------------------------------------------------------------
// Files
// ---------------------------------------------------------------------------

/** Relative paths (posix) of every teams/<team>/comms/*.md file. */
export function listCommsFiles(root) {
  const teamsDir = path.join(root, 'teams');
  if (!fs.existsSync(teamsDir)) return [];
  const out = [];
  for (const team of fs.readdirSync(teamsDir).sort()) {
    const comms = path.join(teamsDir, team, 'comms');
    if (!fs.existsSync(comms) || !fs.statSync(comms).isDirectory()) continue;
    for (const f of fs.readdirSync(comms).sort()) {
      if (f.endsWith('.md')) out.push(`teams/${team}/comms/${f}`);
    }
  }
  return out;
}

export function snapshotComms(root, into = new Map()) {
  for (const rel of listCommsFiles(root)) {
    if (!into.has(rel)) into.set(rel, fs.readFileSync(path.join(root, rel)));
  }
  return into;
}

export function assertSnapshotIntact(root, snap, context = '') {
  for (const [rel, bytes] of snap) {
    const abs = path.join(root, rel);
    assert.ok(fs.existsSync(abs), `${rel} disappeared${context ? ` after ${context}` : ''}`);
    assert.ok(fs.readFileSync(abs).equals(bytes), `${rel} was rewritten${context ? ` by ${context}` : ''}`);
  }
}

/** Every file below dir (relative posix paths). */
export function walkFiles(dir, base = dir) {
  if (!fs.existsSync(dir)) return [];
  const out = [];
  for (const ent of fs.readdirSync(dir, { withFileTypes: true })) {
    const abs = path.join(dir, ent.name);
    if (ent.isDirectory()) out.push(...walkFiles(abs, base));
    else out.push(path.relative(base, abs).split(path.sep).join('/'));
  }
  return out.sort();
}

export function readFrontmatterFile(file) {
  return parseFrontmatter(fs.readFileSync(file, 'utf8'));
}

/** Hand-edit a frontmatter file (used for config edits such as team.md eval_cmd, and for corruption tests). */
export function editFrontmatterFile(file, mutate) {
  const { data, body } = parseFrontmatter(fs.readFileSync(file, 'utf8'));
  const next = mutate(data, body);
  const nextBody = next && typeof next.body === 'string' ? next.body : body;
  fs.writeFileSync(file, stringifyFrontmatter(data, nextBody));
}

/** The text between `## <name>` and the next level-2 heading, trimmed; null when absent. */
export function sectionOf(body, name) {
  const lines = String(body).split('\n');
  const start = lines.findIndex((l) => l.trim() === `## ${name}`);
  if (start < 0) return null;
  let end = lines.findIndex((l, i) => i > start && /^## /.test(l));
  if (end < 0) end = lines.length;
  return lines.slice(start + 1, end).join('\n').trim();
}

// ---------------------------------------------------------------------------
// CLI
// ---------------------------------------------------------------------------

/**
 * Run the CLI in a child process. `--root <root>` is appended when root is given;
 * either root or env.FACTORY_ROOT is required so a test can never write into the repo.
 * FACTORY_AS / FACTORY_ROOT / FACTORY_NOW from the parent env are dropped first.
 */
export function runCli(args, { root, env = {}, input = '', cwd = os.tmpdir(), timeout = 120000 } = {}) {
  if (!root && !env.FACTORY_ROOT) {
    throw new Error('runCli: pass root or env.FACTORY_ROOT so the CLI never falls back to the repo root');
  }
  const argv = [CLI_PATH, ...args];
  if (root) argv.push('--root', root);
  const baseEnv = { ...process.env };
  delete baseEnv.FACTORY_AS;
  delete baseEnv.FACTORY_ACTOR;
  delete baseEnv.FACTORY_ROOT;
  delete baseEnv.FACTORY_NOW;
  const r = spawnSync(process.execPath, argv, { cwd, env: { ...baseEnv, ...env }, input, encoding: 'utf8', timeout });
  const res = {
    code: r.status,
    signal: r.signal,
    stdout: r.stdout || '',
    stderr: r.stderr || '',
    error: r.error,
    args,
    json() {
      try {
        return JSON.parse(res.stdout);
      } catch (e) {
        throw new Error(`stdout is not exactly one JSON document (${e.message})\n--- stdout ---\n${res.stdout}\n--- stderr ---\n${res.stderr}`);
      }
    },
  };
  return res;
}

/** A runCli bound to ctx.root whose FACTORY_NOW follows ctx.clock (advanced 1 s per call). */
export function cliFor(ctx) {
  return (args, opts = {}) => runCli(args, {
    root: ctx.root,
    ...opts,
    env: { FACTORY_NOW: ctx.clock.seconds(1).iso(), ...(opts.env || {}) },
  });
}

export function assertExit(res, code) {
  assert.equal(
    res.code,
    code,
    `factory ${res.args.join(' ')} → exit ${res.code} (expected ${code})\n--- stdout ---\n${res.stdout}\n--- stderr ---\n${res.stderr}`,
  );
}
