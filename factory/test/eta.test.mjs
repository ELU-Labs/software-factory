// Estimates: a project thread's phases (`thread eta`) and its tasks (`dispatch --eta`, `task eta`).
import test from 'node:test';
import assert from 'node:assert/strict';
import { parseDuration, fmtDuration, ETA_PHASES } from '../lib/store.mjs';
import { projectCtx, driveTo, eventsIn, since, expectError } from './helpers.mjs';

test('parseDuration reads minutes and hours; fmtDuration writes them back', () => {
  for (const [text, min] of [['45m', 45], ['45', 45], ['2h', 120], ['1h30m', 90], ['1.5h', 90], ['1h 30m', 90], ['20 min', 20]]) assert.equal(parseDuration(text), min, text);
  for (const bad of ['', 'soon', '2d', '-5m', 'h']) assert.equal(parseDuration(bad), null, bad);
  assert.deepEqual([45, 60, 90, 185].map(fmtDuration), ['45m', '1h', '1h 30m', '3h 5m']);
  assert.ok(!ETA_PHASES.includes('done') && ETA_PHASES.includes('build') && ETA_PHASES.includes('signoff'));
});

test('thread eta: the lead estimates phases; a gate owner only its gate; past phases and other threads are refused', async (t) => {
  const ctx = await projectCtx(t);
  const { store, clock, ref } = ctx;
  await driveTo(ctx, ref, 'design');
  clock.seconds(5);
  const evs = eventsIn((await since(ctx, ref, () => store.setThreadEta({ as: 'fable', ref, eta: 'design=45m, plan=20m,build=3h,code_review=30m' }))).added, 'eta');
  assert.equal(evs.length, 1);
  assert.deepEqual(evs[0].to, [], 'an estimate is news, not a turn');
  assert.deepEqual(evs[0].event.estimates, { design: 45, plan: 20, build: 180, code_review: 30 });
  assert.match(evs[0].body, /design 45m left · plan 20m · build 3h · code_review 30m/);
  let th = await store.thread(ref);
  assert.deepEqual(Object.keys(th.eta), ['design', 'plan', 'build', 'code_review'], 'kept in phase order');
  assert.equal(th.eta.build.minutes, 180);
  assert.equal(th.eta.build.by, 'fable');

  // The code_review gate's owner sets its own gate, and only that.
  const reviewer = th.gates.code_review.by;
  clock.seconds(1);
  await store.setThreadEta({ as: reviewer, ref, eta: 'code_review=15m' });
  th = await store.thread(ref);
  assert.deepEqual(th.eta.code_review.minutes, 15);
  assert.equal(th.eta.code_review.by, reviewer);
  assert.equal(th.eta.build.minutes, 180, 'other estimates stay');
  await expectError(() => store.setThreadEta({ as: reviewer, ref, eta: 'build=1h' }), 'permission', /lead \(fable\), you/);
  await expectError(() => store.setThreadEta({ as: 'opus-1', ref, eta: 'plan=1h' }), 'permission');

  await expectError(() => store.setThreadEta({ as: 'fable', ref, eta: 'brief=10m' }), 'conflict', /behind/);
  await expectError(() => store.setThreadEta({ as: 'fable', ref, eta: 'done=10m' }), 'usage', /not a phase to estimate/);
  await expectError(() => store.setThreadEta({ as: 'fable', ref, eta: 'build=soon' }), 'usage', /not an estimate/);
  await expectError(() => store.setThreadEta({ as: 'fable', ref, eta: 'build' }), 'usage', /<phase>=<time>/);
  await expectError(() => store.setThreadEta({ as: 'fable', ref, eta: '' }), 'usage');
  assert.deepEqual((await store.validate()).errors, []);
});

test('task estimates: dispatch --eta, the owner revises with task eta, the result records the end, rework restarts the clock', async (t) => {
  const ctx = await projectCtx(t);
  const { store, clock, ref } = ctx;
  await driveTo(ctx, ref, 'build');
  clock.seconds(1);
  const { task: created } = await store.createTask({ as: 'fable', ref, title: 'Wire the checkout button' });
  const tref = `${created.team}/${created.id}`;

  // A plan-time estimate on a task still to do.
  clock.seconds(1);
  await store.setTaskEta({ as: 'fable', task: tref, eta: '40m' });
  assert.equal((await store.task(tref)).eta.minutes, 40);

  // Dispatch without --eta keeps the length and restarts the clock at the dispatch.
  clock.seconds(60);
  await store.dispatch({ as: 'fable', task: tref, to: 'opus-1' });
  let tk = await store.task(tref);
  assert.equal(tk.eta.minutes, 40);
  assert.equal(tk.eta.at, tk.updated, 'the clock starts at the dispatch');

  // With --eta it replaces the estimate and posts an eta event.
  clock.seconds(1);
  const evs = eventsIn((await since(ctx, ref, () => store.dispatch({ as: 'fable', task: tref, to: 'opus-1', eta: '25m' }))).added, 'eta');
  assert.equal(evs.length, 1);
  assert.deepEqual([evs[0].event.task, evs[0].event.minutes], [created.id, 25]);
  assert.match(evs[0].body, /25m from now/);

  // The owner revises it; someone else cannot.
  clock.seconds(1);
  await store.setTaskEta({ as: 'opus-1', task: tref, eta: '1h' });
  tk = await store.task(tref);
  assert.deepEqual([tk.eta.minutes, tk.eta.by], [60, 'opus-1']);
  await expectError(() => store.setTaskEta({ as: 'opus-2', task: tref, eta: '10m' }), 'permission', /its owner \(opus-1\)/);

  // The result records when the work ended; review takes no new estimate.
  clock.seconds(600);
  await store.result({ as: 'opus-1', task: tref, outcome: 'done', body: 'Done.' });
  tk = await store.task(tref);
  assert.equal(tk.status, 'review');
  assert.equal(Date.parse(tk.eta.ended) - Date.parse(tk.eta.at), 600_000);
  await expectError(() => store.setTaskEta({ as: 'opus-1', task: tref, eta: '10m' }), 'conflict', /is review/);

  // Rework restarts the clock and drops the end.
  clock.seconds(5);
  await store.rejectTask({ as: 'fable', task: tref, reason: 'Missing the disabled state.' });
  tk = await store.task(tref);
  assert.equal(tk.eta.ended, undefined);
  assert.equal(tk.eta.at, tk.updated);
  assert.equal(tk.eta.minutes, 60);

  const board = await store.board();
  const row = board.teams[0].tasks.find((x) => x.id === created.id);
  assert.equal(row.eta.minutes, 60, 'the board carries the estimate');
  const thRow = board.teams[0].threads.find((x) => `${x.team}/${x.id}` === ref);
  assert.ok(thRow.phase_since, 'and when the current phase began');
  assert.deepEqual((await store.validate()).errors, []);
});
