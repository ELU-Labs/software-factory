// What agent runs cost: the autopilot's ledger (teams/.autopilot/costs.jsonl) totalled per thread and
// for today, beside Running in the board's sidebar and in each thread's Details panel.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import { fileURLToPath } from 'node:url';
import { openStore, AUTOPILOT_DIR, COSTS_FILE } from '../lib/store.mjs';
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
  assert.match(side, /<dt>Cost<\/dt><dd class="mono" title="2 agent runs; 1 reported no cost \(Codex runs report none\)">\$1\.50 · 2 runs<\/dd>/);
  const solo = [].concat(hooks.sidePanel(store.threadView('triage/triage'))).map(String).join('');
  assert.match(solo, /<dt>Cost<\/dt><dd class="mono" title="">no runs yet<\/dd>/);
  assert.equal(hooks.usd(0.255), '$0.26');
  // Today's total sits beside Running in the sidebar (the footer has no room for it).
  assert.match(String(hooks.railRunning()), /<span class="run-cost" title="What agent runs cost today: [^"]*">\$[\d.]+ today<\/span><\/div>/);
});
