// Project threads: init, roster, thread creation, the phase machine brief → done,
// the automatic build gate, advance guards and gate-issue verification.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import * as storeModule from '../lib/store.mjs';
import { parseFrontmatter } from '../lib/yaml.mjs';
import {
  FactoryError, ISO_RE, PHASE_ORDER, GATE_ORDER, ROSTER_IDS, DEFAULT_MEMBERS, GATE_OWNERS, PROJECT,
  plain, useRoot, projectCtx, setupTeam, setupProject, since, eventsIn, single, threadTasks, threadIssues,
  taskRef, openTurnIds, assertGate, assertEventTo, assertPhaseEvent, completeTask, driveTo, expectError,
  sectionOf, describeMessages,
} from './helpers.mjs';

const sorted = (xs) => [...xs].sort();

function isSubsequence(keys, wanted) {
  let i = 0;
  for (const k of keys) if (k === wanted[i]) i++;
  return i === wanted.length;
}

test('store exports the contract constants and FactoryError', () => {
  assert.deepEqual([...storeModule.PROJECT_PHASES], PHASE_ORDER);
  assert.deepEqual(sorted(storeModule.WATCH_PHASES), ['active', 'paused']);
  assert.deepEqual(sorted(storeModule.REVIEW_GATES), sorted(['brief', 'design_review', 'code_review', 'security_review', 'final_review', 'signoff']));
  assert.deepEqual([...storeModule.OPTIONAL_GATES], ['security_review']);
  assert.deepEqual(sorted(storeModule.MESSAGE_TYPES), sorted([
    'kickoff', 'proposal', 'review', 'review_response', 'question', 'answer', 'dispatch', 'result',
    'escalation', 'decision', 'report', 'alert', 'event', 'note',
  ]));
  assert.deepEqual(sorted(storeModule.VERDICTS), sorted(['approve', 'changes_requested', 'blocked']));
  assert.deepEqual(sorted(storeModule.SEVERITIES), sorted(['high', 'medium', 'low', 'nit']));
  assert.deepEqual(sorted(storeModule.STANCES), sorted(['accepted', 'rejected', 'deferred']));
  assert.deepEqual(sorted(storeModule.OUTCOMES), sorted(['done', 'blocked', 'failed']));
  assert.deepEqual(sorted(storeModule.TASK_STATUSES), sorted(['todo', 'doing', 'review', 'done', 'blocked']));
  assert.deepEqual(sorted(storeModule.ISSUE_STATUSES), sorted(['open', 'accepted', 'rejected', 'deferred', 'fixed', 'verified']));
  const err = new FactoryError('usage', 'bad flag');
  assert.ok(err instanceof Error);
  assert.equal(err.code, 'usage');
  assert.equal(err.message, 'bad flag');
  assert.equal(typeof storeModule.openStore, 'function');
});

test('init creates teams/ with README and .gitignore, copies roster and templates, and is idempotent', async (t) => {
  const { root, store } = await useRoot(t);
  assert.ok(fs.existsSync(path.join(root, 'teams', 'README.md')), 'teams/README.md');
  const ignore = fs.readFileSync(path.join(root, 'teams', '.gitignore'), 'utf8');
  assert.match(ignore, /^\*$/m);
  assert.match(ignore, /^!README\.md$/m);
  const membersFile = path.join(root, 'factory', 'members.yaml');
  assert.ok(fs.existsSync(membersFile), 'factory/members.yaml copied');
  for (const tpl of ['team.md', 'thread-project.md', 'thread-watch.md']) {
    assert.ok(fs.existsSync(path.join(root, 'factory', 'templates', tpl)), `factory/templates/${tpl} copied`);
  }
  // A local edit survives a second init (copies happen only when missing).
  const before = fs.readFileSync(membersFile, 'utf8');
  fs.appendFileSync(membersFile, '# local edit\n');
  await store.init();
  await store.init();
  assert.equal(fs.readFileSync(membersFile, 'utf8'), `${before}# local edit\n`);
  assert.ok(fs.existsSync(path.join(root, 'teams', 'README.md')));
});

test('roster matches the contract table', async (t) => {
  const { root, store } = await useRoot(t);
  const want = {
    you: { name: 'Product owner', short: 'PO', kind: 'human', vendor: 'human', model: null, role: 'owner', color: '#111827' },
    fable: { name: 'Fable', short: 'FB', kind: 'agent', vendor: 'anthropic', model: 'claude-fable-5-1', role: 'lead', color: '#D97757', launch: 'claude', logo: 'claude' },
    'opus-1': { name: 'Opus 1', short: 'O1', kind: 'agent', vendor: 'anthropic', model: 'claude-opus-5-5', role: 'builder', color: '#C2410C' },
    'opus-2': { name: 'Opus 2', short: 'O2', kind: 'agent', vendor: 'anthropic', model: 'claude-opus-5-5', role: 'builder', color: '#9A3412' },
    'opus-monitor': { name: 'Opus Monitor', short: 'OM', kind: 'agent', vendor: 'anthropic', model: 'claude-opus-5-5', role: 'monitor', color: '#B45309' },
    'opus-solo': { name: 'Opus Solo', short: 'OS', kind: 'agent', vendor: 'anthropic', model: 'claude-opus-5-5', role: 'solo', color: '#BE123C', launch: 'claude' },
    openai: { name: 'OpenAI', short: 'OA', kind: 'agent', vendor: 'openai', model: null, role: 'reviewer', color: '#10A37F', launch: 'codex', logo: 'openai' },
    grok: { name: 'Grok', short: 'GK', kind: 'agent', vendor: 'xai', model: null, role: 'gatekeeper', color: '#4B5563', launch: null, logo: 'grok' },
    security: { name: 'Security', short: 'SC', kind: 'agent', vendor: 'anthropic', model: 'claude-opus-5-5', role: 'security', color: '#7C3AED', launch: 'claude', logo: 'shield' },
    factory: { name: 'Factory', short: 'FX', kind: 'system', vendor: 'system', model: null, role: 'system', color: '#9CA3AF' },
  };
  const members = await store.members();
  assert.deepEqual(sorted(members.map((m) => m.id)), sorted(ROSTER_IDS));
  for (const m of members) {
    const w = want[m.id];
    for (const [k, v] of Object.entries(w)) assert.equal(m[k], v, `${m.id}.${k}`);
    assert.equal(typeof m.runs, 'string', `${m.id}.runs`);
    assert.ok(m.runs.length > 0, `${m.id}.runs is not empty`);
  }
  assert.equal((await store.member('fable')).role, 'lead');
  assert.equal((await store.member('opus-monitor')).role, 'monitor');

  // members.yaml: `members:` block sequence; a comment sits above openai's and grok's `model: null`.
  const text = fs.readFileSync(path.join(root, 'factory', 'members.yaml'), 'utf8');
  assert.match(text, /^members:\s*$/m);
  const lines = text.split('\n');
  for (const id of ['openai', 'grok']) {
    const at = lines.findIndex((l) => new RegExp(`^\\s*(- )?id:\\s*"?${id}"?\\s*$`).test(l));
    assert.ok(at >= 0, `members.yaml has an entry for ${id}`);
    const model = lines.findIndex((l, i) => i > at && /^\s*model:\s*null\b/.test(l));
    assert.ok(model > at, `${id} has model: null`);
    let prev = model - 1;
    while (prev > at && lines[prev].trim() === '') prev--;
    assert.match(lines[prev].trim(), /^#/, `a YAML comment sits directly above ${id}'s model: null`);
  }
});

test('thread new: defaults, gates, branch, body sections and thread_created event to the lead', async (t) => {
  const ctx = await useRoot(t);
  const { store, root } = ctx;
  await setupTeam(ctx);
  const { added } = await since(ctx, PROJECT, () => setupProject(ctx));
  const th = await store.thread(PROJECT);
  assert.equal(th.id, 'checkout-v2');
  assert.equal(th.title, 'Checkout v2');
  assert.equal(th.kind, 'project');
  assert.equal(th.team, 'checkout');
  assert.equal(th.phase, 'brief');
  assert.equal(th.lead, 'fable', 'lead defaults to the team lead');
  assert.deepEqual(plain(th.members), DEFAULT_MEMBERS);
  assert.deepEqual(plain(th.gates), Object.fromEntries(GATE_ORDER.map((g) => [g, { by: GATE_OWNERS[g], status: 'pending', at: null, ref: null }])));
  assert.equal(th.branch, 'factory/checkout/checkout-v2');
  assert.equal(th.cadence, null);
  assert.equal(th.thresholds, null);
  assert.match(th.created, ISO_RE);
  assert.match(th.updated, ISO_RE);
  assert.equal(th.path, 'teams/checkout/threads/checkout-v2.md');
  for (const s of ['## Brief', '## Design', '## Plan', '## Notes']) assert.ok(th.body.includes(s), `body has ${s}`);

  const raw = parseFrontmatter(fs.readFileSync(path.join(root, 'teams', 'checkout', 'threads', 'checkout-v2.md'), 'utf8'));
  const order = ['id', 'title', 'kind', 'team', 'phase', 'lead', 'members', 'gates', 'branch', 'cadence', 'thresholds', 'created', 'updated'];
  assert.ok(isSubsequence(Object.keys(raw.data), order), `frontmatter key order ${Object.keys(raw.data).join(', ')}`);

  const ev = single(eventsIn(added, 'thread_created'), () => true, 'thread_created event');
  assert.equal(ev.from, 'factory');
  assert.equal(ev.thread, 'checkout-v2');
  assert.deepEqual(plain(ev.to), ['fable'], 'thread_created is addressed to the lead');
  assert.equal(ev.event.by, 'fable');
  assert.ok((await openTurnIds(store, 'fable')).includes(ev.id), 'the lead has an open turn to write the brief');

  // A lead is a member with role lead, or you: a builder, reviewer or gatekeeper is refused.
  for (const lead of ['opus-1', 'openai', 'grok', 'opus-monitor']) {
    await expectError(() => store.createThread({ as: 'you', ref: 'checkout/side-quest', title: 'Side quest', lead }), 'usage', /role lead/);
  }
  // An explicit lead owns the build gate; members stay deduped.
  await setupProject(ctx, { thread: 'side-quest', title: 'Side quest', as: 'you', lead: 'you' });
  const side = await store.thread('checkout/side-quest');
  assert.equal(side.lead, 'you');
  assert.equal(side.gates.build.by, 'you');
  assert.equal(new Set(side.members).size, side.members.length, 'members are deduped');
  for (const m of DEFAULT_MEMBERS.filter((x) => x !== 'fable')) assert.ok(side.members.includes(m), `${m} is a default member`);
});

test('thread ids and refs: invalid ids refused, bare refs resolve when unique, ambiguous refs list candidates', async (t) => {
  const ctx = await projectCtx(t);
  const { store } = ctx;
  await expectError(() => store.createTeam({ as: 'you', id: 'Bad_Team', title: 'Bad', lead: 'fable' }));
  await expectError(() => store.createTeam({ as: 'you', id: 'a'.repeat(42), title: 'Long', lead: 'fable' }));
  await expectError(() => store.createTeam({ as: 'you', id: '-lead', title: 'Dash', lead: 'fable' }));
  await expectError(() => store.createThread({ as: 'fable', ref: 'checkout/Bad Thread', title: 'Bad' }));
  // you or a lead create a missing team on the way (quickstart.test.mjs); anyone else gets not_found.
  await expectError(() => store.createThread({ as: 'opus-1', ref: 'nope/thread', title: 'No team' }), 'not_found');
  await expectError(() => store.createThread({ as: 'fable', ref: PROJECT, title: 'Duplicate' }));
  await setupProject(ctx, { thread: 'a'.repeat(41), title: 'Longest id' });

  assert.equal((await store.thread('checkout-v2')).id, 'checkout-v2', 'bare ref resolves when unique');
  await expectError(() => store.thread('checkout/missing'), 'not_found');

  await setupTeam(ctx, { id: 'payments', title: 'Payments' });
  await setupProject(ctx, { team: 'payments', thread: 'checkout-v2', title: 'Payments checkout' });
  const err = await expectError(() => store.thread('checkout-v2'));
  assert.match(err.message, /checkout/);
  assert.match(err.message, /payments/);
  assert.equal((await store.thread('payments/checkout-v2')).title, 'Payments checkout');
});

test('editSection replaces one section, adds missing ones, and posts section_updated', async (t) => {
  const ctx = await projectCtx(t);
  const { store, ref } = ctx;
  const { added } = await since(ctx, ref, () => store.editSection({ as: 'fable', ref, section: 'Brief', body: 'Problem: carts time out.\nUsers: shoppers.\n' }));
  let th = await store.thread(ref);
  assert.equal(sectionOf(th.body, 'Brief'), 'Problem: carts time out.\nUsers: shoppers.');
  for (const s of ['Design', 'Plan', 'Notes']) assert.notEqual(sectionOf(th.body, s), null, `${s} section intact`);
  const ev = single(eventsIn(added, 'section_updated'), () => true, 'section_updated event');
  assert.equal(ev.event.by, 'fable');
  assert.deepEqual(plain(ev.to), []);

  await store.editSection({ as: 'you', ref, section: 'Brief', body: 'Problem: v2 only.' });
  th = await store.thread(ref);
  assert.equal(sectionOf(th.body, 'Brief'), 'Problem: v2 only.');
  assert.ok(!th.body.includes('carts time out'), 'old section content is replaced');

  await store.editSection({ as: 'fable', ref, section: 'Risks', body: 'Payment provider outage.' });
  th = await store.thread(ref);
  assert.equal(sectionOf(th.body, 'Risks'), 'Payment provider outage.');
  assert.equal(sectionOf(th.body, 'Brief'), 'Problem: v2 only.');
  for (const s of ['Design', 'Plan', 'Notes']) assert.notEqual(sectionOf(th.body, s), null, `${s} section intact`);
});

test('project path brief → done: exact gate owners, phases, gate status/ref and auto events', async (t) => {
  const ctx = await projectCtx(t);
  const { store, clock, ref } = ctx;
  let th = await store.thread(ref);
  assert.deepEqual(Object.fromEntries(Object.entries(th.gates).map(([g, v]) => [g, v.by])), GATE_OWNERS);

  // brief → design (gate owner: you)
  clock.minutes(5);
  await store.editSection({ as: 'fable', ref, section: 'Brief', body: 'Problem: checkout drops carts.' });
  let s = await since(ctx, ref, () => store.review({ as: 'you', ref, verdict: 'approve', points: [], body: 'Brief approved.' }));
  let review = single(s.added, (m) => m.type === 'review', 'brief review');
  assert.equal(review.from, 'you');
  assert.equal(review.gate, 'brief');
  assert.equal(review.verdict, 'approve');
  assert.deepEqual(plain(review.points), []);
  th = await store.thread(ref);
  assert.equal(th.phase, 'design');
  assertGate(th, 'brief', 'approved', review.id);
  assertPhaseEvent(s.added, 'you');
  // Entering design hands the thread to the lead: the phase event opens its turn, which the autopilot starts; the gate event addresses nobody.
  for (const e of eventsIn(s.added)) {
    assert.deepEqual(plain(e.to), e.event.kind === 'phase' ? ['fable'] : [], `entering design: ${e.event.kind} event recipients`);
  }
  const toDesign = single(eventsIn(s.added, 'phase'), () => true, 'phase event into design');
  const leadTurns = (await store.openTurns({ member: 'fable' })).filter((t) => t.message.id === toDesign.id);
  assert.deepEqual(leadTurns.map((t) => [t.message.kind, t.message.phase]), [['phase', 'design']], 'the lead holds a turn on the hand-off, with its phase');

  // design → design_review (lead advances; gate-entry event to openai)
  clock.minutes(5);
  await store.editSection({ as: 'fable', ref, section: 'Design', body: 'Use hosted checkout with retries.' });
  s = await since(ctx, ref, () => store.advance({ as: 'fable', ref, body: 'Design is ready for review.' }));
  th = await store.thread(ref);
  assert.equal(th.phase, 'design_review');
  assertPhaseEvent(s.added, 'fable');
  let entry = assertEventTo(s.added, 'openai');
  assert.ok((await openTurnIds(store, 'openai')).includes(entry.id), 'gate entry opens a turn for openai');

  // design_review → plan (gate owner: openai)
  clock.minutes(5);
  s = await since(ctx, ref, () => store.review({ as: 'openai', ref, verdict: 'approve', points: [], body: 'Design is sound.' }));
  review = single(s.added, (m) => m.type === 'review', 'design review');
  assert.equal(review.gate, 'design_review');
  th = await store.thread(ref);
  assert.equal(th.phase, 'plan');
  assertGate(th, 'design_review', 'approved', review.id);
  assertPhaseEvent(s.added, 'openai');
  assert.ok(!(await openTurnIds(store, 'openai')).includes(entry.id), 'the review closes the gate-entry turn');
  const toPlan = single(eventsIn(s.added, 'phase'), () => true, 'phase event into plan');
  assert.deepEqual(plain(toPlan.to), ['fable'], 'approving design_review hands the thread to the lead');
  assert.ok((await openTurnIds(store, 'fable')).includes(toPlan.id), 'the lead holds a turn on it');

  // plan → build (needs at least one open task)
  clock.minutes(5);
  s = await since(ctx, ref, () => store.createTask({
    as: 'fable', ref, title: 'Add retry to payment call', body: 'Wrap the call.\n\n## Acceptance\n- retries 3 times\n',
  }));
  const [task] = await threadTasks(store, ref);
  assert.equal(task.id, 'T-001');
  assert.equal(task.title, 'Add retry to payment call');
  assert.equal(task.thread, 'checkout-v2');
  assert.equal(task.status, 'todo');
  assert.equal(task.owner, null);
  assert.equal(task.issue, null);
  assert.match(task.created, ISO_RE);
  assert.equal(task.path, 'teams/checkout/tasks/T-001.md');
  const created = single(eventsIn(s.added, 'task_created'), () => true, 'task_created event');
  assert.ok(created.refs.includes('T-001'), 'task_created refs the task');
  s = await since(ctx, ref, () => store.advance({ as: 'fable', ref, body: 'Plan is ready.' }));
  th = await store.thread(ref);
  assert.equal(th.phase, 'build');
  assert.equal(th.gates.build.status, 'pending');
  assertPhaseEvent(s.added, 'fable');
  assert.deepEqual(plain(single(eventsIn(s.added, 'phase'), () => true, 'phase event into build').to), [], 'the lead moving its own thread addresses nobody');
  assert.ok(!(await openTurnIds(store, 'fable')).includes(toPlan.id), 'the lead\'s next writes closed its plan hand-off');

  // build: dispatch → result → accept; the build gate approves itself → code_review
  clock.minutes(5);
  s = await since(ctx, ref, () => store.dispatch({ as: 'fable', task: taskRef(task), to: 'opus-1', body: 'Please take this.' }));
  const dispatch = single(s.added, (m) => m.type === 'dispatch', 'dispatch');
  assert.equal(dispatch.from, 'fable');
  assert.deepEqual(plain(dispatch.to), ['opus-1']);
  assert.equal(dispatch.task, 'T-001');
  assert.equal((await store.task(taskRef(task))).owner, 'opus-1');
  clock.minutes(30);
  s = await since(ctx, ref, () => store.result({ as: 'opus-1', task: taskRef(task), outcome: 'done', body: 'Retry added; tests pass.' }));
  const result = single(s.added, (m) => m.type === 'result', 'result');
  assert.equal(result.task, 'T-001');
  assert.equal(result.outcome, 'done');
  clock.minutes(5);
  s = await since(ctx, ref, () => store.acceptTask({ as: 'fable', task: taskRef(task), body: 'Looks good.' }));
  assert.equal((await store.task(taskRef(task))).status, 'done');
  th = await store.thread(ref);
  assert.equal(th.phase, 'code_review');
  assertGate(th, 'build', 'approved');
  assert.ok(eventsIn(s.added, 'task_status').length >= 1, 'task_status event');
  assertPhaseEvent(s.added, 'fable');
  entry = assertEventTo(s.added, 'openai');
  assert.ok((await openTurnIds(store, 'openai')).includes(entry.id));

  // code_review → final_review (openai) → signoff (grok) → done (you)
  for (const [gate, owner, next, nextOwner] of [
    ['code_review', 'openai', 'final_review', 'grok'],
    ['final_review', 'grok', 'signoff', 'you'],
  ]) {
    clock.minutes(5);
    s = await since(ctx, ref, () => store.review({ as: owner, ref, verdict: 'approve', points: [], body: `${gate} ok.` }));
    review = single(s.added, (m) => m.type === 'review', `${gate} review`);
    assert.equal(review.gate, gate);
    th = await store.thread(ref);
    assert.equal(th.phase, next);
    assertGate(th, gate, 'approved', review.id);
    assertPhaseEvent(s.added, owner);
    entry = assertEventTo(s.added, nextOwner);
    assert.ok((await openTurnIds(store, nextOwner)).includes(entry.id), `${nextOwner} has a turn for ${next}`);
  }
  clock.minutes(5);
  s = await since(ctx, ref, () => store.review({ as: 'you', ref, verdict: 'approve', points: [], body: 'Ship it.' }));
  review = single(s.added, (m) => m.type === 'review', 'signoff review');
  assert.equal(review.gate, 'signoff');
  th = await store.thread(ref);
  assert.equal(th.phase, 'done');
  assertGate(th, 'signoff', 'approved', review.id);
  for (const g of GATE_ORDER) assert.equal(th.gates[g].status, 'approved', `${g} approved at done`);
  const doneEvents = eventsIn(s.added, 'phase');
  assert.ok(
    doneEvents.some((e) => (e.to || []).join() === th.lead && th.members.filter((m) => m !== 'you' && m !== th.lead).every((m) => (e.cc || []).includes(m))),
    `the done event goes to the lead (it merges the PR) and cc's the other members:\n  ${describeMessages(doneEvents)}`,
  );
  assert.ok(th.updated >= th.created);

  // No review is possible once done.
  await expectError(() => store.review({ as: 'you', ref, verdict: 'approve', points: [] }));
});

test('build gate is automatic: approved only when the last task is done', async (t) => {
  const ctx = await projectCtx(t);
  const { store, ref } = ctx;
  await driveTo(ctx, ref, 'plan');
  await store.createTask({ as: 'fable', ref, title: 'First task' });
  await store.createTask({ as: 'fable', ref, title: 'Second task' });
  await store.advance({ as: 'fable', ref });
  const [t1, t2] = await threadTasks(store, ref);
  assert.deepEqual([t1.id, t2.id], ['T-001', 'T-002']);

  await completeTask(ctx, taskRef(t1));
  let th = await store.thread(ref);
  assert.equal(th.phase, 'build', 'one task still open');
  assert.equal(th.gates.build.status, 'pending');

  const s = await since(ctx, ref, () => completeTask(ctx, taskRef(t2), { builder: 'opus-2' }));
  th = await store.thread(ref);
  assert.equal(th.phase, 'code_review');
  assertGate(th, 'build', 'approved');
  assertEventTo(s.added, 'openai');
});

test('advance: guarded transitions; anything else is a usage error naming the right command', async (t) => {
  const ctx = await projectCtx(t);
  const { store, ref } = ctx;
  await expectError(() => store.advance({ as: 'fable', ref }), 'usage', /review/);

  await driveTo(ctx, ref, 'design');
  await store.createTask({ as: 'fable', ref, title: 'Write the design doc' });
  await expectError(() => store.advance({ as: 'fable', ref }), undefined);
  assert.equal((await store.thread(ref)).phase, 'design', 'design → design_review needs every task done');
  await completeTask(ctx, 'checkout/T-001');
  await store.advance({ as: 'fable', ref });
  assert.equal((await store.thread(ref)).phase, 'design_review');
  await expectError(() => store.advance({ as: 'fable', ref }), 'usage', /review/);

  await driveTo(ctx, ref, 'plan');
  await expectError(() => store.advance({ as: 'fable', ref }), undefined);
  assert.equal((await store.thread(ref)).phase, 'plan', 'plan → build needs a task that is not done');
  await store.createTask({ as: 'fable', ref, title: 'Build it' });
  await store.advance({ as: 'you', ref, body: 'Owner moves it on.' });
  assert.equal((await store.thread(ref)).phase, 'build', 'you may advance');

  await expectError(() => store.advance({ as: 'fable', ref }), undefined);
  await expectError(() => store.advance({ as: 'you', ref }), undefined);
  assert.equal((await store.thread(ref)).phase, 'build', 'build → code_review needs all tasks done');
  await completeTask(ctx, 'checkout/T-002');
  assert.equal((await store.thread(ref)).phase, 'code_review');
  await expectError(() => store.advance({ as: 'fable', ref }), 'usage', /review/);
});

test('gate issues become verified when the gate re-approves after fixes', async (t) => {
  const ctx = await projectCtx(t);
  const { store, clock, ref } = ctx;
  await driveTo(ctx, ref, 'code_review');
  clock.minutes(10);
  await store.review({
    as: 'openai', ref, verdict: 'changes_requested', body: 'Two findings.',
    points: [{ severity: 'high', text: 'Retry loop has no backoff' }, { severity: 'medium', text: 'Timeout is not configurable' }],
  });
  const review = (await store.messages(ref)).filter((m) => m.type === 'review').at(-1);
  clock.minutes(10);
  await store.respond({
    as: 'fable', ref, review: review.id, body: 'Taking the first.',
    stances: [{ point: 1, stance: 'accepted' }, { point: 2, stance: 'deferred', reason: 'Next release' }],
  });
  let [i1, i2] = await threadIssues(store, ref);
  assert.equal(i1.status, 'accepted');
  assert.equal(i2.status, 'deferred');
  assert.equal(i2.reason, 'Next release');
  assert.equal((await store.thread(ref)).phase, 'build');

  await completeTask(ctx, `checkout/${i1.task}`);
  i1 = await store.issue('checkout/I-001');
  assert.equal(i1.status, 'fixed', 'a done task fixes its issue');
  assert.equal((await store.thread(ref)).phase, 'code_review', 'automatic build gate');

  clock.minutes(10);
  await store.review({ as: 'openai', ref, verdict: 'approve', points: [], body: 'Fixed.' });
  i1 = await store.issue('checkout/I-001');
  i2 = await store.issue('checkout/I-002');
  assert.equal(i1.status, 'verified', 'fixed issues of the gate are verified on approve');
  assert.equal(i2.status, 'deferred', 'deferred issues stay deferred');
  assert.match(i1.body, /## History/);
  assert.match(i1.body, /verified/);
  assert.equal((await store.thread(ref)).phase, 'final_review');
});

test('reads: entity paths, filters, internal messages, board counts and threadView', async (t) => {
  const ctx = await projectCtx(t);
  const { store, ref } = ctx;
  await store.post({ as: 'fable', ref, type: 'note', to: ['opus-1'], internal: true, body: 'Internal: use the helper.' });
  await store.post({ as: 'fable', ref, type: 'note', body: 'Public note.' });
  const all = await store.messages(ref);
  const internal = all.find((m) => m.internal === true);
  assert.ok(internal, 'internal note listed by default');
  const pub = await store.messages(ref, { internal: false });
  assert.ok(!pub.some((m) => m.id === internal.id), 'internal: false hides internal messages');
  assert.ok(pub.some((m) => m.body.includes('Public note.')));

  const one = await store.message(internal.id);
  assert.equal(one.id, internal.id);
  assert.equal(one.team, 'checkout');
  assert.equal(one.path, `teams/checkout/comms/${internal.id}.md`);

  const ordered = all.map((m) => `${m.ts} ${m.id}`);
  assert.deepEqual(ordered, [...ordered].sort(), 'messages ordered by ts, then id');

  await driveTo(ctx, ref, 'build');
  const todo = await store.tasks({ status: 'todo' });
  assert.ok(todo.length >= 1 && todo.every((x) => x.status === 'todo'));
  assert.equal((await store.task('T-001')).id, 'T-001');
  assert.equal((await store.task('checkout/T-001')).id, 'T-001');
  assert.equal((await store.tasks({ status: 'done' })).length, 0);

  const board = await store.board();
  assert.match(board.generated, ISO_RE);
  assert.equal(board.members.length, ROSTER_IDS.length);
  const team = board.teams.find((x) => x.id === 'checkout');
  assert.ok(team, 'board lists the team');
  assert.equal(team.lead, 'fable');
  const bt = team.threads.find((x) => x.id === 'checkout-v2');
  assert.equal(bt.phase, 'build');
  assert.equal(bt.kind, 'project');
  assert.equal(bt.tasks.total, 1);
  assert.equal(bt.tasks.todo, 1);
  assert.equal(bt.issues.total, 0);
  assert.ok(Array.isArray(bt.openTurns));
  assert.equal(typeof bt.messageCount, 'number');
  const latest = (await store.messages(ref)).at(-1);
  assert.equal(bt.lastMessage.id, latest.id);
  assert.ok(team.tasks.some((x) => x.id === 'T-001' && x.thread === 'checkout-v2'));

  const view = await store.threadView(ref);
  assert.equal(view.team, 'checkout');
  assert.equal(view.thread.id, 'checkout-v2');
  assert.equal(view.messages.length, (await store.messages(ref)).length);
  for (const m of view.messages) assert.equal(typeof m.summary, 'string');
  assert.equal(view.tasks.length, 1);
  assert.equal(typeof view.tasks[0].body, 'string');
  for (const k of ['issues', 'decisions', 'metrics', 'reports', 'openTurns']) assert.ok(Array.isArray(view[k]), `threadView.${k}`);

  const threads = await store.threads({ kind: 'project' });
  assert.ok(threads.some((x) => x.id === 'checkout-v2'));
  assert.equal((await store.threads({ kind: 'watch' })).length, 0);
  assert.ok((await store.teams()).some((x) => x.id === 'checkout'));
  assert.equal((await store.team('checkout')).title, 'Checkout');
});

test('a lead reporting its own task done still waits in review for task accept (PROTOCOL: task accept is the only way to done)', async (t) => {
  const ctx = await projectCtx(t);
  const { store, clock, ref } = ctx;
  clock.seconds(1);
  const { task } = await store.createTask({ as: 'fable', ref, title: 'Tighten the brief', body: 'Doc task.\n\n## Acceptance\n- criterion 2 has a baseline\n' });
  clock.seconds(1);
  await store.dispatch({ as: 'fable', task: taskRef(task), to: 'fable', body: 'Mine.' });
  clock.seconds(1);
  let s = await since(ctx, ref, () => store.result({ as: 'fable', task: taskRef(task), outcome: 'done', body: 'Brief updated.' }));
  const result = single(s.added, (m) => m.type === 'result', 'result');
  assert.equal((await store.task(taskRef(task))).status, 'review', 'done by the lead goes to review like anyone else');
  assert.deepEqual(plain(result.to), [], "the lead's own result opens no self-turn");
  assert.ok(!(await openTurnIds(store, 'fable')).includes(result.id));
  clock.seconds(1);
  s = await since(ctx, ref, () => store.acceptTask({ as: 'fable', task: taskRef(task) }));
  assert.equal((await store.task(taskRef(task))).status, 'done');
  const ev = single(eventsIn(s.added, 'task_status'), () => true, 'task_status event');
  assert.ok(plain(ev.resolves).includes(result.id), 'the accept event resolves the result');
});

test('editSection: a body that repeats the heading is not duplicated; another ## heading in the body is refused', async (t) => {
  const ctx = await projectCtx(t);
  const { store, ref } = ctx;
  await store.editSection({ as: 'fable', ref, section: 'Design', body: '## Design\n\nUse a retry wrapper.\n\n### Details\n\nThree attempts.\n' });
  let th = await store.thread(ref);
  assert.equal((th.body.match(/^## Design\s*$/gm) || []).length, 1, 'one ## Design heading');
  assert.match(sectionOf(th.body, 'Design'), /Use a retry wrapper\.[\s\S]*### Details/);
  await expectError(() => store.editSection({ as: 'fable', ref, section: 'Design', body: 'Intro.\n\n## Plan\n\nSneaky.' }), 'usage', /###/);
  th = await store.thread(ref);
  assert.equal((th.body.match(/^## Plan\s*$/gm) || []).length, 1, 'no second ## Plan');
  // A fenced code block may hold anything.
  await store.editSection({ as: 'fable', ref, section: 'Notes', body: '```md\n## Not a heading\n```\n' });
  th = await store.thread(ref);
  assert.match(storeModule.sectionText(th.body, 'Notes'), /## Not a heading/, 'the store reads the fenced line as content');
  assert.equal(storeModule.sectionText(th.body, 'Not a heading'), null);
});

test('decide: a body line that looks like a decision heading is escaped, so decisions.md still validates', async (t) => {
  const ctx = await projectCtx(t);
  const { store, ref, root } = ctx;
  await store.decide({ as: 'you', ref, title: 'Quote an old decision', body: 'Context:\n## D-999 was the old plan\n## D-9: also this\nDone.' });
  const text = fs.readFileSync(path.join(root, 'teams', 'checkout', 'decisions.md'), 'utf8');
  assert.ok(!/^## D-999/m.test(text) && !/^## D-9:/m.test(text), 'no unescaped heading lines from the body');
  assert.deepEqual((await store.validate()).errors, []);
  assert.equal((await store.decisions('checkout')).length, 1);
});
