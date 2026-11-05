// What agent runs cost: the autopilot's ledger (teams/.autopilot/costs.jsonl) totalled per thread and
// for today, beside Running in the board's sidebar and in each thread's Details panel.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import { fileURLToPath } from 'node:url';
import { openStore, AUTOPILOT_DIR, COSTS_FILE } from '../lib/store.mjs';
import { ownCost, repairCostLedger } from '../lib/autopilot.mjs';
import { runCli, assertExit, makeTempDir } from './helpers.mjs';

const UI_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../tools/factory-ui');

// Noon today and 9 am yesterday on this machine's clock, so "today" holds in every time zone.
const NOW = new Date(2026, 10, 4, 12, 0, 0);
const at = (days, hour) => new Date(2026, 10, 4 + days, hour, 0, 0).toISOString();

function ledgerRoot(t, lines) {
  const root = makeTempDir('factory-costs-');
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  assertExit(runCli(['init'], { root }), 0);
  assertExit(runCli(['thread', 'new', 'web/retry', '--title', 'Retry', '--as', 'you'], { root }), 0);
  fs.mkdirSync(path.join(root, 'teams', AUTOPILOT_DIR), { recursive: true });
  fs.writeFileSync(path.join(root, 'teams', AUTOPILOT_DIR, COSTS_FILE), lines.map((l) => (typeof l === 'string' ? l : JSON.stringify(l))).join('\n') + '\n');
  return { root, store: openStore({ root, now: () => NOW }) };
}

test('costs(): each thread\'s total and today\'s; runs without a cost are counted, not priced; bad lines are skipped', (t) => {
  const { store } = ledgerRoot(t, [
    { at: at(-1, 9), member: 'fable', ref: 'web/retry', outcome: 'answered', cost_usd: 2.25 },
    { at: at(0, 9), member: 'fable', ref: 'web/retry', outcome: 'answered', cost_usd: 1.5 },
    { at: at(0, 10), member: 'openai', ref: 'web/retry', outcome: 'answered', cost_usd: null },
    { at: at(0, 11), member: 'opus-solo', ref: 'triage/triage', outcome: 'failed', cost_usd: 0.255 },
    'not json',
    { at: 'yesterday', ref: 'web/retry', cost_usd: 9 },
    { at: at(0, 11), ref: 'web/retry', cost_usd: -4 },
  ]);
  const c = store.costs();
  assert.deepEqual(c.by_thread['web/retry'], { usd: 3.75, runs: 4, unpriced: 2 });
  assert.deepEqual(c.by_thread['triage/triage'], { usd: 0.255, runs: 1, unpriced: 0 });
  assert.deepEqual(c.today, { usd: 1.755, runs: 4, unpriced: 2 });
  assert.equal(c.since, at(-1, 9));
  assert.deepEqual(store.threadView('web/retry').cost, c.by_thread['web/retry']);
  assert.deepEqual(store.board().costs, { today: c.today, since: c.since });
});

test('costs(): no ledger yet is zero, and a thread with no runs has no cost', (t) => {
  const root = makeTempDir('factory-costs-');
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  assertExit(runCli(['init'], { root }), 0);
  const store = openStore({ root });
  assert.deepEqual(store.costs(), { today: { usd: 0, runs: 0, unpriced: 0 }, by_thread: {}, since: null });
  assert.equal(store.threadView('triage/triage').cost, null);
});

test('the Details panel shows a thread\'s cost, and what it covers on hover', (t) => {
  const { store } = ledgerRoot(t, [
    { at: at(0, 9), member: 'fable', ref: 'web/retry', outcome: 'answered', cost_usd: 1.5 },
    { at: at(0, 10), member: 'openai', ref: 'web/retry', outcome: 'answered', cost_usd: null },
  ]);
  const noop = () => {};
  const hooks = {};
  const sandbox = {
    __factoryUiTest: hooks,
    document: { addEventListener: noop, querySelector: () => null, querySelectorAll: () => [], documentElement: { dataset: {} } },
    window: { addEventListener: noop },
    location: { hash: '' },
    navigator: { platform: 'test', userAgent: 'test' },
    localStorage: { getItem: () => null, setItem: noop },
    setInterval: noop,
    clearInterval: noop,
    setTimeout,
    clearTimeout,
  };
  vm.createContext(sandbox);
  vm.runInContext(fs.readFileSync(path.join(UI_DIR, 'app.js'), 'utf8'), sandbox, { filename: 'app.js' });
  hooks.state.board = store.board();
  const side = [].concat(hooks.sidePanel(store.threadView('web/retry'))).map(String).join('');
  assert.match(side, /<dt>Cost<\/dt><dd class="mono" title="2 agent runs; 1 reported no cost \(Codex runs report none\)\. Each run[^"]*own cost[^"]*">\$1\.50 · 2 runs <span class="faint">at API prices<\/span><\/dd>/);
  const solo = [].concat(hooks.sidePanel(store.threadView('triage/triage'))).map(String).join('');
  assert.match(solo, /<dt>Cost<\/dt><dd class="mono" title="">no runs yet<\/dd>/);
  assert.equal(hooks.usd(0.255), '$0.26');
  // Today's total sits under Running in the sidebar, and says what it is.
  assert.match(String(hooks.railRunning()), /<div class="run-cost" title="What today[^"]*agent runs would cost at API prices: [^"]*">\$[\d.]+ today at API prices<\/div>/);
});

// Claude Code reports a resumed session's running total; these logs are three runs of one session (10, then 12.5, then 13 in all).
const S1 = '11111111-1111-4111-8111-111111111111';
const S2 = '22222222-2222-4222-8222-222222222222';
const S3 = '33333333-3333-4333-8333-333333333333';
function runLogs(root, logs) {
  const dir = path.join(root, 'teams', AUTOPILOT_DIR, 'runs');
  fs.mkdirSync(dir, { recursive: true });
  for (const [name, session, total] of logs) {
    const lines = [{ type: 'system', subtype: 'init', session_id: session }];
    if (total != null) lines.push({ type: 'result', subtype: 'success', session_id: session, total_cost_usd: total, result: 'Done.' });
    fs.writeFileSync(path.join(dir, name), lines.map((l) => JSON.stringify(l)).join('\n') + '\n');
  }
}

test('ledger lines an earlier autopilot wrote with the session total are corrected to each run\'s own cost', (t) => {
  const root = makeTempDir('factory-costs-');
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  runLogs(root, [
    ['20261104T090000.000Z-aaaa-fable.log', S1, 10],
    ['20261104T100000.000Z-bbbb-fable.log', S1, 12.5],
    ['20261104T103000.000Z-dddd-opus-solo.log', S2, 3],
    ['20261104T110000.000Z-cccc-fable.log', S1, 13],
    ['20261104T110000.000Z-ffff-openai.log', 'codex-thread', null],
  ]);
  const old = [
    { at: '2026-11-04T09:05:00.000Z', member: 'fable', ref: 'web/retry', outcome: 'answered', cost_usd: 10 },
    { at: '2026-11-04T10:05:00.000Z', member: 'fable', ref: 'web/retry', outcome: 'answered', cost_usd: 12.5 },
    { at: '2026-11-04T10:35:00.000Z', member: 'opus-solo', ref: 'triage/triage', outcome: 'answered', cost_usd: 3 },
    { at: '2026-11-04T11:05:00.000Z', member: 'fable', ref: 'web/retry', outcome: 'answered', cost_usd: 13 },
    { at: '2026-11-04T11:06:00.000Z', member: 'openai', ref: 'web/retry', outcome: 'answered', cost_usd: null },
    { at: '2026-11-04T11:07:00.000Z', member: 'fable', ref: 'web/other', outcome: 'answered', cost_usd: 99 },
  ];
  const file = path.join(root, 'teams', AUTOPILOT_DIR, COSTS_FILE);
  fs.writeFileSync(file, [...old.map((l) => JSON.stringify(l)), 'not json'].join('\n') + '\n');
  const last = { ended_at: '2026-11-04T11:05:00.000Z', outcome: 'answered', cost_usd: 13 };
  // web/old's latest run predates the ledger: it is priced from the logs alone.
  const older = { ended_at: '2026-11-04T10:02:00.000Z', outcome: 'answered', cost_usd: 12.5, restarts: 0 };
  const members = { fable: { last, by_thread: { 'web/retry': { ...last, restarts: 0 }, 'web/old': older } }, openai: { last: null, by_thread: {} } };

  assert.equal(repairCostLedger(root, members), 2, 'the two resumed runs were counted with the session total');
  const rows = fs.readFileSync(file, 'utf8').trim().split('\n');
  assert.equal(rows.at(-1), 'not json', 'a line that does not parse is kept as it was');
  assert.deepEqual(rows.slice(0, -1).map((l) => JSON.parse(l)).map((x) => [x.member, x.cost_usd, x.session, x.session_usd]), [
    ['fable', 10, S1, 10],
    ['fable', 2.5, S1, 12.5],
    ['opus-solo', 3, S2, 3],
    ['fable', 0.5, S1, 13],
    ['openai', null, null, null],
    ['fable', 99, null, null], // its log is gone: left as it was
  ]);
  assert.equal(members.fable.last.cost_usd, 0.5, 'the member\'s last run shows its own cost too');
  assert.deepEqual(members.fable.by_thread['web/retry'], { ...last, cost_usd: 0.5, restarts: 0 });
  assert.deepEqual(members.fable.by_thread['web/old'], { ...older, cost_usd: 2.5 });
  const before = fs.readFileSync(file, 'utf8');
  assert.equal(repairCostLedger(root, members), 0, 'corrected lines are not corrected again');
  assert.equal(fs.readFileSync(file, 'utf8'), before);
});

test('a run\'s own cost: its session total less the total after the session\'s previous run', (t) => {
  const root = makeTempDir('factory-costs-');
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  runLogs(root, [['20261104T080000.000Z-aaaa-fable.log', S3, 7]]);
  fs.writeFileSync(path.join(root, 'teams', AUTOPILOT_DIR, COSTS_FILE), `${JSON.stringify({ at: '2026-11-04T10:05:00.000Z', member: 'fable', ref: 'web/retry', outcome: 'answered', cost_usd: 2.5, session: S1, session_usd: 12.5 })}\n`);
  const log = 'teams/.autopilot/runs/20261104T120000.000Z-eeee-fable.log';
  assert.equal(ownCost(root, { total: 14.25, session: S1, resumed: true, log }), 1.75, 'from the ledger');
  assert.equal(ownCost(root, { total: 9, session: S3, resumed: true, log }), 2, 'from the previous run\'s log when the ledger has none');
  assert.equal(ownCost(root, { total: 4, session: S2, resumed: false, log }), 4, 'a new session costs what it reports');
  assert.equal(ownCost(root, { total: 50, session: S2, resumed: true, log }), null, 'a resumed session with no earlier total is not counted whole');
  assert.equal(ownCost(root, { total: 3, session: S1, resumed: true, log }), 3, 'a total below the last one started over');
  assert.equal(ownCost(root, { total: null, session: S1, resumed: true, log }), null, 'a run that reports no cost (Codex)');
});
