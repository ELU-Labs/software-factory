// Messages are immutable, ids unique, ts strictly increasing; append-only files only grow.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { parseFrontmatter } from '../lib/yaml.mjs';
import {
  ISO_RE, MSG_ID_RE, MESSAGE_KEYS, openStore, stamp, useRoot, setupTeam, setupProject, setupWatch, since, single,
  threadTasks, threadIssues, taskRef, completeTask, driveTo, fixWatchIssue, listCommsFiles, snapshotComms, assertSnapshotIntact,
  walkFiles, expectError,
} from './helpers.mjs';

const WRITES = new Set([
  'init', 'createTeam', 'createThread', 'editSection', 'post', 'review', 'respond', 'advance', 'createTask', 'dispatch',
  'result', 'acceptTask', 'rejectTask', 'createIssue', 'acceptIssue', 'rejectIssue', 'deferIssue', 'verifyIssue',
  'decide', 'watchRun', 'setWatchState',
]);

/** Wrap the store so that after every write (successful or refused) no earlier message file changed or vanished. */
function guarded(ctx, snap, log) {
  return new Proxy(ctx.store, {
    get(target, prop) {
      const v = Reflect.get(target, prop, target);
      if (typeof v !== 'function') return v;
      if (!WRITES.has(prop)) return v.bind(target);
      return async (...args) => {
        try {
          return await v.apply(target, args);
        } finally {
          assertSnapshotIntact(ctx.root, snap, `${String(prop)}(${JSON.stringify(args[0] && { as: args[0].as, ref: args[0].ref || args[0].task || args[0].issue })})`);
          snapshotComms(ctx.root, snap);
          log.push(String(prop));
        }
      };
    },
  });
}

async function workload(ctx) {
  const { store, clock } = ctx;
  await setupTeam(ctx);
  const ref = await setupProject(ctx);
  await store.editSection({ as: 'fable', ref, section: 'Brief', body: 'Problem: carts drop.' });
  await store.post({ as: 'fable', ref, type: 'question', to: ['openai'], cc: ['you'], body: 'Hosted or embedded?' });
  const q = (await store.messages(ref)).filter((m) => m.type === 'question').at(-1);
  await store.post({ as: 'openai', ref, type: 'answer', reply_to: q.id, body: 'Hosted.' });
  await store.post({ as: 'fable', ref, type: 'note', to: ['opus-1'], internal: true, body: 'Internal hint.' });
  await expectError(() => store.review({ as: 'openai', ref, verdict: 'approve', points: [] }));
  await driveTo(ctx, ref, 'build');
  const [t1] = await threadTasks(store, ref);
  await store.dispatch({ as: 'fable', task: taskRef(t1), to: 'opus-1', body: 'Yours.' });
  await store.result({ as: 'opus-1', task: taskRef(t1), outcome: 'done', body: 'Done.' });
  await store.rejectTask({ as: 'fable', task: taskRef(t1), reason: 'Add tests' });
  await store.result({ as: 'opus-1', task: taskRef(t1), outcome: 'done', body: 'Tests added.' });
  await store.acceptTask({ as: 'fable', task: taskRef(t1) });
  clock.minutes(10);
  await store.review({
    as: 'openai', ref, verdict: 'changes_requested',
    points: [{ severity: 'high', text: 'No backoff' }, { severity: 'low', text: 'Rename' }],
  });
  const review = (await store.messages(ref)).filter((m) => m.type === 'review').at(-1);
  await expectError(() => store.respond({ as: 'fable', ref, review: review.id, stances: [{ point: 1, stance: 'accepted' }] }));
  await store.respond({
    as: 'fable', ref, review: review.id,
    stances: [{ point: 1, stance: 'accepted' }, { point: 2, stance: 'rejected', reason: 'Conventional name' }],
  });
  await store.createIssue({ as: 'grok', ref, severity: 'low', title: 'Copy is long' });
  const manual = (await threadIssues(store, ref)).at(-1);
  await store.deferIssue({ as: 'fable', issue: `checkout/${manual.id}`, reason: 'Later' });
  await driveTo(ctx, ref, 'final_review');
  await store.review({ as: 'grok', ref, verdict: 'blocked', points: [], body: 'Need staging access.' });
  await store.decide({ as: 'you', ref, title: 'Skip staging', gate: 'final_review', verdict: 'approve' });
  await driveTo(ctx, ref, 'done');
  await store.decide({ as: 'fable', ref, title: 'Retro next week' });

  const watch = await setupWatch(ctx);
  clock.hours(1);
  await store.watchRun({ as: 'opus-monitor', ref: watch, metrics: { error_rate: 0.031, success_rate: 0.99 }, note: 'Spike' });
  const wi = (await threadIssues(store, watch)).at(-1);
  await fixWatchIssue(ctx, `checkout/${wi.id}`);
  clock.hours(24);
  await store.watchRun({ as: 'opus-monitor', ref: watch, metrics: { error_rate: 0.01, success_rate: 0.99 } });
  await store.setWatchState({ as: 'fable', ref: watch, state: 'paused' });
  await expectError(() => store.watchRun({ as: 'opus-monitor', ref: watch, metrics: { error_rate: 0.01 } }));
  await store.setWatchState({ as: 'you', ref: watch, state: 'active' });
  return { ref, watch };
}

test('no message file is ever rewritten or deleted across a full workload', async (t) => {
  const ctx = await useRoot(t);
  const snap = new Map();
  const log = [];
  const gctx = { ...ctx, store: guarded(ctx, snap, log) };
  await workload(gctx);
  assert.ok(log.length >= 30, `the workload exercised many writes (${log.length})`);
  assert.ok(snap.size >= 30, `the workload produced many messages (${snap.size})`);
  assertSnapshotIntact(ctx.root, snap, 'the whole workload');
  assert.equal(listCommsFiles(ctx.root).length, snap.size, 'every message file is accounted for');
});

test('message files: canonical frontmatter, every key present in contract order, id consistent with ts/from', async (t) => {
  const ctx = await useRoot(t);
  await workload(ctx);
  const seenTypes = new Set();
  for (const rel of listCommsFiles(ctx.root)) {
    const text = fs.readFileSync(path.join(ctx.root, rel), 'utf8');
    assert.ok(text.startsWith('---\n'), `${rel} starts with ---`);
    const { data } = parseFrontmatter(text);
    const keys = Object.keys(data);
    assert.deepEqual(keys.slice(0, MESSAGE_KEYS.length), MESSAGE_KEYS, `${rel} key order`);
    const stem = path.basename(rel, '.md');
    assert.equal(data.id, stem, `${rel}: filename stem == id`);
    assert.match(data.id, MSG_ID_RE);
    assert.match(data.ts, ISO_RE);
    assert.ok(data.id.startsWith(`${stamp(data.ts)}-${data.from}-`), `${rel}: id = stamp(ts)-from-hex`);
    for (const k of ['to', 'cc', 'resolves', 'refs']) assert.ok(Array.isArray(data[k]), `${rel}: ${k} is a list`);
    assert.equal(typeof data.internal, 'boolean', `${rel}: internal is a boolean`);
    assert.ok(data.reply_to === null || typeof data.reply_to === 'string', `${rel}: reply_to`);
    const extra = keys.slice(MESSAGE_KEYS.length);
    const expectExtra = {
      review: ['gate', 'verdict', 'points'],
      review_response: ['stances'],
      result: ['task', 'outcome'],
      dispatch: ['task'],
      decision: ['decision'],
      report: ['report', 'status'],
      alert: ['metric', 'value', 'threshold', 'issue'],
      event: ['event'],
    }[data.type];
    if (expectExtra) {
      let i = 0;
      for (const k of extra) if (k === expectExtra[i]) i++;
      assert.equal(i, expectExtra.length, `${rel}: ${data.type} keys ${expectExtra.join(', ')} follow internal in order (got ${extra.join(', ')})`);
    }
    if (data.type === 'event') {
      assert.equal(data.from, 'factory');
      assert.equal(typeof data.event.kind, 'string');
      assert.equal(typeof data.event.by, 'string');
    }
    if (data.type === 'review_response') {
      for (const s of data.stances) {
        const order = ['point', 'stance', 'reason', 'action'].filter((k) => k in s);
        assert.deepEqual(Object.keys(s), order, `${rel}: stance key order`);
      }
    }
    if (data.type === 'review') {
      data.points.forEach((p, i) => assert.equal(p.n, i + 1, `${rel}: points numbered 1..k`));
    }
    seenTypes.add(data.type);
  }
  for (const type of ['question', 'answer', 'note', 'review', 'review_response', 'dispatch', 'result', 'decision', 'report', 'alert', 'event']) {
    assert.ok(seenTypes.has(type), `workload produced a ${type}`);
  }
});

test('same-second messages get distinct ids', async (t) => {
  const ctx = await useRoot(t);
  const { store, clock } = ctx;
  await setupTeam(ctx);
  const ref = await setupProject(ctx);
  clock.set(Math.ceil(clock.ms() / 1000) * 1000 + 1000); // the start of a fresh second; frozen from here on
  const ids = [];
  for (let i = 0; i < 40; i++) {
    const { added } = await since(ctx, ref, () => store.post({ as: 'fable', ref, type: 'note', body: `note ${i}` }));
    ids.push(single(added, (m) => m.type === 'note', 'note').id);
  }
  const other = openStore({ root: ctx.root, now: clock.now });
  for (let i = 0; i < 10; i++) {
    const { added } = await since({ ...ctx, store: other }, ref, () => other.post({ as: 'fable', ref, type: 'note', body: `other ${i}` }));
    ids.push(single(added, (m) => m.type === 'note', 'note').id);
  }
  assert.equal(new Set(ids).size, ids.length, 'ids are unique');
  for (const id of ids) {
    assert.match(id, MSG_ID_RE);
    assert.ok(fs.existsSync(path.join(ctx.root, 'teams', 'checkout', 'comms', `${id}.md`)), `${id}.md exists`);
  }
  const stamps = new Set(ids.slice(0, 40).map((id) => id.slice(0, 16)));
  assert.equal(stamps.size, 1, `40 messages with a frozen clock share one second stamp (${[...stamps].join(', ')})`);
});

test('ts strictly increases within a process, even when the clock stalls, runs backwards, or a second store opens', async (t) => {
  const ctx = await useRoot(t);
  const { store, clock } = ctx;
  await setupTeam(ctx);
  const ref = await setupProject(ctx);
  const seen = new Set((await store.messages(ref)).map((m) => m.id));
  let last = (await store.messages(ref)).map((m) => m.ts).sort().at(-1);
  const step = async (label, fn) => {
    await fn();
    const fresh = (await store.messages(ref)).filter((m) => !seen.has(m.id));
    assert.ok(fresh.length > 0, `${label} wrote a message`);
    const tss = fresh.map((m) => m.ts);
    assert.equal(new Set(tss).size, tss.length, `${label}: messages written together have distinct ts`);
    for (const m of fresh) {
      assert.ok(m.ts > last, `${label}: ${m.ts} must be later than ${last}`);
      assert.ok(m.id.startsWith(`${stamp(m.ts)}-`), `${label}: id stamp matches ts`);
      seen.add(m.id);
    }
    last = tss.sort().at(-1);
  };
  for (let i = 0; i < 5; i++) await step(`frozen note ${i}`, () => store.post({ as: 'fable', ref, type: 'note', body: `n${i}` }));
  await step('review with events', () => store.review({ as: 'you', ref, verdict: 'approve', points: [{ severity: 'nit', text: 'tiny' }] }));
  clock.set(clock.ms() - 3600 * 1000);
  await step('clock one hour behind', () => store.post({ as: 'fable', ref, type: 'note', body: 'from the past' }));
  await step('advance with events', () => store.advance({ as: 'fable', ref }));
  const other = openStore({ root: ctx.root, now: clock.now });
  await step('second store instance', () => other.post({ as: 'opus-1', ref, type: 'note', body: 'other store' }));
  clock.hours(2);
  await step('clock moves on', () => store.post({ as: 'fable', ref, type: 'note', body: 'normal again' }));
});

test('append-only files keep their prefix: decisions.md and metrics.jsonl', async (t) => {
  const ctx = await useRoot(t);
  const { store, clock, root } = ctx;
  await setupTeam(ctx);
  const ref = await setupProject(ctx);
  const decisions = path.join(root, 'teams', 'checkout', 'decisions.md');
  const initial = fs.readFileSync(decisions, 'utf8');
  assert.ok(initial.startsWith('# Decisions — Checkout'), 'decisions.md starts with its title');
  assert.match(initial, /append-only/i);
  await store.decide({ as: 'you', ref, title: 'Use hosted checkout', body: 'Simpler.' });
  const d1 = fs.readFileSync(decisions, 'utf8');
  assert.ok(d1.startsWith(initial));
  assert.match(d1, /^## D-001: Use hosted checkout$/m);
  assert.match(d1, /^- ts: \d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/m);
  assert.match(d1, /^- by: you$/m);
  assert.match(d1, /^- thread: checkout-v2$/m);
  assert.match(d1, /^- message: \d{8}T\d{6}Z-you-[0-9a-f]{4}$/m);
  assert.match(d1, /^- resolves: \[.*\]$/m);
  await store.decide({ as: 'fable', ref, title: 'Ship behind a flag', body: 'Safer.' });
  const d2 = fs.readFileSync(decisions, 'utf8');
  assert.ok(d2.startsWith(d1), 'the first entry is never rewritten');
  assert.match(d2, /^## D-002: Ship behind a flag$/m);

  const watch = await setupWatch(ctx);
  const metrics = path.join(root, 'teams', 'checkout', 'metrics.jsonl');
  clock.hours(1);
  await store.watchRun({ as: 'opus-monitor', ref: watch, metrics: { error_rate: 0.01, success_rate: 0.99 } });
  const m1 = fs.readFileSync(metrics, 'utf8');
  clock.hours(1);
  await store.watchRun({ as: 'opus-monitor', ref: watch, metrics: { error_rate: 0.05, success_rate: 0.99 } });
  const m2 = fs.readFileSync(metrics, 'utf8');
  assert.ok(m2.startsWith(m1), 'metrics.jsonl only grows');
  assert.equal(m2.split('\n').filter(Boolean).length, 2);
  for (const line of m2.split('\n').filter(Boolean)) JSON.parse(line);
});

test('writes leave no lock or temp files behind', async (t) => {
  const ctx = await useRoot(t);
  await workload(ctx);
  const leftovers = walkFiles(path.join(ctx.root, 'teams')).filter((f) => {
    const base = f.split('/').pop();
    return base === '.lock' || base.startsWith('.tmp-');
  });
  assert.deepEqual(leftovers, []);
});

test('a lock left by a killed command (its pid is gone) is taken over at once', async (t) => {
  const ctx = await useRoot(t);
  const { store } = ctx;
  await setupTeam(ctx);
  const ref = await setupProject(ctx);
  // A pid that is certainly not running: spawn a child and let it exit.
  const { spawnSync } = await import('node:child_process');
  const dead = spawnSync(process.execPath, ['-e', 'process.stdout.write(String(process.pid))'], { encoding: 'utf8' }).stdout.trim();
  fs.writeFileSync(path.join(ctx.root, 'teams', 'checkout', '.lock'), `${dead} ${new Date().toISOString()}\n`);
  const started = Date.now();
  await store.post({ as: 'fable', ref, type: 'note', body: 'after a crash' });
  assert.ok(Date.now() - started < 5000, 'no 10 s wait for a dead holder');
  assert.ok(!fs.existsSync(path.join(ctx.root, 'teams', 'checkout', '.lock')));
});

test('messages, tasks and issues are published whole: a reader never sees a half-written file', async (t) => {
  const ctx = await useRoot(t);
  const { store } = ctx;
  await setupTeam(ctx);
  const ref = await setupProject(ctx);
  await store.post({ as: 'fable', ref, type: 'note', body: 'x'.repeat(200000) });
  const leftovers = walkFiles(path.join(ctx.root, 'teams')).filter((f) => f.split('/').pop().startsWith('.tmp-'));
  assert.deepEqual(leftovers, [], 'the temp file is removed after publishing');
  const note = (await store.messages(ref)).filter((m) => m.type === 'note').at(-1);
  assert.equal(note.body.trim().length, 200000);
});
