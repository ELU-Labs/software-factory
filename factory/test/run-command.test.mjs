// Copy and Run on a command a message shows: the board renders both buttons on a fenced shell block, and
// Run opens a terminal window in the repo folder for a block that is really in that message.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import { fileURLToPath } from 'node:url';
import { openStore } from '../lib/store.mjs';
import { startServer, terminalLauncher } from '../../tools/factory-ui/server.mjs';
import { runCli, assertExit, makeTempDir } from './helpers.mjs';

const UI_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../tools/factory-ui');
const REF = 'ops/run';
const BODY = [
  'Run this:',
  '',
  '```bash',
  '# patch the org',
  'curl -sS -X PATCH "https://example.test/x" -d \'{"a": 1}\'',
  '```',
  '',
  '```console',
  '$ npm test',
  'ok 12',
  '```',
  '',
  '```json',
  '{"a": 1}',
  '```',
].join('\n');

function loadUi() {
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

test('a fenced block shows Copy, and Run when it is a shell command', () => {
  const hooks = loadUi();
  const out = hooks.md(BODY);
  const blocks = out.split('<div class="code-block"').slice(1);
  assert.equal(blocks.length, 3);
  for (const b of blocks) assert.match(b, /data-act="copy-code"/);
  assert.match(blocks[0], /^ data-lang="bash"><pre><code># patch the org\ncurl -sS -X PATCH &quot;https:\/\/example.test\/x&quot;/);
  assert.match(blocks[0], /data-act="run-code"/);
  assert.match(blocks[1], /data-act="run-code"/);
  assert.doesNotMatch(blocks[2], /run-code/, 'JSON is copied, not run');
  assert.doesNotMatch(hooks.md('```\n{"a": 1}\n```'), /run-code/, 'data with no language is not run');
  assert.match(hooks.md('```\ngit status\n```'), /run-code/, 'a command with no language is');
  assert.equal(hooks.commandText('$ npm test\nok 12\n$ npm run lint', 'console'), 'npm test\nnpm run lint', 'a console block runs its $ lines');
  assert.equal(hooks.commandText('git status', 'bash'), 'git status');
});

async function board(t, terminal) {
  const root = makeTempDir('factory-run-');
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  assertExit(runCli(['init'], { root }), 0);
  const store = openStore({ root });
  store.createThread({ as: 'you', ref: REF, title: 'Run', teamTitle: 'Ops', kind: 'solo' });
  const msg = (await store.post({ as: 'you', ref: REF, type: 'note', to: [store.threadView(REF).thread.owner], body: BODY })).message;
  const srv = await startServer({ root, port: 0, terminal, warn: () => {} });
  t.after(() => srv.close());
  const call = async (p, body) => {
    const res = await fetch(new URL(p, srv.url), body === undefined ? {} : { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Factory-UI': '1' }, body: JSON.stringify(body) });
    return { status: res.status, json: await res.json() };
  };
  return { root, msg, call };
}

test('Run opens a terminal in the repo folder for a command that is in the message, and nothing else', async (t) => {
  const seen = makeTempDir('factory-run-seen-');
  t.after(() => fs.rmSync(seen, { recursive: true, force: true }));
  const out = path.join(seen, 'line.txt');
  // A stand-in terminal: it records the shell line it was given.
  const fake = (line) => [process.execPath, ['-e', `require('fs').writeFileSync(${JSON.stringify(out)}, process.argv[1])`, line]];
  const { root, msg, call } = await board(t, fake);
  assert.equal((await call('/api/board')).json.terminal, true);

  const bash = '# patch the org\ncurl -sS -X PATCH "https://example.test/x" -d \'{"a": 1}\'';
  const ok = await call('/api/run', { id: msg.id, code: bash });
  assert.equal(ok.status, 200, JSON.stringify(ok.json));
  const line = fs.readFileSync(out, 'utf8');
  const m = /^cd '(.+)' && source '(.+\/run\.sh)'$/.exec(line);
  assert.ok(m, line);
  assert.equal(fs.realpathSync(m[1]), fs.realpathSync(root));
  const script = fs.readFileSync(m[2], 'utf8');
  assert.match(script, /^cat <<'FACTORY_RUN_[0-9a-f]{8}'\n# patch the org\ncurl[^\n]*\nFACTORY_RUN_[0-9a-f]{8}\n# patch the org\ncurl -sS -X PATCH "https:\/\/example.test\/x" -d '\{"a": 1\}'\nrm -rf -- '[^']+'\n$/);
  fs.rmSync(path.dirname(m[2]), { recursive: true, force: true });

  fs.rmSync(out);
  assert.equal((await call('/api/run', { id: msg.id, code: '$ npm test\nok 12' })).status, 200);
  const consoleScript = fs.readFileSync(/source '(.+)'$/.exec(fs.readFileSync(out, 'utf8'))[1], 'utf8');
  assert.match(consoleScript, /\nnpm test\nrm -rf/, 'a console block runs its command, not its output');

  fs.rmSync(out);
  const forged = await call('/api/run', { id: msg.id, code: 'rm -rf ~' });
  assert.equal(forged.status, 404, 'a command that is not in the message never runs');
  assert.equal((await call('/api/run', { id: msg.id, code: '{"a": 1}' })).status, 400, 'JSON is not run');
  assert.equal((await call('/api/run', { id: 'nope', code: bash })).status, 404);
  assert.ok(!fs.existsSync(out), 'none of those opened a terminal');
});

test('a board with no way to open a terminal offers Copy only', async (t) => {
  const { msg, call } = await board(t, null);
  assert.equal((await call('/api/board')).json.terminal, false);
  const r = await call('/api/run', { id: msg.id, code: 'git status' });
  assert.equal(r.status, 400);
  assert.match(r.json.message || r.json.error || '', /cannot open a terminal here/);
  assert.equal(terminalLauncher({}, 'linux'), null);
  assert.deepEqual(terminalLauncher({ FACTORY_TERMINAL_BIN: '/usr/bin/my-term' }, 'linux')('echo hi'), ['/usr/bin/my-term', ['echo hi']]);
  assert.equal(terminalLauncher({}, 'darwin')('echo hi')[0], 'osascript');
});
