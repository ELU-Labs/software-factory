// The Triage thread a new factory starts with (`factory init`), and the board's
// observability offer on it.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import { fileURLToPath } from 'node:url';
import { openStore, TRIAGE_REF } from '../lib/store.mjs';
import { runCli, assertExit, makeTempDir } from './helpers.mjs';

const UI_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../tools/factory-ui');

function freshRoot(t) {
  const root = makeTempDir('factory-triage-');
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  return root;
}

function loadPage() {
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
  return hooks;
}

test('init starts a new factory with the Triage thread: single-agent, with instructions, and no turn for anyone', async (t) => {
  const root = freshRoot(t);
  const r = runCli(['init'], { root });
  assertExit(r, 0);
  assert.match(r.stdout, /\+ teams\/triage\/threads\/triage\.md/);
  const store = openStore({ root });
  const th = store.thread(TRIAGE_REF);
  assert.equal(th.kind, 'solo');
  assert.equal(th.owner, 'opus-solo');
  assert.equal(th.title, 'Triage');
  assert.match(th.body, /## Instructions\n\nFor each bug report, error or stack trace the owner posts:/);
  assert.match(runCli(['turns', TRIAGE_REF], { root }).stdout, /No open turns/, 'nothing starts until the owner posts');
  assertExit(runCli(['validate'], { root }), 0);
  // Idempotent: a second init leaves it alone and adds nothing.
  const again = runCli(['init'], { root });
  assertExit(again, 0);
  assert.match(again.stdout, /already initialised/);
  assert.deepEqual(store.threads().map((x) => `${x.team}/${x.id}`), [TRIAGE_REF]);
});

test('init adds no Triage thread to a factory that has teams, or whose Triage team was archived', async (t) => {
  const root = freshRoot(t);
  openStore({ root }).init();
  assertExit(runCli(['thread', 'new', 'checkout/retry', '--title', 'Retry', '--as', 'you'], { root }), 0);
  assertExit(runCli(['init'], { root }), 0);
  assert.equal(fs.existsSync(path.join(root, 'teams', 'triage')), false, 'a factory in use gets no new thread');

  const other = freshRoot(t);
  assertExit(runCli(['init'], { root: other }), 0);
  assertExit(runCli(['team', 'archive', 'triage', '--as', 'you'], { root: other }), 0);
  assertExit(runCli(['init'], { root: other }), 0);
  assert.equal(fs.existsSync(path.join(other, 'teams', 'triage')), false, 'an archived Triage team stays archived');
});

test('the board offers live product observability on the Triage thread only, until the owner answers', async (t) => {
  const root = freshRoot(t);
  assertExit(runCli(['init'], { root }), 0);
  assertExit(runCli(['thread', 'new', 'checkout/retry', '--title', 'Retry', '--as', 'you'], { root }), 0);
  const store = openStore({ root });
  const page = loadPage();
  const card = String(page.offerCard(store.threadView(TRIAGE_REF)));
  assert.match(card, /Want live product observability\?/);
  assert.match(card, /<a class="btn btn-primary sm" href="https:\/\/elu\.dev\/promo" target="_blank" rel="noopener" data-act="offer" data-choice="yes">Yes<\/a>/);
  assert.match(card, /data-act="offer" data-choice="no">No</);
  assert.equal(String(page.offerCard(store.threadView('checkout/retry'))), '', 'not on other threads');
  for (const answer of ['yes', 'no']) {
    page.state.offer = answer;
    assert.equal(String(page.offerCard(store.threadView(TRIAGE_REF))), '', `gone after ${answer}`);
  }
});
