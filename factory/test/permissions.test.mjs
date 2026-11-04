// Permissions: every rule, error code `permission`, and a refused write writes nothing.
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  projectCtx, setupWatch, threadTasks, taskRef, completeTask, driveTo, expectError, expectRefused, listCommsFiles, fixWatchIssue,
} from './helpers.mjs';

test('--as is required, must be a roster member, and factory is reserved', async (t) => {
  const ctx = await projectCtx(t);
  const { store, ref } = ctx;
  const before = listCommsFiles(ctx.root).length;
  await expectError(() => store.post({ ref, type: 'note', body: 'who am I?' }));
  assert.equal(listCommsFiles(ctx.root).length, before);
  await expectRefused(ctx, () => store.post({ as: 'mallory', ref, type: 'note', body: 'hi' }));
  await expectRefused(ctx, () => store.post({ as: 'factory', ref, type: 'note', body: 'hi' }));
  await expectRefused(ctx, () => store.createTask({ as: 'factory', ref, title: 'Sneaky task' }));
  await expectRefused(ctx, () => store.createTeam({ as: 'factory', id: 'sneaky', title: 'Sneaky', lead: 'fable' }));
  await expectRefused(ctx, () => store.advance({ as: 'mallory', ref }));
  assert.equal((await threadTasks(store, ref)).length, 0);
});

test('post: actor must belong to the thread; to/cc must be roster members; event type refused', async (t) => {
  const ctx = await projectCtx(t);
  const { store, ref } = ctx;
  await expectRefused(ctx, () => store.post({ as: 'opus-monitor', ref, type: 'note', body: 'not a member here' }));
  await expectRefused(ctx, () => store.post({ as: 'fable', ref, type: 'event', body: 'fake event' }));
  await expectRefused(ctx, () => store.post({ as: 'you', ref, type: 'event', body: 'fake event' }));
  await expectError(() => store.post({ as: 'fable', ref, type: 'question', to: ['mallory'], body: 'hi' }));
  await expectError(() => store.post({ as: 'fable', ref, type: 'note', cc: ['mallory'], body: 'hi' }));
  await expectError(() => store.post({ as: 'fable', ref, type: 'gossip', body: 'hi' }));
  // members, lead and you may post
  for (const as of ['you', 'fable', 'opus-1', 'opus-2', 'openai', 'grok']) {
    await store.post({ as, ref, type: 'note', body: `hello from ${as}` });
  }
  // the watch owner may post on its watch thread even though it is not in the project
  const watch = await setupWatch(ctx);
  await store.post({ as: 'opus-monitor', ref: watch, type: 'note', body: 'monitor checking in' });
});

test('review: only the current gate owner, and the error names the phase and owner', async (t) => {
  const ctx = await projectCtx(t);
  const { store, ref } = ctx;
  for (const as of ['openai', 'fable', 'grok']) {
    await expectRefused(ctx, () => store.review({ as, ref, verdict: 'approve', points: [] }), 'permission', /brief/);
  }
  const err = await expectRefused(ctx, () => store.review({ as: 'grok', ref, verdict: 'approve', points: [] }));
  assert.match(err.message, /\byou\b/, 'names the gate owner');

  await driveTo(ctx, ref, 'design');
  await expectError(() => store.review({ as: 'openai', ref, verdict: 'approve', points: [] }));
  await expectError(() => store.review({ as: 'you', ref, verdict: 'approve', points: [] }));
  assert.equal((await store.thread(ref)).phase, 'design', 'no review gate in design');

  await driveTo(ctx, ref, 'design_review');
  for (const as of ['you', 'grok', 'fable']) {
    await expectRefused(ctx, () => store.review({ as, ref, verdict: 'approve', points: [] }), 'permission', /design_review/);
  }
  const named = await expectRefused(ctx, () => store.review({ as: 'you', ref, verdict: 'approve', points: [] }));
  assert.match(named.message, /openai/);

  await driveTo(ctx, ref, 'final_review');
  await expectRefused(ctx, () => store.review({ as: 'openai', ref, verdict: 'approve', points: [] }), 'permission', /final_review/);
  await driveTo(ctx, ref, 'signoff');
  await expectRefused(ctx, () => store.review({ as: 'grok', ref, verdict: 'approve', points: [] }), 'permission', /signoff/);
  await store.review({ as: 'you', ref, verdict: 'approve', points: [] });
  assert.equal((await store.thread(ref)).phase, 'done');
});

test('respond: the thread lead only', async (t) => {
  const ctx = await projectCtx(t);
  const { store, ref } = ctx;
  await driveTo(ctx, ref, 'code_review');
  await store.review({ as: 'openai', ref, verdict: 'changes_requested', points: [{ severity: 'high', text: 'Fix it' }] });
  const review = (await store.messages(ref)).filter((m) => m.type === 'review').at(-1);
  const stances = [{ point: 1, stance: 'accepted' }];
  for (const as of ['openai', 'opus-1', 'you', 'grok']) {
    await expectRefused(ctx, () => store.respond({ as, ref, review: review.id, stances }));
  }
  assert.equal((await store.thread(ref)).phase, 'code_review');
  await store.respond({ as: 'fable', ref, review: review.id, stances });
  assert.equal((await store.thread(ref)).phase, 'build');
});

test('advance, task new, dispatch, task accept/reject, issue triage and thread edit: lead or you', async (t) => {
  const ctx = await projectCtx(t);
  const { store, ref } = ctx;
  for (const as of ['opus-1', 'openai', 'grok']) {
    await expectRefused(ctx, () => store.editSection({ as, ref, section: 'Brief', body: 'hijack' }));
  }
  await store.editSection({ as: 'you', ref, section: 'Brief', body: 'Owner edit.' });

  await expectRefused(ctx, () => store.createThread({ as: 'opus-1', ref: 'checkout/rogue', title: 'Rogue' }));
  await expectRefused(ctx, () => store.createTeam({ as: 'opus-1', id: 'rogue', title: 'Rogue', lead: 'opus-1' }));

  await driveTo(ctx, ref, 'plan');
  for (const as of ['opus-1', 'opus-2', 'openai']) {
    await expectRefused(ctx, () => store.createTask({ as, ref, title: 'Rogue task' }));
  }
  await store.createTask({ as: 'you', ref, title: 'Owner task' });
  await store.createTask({ as: 'fable', ref, title: 'Lead task' });
  for (const as of ['opus-1', 'openai']) await expectRefused(ctx, () => store.advance({ as, ref }));
  await store.advance({ as: 'fable', ref });
  const [t1, t2] = await threadTasks(store, ref);

  await expectRefused(ctx, () => store.dispatch({ as: 'opus-2', task: taskRef(t1), to: 'opus-1' }));
  for (const to of ['openai', 'grok', 'opus-monitor', 'you']) {
    await expectRefused(ctx, () => store.dispatch({ as: 'fable', task: taskRef(t1), to }));
  }
  await store.dispatch({ as: 'fable', task: taskRef(t1), to: 'opus-1' });
  await store.dispatch({ as: 'you', task: taskRef(t2), to: 'fable' });
  assert.equal((await store.task(taskRef(t2))).owner, 'fable', 'the lead may dispatch to itself');

  await store.result({ as: 'opus-1', task: taskRef(t1), outcome: 'done', body: 'done' });
  for (const as of ['opus-1', 'opus-2', 'openai']) {
    await expectRefused(ctx, () => store.acceptTask({ as, task: taskRef(t1) }));
    await expectRefused(ctx, () => store.rejectTask({ as, task: taskRef(t1), reason: 'no' }));
  }
  await store.rejectTask({ as: 'you', task: taskRef(t1), reason: 'Needs tests' });
  assert.equal((await store.task(taskRef(t1))).status, 'doing');

  await store.createIssue({ as: 'opus-2', ref, severity: 'low', title: 'Manual finding' });
  const issue = 'checkout/I-001';
  for (const as of ['opus-1', 'opus-2', 'openai', 'grok']) {
    await expectRefused(ctx, () => store.acceptIssue({ as, issue }));
    await expectRefused(ctx, () => store.rejectIssue({ as, issue, reason: 'no' }));
    await expectRefused(ctx, () => store.deferIssue({ as, issue, reason: 'later' }));
  }
  assert.equal((await store.issue(issue)).status, 'open');
  await store.deferIssue({ as: 'fable', issue, reason: 'Later' });
  assert.equal((await store.issue(issue)).status, 'deferred');
});

test('result: the task owner or the lead', async (t) => {
  const ctx = await projectCtx(t);
  const { store, ref } = ctx;
  await driveTo(ctx, ref, 'plan');
  await store.createTask({ as: 'fable', ref, title: 'One' });
  await store.createTask({ as: 'fable', ref, title: 'Two' });
  await store.advance({ as: 'fable', ref });
  const [t1, t2] = await threadTasks(store, ref);
  await store.dispatch({ as: 'fable', task: taskRef(t1), to: 'opus-1' });
  await store.dispatch({ as: 'fable', task: taskRef(t2), to: 'opus-2' });
  for (const as of ['opus-2', 'openai', 'grok', 'you']) {
    await expectRefused(ctx, () => store.result({ as, task: taskRef(t1), outcome: 'done', body: 'not mine' }));
  }
  await store.result({ as: 'opus-1', task: taskRef(t1), outcome: 'done', body: 'mine' });
  await store.result({ as: 'fable', task: taskRef(t2), outcome: 'blocked', body: 'lead reports for opus-2' });
});

test('issue new: any thread member, nobody else', async (t) => {
  const ctx = await projectCtx(t);
  const { store, ref } = ctx;
  await expectRefused(ctx, () => store.createIssue({ as: 'opus-monitor', ref, severity: 'low', title: 'Outsider finding' }));
  await expectRefused(ctx, () => store.createIssue({ as: 'factory', ref, severity: 'low', title: 'Factory finding' }));
  for (const as of ['opus-2', 'openai', 'grok', 'you', 'fable']) {
    await store.createIssue({ as, ref, severity: 'nit', title: `Finding from ${as}` });
  }
  const issues = (await store.issues()).filter((x) => x.thread === 'checkout-v2');
  assert.deepEqual(issues.map((x) => x.raised_by).sort(), ['fable', 'grok', 'openai', 'opus-2', 'you']);
});

test('verify: the watch owner, the lead or you', async (t) => {
  const ctx = await projectCtx(t);
  const { store, ref } = ctx;
  await driveTo(ctx, ref, 'build');
  const fixedIssue = async (title) => {
    await store.createIssue({ as: 'opus-1', ref, severity: 'medium', title });
    const iss = (await store.issues()).filter((x) => x.thread === 'checkout-v2').at(-1);
    await store.acceptIssue({ as: 'fable', issue: `checkout/${iss.id}` });
    const accepted = await store.issue(`checkout/${iss.id}`);
    await completeTask(ctx, `checkout/${accepted.task}`);
    assert.equal((await store.issue(`checkout/${iss.id}`)).status, 'fixed');
    return `checkout/${iss.id}`;
  };
  const a = await fixedIssue('First production bug');
  for (const as of ['opus-1', 'opus-2', 'openai', 'grok']) {
    await expectRefused(ctx, () => store.verifyIssue({ as, issue: a, pass: true, note: 'not mine' }));
  }
  await store.verifyIssue({ as: 'you', issue: a, pass: true, note: 'Checked prod' });
  assert.equal((await store.issue(a)).status, 'verified');
  const b = await fixedIssue('Second production bug');
  await store.verifyIssue({ as: 'fable', issue: b, pass: false, note: 'Still failing' });
  assert.equal((await store.issue(b)).status, 'open');

  const watch = await setupWatch(ctx);
  await store.createIssue({ as: 'opus-monitor', ref: watch, severity: 'high', title: 'Watch finding', metric: 'error_rate' });
  const wi = (await store.issues()).filter((x) => x.thread === 'checkout-health').at(-1);
  const wref = `checkout/${wi.id}`;
  await fixWatchIssue(ctx, wref);
  assert.equal((await store.issue(wref)).status, 'fixed');
  await store.verifyIssue({ as: 'opus-monitor', issue: wref, pass: true, note: 'Prod is green' });
  assert.equal((await store.issue(wref)).status, 'verified');
});

test('decide: you or the lead; --gate is you only', async (t) => {
  const ctx = await projectCtx(t);
  const { store, ref } = ctx;
  for (const as of ['opus-1', 'openai', 'grok']) {
    await expectRefused(ctx, () => store.decide({ as, ref, title: 'Rogue decision' }));
  }
  await store.decide({ as: 'fable', ref, title: 'Lead decision' });
  await store.decide({ as: 'you', ref, title: 'Owner decision' });
  await expectRefused(ctx, () => store.decide({ as: 'fable', ref, title: 'Lead gate override', gate: 'brief', verdict: 'approve' }));
  assert.equal((await store.thread(ref)).phase, 'brief');
  await store.decide({ as: 'you', ref, title: 'Owner approves the brief', gate: 'brief', verdict: 'approve' });
  assert.equal((await store.thread(ref)).phase, 'design');
  assert.deepEqual((await store.decisions('checkout')).map((d) => d.id), ['D-001', 'D-002', 'D-003']);
});

test('watch: run by the owner or the lead; pause/resume by the lead or you', async (t) => {
  const ctx = await projectCtx(t);
  const { store } = ctx;
  const watch = await setupWatch(ctx);
  const metrics = { error_rate: 0.01, success_rate: 0.99 };
  for (const as of ['opus-1', 'grok', 'openai']) {
    await expectRefused(ctx, () => store.watchRun({ as, ref: watch, metrics }));
  }
  assert.equal((await store.metrics(watch)).length, 0);
  ctx.clock.hours(1);
  await store.watchRun({ as: 'opus-monitor', ref: watch, metrics });
  ctx.clock.hours(1);
  await store.watchRun({ as: 'fable', ref: watch, metrics });
  assert.equal((await store.metrics(watch)).length, 2);

  for (const as of ['opus-monitor', 'opus-1', 'openai']) {
    await expectRefused(ctx, () => store.setWatchState({ as, ref: watch, state: 'paused' }));
  }
  await store.setWatchState({ as: 'fable', ref: watch, state: 'paused' });
  assert.equal((await store.thread(watch)).phase, 'paused');
  await store.setWatchState({ as: 'you', ref: watch, state: 'active' });
  assert.equal((await store.thread(watch)).phase, 'active');
});
