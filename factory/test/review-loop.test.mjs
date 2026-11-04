// Review gates, findings → issues → tasks, responses, overrides.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import {
  ISO_RE, plain, projectCtx, since, eventsIn, single, threadTasks, threadIssues, openTurnIds, assertGate,
  assertEventTo, assertPhaseEvent, completeTask, driveTo, expectError, describeMessages, editFrontmatterFile,
} from './helpers.mjs';

const LONG_POINT = 'The retry loop in the payment client has no backoff and will hammer the provider under partial outages, retrying instantly';

async function reviewAt(ctx, { as, verdict, points, body = 'Review.' }) {
  ctx.clock.minutes(10);
  const s = await since(ctx, ctx.ref, () => ctx.store.review({ as, ref: ctx.ref, verdict, points, body }));
  return { ...s, review: single(s.added, (m) => m.type === 'review', 'review message') };
}

async function respondTo(ctx, review, stances, extra = {}) {
  ctx.clock.minutes(10);
  const args = { as: 'fable', ref: ctx.ref, stances, body: 'Response.', ...extra };
  if (review) args.review = review.id;
  const s = await since(ctx, ctx.ref, () => ctx.store.respond(args));
  return { ...s, response: single(s.added, (m) => m.type === 'review_response', 'review_response message') };
}

test('changes_requested: points become issues, review is addressed to the lead, phase unchanged', async (t) => {
  const ctx = await projectCtx(t);
  const { store, ref } = ctx;
  await driveTo(ctx, ref, 'code_review');
  const { review, added } = await reviewAt(ctx, {
    as: 'openai', verdict: 'changes_requested', body: 'Two findings.',
    points: [{ severity: 'high', text: LONG_POINT }, { severity: 'low', text: 'Rename the helper' }],
  });
  assert.equal(review.gate, 'code_review');
  assert.equal(review.verdict, 'changes_requested');
  assert.deepEqual(plain(review.points), [
    { n: 1, severity: 'high', text: LONG_POINT },
    { n: 2, severity: 'low', text: 'Rename the helper' },
  ]);
  assert.ok(review.to.includes('fable'), 'the review opens a turn for the lead');
  assert.ok((await openTurnIds(store, 'fable')).includes(review.id));

  const th = await store.thread(ref);
  assert.equal(th.phase, 'code_review');
  assertGate(th, 'code_review', 'changes_requested', review.id);

  const issues = await threadIssues(store, ref);
  assert.equal(issues.length, 2);
  const [i1, i2] = issues;
  assert.equal(i1.id, 'I-001');
  assert.equal(i2.id, 'I-002');
  for (const [iss, n, sev] of [[i1, 1, 'high'], [i2, 2, 'low']]) {
    assert.equal(iss.gate, 'code_review');
    assert.equal(iss.source, review.id);
    assert.equal(iss.point, n);
    assert.equal(iss.severity, sev);
    assert.equal(iss.status, 'open');
    assert.equal(iss.raised_by, 'openai');
    assert.equal(iss.task, null);
    assert.equal(iss.thread, 'checkout-v2');
    assert.match(iss.created, ISO_RE);
    assert.equal(iss.path, `teams/checkout/issues/${iss.id}.md`);
  }
  assert.equal(i1.title, LONG_POINT.slice(0, 80), 'issue title = first 80 chars of the point');
  assert.equal(i2.title, 'Rename the helper');
  assert.ok(i1.body.includes(LONG_POINT), 'issue body carries the full point text');
  assert.ok(eventsIn(added, 'issue_created').length >= 1, 'issue_created events');
});

test('respond accepted + rejected: task linked to the issue, thread back to build, later gates reset', async (t) => {
  const ctx = await projectCtx(t);
  const { store, ref } = ctx;
  await driveTo(ctx, ref, 'code_review');
  const { review } = await reviewAt(ctx, {
    as: 'openai', verdict: 'changes_requested',
    points: [{ severity: 'high', text: 'Retry loop has no backoff' }, { severity: 'low', text: 'Rename the helper' }],
  });
  const { response, added } = await respondTo(ctx, review, [
    { point: 1, stance: 'accepted' },
    { point: 2, stance: 'rejected', reason: 'Name matches the module' },
  ]);
  assert.equal(response.from, 'fable');
  assert.equal(response.reply_to, review.id);
  assert.deepEqual(plain(response.stances), [
    { point: 1, stance: 'accepted' },
    { point: 2, stance: 'rejected', reason: 'Name matches the module' },
  ]);

  const [i1, i2] = await threadIssues(store, ref);
  assert.equal(i1.status, 'accepted');
  assert.equal(i2.status, 'rejected');
  assert.equal(i2.reason, 'Name matches the module');
  const tasks = await threadTasks(store, ref);
  const fix = tasks.find((x) => x.issue === 'I-001');
  assert.ok(fix, `a task links I-001; tasks: ${tasks.map((x) => `${x.id}:${x.issue}`).join(', ')}`);
  assert.equal(i1.task, fix.id);
  assert.equal(fix.title, `Fix: ${i1.title}`);
  assert.equal(fix.status, 'todo');
  assert.equal(fix.thread, 'checkout-v2');
  assert.ok(!tasks.some((x) => x.issue === 'I-002'), 'rejected points make no task');

  const th = await store.thread(ref);
  assert.equal(th.phase, 'build');
  for (const g of ['build', 'code_review', 'final_review', 'signoff']) assert.equal(th.gates[g].status, 'pending', `${g} reset`);
  for (const g of ['brief', 'design_review']) assert.equal(th.gates[g].status, 'approved', `${g} untouched`);
  const phase = assertPhaseEvent(added, 'fable');
  assert.ok(eventsIn(added, 'phase').some((e) => e.to.includes('fable')), `back-to-build event to the lead:\n  ${describeMessages(eventsIn(added))}`);
  assert.equal(phase.from, 'factory');
  assert.ok(eventsIn(added, 'task_created').length >= 1);
  assert.ok(eventsIn(added, 'issue_status').length >= 1);
  assert.ok(!(await openTurnIds(store, 'fable')).includes(review.id), 'the response closes the lead turn on the review');

  // The loop closes: fix → automatic build gate → re-review.
  await completeTask(ctx, `checkout/${fix.id}`);
  assert.equal((await store.issue('checkout/I-001')).status, 'fixed');
  assert.equal((await store.thread(ref)).phase, 'code_review');
  await reviewAt(ctx, { as: 'openai', verdict: 'approve', points: [] });
  assert.equal((await store.issue('checkout/I-001')).status, 'verified');
  assert.equal((await store.issue('checkout/I-002')).status, 'rejected');
});

test('an all-rejected response keeps the phase and hands the turn back to the reviewer', async (t) => {
  const ctx = await projectCtx(t);
  const { store, ref } = ctx;
  await driveTo(ctx, ref, 'code_review');
  const { review } = await reviewAt(ctx, { as: 'openai', verdict: 'changes_requested', points: [{ severity: 'medium', text: 'Use a config flag' }] });
  const tasksBefore = (await threadTasks(store, ref)).length;
  const { response } = await respondTo(ctx, review, [{ point: 1, stance: 'rejected', reason: 'Flag already exists upstream' }]);
  const th = await store.thread(ref);
  assert.equal(th.phase, 'code_review');
  assert.equal(th.gates.code_review.status, 'changes_requested');
  assert.equal((await threadTasks(store, ref)).length, tasksBefore, 'no task without an accepted stance');
  assert.ok(response.to.includes('openai'), 'the response is addressed to the reviewer');
  assert.ok((await openTurnIds(store, 'openai')).includes(response.id), 'the reviewer has a turn');

  // The reviewer re-reviews; the review (no --reply-to) answers that turn.
  const again = await reviewAt(ctx, { as: 'openai', verdict: 'approve', points: [], body: 'Fair enough.' });
  assert.equal(again.review.reply_to, response.id);
  assert.ok(!(await openTurnIds(store, 'openai')).includes(response.id));
  assert.equal((await store.thread(ref)).phase, 'final_review');
  assert.equal((await store.issue('checkout/I-001')).status, 'rejected');
});

test('design_review findings return the thread to design and reset design_review', async (t) => {
  const ctx = await projectCtx(t);
  const { store, ref } = ctx;
  await driveTo(ctx, ref, 'design_review');
  const { review } = await reviewAt(ctx, { as: 'openai', verdict: 'changes_requested', points: [{ severity: 'high', text: 'Design misses refunds' }] });
  const { added } = await respondTo(ctx, review, [{ point: 1, stance: 'accepted', action: 'Add a refunds section to the design' }]);
  let th = await store.thread(ref);
  assert.equal(th.phase, 'design');
  assert.equal(th.gates.design_review.status, 'pending');
  assert.equal(th.gates.brief.status, 'approved');
  assert.ok(eventsIn(added, 'phase').some((e) => e.to.includes('fable')), 'phase event to the lead');
  const [task] = await threadTasks(store, ref);
  assert.equal(task.title, 'Add a refunds section to the design', 'action overrides the task title');
  assert.equal(task.issue, 'I-001');

  await expectError(() => store.advance({ as: 'fable', ref }));
  assert.equal((await store.thread(ref)).phase, 'design', 'cannot leave design with an open task');
  await completeTask(ctx, `checkout/${task.id}`);
  assert.equal((await store.issue('checkout/I-001')).status, 'fixed');
  const s = await since(ctx, ref, () => store.advance({ as: 'fable', ref, body: 'Refunds added.' }));
  assert.equal((await store.thread(ref)).phase, 'design_review');
  assertEventTo(s.added, 'openai');
  await reviewAt(ctx, { as: 'openai', verdict: 'approve', points: [] });
  th = await store.thread(ref);
  assert.equal(th.phase, 'plan');
  assert.equal((await store.issue('checkout/I-001')).status, 'verified');
});

test('approve with low/nit points: allowed; accepted points behave per gate', async (t) => {
  const ctx = await projectCtx(t);
  const { store, ref } = ctx;

  // brief: approve + nit → design; accepting it adds a lead-owned task, phase unchanged.
  const brief = await reviewAt(ctx, { as: 'you', verdict: 'approve', points: [{ severity: 'nit', text: 'Name the success metric' }] });
  assert.equal((await store.thread(ref)).phase, 'design');
  assert.ok(brief.review.to.includes('fable'), 'points open a turn for the lead even on approve');
  let issues = await threadIssues(store, ref);
  assert.equal(issues.length, 1);
  assert.equal(issues[0].gate, 'brief');
  assert.equal(issues[0].severity, 'nit');
  await respondTo(ctx, brief.review, [{ point: 1, stance: 'accepted' }]);
  assert.equal((await store.thread(ref)).phase, 'design');
  assert.equal((await threadTasks(store, ref)).length, 1);

  // code_review: approve + low → final_review; accepting it sends the thread back to build.
  await driveTo(ctx, ref, 'code_review');
  const code = await reviewAt(ctx, { as: 'openai', verdict: 'approve', points: [{ severity: 'low', text: 'Add a log line' }] });
  assert.equal((await store.thread(ref)).phase, 'final_review');
  await respondTo(ctx, code.review, [{ point: 1, stance: 'accepted' }]);
  let th = await store.thread(ref);
  assert.equal(th.phase, 'build');
  for (const g of ['build', 'code_review', 'final_review', 'signoff']) assert.equal(th.gates[g].status, 'pending', `${g} reset`);

  // signoff on a done thread: the accepted point is new, unreviewed work, so the
  // thread reopens to build and its build..signoff gates reset.
  await driveTo(ctx, ref, 'signoff');
  const sign = await reviewAt(ctx, { as: 'you', verdict: 'approve', points: [{ severity: 'nit', text: 'Follow up on copy' }] });
  assert.equal((await store.thread(ref)).phase, 'done');
  const before = (await threadTasks(store, ref)).length;
  await respondTo(ctx, sign.review, [{ point: 1, stance: 'accepted' }]);
  th = await store.thread(ref);
  assert.equal(th.phase, 'build', 'a fix accepted after signoff goes back through the review gates');
  for (const g of ['build', 'code_review', 'final_review', 'signoff']) assert.equal(th.gates[g].status, 'pending', `${g} reset`);
  assert.equal((await threadTasks(store, ref)).length, before + 1);
  issues = await threadIssues(store, ref);
  assert.equal(issues.find((x) => x.gate === 'signoff').status, 'accepted');
});

test('approve with a high or medium point is refused as a usage error', async (t) => {
  const ctx = await projectCtx(t);
  const { store, ref } = ctx;
  await driveTo(ctx, ref, 'code_review');
  for (const severity of ['high', 'medium']) {
    await expectError(
      () => store.review({ as: 'openai', ref, verdict: 'approve', points: [{ severity, text: 'Must fix' }] }),
      'usage',
      /changes_requested/,
    );
  }
  const th = await store.thread(ref);
  assert.equal(th.phase, 'code_review');
  assert.equal(th.gates.code_review.status, 'pending');
  assert.equal((await threadIssues(store, ref)).length, 0);
  assert.equal((await store.messages(ref)).filter((m) => m.type === 'review' && m.gate === 'code_review').length, 0);
});

test('respond must cover every point exactly once, and rejections need a reason', async (t) => {
  const ctx = await projectCtx(t);
  const { store, ref } = ctx;
  await driveTo(ctx, ref, 'code_review');
  const { review } = await reviewAt(ctx, {
    as: 'openai', verdict: 'changes_requested',
    points: [{ severity: 'high', text: 'One' }, { severity: 'medium', text: 'Two' }],
  });
  const bad = [
    [{ point: 1, stance: 'accepted' }],
    [{ point: 1, stance: 'accepted' }, { point: 1, stance: 'rejected', reason: 'dup' }, { point: 2, stance: 'accepted' }],
    [{ point: 1, stance: 'accepted' }, { point: 2, stance: 'accepted' }, { point: 3, stance: 'accepted' }],
    [{ point: 1, stance: 'accepted' }, { point: 2, stance: 'rejected' }],
    [{ point: 1, stance: 'accepted' }, { point: 2, stance: 'rejected', reason: '' }],
    [{ point: 1, stance: 'accepted' }, { point: 2, stance: 'ignored' }],
  ];
  for (const stances of bad) {
    await expectError(() => store.respond({ as: 'fable', ref, review: review.id, stances }));
  }
  assert.equal((await store.thread(ref)).phase, 'code_review');
  assert.equal((await threadTasks(store, ref)).filter((x) => x.issue).length, 0, 'refused responses create no tasks');
  assert.equal((await store.messages(ref)).filter((m) => m.type === 'review_response').length, 0);
  await respondTo(ctx, review, [{ point: 2, stance: 'deferred', reason: 'Later' }, { point: 1, stance: 'accepted' }]);
  assert.equal((await store.thread(ref)).phase, 'build');
});

test('respond without a review id answers the latest review awaiting a response', async (t) => {
  const ctx = await projectCtx(t);
  const { store, ref } = ctx;
  await driveTo(ctx, ref, 'code_review');
  const first = await reviewAt(ctx, { as: 'openai', verdict: 'changes_requested', points: [{ severity: 'medium', text: 'First finding' }] });
  await respondTo(ctx, first.review, [{ point: 1, stance: 'rejected', reason: 'Not applicable' }]);
  const second = await reviewAt(ctx, { as: 'openai', verdict: 'changes_requested', points: [{ severity: 'high', text: 'Second finding' }] });
  const { response } = await respondTo(ctx, null, [{ point: 1, stance: 'accepted' }]);
  assert.equal(response.reply_to, second.review.id);
  assert.equal((await store.thread(ref)).phase, 'build');
});

test('blocked: the owner overrides with decide --gate; the lead may not', async (t) => {
  const ctx = await projectCtx(t);
  const { store, root, ref } = ctx;
  await driveTo(ctx, ref, 'code_review');
  const blocked = await reviewAt(ctx, { as: 'openai', verdict: 'blocked', points: [], body: 'Cannot review without staging access.' });
  let th = await store.thread(ref);
  assert.equal(th.phase, 'code_review');
  assertGate(th, 'code_review', 'blocked', blocked.review.id);
  assert.ok(blocked.review.to.includes('fable'), 'a non-approve verdict opens a turn for the lead');
  assert.ok(
    eventsIn(blocked.added).some((e) => (e.cc || []).includes('you')),
    `blocked events cc the owner:\n  ${describeMessages(eventsIn(blocked.added))}`,
  );

  await expectError(() => store.decide({ as: 'fable', ref, title: 'Lead override', gate: 'code_review', verdict: 'approve' }), 'permission');
  await expectError(() => store.decide({ as: 'you', ref, title: 'Wrong gate', gate: 'final_review', verdict: 'approve' }));
  assert.equal((await store.thread(ref)).phase, 'code_review');

  ctx.clock.minutes(10);
  const s = await since(ctx, ref, () => store.decide({
    as: 'you', ref, title: 'Ship without staging review', gate: 'code_review', verdict: 'approve',
    resolves: [blocked.review.id], body: 'Owner override: staging is down; prod canary covers it.',
  }));
  const decision = single(s.added, (m) => m.type === 'decision', 'decision message');
  assert.equal(decision.from, 'you');
  assert.equal(decision.decision, 'D-001');
  assert.equal(decision.gate, 'code_review');
  assert.equal(decision.verdict, 'approve');
  th = await store.thread(ref);
  assert.equal(th.phase, 'final_review');
  assertGate(th, 'code_review', 'approved', decision.id);
  assertEventTo(s.added, 'grok');
  assert.ok(eventsIn(s.added, 'decision').length >= 1, 'decision event');

  const text = fs.readFileSync(path.join(root, 'teams', 'checkout', 'decisions.md'), 'utf8');
  assert.match(text, /^## D-001: Ship without staging review$/m);
  assert.match(text, /^- by: you$/m);
  assert.match(text, /^- thread: checkout-v2$/m);
  assert.ok(text.includes(`- message: ${decision.id}`));
  assert.match(text, /^- gate: code_review approve$/m);
  const [d] = await store.decisions('checkout');
  assert.equal(d.id, 'D-001');
  assert.equal(d.title, 'Ship without staging review');
  assert.equal(d.by, 'you');
  assert.equal(d.thread, 'checkout-v2');
  assert.equal(d.message, decision.id);
  assert.match(String(d.gate), /code_review/);
  assert.match(d.body, /Owner override/);
});

test('decide --gate changes_requested by you keeps the phase', async (t) => {
  const ctx = await projectCtx(t);
  const { store, ref } = ctx;
  await driveTo(ctx, ref, 'final_review');
  const s = await since(ctx, ref, () => store.decide({ as: 'you', ref, title: 'Needs a second look', gate: 'final_review', verdict: 'changes_requested' }));
  const decision = single(s.added, (m) => m.type === 'decision', 'decision message');
  const th = await store.thread(ref);
  assert.equal(th.phase, 'final_review');
  assertGate(th, 'final_review', 'changes_requested', decision.id);
});

test('decide without --gate: you or the lead; D numbers are sequential; resolves closes turns', async (t) => {
  const ctx = await projectCtx(t);
  const { store, ref } = ctx;
  await store.post({ as: 'opus-1', ref, type: 'question', to: ['openai'], body: 'Hosted or embedded checkout?' });
  const question = (await store.messages(ref)).filter((m) => m.type === 'question').at(-1);
  assert.ok((await openTurnIds(store, 'openai')).includes(question.id));
  ctx.clock.minutes(5);
  await store.decide({ as: 'fable', ref, title: 'Use hosted checkout', resolves: [question.id], body: 'Hosted is simpler.' });
  assert.ok(!(await openTurnIds(store, 'openai')).includes(question.id), 'the lead may resolve the question');
  ctx.clock.minutes(5);
  await store.decide({ as: 'you', ref, title: 'Keep the old flow for one week', body: 'Rollback window.' });
  const ds = await store.decisions('checkout');
  assert.deepEqual(ds.map((d) => d.id), ['D-001', 'D-002']);
  assert.deepEqual(ds.map((d) => d.by), ['fable', 'you']);
  assert.ok(ds[0].resolves.includes(question.id));
  const msgs = (await store.messages(ref)).filter((m) => m.type === 'decision');
  assert.deepEqual(msgs.map((m) => m.decision), ['D-001', 'D-002']);
  assert.equal((await store.thread(ref)).phase, 'brief', 'a plain decision moves no phase');
});

test('issue accept: refused for review issues; a manual issue in code_review sends the thread to build', async (t) => {
  const ctx = await projectCtx(t);
  const { store, ref } = ctx;
  await driveTo(ctx, ref, 'code_review');
  await reviewAt(ctx, { as: 'openai', verdict: 'changes_requested', points: [{ severity: 'low', text: 'Tidy imports' }] });
  await expectError(() => store.acceptIssue({ as: 'fable', issue: 'checkout/I-001' }));
  assert.equal((await store.issue('checkout/I-001')).status, 'open', 'review issues are accepted through respond');

  ctx.clock.minutes(5);
  await store.createIssue({ as: 'opus-2', ref, severity: 'medium', title: 'Spinner never stops on error', body: 'Seen in staging.' });
  const manual = await store.issue('checkout/I-002');
  assert.equal(manual.gate, null);
  assert.equal(manual.raised_by, 'opus-2');
  assert.equal(manual.status, 'open');
  assert.equal(manual.severity, 'medium');
  assert.equal(manual.title, 'Spinner never stops on error');

  ctx.clock.minutes(5);
  await store.acceptIssue({ as: 'fable', issue: 'checkout/I-002', action: 'Stop the spinner on error' });
  const accepted = await store.issue('checkout/I-002');
  assert.equal(accepted.status, 'accepted');
  const task = await store.task(`checkout/${accepted.task}`);
  assert.equal(task.title, 'Stop the spinner on error');
  assert.equal(task.issue, 'I-002');
  const th = await store.thread(ref);
  assert.equal(th.phase, 'build');
  for (const g of ['build', 'code_review', 'final_review', 'signoff']) assert.equal(th.gates[g].status, 'pending', `${g} reset`);

  await store.createIssue({ as: 'grok', ref, severity: 'low', title: 'Copy is long' });
  await store.createIssue({ as: 'openai', ref, severity: 'nit', title: 'Button colour' });
  await store.rejectIssue({ as: 'fable', issue: 'checkout/I-003', reason: 'Copy approved by owner' });
  await store.deferIssue({ as: 'you', issue: 'checkout/I-004', reason: 'Design refresh next quarter' });
  const rej = await store.issue('checkout/I-003');
  const def = await store.issue('checkout/I-004');
  assert.equal(rej.status, 'rejected');
  assert.equal(rej.reason, 'Copy approved by owner');
  assert.equal(def.status, 'deferred');
  assert.equal(def.reason, 'Design refresh next quarter');
  assert.match(rej.body, /## History/);
});

// ---- Approvals verify fixed issues -------------------------------------

test('an approval verifies the fixed issues its reviewer raised at any gate; signoff verifies the rest', async (t) => {
  const ctx = await projectCtx(t);
  const { store, ref } = ctx;
  await driveTo(ctx, ref, 'design_review');
  const dr = await reviewAt(ctx, { as: 'openai', verdict: 'approve', points: [{ severity: 'low', text: 'Log the retry count' }] });
  assert.equal((await store.thread(ref)).phase, 'plan');
  const fromDesign = (await threadIssues(store, ref)).find((x) => x.source === dr.review.id);
  await respondTo(ctx, dr.review, [{ point: 1, stance: 'accepted' }]);
  assert.equal((await store.thread(ref)).phase, 'plan', 'an accepted point before the build changes no phase');

  await driveTo(ctx, ref, 'build');
  ctx.clock.minutes(1);
  await store.createIssue({ as: 'grok', ref, severity: 'medium', title: 'Error copy is unclear', source: 'sentry:pq4411' });
  await store.createIssue({ as: 'opus-2', ref, severity: 'low', title: 'Noisy debug log' });
  const manual = (await threadIssues(store, ref)).filter((x) => x.gate == null);
  const byGrok = manual.find((x) => x.raised_by === 'grok');
  const byOpus = manual.find((x) => x.raised_by === 'opus-2');
  for (const x of manual) await store.acceptIssue({ as: 'fable', issue: `checkout/${x.id}` });
  await driveTo(ctx, ref, 'code_review');
  for (const x of [fromDesign, byGrok, byOpus]) assert.equal((await store.issue(`checkout/${x.id}`)).status, 'fixed');

  await reviewAt(ctx, { as: 'openai', verdict: 'approve', points: [] });
  assert.equal((await store.issue(`checkout/${fromDesign.id}`)).status, 'verified', 'openai\'s design_review point is verified by openai\'s code_review approval');
  assert.equal((await store.issue(`checkout/${byGrok.id}`)).status, 'fixed');
  await reviewAt(ctx, { as: 'grok', verdict: 'approve', points: [] });
  assert.equal((await store.issue(`checkout/${byGrok.id}`)).status, 'verified', 'grok\'s manual issue is verified by grok\'s final_review approval');
  assert.equal((await store.issue(`checkout/${byOpus.id}`)).status, 'fixed');
  const s = await since(ctx, ref, () => reviewAt(ctx, { as: 'you', verdict: 'approve', points: [] }));
  assert.equal((await store.thread(ref)).phase, 'done');
  assert.equal((await store.issue(`checkout/${byOpus.id}`)).status, 'verified', 'the signoff approval verifies every fixed issue left');
  assert.ok(eventsIn(s.added, 'issue_status').some((e) => e.event.issue === byOpus.id && e.event.to === 'verified'));
  assert.ok(!(await threadIssues(store, ref)).some((x) => x.status === 'fixed'), 'nothing is left fixed-but-unverified on a done thread');
  assert.deepEqual((await store.validate()).errors, []);
});

test('a gate decision by you verifies the same issues a review would', async (t) => {
  const ctx = await projectCtx(t);
  const { store, ref } = ctx;
  await driveTo(ctx, ref, 'build');
  await store.createIssue({ as: 'opus-2', ref, severity: 'low', title: 'Noisy debug log' });
  const [issue] = await threadIssues(store, ref);
  await store.acceptIssue({ as: 'fable', issue: `checkout/${issue.id}` });
  await driveTo(ctx, ref, 'signoff');
  assert.equal((await store.issue(`checkout/${issue.id}`)).status, 'fixed');
  await store.decide({ as: 'you', ref, title: 'Ship it', gate: 'signoff', verdict: 'approve' });
  assert.equal((await store.issue(`checkout/${issue.id}`)).status, 'verified');
});

// ---- send-back rules --------------------------------------------------------

test('a response to a superseded review never rewinds the thread; the accepted point is a new task', async (t) => {
  const ctx = await projectCtx(t);
  const { store, ref } = ctx;
  // brief: changes_requested, then approved by a second review; answering the first one later keeps design.
  const first = await reviewAt(ctx, { as: 'you', verdict: 'changes_requested', points: [{ severity: 'medium', text: 'Name the metric' }] });
  await reviewAt(ctx, { as: 'you', verdict: 'approve', points: [] });
  assert.equal((await store.thread(ref)).phase, 'design');
  await respondTo(ctx, first.review, [{ point: 1, stance: 'accepted' }]);
  let th = await store.thread(ref);
  assert.equal(th.phase, 'design', 'the stale brief review does not send the thread back to brief');
  assert.equal(th.gates.brief.status, 'approved', 'the brief gate stays approved');

  // design_review: changes_requested, overridden by a decision; answering it later keeps plan.
  await driveTo(ctx, ref, 'design_review');
  const dr = await reviewAt(ctx, { as: 'openai', verdict: 'changes_requested', points: [{ severity: 'high', text: 'Retries need backoff' }] });
  await store.decide({ as: 'you', ref, title: 'Proceed', gate: 'design_review', verdict: 'approve' });
  assert.equal((await store.thread(ref)).phase, 'plan');
  const before = (await threadTasks(store, ref)).length;
  await respondTo(ctx, dr.review, [{ point: 1, stance: 'accepted' }]);
  th = await store.thread(ref);
  assert.equal(th.phase, 'plan', 'the overridden review does not send the thread back to design');
  assert.equal((await threadTasks(store, ref)).length, before + 1);

  // A current review still sends the thread back as before.
  await driveTo(ctx, ref, 'code_review');
  const cr = await reviewAt(ctx, { as: 'openai', verdict: 'changes_requested', points: [{ severity: 'high', text: 'Missing test' }] });
  await respondTo(ctx, cr.review, [{ point: 1, stance: 'accepted' }]);
  assert.equal((await store.thread(ref)).phase, 'build');
});

test('work added after the build sends the thread back to build: task new, task new --issue, issue accept (even on a done thread)', async (t) => {
  const ctx = await projectCtx(t);
  const { store, ref } = ctx;
  await driveTo(ctx, ref, 'final_review');
  let s = await since(ctx, ref, () => store.createTask({ as: 'fable', ref, title: 'Late cleanup' }));
  let th = await store.thread(ref);
  assert.equal(th.phase, 'build', 'task new at final_review goes back to build');
  for (const g of ['build', 'code_review', 'final_review', 'signoff']) assert.equal(th.gates[g].status, 'pending', `${g} reset`);
  assert.ok(eventsIn(s.added, 'phase').some((e) => e.event.to === 'build'));

  await driveTo(ctx, ref, 'done');
  await store.createIssue({ as: 'grok', ref, severity: 'medium', title: 'Found after release' });
  const late = (await threadIssues(store, ref)).at(-1);
  s = await since(ctx, ref, () => store.createTask({ as: 'fable', ref, title: 'Fix it', issue: late.id }));
  th = await store.thread(ref);
  assert.equal(th.phase, 'build', 'task new --issue on a done thread reopens it to build');
  assert.equal((await store.issue(`checkout/${late.id}`)).status, 'accepted');

  await driveTo(ctx, ref, 'signoff');
  await store.createIssue({ as: 'opus-2', ref, severity: 'low', title: 'One more' });
  const more = (await threadIssues(store, ref)).at(-1);
  await store.acceptIssue({ as: 'fable', issue: `checkout/${more.id}` });
  assert.equal((await store.thread(ref)).phase, 'build', 'issue accept at signoff goes back to build');
  assert.deepEqual((await store.validate()).errors, []);
});

test('a review point already answered and later reopened is triaged with issue accept (no deadlock)', async (t) => {
  const ctx = await projectCtx(t);
  const { store, ref } = ctx;
  await driveTo(ctx, ref, 'code_review');
  const cr = await reviewAt(ctx, { as: 'openai', verdict: 'changes_requested', points: [{ severity: 'high', text: 'No backoff' }] });
  const point = (await threadIssues(store, ref)).find((x) => x.source === cr.review.id);
  await expectError(() => store.acceptIssue({ as: 'fable', issue: `checkout/${point.id}` }), 'usage', /respond/);
  await respondTo(ctx, cr.review, [{ point: 1, stance: 'accepted' }]);
  await driveTo(ctx, ref, 'code_review');
  assert.equal((await store.issue(`checkout/${point.id}`)).status, 'fixed');
  await store.verifyIssue({ as: 'fable', issue: `checkout/${point.id}`, pass: false, note: 'Still hammering in staging' });
  assert.equal((await store.issue(`checkout/${point.id}`)).status, 'open');
  await expectError(() => store.respond({ as: 'fable', ref, review: cr.review.id, stances: [{ point: 1, stance: 'accepted' }] }));
  const r = await store.acceptIssue({ as: 'fable', issue: `checkout/${point.id}`, action: 'Second attempt at backoff' });
  assert.equal(r.issue.status, 'accepted');
  assert.equal(r.task.issue, point.id);
  assert.equal((await store.thread(ref)).phase, 'build');
});

test('signoff is refused while an issue is untriaged; code review is refused while a task is unfinished (decide overrides)', async (t) => {
  const ctx = await projectCtx(t);
  const { store, ref, root } = ctx;
  await driveTo(ctx, ref, 'signoff');
  await store.createIssue({ as: 'grok', ref, severity: 'medium', title: 'Untriaged finding' });
  const open = (await threadIssues(store, ref)).at(-1);
  await expectError(() => store.review({ as: 'you', ref, verdict: 'approve', points: [] }), 'conflict', new RegExp(open.id));
  await expectError(() => store.decide({ as: 'you', ref, title: 'Ship', gate: 'signoff', verdict: 'approve' }), 'conflict', new RegExp(open.id));
  assert.equal((await store.thread(ref)).phase, 'signoff');
  await store.deferIssue({ as: 'fable', issue: `checkout/${open.id}`, reason: 'Next release' });
  await reviewAt(ctx, { as: 'you', verdict: 'approve', points: [] });
  assert.equal((await store.thread(ref)).phase, 'done');

  // A task that is not done at code_review (only possible by hand) blocks a review approval.
  const ctx2 = await projectCtx(t);
  await driveTo(ctx2, ctx2.ref, 'code_review');
  const [task] = await threadTasks(ctx2.store, ctx2.ref);
  editFrontmatterFile(path.join(ctx2.root, 'teams', 'checkout', 'tasks', `${task.id}.md`), (d) => { d.status = 'doing'; });
  await expectError(() => ctx2.store.review({ as: 'openai', ref: ctx2.ref, verdict: 'approve', points: [] }), 'conflict', /unfinished tasks/);
  await ctx2.store.decide({ as: 'you', ref: ctx2.ref, title: 'Approve anyway', gate: 'code_review', verdict: 'approve' });
  assert.equal((await ctx2.store.thread(ctx2.ref)).phase, 'final_review');
  void root;
});

test('issue titles from review points are cut by code point, never splitting an emoji', async (t) => {
  const ctx = await projectCtx(t);
  const { store, ref } = ctx;
  await driveTo(ctx, ref, 'code_review');
  await reviewAt(ctx, { as: 'openai', verdict: 'changes_requested', points: [{ severity: 'high', text: `${'x'.repeat(79)}🚀 and more text after` }] });
  const [issue] = await threadIssues(store, ref);
  assert.ok(!/[\uD800-\uDBFF](?![\uDC00-\uDFFF])/.test(issue.title), `no lone high surrogate in ${JSON.stringify(issue.title)}`);
  assert.equal([...issue.title].length, 80);
  assert.ok(issue.title.endsWith('🚀'));
});

test('task new --issue: a project issue is fixed on its own thread; validate flags a task linked across threads', async (t) => {
  const ctx = await projectCtx(t);
  const { store, ref, root } = ctx;
  await driveTo(ctx, ref, 'build');
  await store.createIssue({ as: 'grok', ref, severity: 'medium', title: 'Rage clicks on pay' });
  const issue = (await threadIssues(store, ref)).at(-1);
  const other = 'checkout/other';
  ctx.clock.seconds(1);
  await store.createThread({ as: 'fable', ref: other, title: 'Other' });
  await expectError(() => store.createTask({ as: 'fable', ref: other, title: 'Fix it', issue: issue.id }), 'usage', /belongs to checkout\/checkout-v2/);
  assert.equal((await store.issue(`checkout/${issue.id}`)).status, 'open');
  const r = await store.createTask({ as: 'fable', ref, title: 'Fix it', issue: issue.id });
  editFrontmatterFile(path.join(root, 'teams', 'checkout', 'tasks', `${r.task.id}.md`), (d) => { d.thread = 'other'; });
  const v = await store.validate();
  assert.ok(v.errors.some((e) => /only a watch or single-agent issue is fixed from another thread/.test(e.message)), JSON.stringify(v.errors));
});
