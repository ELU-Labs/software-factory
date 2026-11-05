// Continue in terminal: each agent's saved session on a thread, with the command that resumes it
// (Claude Code or Codex), in the thread view and its Details panel.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import { fileURLToPath } from 'node:url';
import { openStore, AUTOPILOT_DIR } from '../lib/store.mjs';
import { runCli, assertExit, makeTempDir } from './helpers.mjs';

const UI_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../tools/factory-ui');
const A = '0a1b2c3d-1111-4222-8333-444455556666';
const B = '01a1a50f-e617-76f3-9f72-22f4e7e20986';
const C = '9f8e7d6c-5b4a-4321-8765-0123456789ab';

function root(t, sessions) {
  const dir = path.join(makeTempDir('factory-resume-'), 'my repo');
  fs.mkdirSync(dir);
  t.after(() => fs.rmSync(path.dirname(dir), { recursive: true, force: true }));
  assertExit(runCli(['init'], { root: dir }), 0);
  const store = openStore({ root: dir });
  store.createThread({ as: 'you', ref: 'web/retry', title: 'Retry', kind: 'project' });
  store.createThread({ as: 'you', ref: 'web/codex-led', title: 'Codex led', kind: 'project', roles: { lead: { model: 'gpt-6.1-sol' } } });
  fs.mkdirSync(path.join(dir, 'teams', AUTOPILOT_DIR), { recursive: true });
  fs.writeFileSync(path.join(dir, 'teams', AUTOPILOT_DIR, 'sessions.json'), JSON.stringify(sessions));
  return { dir, store };
}

test('threadSessions: a Claude agent resumes with claude --resume, Codex with codex resume, both from the repo root (quoted)', (t) => {
  const { dir, store } = root(t, {
    fable: { 'web/retry': A, 'web/codex-led': C },
    openai: { 'web/retry': B },
    'opus-solo': { 'triage/triage': C },
    ghost: { 'web/retry': A },
    grok: { 'web/retry': 'not-a-session; rm -rf ~' },
  });
  const q = `'${dir}'`;
  assert.deepEqual(store.threadSessions('web/retry'), [
    { member: 'fable', session: A, cli: 'claude', command: `cd ${q} && claude --resume ${A}` },
    { member: 'openai', session: B, cli: 'codex', command: `cd ${q} && codex resume ${B}` },
  ], 'no session for a member off the roster, or an id that is not a session');
  assert.deepEqual(store.threadSessions('web/codex-led').map((s) => [s.member, s.cli]), [['fable', 'codex']], 'a lead on an OpenAI model runs on Codex');
  assert.deepEqual(store.threadSessions('triage/triage').map((s) => s.command), [`cd ${q} && claude --resume ${C}`]);
  assert.deepEqual(store.threadView('web/retry').sessions, store.threadSessions('web/retry'));
});

test('threadSessions: none before the autopilot saved any', (t) => {
  const dir = makeTempDir('factory-resume-');
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  assertExit(runCli(['init'], { root: dir }), 0);
  assert.deepEqual(openStore({ root: dir }).threadView('triage/triage').sessions, []);
});

test('the Details panel offers each session\'s command to copy, except while that agent runs on the thread', (t) => {
  const { store } = root(t, { fable: { 'web/retry': A }, openai: { 'web/retry': B } });
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
  const v = store.threadView('web/retry');
  let side = [].concat(hooks.sidePanel(v)).map(String).join('');
  assert.match(side, /<h2>Continue in terminal<\/h2>/);
  const cmd = v.sessions[0].command.replace(/&/g, '&amp;').replace(/'/g, '&#39;');
  assert.ok(side.includes(`data-act="copy-resume" data-cmd="${cmd}"`), side);
  assert.equal((side.match(/data-act="copy-resume"/g) || []).length, 2);
  // The autopilot running fable on this thread: its row says so instead.
  v.autopilot = { alive: true, members: { fable: { runs: [{ ref: 'web/retry', pid: 1, started_at: new Date().toISOString() }] } } };
  side = [].concat(hooks.sidePanel(v)).map(String).join('');
  assert.equal((side.match(/data-act="copy-resume"/g) || []).length, 1);
  assert.match(side, /running now/);
  // No sessions: no card.
  v.sessions = [];
  assert.doesNotMatch([].concat(hooks.sidePanel(v)).map(String).join(''), /Continue in terminal/);
});
