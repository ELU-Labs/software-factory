// Jump to (Cmd-K): a box that finds a thread, team or view as you type; arrows pick, Enter goes,
// Esc closes.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import { fileURLToPath } from 'node:url';
import { openStore } from '../lib/store.mjs';
import { runCli, assertExit, makeTempDir } from './helpers.mjs';

const UI_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../tools/factory-ui');

/** A page with just enough DOM for the jump box: elements by id, created when HTML that names them is set. */
function loadPage() {
  const byId = new Map();
  const listeners = {};
  const el = (id) => {
    let html = '';
    const node = {
      id,
      value: '',
      _html: undefined,
      focused: false,
      focus() {
        node.focused = true;
      },
      get firstChild() {
        return html ? {} : null;
      },
      get innerHTML() {
        return html;
      },
      set innerHTML(s) {
        html = s;
        for (const [, child] of s.matchAll(/\bid="([^"]+)"/g)) if (!byId.has(child)) byId.set(child, el(child));
      },
      appendChild(child) {
        byId.set(child.id, child);
      },
    };
    return node;
  };
  const document = {
    title: '',
    visibilityState: 'visible',
    hasFocus: () => true,
    documentElement: { dataset: {} },
    body: el('body'),
    createElement: () => el(''),
    querySelector: (sel) => (sel.startsWith('#') ? byId.get(sel.slice(1)) || null : null),
    querySelectorAll: () => [],
    addEventListener: (type, fn) => (listeners[type] ||= []).push(fn),
  };
  document.body.appendChild = (child) => byId.set(child.id, child);
  const location = { hash: '#/board' };
  const hooks = {};
  const sandbox = {
    __factoryUiTest: hooks,
    document,
    window: { addEventListener: () => {} },
    location,
    navigator: { platform: 'MacIntel', userAgent: 'test' },
    localStorage: { getItem: () => null, setItem: () => {} },
    setInterval: () => {},
    clearInterval: () => {},
    setTimeout,
    clearTimeout,
  };
  vm.createContext(sandbox);
  vm.runInContext(fs.readFileSync(path.join(UI_DIR, 'app.js'), 'utf8'), sandbox, { filename: 'app.js' });
  const fire = (type, e) => {
    const ev = { preventDefault() {}, shiftKey: false, altKey: false, metaKey: false, ctrlKey: false, target: {}, ...e };
    for (const fn of listeners[type] || []) fn(ev);
  };
  return { hooks, byId, fire, location };
}

function factory(t) {
  const root = makeTempDir('factory-jump-');
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  assertExit(runCli(['init'], { root }), 0);
  const t0 = Date.now() + 60000;
  let n = 0;
  const store = openStore({ root, now: () => t0 + 1000 * n++ });
  store.createThread({ as: 'you', ref: 'web/retry', title: 'Retry payments', kind: 'project' });
  store.createThread({ as: 'you', ref: 'web/checkout', title: 'Checkout copy', kind: 'project' });
  store.createThread({ as: 'you', ref: 'api/payments-audit', title: 'Audit payment hooks', kind: 'project' });
  return store;
}

test('jumpItems: every word must match; titles that start with the query come first; teams and views are found too', (t) => {
  const store = factory(t);
  const { hooks } = loadPage();
  hooks.state.board = store.board();
  const titles = (q) => [...hooks.jumpItems(q).map((x) => x.title)];
  assert.deepEqual(titles('pay'), ['Audit payment hooks', 'Retry payments'], 'the latest first among equals');
  assert.deepEqual(titles('retry'), ['Retry payments'], 'a title starting with the query ranks first');
  assert.deepEqual(titles('web pay'), ['Retry payments'], 'words match the team too');
  assert.deepEqual(titles('payments retry'), ['Retry payments'], 'in any order');
  assert.deepEqual(titles('inbox'), ['Inbox']);
  assert.deepEqual([...hooks.jumpItems('api').map((x) => [...[x.title, x.href]])], [['Api', '#/board'], ['Audit payment hooks', '#/t/api/payments-audit']]);
  assert.deepEqual(titles('zzz'), []);
});

test('jumpItems with no query: threads waiting on you first, then the latest, then the views', (t) => {
  const store = factory(t);
  store.post({ as: 'fable', ref: 'web/checkout', type: 'question', to: ['you'], body: 'Which tone?' });
  const { hooks } = loadPage();
  hooks.state.board = store.board();
  const items = hooks.jumpItems('');
  assert.equal(items[0].title, 'Checkout copy', 'waits on you');
  assert.ok(items.length <= 9);
  assert.deepEqual([...items.slice(-3).map((x) => x.title)], ['Board', 'Tasks', 'Inbox']);
});

test('Cmd-K opens the box; typing filters; arrows pick; Enter goes there and closes it; Esc closes it', (t) => {
  const store = factory(t);
  const { hooks, byId, fire, location } = loadPage();
  hooks.state.board = store.board();
  fire('keydown', { key: 'k', metaKey: true });
  assert.ok(hooks.state.jump, 'open');
  assert.ok(byId.get('jump-input').focused);
  const input = byId.get('jump-input');
  input.value = 'pay';
  fire('input', { target: input });
  assert.equal((byId.get('jump-list').innerHTML.match(/data-act="jump-go"/g) || []).length, 2);
  fire('keydown', { key: 'ArrowDown', target: input });
  assert.match(byId.get('jump-list').innerHTML, /<a class="jump-item on" href="#\/t\/web\/retry"/);
  fire('keydown', { key: 'Enter', target: input });
  assert.equal(location.hash, '#/t/web/retry');
  assert.equal(hooks.state.jump, null);
  assert.equal(byId.get('jump').innerHTML, '');

  fire('keydown', { key: 'k', metaKey: true });
  fire('keydown', { key: 'Escape', target: byId.get('jump-input') });
  assert.equal(hooks.state.jump, null);
  fire('keydown', { key: 'k', ctrlKey: true });
  assert.equal(hooks.state.jump, null, 'on a Mac it is Cmd-K, not Ctrl-K');
});
