// Turns (@mention model) and the CLI conveniences that close them.
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  ISO_RE, plain, projectCtx, setupTeam, setupProject, setupWatch, since, eventsIn, single, threadTasks,
  taskRef, openTurnIds, driveTo, expectError, describeMessages,
} from './helpers.mjs';

async function postOne(ctx, ref, args) {
  ctx.clock.seconds(30);
  const { added } = await since(ctx, ref, () => ctx.store.post({ ref, ...args }));
  return single(added, (m) => m.type === args.type && m.from === args.as, `${args.type} from ${args.as}`);
}

test('to opens one turn per recipient; cc never opens a turn', async (t) => {
  const ctx = await projectCtx(t);
  const { store, ref } = ctx;
  const q = await postOne(ctx, ref, { as: 'fable', type: 'question', to: ['openai', 'grok'], cc: ['you', 'opus-1'], body: 'Which retry policy?' });
  assert.deepEqual(plain(q.to), ['openai', 'grok']);
  assert.deepEqual(plain(q.cc), ['you', 'opus-1']);
  assert.ok((await openTurnIds(store, 'openai')).includes(q.id));
  assert.ok((await openTurnIds(store, 'grok')).includes(q.id));
  assert.ok(!(await openTurnIds(store, 'you')).includes(q.id), 'cc does not open a turn');
  assert.ok(!(await openTurnIds(store, 'opus-1')).includes(q.id), 'cc does not open a turn');
  assert.ok(!(await openTurnIds(store, 'fable')).includes(q.id), 'the sender has no turn');

  const turn = (await store.openTurns({ member: 'openai' })).find((x) => x.message.id === q.id);
  assert.equal(turn.team, 'checkout');
  assert.equal(turn.thread, 'checkout-v2');
  assert.equal(turn.member, 'openai');
  assert.equal(turn.message.from, 'fable');
  assert.equal(turn.message.type, 'question');
  assert.equal(turn.message.ts, q.ts);
  assert.equal(turn.message.summary, 'Which retry policy?');
  assert.equal(typeof turn.age_seconds, 'number');
});

test('reply_to closes a turn only when the reply comes from that recipient', async (t) => {
  const ctx = await projectCtx(t);
  const { store, ref } = ctx;
  const q = await postOne(ctx, ref, { as: 'fable', type: 'question', to: ['openai', 'grok'], body: 'Ready for review?' });
  await postOne(ctx, ref, { as: 'grok', type: 'answer', reply_to: q.id, body: 'Grok is ready.' });
  assert.ok(!(await openTurnIds(store, 'grok')).includes(q.id), "grok's reply closes grok's turn");
  assert.ok((await openTurnIds(store, 'openai')).includes(q.id), "someone else's reply does not close openai's turn");
  await postOne(ctx, ref, { as: 'opus-2', type: 'note', reply_to: q.id, body: 'FYI I can help.' });
  assert.ok((await openTurnIds(store, 'openai')).includes(q.id));
  const a = await postOne(ctx, ref, { as: 'openai', type: 'answer', reply_to: q.id, body: 'Yes.' });
  assert.equal(a.reply_to, q.id);
  assert.ok(!(await openTurnIds(store, 'openai')).includes(q.id));
});

test('resolves closes a turn when it comes from the recipient, the sender, the lead, the watch owner or you', async (t) => {
  const ctx = await projectCtx(t);
  const { store, ref } = ctx;
  for (const resolver of ['openai', 'opus-1', 'fable', 'you']) {
    const q = await postOne(ctx, ref, { as: 'opus-1', type: 'question', to: ['openai'], body: `Question for ${resolver} to resolve` });
    assert.ok((await openTurnIds(store, 'openai')).includes(q.id));
    const r = await postOne(ctx, ref, { as: resolver, type: 'note', resolves: [q.id], body: `Resolved by ${resolver}.` });
    assert.equal(r.resolves[0], q.id);
    // The resolver's own event/alert/report turns in the thread ride along.
    for (const extra of plain(r.resolves).slice(1)) {
      assert.ok(['event', 'alert', 'report'].includes((await store.message(extra)).type), `${extra} is a notification turn of ${resolver}`);
    }
    assert.ok(!(await openTurnIds(store, 'openai')).includes(q.id), `${resolver} may resolve`);
  }

  const watch = await setupWatch(ctx);
  const wq = await postOne(ctx, watch, { as: 'fable', type: 'question', to: ['you'], body: 'Raise the error budget?' });
  assert.ok((await openTurnIds(store, 'you')).includes(wq.id));
  await postOne(ctx, watch, { as: 'opus-monitor', type: 'note', resolves: [wq.id], body: 'Budget raised already.' });
  assert.ok(!(await openTurnIds(store, 'you')).includes(wq.id), 'the watch owner may resolve');
});

test('resolves from an unauthorised member is refused', async (t) => {
  const ctx = await projectCtx(t);
  const { store, ref } = ctx;
  const q = await postOne(ctx, ref, { as: 'fable', type: 'question', to: ['openai'], body: 'Which retry policy?' });
  for (const intruder of ['grok', 'opus-2']) {
    await expectError(() => store.post({ as: intruder, ref, type: 'note', resolves: [q.id], body: 'Closing this.' }));
  }
  assert.ok((await openTurnIds(store, 'openai')).includes(q.id), 'the turn stays open');
  assert.ok(!(await store.messages(ref)).some((m) => (m.resolves || []).includes(q.id)), 'no message was written');
});

test('openTurns: oldest first, summary, age_seconds and filters', async (t) => {
  const ctx = await projectCtx(t);
  const { store, clock, ref } = ctx;
  const q1 = await postOne(ctx, ref, { as: 'fable', type: 'question', to: ['openai'], body: '**Which** retry policy?\n\nDetails below.' });
  clock.seconds(60);
  const q2 = await postOne(ctx, ref, { as: 'fable', type: 'question', to: ['openai'], body: `\n\n${'x'.repeat(300)}\nsecond line` });
  clock.seconds(30);
  const turns = (await store.openTurns({ member: 'openai' })).filter((x) => [q1.id, q2.id].includes(x.message.id));
  assert.deepEqual(turns.map((x) => x.message.id), [q1.id, q2.id], 'oldest first');
  assert.equal(turns[0].message.summary, 'Which retry policy?', 'summary strips Markdown markers');
  assert.ok(turns[1].message.summary.length <= 140, 'summary is at most 140 chars');
  assert.ok(turns[1].message.summary.startsWith('xxxx'), 'summary is the first non-empty line');
  assert.ok(Math.abs(turns[0].age_seconds - 120) <= 1, `age of q1 ≈ 120 s, got ${turns[0].age_seconds}`);
  assert.ok(Math.abs(turns[1].age_seconds - 30) <= 1, `age of q2 ≈ 30 s, got ${turns[1].age_seconds}`);

  const all = await store.openTurns();
  assert.ok(all.some((x) => x.member === 'openai' && x.message.id === q1.id), 'no filter lists every member');
  const forThread = await store.openTurns({ member: 'openai', thread: 'checkout-v2' });
  assert.ok(forThread.some((x) => x.message.id === q1.id));

  await setupTeam(ctx, { id: 'payments', title: 'Payments' });
  const other = await setupProject(ctx, { team: 'payments', thread: 'refunds', title: 'Refunds' });
  const q3 = await postOne(ctx, other, { as: 'fable', type: 'question', to: ['openai'], body: 'Refund window?' });
  const payments = await store.openTurns({ member: 'openai', team: 'payments' });
  assert.ok(payments.length >= 1);
  assert.ok(payments.every((x) => x.team === 'payments'));
  assert.ok(payments.some((x) => x.message.id === q3.id));
  const ordered = (await store.openTurns({ member: 'openai' })).map((x) => x.message.ts);
  assert.deepEqual(ordered, [...ordered].sort(), 'oldest first across teams');
});

test('gate entry opens a turn for the gate owner; thread_created opens one for the lead', async (t) => {
  const ctx = await projectCtx(t);
  const { store, ref } = ctx;
  const created = eventsIn(await store.messages(ref), 'thread_created')[0];
  const fableTurn = (await store.openTurns({ member: 'fable' })).find((x) => x.message.id === created.id);
  assert.ok(fableTurn, 'thread_created opens a turn for the lead');
  assert.equal(fableTurn.message.from, 'factory');
  assert.equal(fableTurn.message.type, 'event');

  await driveTo(ctx, ref, 'design');
  const s = await since(ctx, ref, () => store.advance({ as: 'fable', ref }));
  const entry = eventsIn(s.added).find((e) => e.to.includes('openai'));
  assert.ok(entry, `gate entry event to openai:\n  ${describeMessages(s.added)}`);
  assert.ok((await openTurnIds(store, 'openai')).includes(entry.id));
});

test('review convenience: replies to the newest open turn and resolves the reviewer\'s other turns', async (t) => {
  const ctx = await projectCtx(t);
  const { store, ref } = ctx;
  const s0 = await since(ctx, ref, () => driveTo(ctx, ref, 'code_review'));
  const entry = eventsIn(s0.added).filter((e) => e.to.includes('openai')).at(-1);
  assert.ok(entry, 'code_review gate entry addressed to openai');
  const early = await postOne(ctx, ref, { as: 'opus-1', type: 'question', to: ['openai'], body: 'Any early concerns?' });
  const question = await postOne(ctx, ref, { as: 'fable', type: 'question', to: ['openai'], body: 'Please focus on retries.' });
  const before = await openTurnIds(store, 'openai');
  for (const id of [entry.id, early.id, question.id]) assert.ok(before.includes(id), `openai has a turn on ${id}`);

  ctx.clock.minutes(5);
  const { added } = await since(ctx, ref, () => store.review({ as: 'openai', ref, verdict: 'approve', points: [], body: 'Retries look right.' }));
  const review = single(added, (m) => m.type === 'review', 'review');
  assert.equal(review.reply_to, question.id, 'reply_to = the newest open turn in the thread');
  assert.ok(review.resolves.includes(early.id), 'the other open turns are resolved');
  assert.ok(review.resolves.includes(entry.id), 'the gate-entry turn is resolved too');
  const left = (await store.openTurns({ member: 'openai' })).filter((x) => x.thread === 'checkout-v2');
  assert.deepEqual(left.map((x) => x.message.id), [], 'the reviewer has no open turns left in the thread');
});

test('result and answer conveniences reply to the actor\'s open turn', async (t) => {
  const ctx = await projectCtx(t);
  const { store, ref } = ctx;
  await driveTo(ctx, ref, 'build');
  const [task] = await threadTasks(store, ref);
  ctx.clock.seconds(30);
  let s = await since(ctx, ref, () => store.dispatch({ as: 'fable', task: taskRef(task), to: 'opus-1', body: 'Yours.' }));
  const dispatch = single(s.added, (m) => m.type === 'dispatch', 'dispatch');
  assert.ok((await openTurnIds(store, 'opus-1')).includes(dispatch.id), 'dispatch opens a turn for the builder');
  ctx.clock.minutes(20);
  s = await since(ctx, ref, () => store.result({ as: 'opus-1', task: taskRef(task), outcome: 'done', body: 'Done.' }));
  const result = single(s.added, (m) => m.type === 'result', 'result');
  assert.equal(result.reply_to, dispatch.id);
  assert.ok(!(await openTurnIds(store, 'opus-1')).includes(dispatch.id));

  const q = await postOne(ctx, ref, { as: 'fable', type: 'question', to: ['opus-2'], body: 'Can you pair on tests?' });
  const a = await postOne(ctx, ref, { as: 'opus-2', type: 'answer', body: 'Yes, after lunch.' });
  assert.equal(a.reply_to, q.id);
  assert.ok(!(await openTurnIds(store, 'opus-2')).includes(q.id));
});

test('task reject re-dispatches to the owner; task accept resolves the result turn', async (t) => {
  const ctx = await projectCtx(t);
  const { store, ref } = ctx;
  await driveTo(ctx, ref, 'build');
  const [task] = await threadTasks(store, ref);
  const tref = taskRef(task);
  await store.dispatch({ as: 'fable', task: tref, to: 'opus-1', body: 'Yours.' });
  ctx.clock.minutes(20);
  await store.result({ as: 'opus-1', task: tref, outcome: 'done', body: 'Done.' });
  const r1 = (await store.messages(ref)).filter((m) => m.type === 'result').at(-1);

  ctx.clock.minutes(5);
  let s = await since(ctx, ref, () => store.rejectTask({ as: 'fable', task: tref, reason: 'Missing tests for the retry path' }));
  let after = await store.task(tref);
  assert.equal(after.status, 'doing');
  assert.equal(after.owner, 'opus-1', 'same owner');
  const redispatch = single(s.added, (m) => m.type === 'dispatch', 'dispatch after reject');
  assert.deepEqual(plain(redispatch.to), ['opus-1']);
  assert.equal(redispatch.task, task.id);
  assert.match(redispatch.body, /Missing tests for the retry path/);
  assert.ok((await openTurnIds(store, 'opus-1')).includes(redispatch.id), 'the reject opens the owner\'s turn');
  const rejectEvent = eventsIn(s.added, 'task_status').find((e) => (e.resolves || []).includes(r1.id));
  assert.ok(rejectEvent, `the task_status event resolves the result:\n  ${describeMessages(eventsIn(s.added))}`);
  assert.ok(!(await openTurnIds(store, 'fable')).includes(r1.id));

  ctx.clock.minutes(20);
  await store.result({ as: 'opus-1', task: tref, outcome: 'done', body: 'Tests added.' });
  const r2 = (await store.messages(ref)).filter((m) => m.type === 'result').at(-1);
  assert.notEqual(r2.id, r1.id);
  ctx.clock.minutes(5);
  s = await since(ctx, ref, () => store.acceptTask({ as: 'fable', task: tref, body: 'Good.' }));
  after = await store.task(tref);
  assert.equal(after.status, 'done');
  const acceptEvent = eventsIn(s.added, 'task_status').find((e) => (e.resolves || []).includes(r2.id));
  assert.ok(acceptEvent, `the task accept event resolves the result:\n  ${describeMessages(eventsIn(s.added))}`);
  assert.equal(acceptEvent.from, 'factory');
  assert.ok(!(await openTurnIds(store, 'fable')).includes(r2.id), 'the lead has no turn left on the result');
  for (const e of eventsIn(s.added)) {
    if (!(e.to || []).length) continue;
    assert.ok(e.event.kind === 'phase' || e.event.kind === 'gate', 'only gate entries address someone');
  }
  assert.match(after.updated, ISO_RE);
});

test('re-dispatching a blocked task answers the blocked result: the lead\'s turn on it closes', async (t) => {
  const ctx = await projectCtx(t);
  const { store, ref } = ctx;
  await driveTo(ctx, ref, 'build');
  const [task] = await threadTasks(store, ref);
  const tref = taskRef(task);
  await store.dispatch({ as: 'fable', task: tref, to: 'opus-1', body: 'Yours.' });
  ctx.clock.minutes(10);
  await store.result({ as: 'opus-1', task: tref, outcome: 'blocked', body: 'Waiting on an answer.' });
  const blocked = (await store.messages(ref)).filter((m) => m.type === 'result').at(-1);
  assert.ok((await openTurnIds(store, 'fable')).includes(blocked.id), 'a blocked result opens the lead\'s turn');

  ctx.clock.minutes(5);
  let s = await since(ctx, ref, () => store.dispatch({ as: 'fable', task: tref, to: 'opus-1', body: 'Answered; go on.' }));
  const again = single(s.added, (m) => m.type === 'dispatch', 'the re-dispatch');
  assert.equal(again.reply_to, blocked.id, 'the re-dispatch replies to the blocked result');
  assert.deepEqual(plain(again.resolves), [], 'the lead replying closes its own turn; nothing to resolve');
  assert.ok(!(await openTurnIds(store, 'fable')).includes(blocked.id), 'the lead has no turn left on the blocked result');
  assert.ok((await openTurnIds(store, 'opus-1')).includes(again.id), 'the re-dispatch opens the builder\'s turn');

  // A failed result re-dispatched by you (to the other builder) is resolved by name.
  ctx.clock.minutes(10);
  await store.result({ as: 'opus-1', task: tref, outcome: 'failed', body: 'Cannot be done this way.' });
  const failed = (await store.messages(ref)).filter((m) => m.type === 'result').at(-1);
  assert.equal((await store.task(tref)).status, 'blocked');
  ctx.clock.minutes(5);
  s = await since(ctx, ref, () => store.dispatch({ as: 'you', task: tref, to: 'opus-2', body: 'Try the other approach.' }));
  const third = single(s.added, (m) => m.type === 'dispatch', 'the dispatch by you');
  assert.equal(third.reply_to, failed.id);
  assert.deepEqual(plain(third.resolves), [failed.id], 'you resolve the lead\'s turn on the failed result');
  assert.ok(!(await openTurnIds(store, 'fable')).includes(failed.id));

  // A first dispatch, or a dispatch of a task that is not blocked, replies to nothing.
  const fresh = (await store.createTask({ as: 'fable', ref, title: 'Another task' })).task;
  ctx.clock.minutes(1);
  s = await since(ctx, ref, () => store.dispatch({ as: 'fable', task: taskRef(fresh), to: 'opus-2' }));
  const first = single(s.added, (m) => m.type === 'dispatch', 'a first dispatch');
  assert.equal(first.reply_to, null);
  assert.deepEqual(plain(first.resolves), []);
  const v = await store.validate();
  assert.deepEqual(v.errors, [], 'the re-dispatch messages validate');
});

test('event, alert and report turns close on the recipient\'s next write in that thread', async (t) => {
  const ctx = await projectCtx(t);
  const { store, ref } = ctx;
  const created = eventsIn(await store.messages(ref), 'thread_created')[0];
  assert.ok((await openTurnIds(store, 'fable')).includes(created.id), 'thread_created opens the lead\'s turn');

  // Someone else's write leaves it open.
  await postOne(ctx, ref, { as: 'opus-2', type: 'note', body: 'Watching this one.' });
  assert.ok((await openTurnIds(store, 'fable')).includes(created.id), 'another member\'s write does not close it');

  // A command that writes no message of the actor's: its first factory event carries the resolution.
  ctx.clock.seconds(30);
  let s = await since(ctx, ref, () => store.editSection({ as: 'fable', ref, section: 'Notes', body: 'Scope notes.' }));
  const updated = single(s.added, (m) => m.type === 'event' && m.event.kind === 'section_updated', 'section_updated');
  assert.deepEqual(plain(updated.resolves), [created.id], 'the factory event resolves the lead\'s notification turn');
  assert.ok(!(await openTurnIds(store, 'fable')).includes(created.id));

  // A command that writes the actor's own message: that message carries it, not the events after it.
  await driveTo(ctx, ref, 'design');
  s = await since(ctx, ref, () => store.advance({ as: 'fable', ref }));
  const entry = eventsIn(s.added).find((e) => (e.to || []).includes('openai'));
  assert.ok((await openTurnIds(store, 'openai')).includes(entry.id), 'the gate entry opens the reviewer\'s turn');
  const q = await postOne(ctx, ref, { as: 'fable', type: 'question', to: ['openai'], body: 'Anything unclear?' });
  ctx.clock.seconds(30);
  s = await since(ctx, ref, () => store.post({ as: 'openai', ref, type: 'answer', reply_to: q.id, body: 'All clear.' }));
  const answer = single(s.added, (m) => m.type === 'answer', 'answer');
  assert.equal(answer.reply_to, q.id);
  assert.deepEqual(plain(answer.resolves), [entry.id], 'the answer also closes the reviewer\'s gate-entry event turn');
  assert.ok(!(await openTurnIds(store, 'openai')).includes(entry.id));

  // Questions are not notifications: only reply_to or resolves close them.
  const q2 = await postOne(ctx, ref, { as: 'fable', type: 'question', to: ['openai'], body: 'One more thing?' });
  await postOne(ctx, ref, { as: 'openai', type: 'note', reply_to: null, body: 'Unrelated note.' });
  assert.ok((await openTurnIds(store, 'openai')).includes(q2.id), 'a question stays open across the recipient\'s unrelated write');

  // Turns in another thread are untouched.
  const watch = await setupWatch(ctx);
  await store.watchRun({ as: 'opus-monitor', ref: watch, metrics: { error_rate: 0.5 } });
  const alert = (await store.messages(watch)).find((m) => m.type === 'alert');
  assert.ok(alert && (await openTurnIds(store, 'fable')).includes(alert.id), 'a breach alert opens the lead\'s turn');
  await postOne(ctx, ref, { as: 'fable', type: 'note', body: 'Project note.' });
  assert.ok((await openTurnIds(store, 'fable')).includes(alert.id), 'a write in another thread leaves it open');
  const issue = (await store.issues({ thread: watch })).find((i) => i.status === 'open');
  ctx.clock.seconds(30);
  s = await since(ctx, watch, () => store.deferIssue({ as: 'fable', issue: `checkout/${issue.id}`, reason: 'Known; fix after launch.' }));
  const deferred = single(s.added, (m) => m.type === 'event' && m.event.kind === 'issue_status', 'issue_status');
  assert.ok(deferred.resolves.includes(alert.id), 'triaging the issue closes the alert turn');
  for (const id of await openTurnIds(store, 'fable')) {
    const m = await store.message(id);
    assert.ok(!(m.thread === 'checkout-health' && ['event', 'alert', 'report'].includes(m.type)), `no notification turn left in the watch thread (${id})`);
  }

  const v = await store.validate();
  assert.deepEqual(v.errors, [], 'the automatic resolutions validate');
});

test('an answer, question, escalation or note to you closes once you write again in that thread', async (t) => {
  const ctx = await projectCtx(t);
  const { store, ref } = ctx;
  const q = await postOne(ctx, ref, { as: 'you', type: 'question', to: ['fable'], body: 'Is the PR green?' });
  const a = await postOne(ctx, ref, { as: 'fable', type: 'answer', to: ['you'], reply_to: q.id, body: 'Yes, all checks pass.' });
  const ask = await postOne(ctx, ref, { as: 'fable', type: 'question', to: ['you'], body: 'Merge now or wait?' });
  const esc = await postOne(ctx, ref, { as: 'openai', type: 'escalation', to: ['you'], body: 'Retry policy needs an owner call.' });
  const fyi = await postOne(ctx, ref, { as: 'fable', type: 'note', to: ['you'], body: 'Grok can start its final review.' });
  for (const m of [a, ask, esc, fyi]) assert.ok((await openTurnIds(store, 'you')).includes(m.id), `${m.type} is open until you write again`);

  // Someone else's write, or yours in another thread, leaves it open.
  await postOne(ctx, ref, { as: 'opus-2', type: 'note', body: 'Watching.' });
  assert.ok((await openTurnIds(store, 'you')).includes(a.id));
  const watch = await setupWatch(ctx);
  await postOne(ctx, watch, { as: 'you', type: 'note', body: 'Elsewhere.' });
  assert.ok((await openTurnIds(store, 'you')).includes(a.id), 'a write in another thread leaves it open');

  // Your next message in the thread, with no reply_to, is your answer: nothing stays waiting on you.
  await postOne(ctx, ref, { as: 'you', type: 'question', to: ['fable'], body: 'Also, does it know about the MCP?' });
  const open = await openTurnIds(store, 'you');
  for (const m of [a, ask, esc, fyi]) assert.ok(!open.includes(m.id), `the ${m.type} closed on your next write`);
  // The asker's own turn opened by your message stays: it reads it and asks again if its question is still open.
  assert.ok((await store.openTurns({ member: 'fable' })).length >= 1);

  // An answer or question sent after your write opens a fresh turn (the asker asking again).
  const a2 = await postOne(ctx, ref, { as: 'fable', type: 'answer', to: ['you'], body: 'It does after the restart.' });
  const again = await postOne(ctx, ref, { as: 'fable', type: 'question', to: ['you'], body: 'Still open: merge now or wait?' });
  for (const m of [a2, again]) assert.ok((await openTurnIds(store, 'you')).includes(m.id));
  assert.deepEqual((await store.validate()).errors, []);
});

test('decide --gate settles the escalations you hold in the thread; decide --reply-to answers one', async (t) => {
  const ctx = await projectCtx(t);
  const { store, ref } = ctx;
  await driveTo(ctx, ref, 'design_review');
  const esc = await postOne(ctx, ref, { as: 'openai', type: 'escalation', to: ['you'], body: 'Retry policy needs an owner call.' });
  assert.ok((await openTurnIds(store, 'you')).includes(esc.id));
  ctx.clock.minutes(5);
  const r = await store.decide({ as: 'you', ref, title: 'Keep inline retry', gate: 'design_review', verdict: 'approve' });
  assert.ok(r.message.resolves.includes(esc.id), 'the gate decision resolves the escalation');
  assert.ok(!(await openTurnIds(store, 'you')).includes(esc.id));

  // The lead answering an escalation addressed to you with a decision closes your turn too.
  const esc2 = await postOne(ctx, ref, { as: 'opus-1', type: 'escalation', to: ['you'], body: 'Which provider?' });
  ctx.clock.minutes(1);
  const d = await store.decide({ as: 'fable', ref, title: 'Use provider A', reply_to: esc2.id });
  assert.equal(d.message.reply_to, esc2.id);
  assert.ok(d.message.resolves.includes(esc2.id));
  assert.ok(!(await openTurnIds(store, 'you')).includes(esc2.id));
  assert.deepEqual((await store.validate()).errors, []);
});

test('decide --gate closes the overridden gate owner\'s gate-entry notification', async (t) => {
  const ctx = await projectCtx(t);
  const { store, ref } = ctx;
  await driveTo(ctx, ref, 'final_review');
  const entryTurns = async () => {
    const out = [];
    for (const id of await openTurnIds(store, 'grok')) {
      const m = await store.message(id);
      if (m.type === 'event' && m.event.kind === 'phase' && m.event.to === 'final_review') out.push(id);
    }
    return out;
  };
  const entry = await entryTurns();
  assert.equal(entry.length, 1, 'grok holds the event that put the thread in final_review');
  ctx.clock.minutes(5);
  const r = await store.decide({ as: 'you', ref, title: 'Ship without the load test', gate: 'final_review', verdict: 'approve' });
  assert.ok(r.message.resolves.includes(entry[0]), 'the gate decision resolves it');
  assert.deepEqual(await entryTurns(), [], 'grok is no longer waited on for an overridden gate');
  assert.equal((await store.thread(ref)).phase, 'signoff');
  assert.deepEqual((await store.validate()).errors, []);
});

test('post --type decision: --reply-to is kept; --to, --cc and --internal are refused instead of dropped', async (t) => {
  const ctx = await projectCtx(t);
  const { store, ref } = ctx;
  const q = await postOne(ctx, ref, { as: 'opus-1', type: 'question', to: ['fable'], body: 'Hosted or embedded?' });
  for (const extra of [{ to: ['openai'] }, { cc: ['grok'] }, { internal: true }]) {
    await expectError(() => store.post({ as: 'fable', ref, type: 'decision', body: 'Hosted.', ...extra }), 'usage', /decision takes no/);
  }
  ctx.clock.seconds(30);
  const r = await store.post({ as: 'fable', ref, type: 'decision', reply_to: q.id, body: 'Hosted checkout.' });
  assert.equal(r.message.reply_to, q.id);
  assert.ok(!(await openTurnIds(store, 'fable')).includes(q.id), 'the decision answers the question');
  assert.equal(r.decision.title, 'Hosted checkout.');
});

test('re-dispatching a task whose done result was never accepted answers that result', async (t) => {
  const ctx = await projectCtx(t);
  const { store, ref } = ctx;
  await driveTo(ctx, ref, 'build');
  const [task] = await threadTasks(store, ref);
  const tref = taskRef(task);
  await store.dispatch({ as: 'fable', task: tref, to: 'opus-1', body: 'Yours.' });
  ctx.clock.minutes(10);
  await store.result({ as: 'opus-1', task: tref, outcome: 'done', body: 'Done.' });
  const done = (await store.messages(ref)).filter((m) => m.type === 'result').at(-1);
  assert.ok((await openTurnIds(store, 'fable')).includes(done.id));
  ctx.clock.minutes(5);
  const s = await since(ctx, ref, () => store.dispatch({ as: 'fable', task: tref, to: 'opus-2', body: 'Hand it to opus-2 instead.' }));
  const again = single(s.added, (m) => m.type === 'dispatch', 're-dispatch');
  assert.equal(again.reply_to, done.id, 'the re-dispatch replies to the unaccepted done result');
  assert.ok(!(await openTurnIds(store, 'fable')).includes(done.id), 'no orphaned result turn');
});

test('reply_to and resolves must name a message of the same team', async (t) => {
  const ctx = await projectCtx(t);
  const { store, ref } = ctx;
  await setupTeam(ctx, { id: 'payments', title: 'Payments' });
  const other = await setupProject(ctx, { team: 'payments', thread: 'refunds', title: 'Refunds' });
  const q = await postOne(ctx, other, { as: 'fable', type: 'question', to: ['openai'], body: 'Refund window?' });
  await expectError(() => store.post({ as: 'openai', ref, type: 'answer', reply_to: q.id, body: '30 days.' }), 'usage', /team payments/);
  await expectError(() => store.post({ as: 'fable', ref, type: 'note', resolves: [q.id], body: 'Settled.' }), 'usage', /team payments/);
  assert.ok((await openTurnIds(store, 'openai')).includes(q.id), 'the turn stays open');
});

test('a builder dispatched onto a thread it is not a member of can post and raise issues there', async (t) => {
  const ctx = await projectCtx(t, { members: ['openai', 'grok'] });
  const { store, ref } = ctx;
  assert.ok(!(await store.thread(ref)).members.includes('opus-2'));
  await driveTo(ctx, ref, 'build');
  const [task] = await threadTasks(store, ref);
  await expectError(() => store.post({ as: 'opus-2', ref, type: 'note', body: 'Hello?' }), 'permission');
  await store.dispatch({ as: 'fable', task: taskRef(task), to: 'opus-2', body: 'Yours.' });
  ctx.clock.minutes(1);
  await store.post({ as: 'opus-2', ref, type: 'question', to: ['fable'], body: 'Which retry count?' });
  await store.createIssue({ as: 'opus-2', ref, severity: 'low', title: 'Found a flaky test' });
  assert.ok((await store.issues({ thread: ref })).some((x) => x.raised_by === 'opus-2'));
  await expectError(() => store.post({ as: 'opus-1', ref, type: 'note', body: 'Not mine.' }), 'permission');
});

test('dismiss closes only the turns it names; it is not a write, so the rest stay open', async (t) => {
  const ctx = await projectCtx(t);
  const { store, ref } = ctx;
  const n1 = await postOne(ctx, ref, { as: 'fable', type: 'note', to: ['you'], body: 'Start grok from the board.' });
  const q = await postOne(ctx, ref, { as: 'fable', type: 'question', to: ['you'], body: 'Merge #988 too?' });
  ctx.clock.seconds(30);
  const r = store.dismiss({ as: 'you', ref, ids: [n1.id] });
  assert.deepEqual(r.dismissed, [n1.id]);
  assert.equal(r.message.internal, true);
  assert.equal(r.message.dismissal, true);
  assert.deepEqual(r.message.to, []);
  const open = await openTurnIds(store, 'you');
  assert.ok(!open.includes(n1.id), 'the dismissed note closed');
  assert.ok(open.includes(q.id), 'the question stays: a dismissal is not your answer');
  assert.deepEqual((await store.openTurns({ member: 'fable' })).filter((x) => x.message.id === r.message.id), [], 'and starts nobody');
  assert.throws(() => store.dismiss({ as: 'you', ref, ids: [n1.id] }), /is not waiting on you/);
  assert.throws(() => store.dismiss({ as: 'you', ref, ids: [] }), /name the message/);
  assert.deepEqual((await store.validate()).errors, []);
});

test('you can dismiss the turns of an agent you will not start; nobody else can dismiss for another', async (t) => {
  const ctx = await projectCtx(t, { members: ['openai', 'grok'] });
  const { store, ref } = ctx;
  const p1 = await postOne(ctx, ref, { as: 'fable', type: 'note', to: ['grok'], body: 'Review the plan.' });
  const p2 = await postOne(ctx, ref, { as: 'fable', type: 'question', to: ['grok', 'openai'], body: 'Which runner?' });
  ctx.clock.seconds(30);
  assert.throws(() => store.dismiss({ as: 'fable', ref, ids: [p1.id], member: 'grok' }), /only you can dismiss another member/);
  assert.throws(() => store.dismiss({ as: 'you', ref, ids: [p1.id] }), /is not waiting on you/);
  const r = store.dismiss({ as: 'you', ref, ids: [p1.id, p2.id], member: 'grok' });
  assert.deepEqual(r.dismissed, [p1.id, p2.id]);
  assert.equal(r.member, 'grok');
  assert.match(r.message.body.trim(), /for grok\.$/);
  const grok = await openTurnIds(store, 'grok');
  assert.ok(!grok.includes(p1.id) && !grok.includes(p2.id), 'both grok turns closed');
  assert.ok((await openTurnIds(store, 'openai')).includes(p2.id), 'the same question stays open for openai');
  assert.deepEqual((await store.validate()).errors, []);
});

test('dismissing the agent that owns the pending gate stops the wait on it until the gate moves; it approves nothing', async (t) => {
  const ctx = await projectCtx(t, { members: ['openai', 'grok'] });
  const { store, ref } = ctx;
  await driveTo(ctx, ref, 'final_review');
  const th = await store.thread(ref);
  assert.equal(th.gates.final_review.by, 'grok');
  const held = (await store.openTurns({ member: 'grok', thread: ref })).map((x) => x.message.id);
  assert.ok(held.length > 0, 'grok holds the gate-entry turn');
  ctx.clock.seconds(30);
  const gateOf = async () => (await store.board()).teams.flatMap((x) => x.threads).find((x) => `${x.team}/${x.id}` === ref).gate_dismissed;
  assert.equal(await gateOf(), null);
  const r = store.dismiss({ as: 'you', ref, ids: held, member: 'grok' });
  assert.equal(r.gate, 'final_review');
  assert.equal(r.message.dismissed_gate, 'final_review');
  assert.deepEqual((await store.openTurns({ member: 'grok', thread: ref })), []);
  assert.equal(await gateOf(), 'final_review');
  assert.equal(store.threadView(ref).thread.gate_dismissed, 'final_review');
  assert.equal((await store.thread(ref)).gates.final_review.status, 'pending', 'the gate is not approved');
  // A second dismissal with no turns left still records just the gate; your own gates are not dismissed this way.
  ctx.clock.seconds(5);
  assert.equal(store.dismiss({ as: 'you', ref, member: 'grok' }).gate, 'final_review');
  assert.throws(() => store.dismiss({ as: 'you', ref }), /name the message/);
  assert.deepEqual((await store.validate()).errors, []);
  // Once grok reviews, the gate moves and the dismissal no longer applies.
  ctx.clock.seconds(5);
  await store.review({ as: 'grok', ref, verdict: 'approve', points: [], body: 'Fine.' });
  assert.equal((await store.thread(ref)).phase, 'signoff');
  assert.equal(await gateOf(), null);
});

test('skipping a review gate: your gate decision approves it and closes the review request the gate owner still holds', async (t) => {
  const ctx = await projectCtx(t, { members: ['openai', 'grok'] });
  const { store, ref } = ctx;
  await driveTo(ctx, ref, 'final_review');
  ctx.clock.seconds(5);
  const p = await postOne(ctx, ref, { as: 'fable', type: 'proposal', to: ['grok'], body: 'Final review, round 2.' });
  const q = await postOne(ctx, ref, { as: 'fable', type: 'question', to: ['grok'], body: 'Unrelated: which runner?' });
  ctx.clock.seconds(5);
  await store.decide({ as: 'you', ref, gate: 'final_review', verdict: 'approve', title: "Skip grok's final review" });
  assert.equal((await store.thread(ref)).phase, 'signoff');
  const grok = await openTurnIds(store, 'grok');
  assert.ok(!grok.includes(p.id), 'the review request closed');
  assert.ok(grok.includes(q.id), 'a question that is not a review request stays');
  assert.deepEqual((await store.validate()).errors, []);
});
