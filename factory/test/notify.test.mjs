// What waits on you reaches you: the tab title counts it, a desktop notification announces what is
// new (opt-in, only while the board is not in front), and threads with activity you have not read
// show an unread dot in the sidebar.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import { fileURLToPath } from 'node:url';
import { openStore } from '../lib/store.mjs';
import { runCli, assertExit, makeTempDir } from './helpers.mjs';

const UI_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../tools/factory-ui');

function loadPage({ permission = 'granted', visible = false } = {}) {
  const noop = () => {};
  const hooks = {};
  const shown = [];
  class FakeNotification {
    static permission = permission;
    constructor(title, opts) {
      shown.push({ title, ...opts });
    }
    close() {}
  }
  const sandbox = {
    __factoryUiTest: hooks,
    Notification: FakeNotification,
    document: { addEventListener: noop, querySelector: () => null, querySelectorAll: () => [], documentElement: { dataset: {} }, title: '', visibilityState: visible ? 'visible' : 'hidden', hasFocus: () => visible },
    window: { addEventListener: noop, isSecureContext: true },
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
  return { hooks, shown, document: sandbox.document };
}

function factory(t) {
  const root = makeTempDir('factory-notify-');
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  assertExit(runCli(['init'], { root }), 0);
  // A minute ahead of init, so the Triage thread it made is older than anything here.
  const t0 = Date.now() + 60000;
  let n = 0;
  const store = openStore({ root, now: () => t0 + 1000 * n++ });
  store.createThread({ as: 'fable', ref: 'web/retry', title: 'Retry payments', kind: 'project' });
  return store;
}

test('the tab title counts what waits on you; a notification goes out only for what is new since the last refresh', (t) => {
  const store = factory(t);
  const { hooks, shown, document } = loadPage();
  hooks.state.notify = true;
  store.post({ as: 'fable', ref: 'web/retry', type: 'question', to: ['you'], body: 'Which card networks?' });
  hooks.state.board = store.board();
  hooks.notifyWaiting();
  const backlog = hooks.waitingOnYou().length;
  assert.equal(backlog, 1);
  assert.equal(document.title, '(1) Software Factory');
  assert.equal(shown.length, 0, 'the backlog at page load is not news');

  store.post({ as: 'fable', ref: 'web/retry', type: 'question', to: ['you'], body: 'Should retries stop after **two** declines?' });
  hooks.state.board = store.board();
  hooks.notifyWaiting();
  assert.equal(shown.length, 1);
  assert.equal(shown[0].title, 'Fable · Retry payments');
  assert.equal(shown[0].body, 'Should retries stop after two declines?');
  assert.equal(document.title, `(${backlog + 1}) Software Factory`);
  hooks.notifyWaiting();
  assert.equal(shown.length, 1, 'the same item never notifies twice');
});

test('no notification while the board is in front, before you turn them on, or when the browser blocks them', (t) => {
  for (const [opts, on] of [[{ visible: true }, true], [{}, false], [{ permission: 'denied' }, true]]) {
    const store = factory(t);
    const { hooks, shown, document } = loadPage(opts);
    hooks.state.notify = on;
    hooks.state.board = store.board();
    hooks.notifyWaiting();
    store.post({ as: 'fable', ref: 'web/retry', type: 'question', to: ['you'], body: 'One more?' });
    hooks.state.board = store.board();
    hooks.notifyWaiting();
    assert.equal(shown.length, 0, JSON.stringify(opts));
    assert.match(document.title, /^\(\d+\) Software Factory$/, 'the title still counts');
  }
});

test('many new items: two notifications, then one that counts the rest', (t) => {
  const store = factory(t);
  const { hooks, shown } = loadPage();
  hooks.state.notify = true;
  hooks.state.board = store.board();
  hooks.notifyWaiting();
  for (const q of ['One?', 'Two?', 'Three?', 'Four?']) store.post({ as: 'fable', ref: 'web/retry', type: 'question', to: ['you'], body: q });
  hooks.state.board = store.board();
  hooks.notifyWaiting();
  assert.deepEqual(shown.map((x) => x.body), ['One?', 'Two?', '2 more waiting on you']);
});

test('unread: activity after your last look shows a dot in the sidebar; reading the thread clears it; your own posts never count', (t) => {
  const store = factory(t);
  const { hooks } = loadPage();
  hooks.state.board = store.board();
  hooks.state.route = { name: 'board' };
  hooks.state.seenSince = hooks.state.board.generated;
  const th = () => hooks.state.board.teams.find((x) => x.id === 'web').threads[0];
  assert.equal(hooks.isUnread(th()), false, 'what was there when tracking began is read');

  store.post({ as: 'fable', ref: 'web/retry', type: 'note', body: 'Started the brief.' });
  hooks.state.board = store.board();
  assert.equal(hooks.isUnread(th()), true);
  assert.match(String(hooks.railTeams()), /class="titem unread"[^>]*title="Retry payments \(new since you last looked\)"[\s\S]*<span class="unread-dot" aria-label="unread"><\/span>/);

  hooks.markSeen(store.threadView('web/retry'));
  assert.equal(hooks.isUnread(th()), false);
  assert.doesNotMatch(String(hooks.railTeams()), /unread-dot/);

  store.post({ as: 'you', ref: 'web/retry', type: 'note', body: 'Thanks.' });
  hooks.state.board = store.board();
  assert.equal(hooks.isUnread(th()), false, 'your own message is not news');
});
