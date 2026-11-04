// Watch threads: runs, breaches → issues/alerts/reports/metrics, verification, cadence.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import {
  ISO_RE, DEFAULT_THRESHOLDS, plain, watchCtx, setupWatch, since, eventsIn, single, threadIssues, threadTasks,
  completeTask, expectError, readFrontmatterFile, editFrontmatterFile, runCli, assertExit, fixWatchIssue, setupProject, driveTo,
} from './helpers.mjs';

const REPORT_RE = /^reports\/checkout-health-\d{8}T\d{6}Z\.md$/;

async function run(ctx, args, ref = ctx.ref) {
  ctx.clock.hours(1);
  const s = await since(ctx, ref, () => ctx.store.watchRun({ as: 'opus-monitor', ref, ...args }));
  const rows = await ctx.store.metrics(ref);
  return { ...s, row: rows[rows.length - 1], rows };
}

function readReport(ctx, row) {
  return readFrontmatterFile(path.join(ctx.root, 'teams', 'checkout', row.report));
}

/** Fix a watch issue through a project thread, reviewed through signoff (it is then `fixed`). */
async function fixIssue(ctx, id, action) {
  await fixWatchIssue(ctx, `checkout/${id}`, { action });
}

function dueIds(list) {
  return list.map((x) => {
    if (typeof x === 'string') return x.split('/').pop();
    if (typeof x.thread === 'string') return x.thread;
    if (x.thread && typeof x.thread === 'object') return x.thread.id;
    return x.id;
  });
}

function writeEvalScript(ctx, name, lines) {
  const dir = path.join(ctx.root, 'scripts');
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, name);
  fs.writeFileSync(file, [
    "import fs from 'node:fs';",
    "fs.writeFileSync(new URL('./cwd.txt', import.meta.url), process.cwd());",
    ...lines.map((l) => `console.log(${JSON.stringify(l)});`),
    '',
  ].join('\n'));
  const cmd = `${JSON.stringify(process.execPath)} ${JSON.stringify(file)}`;
  editFrontmatterFile(path.join(ctx.root, 'teams', 'checkout', 'team.md'), (data) => {
    data.eval_cmd = cmd;
  });
  return { cwdFile: path.join(dir, 'cwd.txt') };
}

test('watch thread shape', async (t) => {
  const ctx = await watchCtx(t);
  const th = await ctx.store.thread(ctx.ref);
  assert.equal(th.kind, 'watch');
  assert.equal(th.phase, 'active');
  assert.equal(th.lead, 'fable');
  assert.equal(th.owner, 'opus-monitor');
  assert.equal(th.cadence, 'daily');
  assert.deepEqual(plain(th.thresholds), DEFAULT_THRESHOLDS);
  assert.equal(th.last_run, null);
  assert.equal(th.gates, null);
  assert.equal(th.branch, 'factory/checkout/checkout-health');
  for (const s of ['## What we watch', '## Thresholds', '## Runbook']) assert.ok(th.body.includes(s), `body has ${s}`);
});

test('a breach opens an issue, alerts the lead, writes the report and one metrics line', async (t) => {
  const ctx = await watchCtx(t);
  const { store, root, ref } = ctx;
  const th0 = await store.thread(ref);
  const { added, row, rows } = await run(ctx, { metrics: { error_rate: 0.031, success_rate: 0.99 }, note: 'Spike after the 14:00 deploy' });

  // metrics.jsonl
  assert.equal(rows.length, 1);
  assert.equal(row.thread, 'checkout-health');
  assert.deepEqual(plain(row.metrics), { error_rate: 0.031, success_rate: 0.99 });
  assert.deepEqual(plain(row.breaches), ['error_rate']);
  assert.equal(row.by, 'opus-monitor');
  assert.match(row.ts, ISO_RE);
  assert.equal(row.window.from, th0.created, 'first window starts at thread creation');
  assert.match(row.window.to, ISO_RE);
  assert.match(row.report, REPORT_RE);
  const lines = fs.readFileSync(path.join(root, 'teams', 'checkout', 'metrics.jsonl'), 'utf8').split('\n').filter(Boolean);
  assert.equal(lines.length, 1);
  const parsed = JSON.parse(lines[0]);
  for (const k of ['ts', 'thread', 'window', 'metrics', 'breaches', 'report', 'by']) assert.ok(k in parsed, `metrics line has ${k}`);
  assert.deepEqual(parsed.breaches, ['error_rate']);

  // issue
  const issues = await threadIssues(store, ref);
  assert.equal(issues.length, 1);
  const [iss] = issues;
  assert.equal(iss.id, 'I-001');
  assert.equal(iss.gate, null);
  assert.equal(iss.metric, 'error_rate');
  assert.equal(iss.severity, 'high', '0.031 exceeds max 0.02 by more than 50%');
  assert.equal(iss.status, 'open');
  assert.equal(iss.thread, 'checkout-health');
  assert.equal(iss.source, row.report);
  assert.equal(iss.point, null);

  // report file
  const report = readReport(ctx, row);
  assert.equal(report.data.thread, 'checkout-health');
  assert.equal(report.data.status, 'breach');
  assert.equal(report.data.by, 'opus-monitor');
  assert.match(report.data.ts, ISO_RE);
  assert.deepEqual(plain(report.data.breaches), ['error_rate']);
  assert.deepEqual(plain(report.data.opened), ['I-001']);
  assert.deepEqual(plain(report.data.verified), []);
  assert.deepEqual(plain(report.data.reopened), []);
  assert.deepEqual(plain(report.data.metrics), { error_rate: 0.031, success_rate: 0.99 });
  assert.ok(report.data.window && report.data.window.from && report.data.window.to, 'report window');
  assert.match(report.body, /\|\s*metric\s*\|\s*value\s*\|\s*threshold\s*\|\s*status\s*\|/);
  assert.match(report.body, /error_rate/);
  assert.match(report.body, /success_rate/);
  assert.match(report.body, /I-001/);
  assert.ok(report.body.includes('Spike after the 14:00 deploy'), 'the note is in the report');
  const reports = await store.reports(ref);
  assert.equal(reports.length, 1);
  assert.equal(reports[0].status, 'breach');
  assert.ok(String(reports[0].file).endsWith(path.basename(row.report)));

  // alert + report messages
  const alert = single(added, (m) => m.type === 'alert', 'alert');
  assert.equal(alert.from, 'opus-monitor');
  assert.deepEqual(plain(alert.to), ['fable']);
  assert.equal(alert.metric, 'error_rate');
  assert.equal(alert.value, 0.031);
  assert.deepEqual(plain(alert.threshold), { max: 0.02 });
  assert.equal(alert.issue, 'I-001');
  const msg = single(added, (m) => m.type === 'report', 'report message');
  assert.equal(msg.from, 'opus-monitor');
  assert.deepEqual(plain(msg.to), ['fable'], 'breach reports go to the lead');
  assert.deepEqual(plain(msg.cc), ['you']);
  assert.equal(msg.report, row.report);
  assert.equal(msg.status, 'breach');
  assert.ok(eventsIn(added, 'watch_run').length >= 1, 'watch_run event');
  assert.ok(eventsIn(added, 'issue_created').length >= 1, 'issue_created event');

  const th = await store.thread(ref);
  assert.match(String(th.last_run), ISO_RE);
});

test('no duplicate issue while one is open or accepted; rejected ones do not suppress', async (t) => {
  const ctx = await watchCtx(t);
  const { store, ref } = ctx;
  await run(ctx, { metrics: { error_rate: 0.05, success_rate: 0.99 } });
  const second = await run(ctx, { metrics: { error_rate: 0.06, success_rate: 0.99 } });
  let issues = (await threadIssues(store, ref)).filter((x) => x.metric === 'error_rate');
  assert.equal(issues.length, 1, 'still one open error_rate issue');
  assert.deepEqual(plain(second.row.breaches), ['error_rate']);
  assert.equal(second.added.filter((m) => m.type === 'alert').length, 0, 'no second alert');
  const report = readReport(ctx, second.row);
  assert.equal(report.data.status, 'breach');
  assert.deepEqual(plain(report.data.opened), []);

  await fixWatchIssue(ctx, 'checkout/I-001', { done: false });
  await run(ctx, { metrics: { error_rate: 0.07, success_rate: 0.99 } });
  issues = (await threadIssues(store, ref)).filter((x) => x.metric === 'error_rate');
  assert.equal(issues.length, 1, 'an accepted issue also suppresses a new one');

  await run(ctx, { metrics: { error_rate: 0.01, success_rate: 0.5 } });
  let sr = (await threadIssues(store, ref)).filter((x) => x.metric === 'success_rate');
  assert.equal(sr.length, 1);
  await store.rejectIssue({ as: 'fable', issue: `checkout/${sr[0].id}`, reason: 'Load test traffic' });
  await run(ctx, { metrics: { error_rate: 0.01, success_rate: 0.5 } });
  sr = (await threadIssues(store, ref)).filter((x) => x.metric === 'success_rate');
  assert.equal(sr.length, 2, 'a rejected issue does not suppress a new breach issue');
});

test('accept onto a project thread → task → signoff → fixed; a passing run verifies the issue', async (t) => {
  const ctx = await watchCtx(t);
  const { store, ref } = ctx;
  await run(ctx, { metrics: { error_rate: 0.031, success_rate: 0.99 } });

  // Watch threads hold no tasks: the fix goes through a project thread's review gates.
  await expectError(() => store.acceptIssue({ as: 'fable', issue: 'checkout/I-001' }), 'usage', /--thread/);
  await expectError(() => store.createTask({ as: 'fable', ref, title: 'Hotfix' }), 'usage', /watch thread/);
  await expectError(() => store.createTask({ as: 'fable', ref, title: 'Hotfix', issue: 'I-001' }), 'usage', /watch thread/);
  const fix = await setupProject(ctx, { thread: 'sdk-rollback', title: 'SDK rollback' });
  await expectError(() => store.acceptIssue({ as: 'fable', issue: 'checkout/I-001', thread: fix }), 'conflict', /plan or later/);
  await driveTo(ctx, fix, 'plan');
  await store.acceptIssue({ as: 'fable', issue: 'checkout/I-001', action: 'Roll back the payment SDK', thread: fix });
  let iss = await store.issue('checkout/I-001');
  assert.equal(iss.status, 'accepted');
  assert.equal(iss.thread, 'checkout-health', 'the issue stays on its watch thread');
  const task = await store.task(`checkout/${iss.task}`);
  assert.equal(task.title, 'Roll back the payment SDK');
  assert.equal(task.issue, 'I-001');
  assert.equal(task.thread, 'sdk-rollback');
  assert.equal((await threadTasks(store, ref)).length, 0, 'no task on the watch thread');
  const acceptedEvent = (await store.messages(ref)).filter((m) => m.type === 'event' && m.event.kind === 'issue_status' && m.event.to === 'accepted').at(-1);
  assert.match(acceptedEvent.body, new RegExp(`→ ${task.id} on sdk-rollback`), 'the watch thread says where the fix task lives');

  await driveTo(ctx, fix, 'build');
  await completeTask(ctx, `checkout/${task.id}`);
  iss = await store.issue('checkout/I-001');
  assert.equal(iss.status, 'accepted', 'a done task is not yet a reviewed fix');
  assert.equal((await store.thread(fix)).phase, 'code_review');
  await driveTo(ctx, fix, 'signoff');
  assert.equal((await store.issue('checkout/I-001')).status, 'accepted');
  const s = await since(ctx, ref, () => driveTo(ctx, fix, 'done'));
  iss = await store.issue('checkout/I-001');
  assert.equal(iss.status, 'fixed', 'the signoff makes it fixed');
  assert.ok(eventsIn(s.added, 'issue_status').some((e) => e.event.issue === 'I-001' && e.event.to === 'fixed'), 'the issue_status event is posted in the watch thread');
  assert.equal((await store.validate()).errors.length, 0);

  const ok = await run(ctx, { metrics: { error_rate: 0.01, success_rate: 0.99 } });
  iss = await store.issue('checkout/I-001');
  assert.equal(iss.status, 'verified');
  assert.deepEqual(plain(ok.row.breaches), []);
  const report = readReport(ctx, ok.row);
  assert.equal(report.data.status, 'ok');
  assert.deepEqual(plain(report.data.verified), ['I-001']);
  assert.match(report.body, /I-001/);
  const msg = single(ok.added, (m) => m.type === 'report', 'report message');
  assert.deepEqual(plain(msg.to), [], 'ok reports address nobody');
  assert.deepEqual(plain(msg.cc), ['you']);
  assert.equal(msg.status, 'ok');
  assert.equal(ok.added.filter((m) => m.type === 'alert').length, 0);
  assert.ok(eventsIn(ok.added, 'issue_status').length >= 1, 'issue_status event for the verification');
});

test('a failing run on a fixed issue reopens it', async (t) => {
  const ctx = await watchCtx(t);
  const { store } = ctx;
  await run(ctx, { metrics: { error_rate: 0.031, success_rate: 0.99 } });
  await fixIssue(ctx, 'I-001');
  assert.equal((await store.issue('checkout/I-001')).status, 'fixed');
  const bad = await run(ctx, { metrics: { error_rate: 0.04, success_rate: 0.99 } });
  const iss = await store.issue('checkout/I-001');
  assert.equal(iss.status, 'open');
  assert.match(iss.body, /reopened/);
  assert.match(iss.body, /not deployed yet, defer the issue/, 'the reopen tells the lead a fix may not have shipped');
  const report = readReport(ctx, bad.row);
  assert.equal(report.data.status, 'breach');
  assert.ok(plain(report.data.reopened).includes('I-001'));
});

test('a metric missing from the run is reported as missing, not as a breach', async (t) => {
  const ctx = await watchCtx(t);
  const { store, ref } = ctx;
  const res = await run(ctx, { metrics: { error_rate: 0.01 } });
  assert.deepEqual(plain(res.row.breaches), []);
  assert.equal((await threadIssues(store, ref)).length, 0);
  const report = readReport(ctx, res.row);
  assert.equal(report.data.status, 'ok');
  const line = report.body.split('\n').find((l) => l.includes('success_rate'));
  assert.ok(line, 'the missing metric is listed in the report');
  assert.match(line, /missing/i);
  assert.equal(single(res.added, (m) => m.type === 'report', 'report').status, 'ok');
});

test('min thresholds and severity: > 50% relative overshoot is high, otherwise medium', async (t) => {
  const ctx = await watchCtx(t);
  const { store, ref } = ctx;
  const res = await run(ctx, { metrics: { error_rate: 0.025, success_rate: 0.4 } });
  assert.deepEqual(plain(res.row.breaches).sort(), ['error_rate', 'success_rate']);
  const issues = await threadIssues(store, ref);
  assert.equal(issues.find((x) => x.metric === 'error_rate').severity, 'medium', '0.025 vs max 0.02 is 25% over');
  assert.equal(issues.find((x) => x.metric === 'success_rate').severity, 'high', '0.4 vs min 0.98 is 59% under');
  const alerts = res.added.filter((m) => m.type === 'alert');
  assert.equal(alerts.length, 2);
  assert.deepEqual(plain(alerts.find((a) => a.metric === 'success_rate').threshold), { min: 0.98 });
});

test('paused threads refuse runs and are never due; resume restores both', async (t) => {
  const ctx = await watchCtx(t);
  const { store, ref } = ctx;
  let s = await since(ctx, ref, () => store.setWatchState({ as: 'fable', ref, state: 'paused' }));
  assert.equal((await store.thread(ref)).phase, 'paused');
  assert.ok(eventsIn(s.added, 'watch_state').length >= 1, 'watch_state event');
  await expectError(() => store.watchRun({ as: 'opus-monitor', ref, metrics: { error_rate: 0.01, success_rate: 0.99 } }));
  assert.equal((await store.metrics(ref)).length, 0);
  assert.ok(!dueIds(await store.watchDue()).includes('checkout-health'), 'paused threads are not due');

  s = await since(ctx, ref, () => store.setWatchState({ as: 'fable', ref, state: 'active' }));
  assert.equal((await store.thread(ref)).phase, 'active');
  assert.ok(eventsIn(s.added, 'watch_state').length >= 1);
  assert.ok(dueIds(await store.watchDue()).includes('checkout-health'));
  await run(ctx, { metrics: { error_rate: 0.01, success_rate: 0.99 } });
  assert.equal((await store.metrics(ref)).length, 1);
});

test('watchDue follows each cadence against the controllable clock', async (t) => {
  const ctx = await watchCtx(t);
  const { store, clock } = ctx;
  const twoHourly = await setupWatch(ctx, { thread: 'latency-watch', title: 'Latency', cadence: '2h' });
  const weekly = await setupWatch(ctx, { thread: 'weekly-watch', title: 'Weekly', cadence: 'weekly' });
  let due = dueIds(await store.watchDue());
  for (const id of ['checkout-health', 'latency-watch', 'weekly-watch']) assert.ok(due.includes(id), `${id} never ran → due`);

  clock.minutes(1);
  const metrics = { error_rate: 0.01, success_rate: 0.99 };
  for (const ref of [ctx.ref, twoHourly, weekly]) await store.watchRun({ as: 'opus-monitor', ref, metrics });
  due = dueIds(await store.watchDue());
  assert.deepEqual(due.filter((x) => ['checkout-health', 'latency-watch', 'weekly-watch'].includes(x)), [], 'just ran → nothing due');

  clock.minutes(60);
  assert.ok(!dueIds(await store.watchDue()).includes('latency-watch'), '1 h < 2 h');
  clock.minutes(61);
  due = dueIds(await store.watchDue());
  assert.ok(due.includes('latency-watch'), '2 h cadence due after 2 h 1 m');
  assert.ok(!due.includes('checkout-health'), 'daily not due after 2 h');
  clock.minutes(22 * 60);
  due = dueIds(await store.watchDue());
  assert.ok(due.includes('checkout-health'), 'daily due after 24 h 1 m');
  assert.ok(!due.includes('weekly-watch'), 'weekly not due after a day');
  clock.days(6);
  due = dueIds(await store.watchDue());
  assert.ok(due.includes('weekly-watch'), 'weekly due after 7 days');
});

test('run windows: default from = thread created then previous to; explicit windows are kept', async (t) => {
  const ctx = await watchCtx(t);
  const { store, ref } = ctx;
  const th = await store.thread(ref);
  const first = await run(ctx, { metrics: { error_rate: 0.01, success_rate: 0.99 } });
  assert.equal(first.row.window.from, th.created);
  ctx.clock.hours(6);
  const second = await run(ctx, { metrics: { error_rate: 0.01, success_rate: 0.99 } });
  assert.equal(second.row.window.from, first.row.window.to);
  assert.ok(second.row.window.to > first.row.window.to);
  const third = await run(ctx, {
    metrics: { error_rate: 0.01, success_rate: 0.99 }, from: '2026-01-01T00:00:00.000Z', to: '2026-01-02T00:00:00.000Z',
  });
  assert.equal(third.row.window.from, '2026-01-01T00:00:00.000Z');
  assert.equal(third.row.window.to, '2026-01-02T00:00:00.000Z');
});

test('non-numeric metric values are refused', async (t) => {
  const ctx = await watchCtx(t);
  const { store, ref } = ctx;
  await expectError(() => store.watchRun({ as: 'opus-monitor', ref, metrics: { error_rate: 'high', success_rate: 0.99 } }));
  await expectError(() => store.watchRun({ as: 'opus-monitor', ref, metrics: { error_rate: [0.01], success_rate: 0.99 } }));
  assert.equal((await store.metrics(ref)).length, 0);
  assert.equal((await threadIssues(store, ref)).length, 0);
});

test('--exec runs eval_cmd from the root and reads the last JSON object line ({metric: n} form)', async (t) => {
  const ctx = await watchCtx(t);
  const { store, root, ref } = ctx;
  const { cwdFile } = writeEvalScript(ctx, 'eval-flat.mjs', [
    'running checkout eval',
    JSON.stringify({ metrics: { error_rate: 0.9, success_rate: 0.1 } }),
    JSON.stringify({ error_rate: 0.01, success_rate: 0.99 }),
  ]);
  const res = await run(ctx, { exec: true });
  assert.deepEqual(plain(res.row.metrics), { error_rate: 0.01, success_rate: 0.99 });
  assert.deepEqual(plain(res.row.breaches), []);
  assert.equal(fs.realpathSync(fs.readFileSync(cwdFile, 'utf8')), root, 'eval_cmd runs with cwd = root');
  assert.equal((await threadIssues(store, ref)).length, 0);
});

test('--exec accepts the {metrics: {...}} form and breaches open issues', async (t) => {
  const ctx = await watchCtx(t);
  const { store, ref } = ctx;
  writeEvalScript(ctx, 'eval-nested.mjs', ['warming up', JSON.stringify({ metrics: { error_rate: 0.05, success_rate: 0.99 } })]);
  const res = await run(ctx, { exec: true });
  assert.deepEqual(plain(res.row.metrics), { error_rate: 0.05, success_rate: 0.99 });
  assert.deepEqual(plain(res.row.breaches), ['error_rate']);
  assert.equal((await threadIssues(store, ref)).length, 1);
});

test('--exec with non-numeric output is refused', async (t) => {
  const ctx = await watchCtx(t);
  const { store, ref } = ctx;
  writeEvalScript(ctx, 'eval-bad.mjs', [JSON.stringify({ error_rate: 'n/a', success_rate: 0.99 })]);
  await expectError(() => store.watchRun({ as: 'opus-monitor', ref, exec: true }));
  assert.equal((await store.metrics(ref)).length, 0);
});

test('CLI watch run --exec uses the team eval_cmd', async (t) => {
  const ctx = await watchCtx(t);
  const { store, ref } = ctx;
  writeEvalScript(ctx, 'eval-cli.mjs', [JSON.stringify({ error_rate: 0.012, success_rate: 0.991 })]);
  const res = runCli(['watch', 'run', 'checkout/checkout-health', '--exec', '--as', 'opus-monitor', '--json'], {
    root: ctx.root, env: { FACTORY_NOW: ctx.clock.hours(1).iso() },
  });
  assertExit(res, 0);
  res.json();
  const rows = await store.metrics(ref);
  assert.equal(rows.length, 1);
  assert.deepEqual(plain(rows[0].metrics), { error_rate: 0.012, success_rate: 0.991 });
});

test('manual verify: pass → verified, fail → open', async (t) => {
  const ctx = await watchCtx(t);
  const { store } = ctx;
  await run(ctx, { metrics: { error_rate: 0.05, success_rate: 0.5 } });
  await fixIssue(ctx, 'I-001');
  await fixIssue(ctx, 'I-002');
  await store.verifyIssue({ as: 'opus-monitor', issue: 'checkout/I-001', pass: true, note: 'Prod dashboard green' });
  await store.verifyIssue({ as: 'fable', issue: 'checkout/I-002', pass: false, note: 'Still low' });
  assert.equal((await store.issue('checkout/I-001')).status, 'verified');
  assert.equal((await store.issue('checkout/I-002')).status, 'open');
  assert.match((await store.issue('checkout/I-001')).body, /Prod dashboard green/);
});

test('review, respond and advance are errors on watch threads', async (t) => {
  const ctx = await watchCtx(t);
  const { store, ref } = ctx;
  await expectError(() => store.review({ as: 'you', ref, verdict: 'approve', points: [] }));
  await expectError(() => store.review({ as: 'openai', ref, verdict: 'approve', points: [] }));
  await expectError(() => store.respond({ as: 'fable', ref, stances: [] }));
  await expectError(() => store.advance({ as: 'fable', ref }));
  assert.equal((await store.thread(ref)).phase, 'active');
  assert.equal((await threadTasks(store, ref)).length, 0);
});

test('D3: an open or accepted issue whose metric recovered without a verified fix is listed for triage; its status does not change', async (t) => {
  const ctx = await watchCtx(t);
  const { store, ref } = ctx;
  await run(ctx, { metrics: { error_rate: 0.05, success_rate: 0.5 } });
  const issues = await threadIssues(store, ref);
  const err = issues.find((x) => x.metric === 'error_rate');
  const sr = issues.find((x) => x.metric === 'success_rate');
  await fixWatchIssue(ctx, `checkout/${sr.id}`, { done: false });
  assert.equal((await store.issue(`checkout/${sr.id}`)).status, 'accepted');

  const ok = await run(ctx, { metrics: { error_rate: 0.01, success_rate: 0.99 } });
  assert.equal((await store.issue(`checkout/${err.id}`)).status, 'open', 'no status change');
  assert.equal((await store.issue(`checkout/${sr.id}`)).status, 'accepted', 'no status change');
  const report = readReport(ctx, ok.row);
  assert.deepEqual(plain(report.data.recovered).sort(), [err.id, sr.id].sort());
  assert.match(report.body, /## Recovered without a verified fix — triage/);
  for (const id of [err.id, sr.id]) {
    const line = report.body.split('\n').find((l) => l.startsWith(`- ${id} `));
    assert.ok(line && /recovered without a verified fix — triage/.test(line), `${id} is listed: ${line}`);
  }
  const msg = single(ok.added, (m) => m.type === 'report', 'report');
  assert.match(msg.body, /recovered without a verified fix — triage/);
  assert.equal(eventsIn(ok.added, 'issue_status').length, 0, 'no issue changed');

  // Still breaching: nothing is listed as recovered.
  const bad = await run(ctx, { metrics: { error_rate: 0.09, success_rate: 0.99 } });
  assert.deepEqual(plain(readReport(ctx, bad.row).data.recovered), [sr.id]);

  // The CLI prints them.
  ctx.clock.hours(1);
  const r = runCli(['watch', 'run', ref, '--metrics', '{"error_rate":0.01,"success_rate":0.99}', '--as', 'opus-monitor'], { root: ctx.root, env: { FACTORY_NOW: ctx.clock.iso() } });
  assertExit(r, 0);
  assert.match(r.stdout, new RegExp(`~ ${err.id} \\(open\\) recovered without a verified fix — triage`));
  assert.deepEqual((await store.validate()).errors, []);
});

test('eval_cmd: the last JSON line must parse; NaN after a valid line is refused, not replaced by the earlier line', async (t) => {
  const ctx = await watchCtx(t);
  const { store, ref } = ctx;
  writeEvalScript(ctx, 'eval-nan.mjs', [JSON.stringify({ error_rate: 0.01, success_rate: 0.99 }), '{"error_rate": NaN, "success_rate": 0.99}']);
  const err = await expectError(() => store.watchRun({ as: 'opus-monitor', ref, exec: true }), 'invalid', /NaN/);
  assert.match(err.message, /last JSON line/);
  assert.equal((await store.metrics(ref)).length, 0, 'no metrics row');
});

test('a good run never verifies a watch issue whose fix task is done but not yet signed off', async (t) => {
  const ctx = await watchCtx(t);
  const { store, ref } = ctx;
  await run(ctx, { metrics: { error_rate: 0.05, success_rate: 0.99 } });
  const [issue] = await threadIssues(store, ref);
  const { task } = await fixWatchIssue(ctx, `checkout/${issue.id}`, { done: false });
  await completeTask(ctx, `checkout/${task.id}`);
  await run(ctx, { metrics: { error_rate: 0.01, success_rate: 0.99 } });
  assert.equal((await store.issue(`checkout/${issue.id}`)).status, 'accepted', 'a done task before signoff is not verified by a good run');
});
