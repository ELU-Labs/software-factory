// The one-command start: `thread new` creates a missing team, `wait` returns
// when someone else writes, and `ui` runs in the background and is reused.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { useRoot, runCli, assertExit, openStore, CLI_PATH } from './helpers.mjs';

function freePort() {
  return new Promise((resolve, reject) => {
    const srv = net.createServer();
    srv.once('error', reject);
    srv.listen(0, '127.0.0.1', () => {
      const { port } = srv.address();
      srv.close(() => resolve(port));
    });
  });
}

test('thread new creates a missing team and its folder (you or a lead only)', async (t) => {
  const { root, store } = await useRoot(t);
  const r = await store.createThread({ as: 'fable', ref: 'payments/retry-button', title: 'Retry button', teamTitle: 'Payments' });
  assert.equal(r.team_created, true);
  assert.equal(r.thread.phase, 'brief');
  const team = await store.team('payments');
  assert.equal(team.title, 'Payments');
  assert.equal(team.lead, 'fable');
  for (const sub of ['threads', 'comms', 'tasks', 'issues', 'reports']) assert.ok(fs.existsSync(path.join(root, 'teams/payments', sub)), `${sub}/ exists`);

  const again = await store.createThread({ as: 'fable', ref: 'payments/refunds', title: 'Refunds' });
  assert.equal(again.team_created, false);

  const byId = await store.createThread({ as: 'you', ref: 'search-ux/typo-fix', title: 'Typo fix' });
  assert.equal(byId.team_created, true);
  assert.equal((await store.team('search-ux')).title, 'Search ux');

  assert.throws(() => store.createThread({ as: 'opus-1', ref: 'other/x', title: 'X' }), (e) => e.code === 'not_found');
  assert.ok(!fs.existsSync(path.join(root, 'teams/other')), 'a builder cannot create a team folder');
  assert.equal(store.validate().ok, true);

  const cli = runCli(['thread', 'new', 'growth/welcome-email', '--title', 'Welcome email', '--team-title', 'Growth', '--as', 'fable'], { root });
  assertExit(cli, 0);
  assert.match(cli.stdout, /Created team growth \(new folder teams\/growth\)/);
});

test('wait returns when someone else writes and ignores the caller\'s own writes', async (t) => {
  const { root, store } = await useRoot(t);
  await store.createThread({ as: 'fable', ref: 'payments/retry-button', title: 'Retry button' });

  const own = runCli(['wait', 'payments/retry-button', '--as', 'you', '--timeout', '2s', '--json'], { root });
  assertExit(own, 0);
  assert.equal(JSON.parse(own.stdout).timed_out, true);

  const env = { ...process.env };
  delete env.FACTORY_ACTOR; // the suite may itself run inside an autopilot run
  const child = spawn(process.execPath, [CLI_PATH, 'wait', 'payments/retry-button', '--as', 'fable', '--timeout', '30s', '--json', '--root', root], { stdio: ['ignore', 'pipe', 'pipe'], env });
  let out = '';
  child.stdout.on('data', (c) => { out += c; });
  const done = new Promise((resolve) => child.on('close', resolve));
  await new Promise((resolve) => setTimeout(resolve, 800));
  await store.post({ as: 'fable', ref: 'payments/retry-button', type: 'note', body: 'my own note does not wake me' });
  await new Promise((resolve) => setTimeout(resolve, 3500));
  await store.post({ as: 'you', ref: 'payments/retry-button', type: 'note', to: ['fable'], body: 'Make it orange.' });
  const code = await done;
  assert.equal(code, 0);
  const r = JSON.parse(out);
  assert.equal(r.timed_out, false);
  assert.deepEqual(r.messages.map((m) => [m.from, m.summary]), [['you', 'Make it orange.']]);
  assert.ok(r.waiting_on_you.length >= 1, 'the note to fable is a turn fable now holds');
});

test('the board keeps the autopilot running, and ui --stop stops both', async (t) => {
  const { root } = await useRoot(t);
  const port = String(await freePort());
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'factory-no-agents-'));
  // No agent CLI, so the autopilot it starts can start nothing.
  const env = { FACTORY_NO_AUTOPILOT: '', FACTORY_CODEX_BIN: path.join(dir, 'no-codex'), FACTORY_CLAUDE_BIN: path.join(dir, 'no-claude') };
  t.after(() => {
    runCli(['ui', '--stop', '--port', port], { root });
    runCli(['autopilot', '--stop'], { root });
  });
  assertExit(runCli(['ui', '--detach', '--port', port], { root, env }), 0);
  let alive = false;
  for (let i = 0; i < 50 && !alive; i++) {
    await new Promise((resolve) => setTimeout(resolve, 200));
    alive = openStore({ root }).autopilot().alive;
  }
  assert.ok(alive, 'starting the board started the autopilot');
  const stop = runCli(['ui', '--stop', '--port', port, '--json'], { root });
  assertExit(stop, 0);
  assert.equal(JSON.parse(stop.stdout).autopilot_stopped, true);
  assert.equal(openStore({ root }).autopilot().alive, false, 'stopping the board stopped its autopilot');
});

test('ui --detach runs the board in the background, reuses it, links a thread, and --stop stops it', async (t) => {
  const { root, store } = await useRoot(t);
  await store.createThread({ as: 'fable', ref: 'payments/retry-button', title: 'Retry button' });
  const port = String(await freePort());
  t.after(() => runCli(['ui', '--stop', '--port', port], { root }));

  const up = runCli(['ui', '--detach', '--port', port, '--thread', 'payments/retry-button', '--json'], { root });
  assertExit(up, 0);
  const a = JSON.parse(up.stdout);
  assert.equal(a.detached, true);
  assert.equal(a.url, `http://127.0.0.1:${port}/#/t/payments/retry-button`);

  const res = await fetch(`http://127.0.0.1:${port}/api/info`);
  const info = await res.json();
  assert.equal(info.app, 'factory-board');
  assert.equal(fs.realpathSync(info.root), fs.realpathSync(root));

  const again = runCli(['ui', '--port', port, '--json'], { root });
  assertExit(again, 0);
  const b = JSON.parse(again.stdout);
  assert.equal(b.already_running, true);
  assert.equal(b.pid, a.pid);

  const other = await useRoot(t);
  const clash = runCli(['ui', '--port', port], { root: other.root });
  assertExit(clash, 1);
  assert.match(clash.stderr, /another factory root/);

  const stop = runCli(['ui', '--stop', '--port', port, '--json'], { root });
  assertExit(stop, 0);
  assert.equal(JSON.parse(stop.stdout).stopped, true);
  await new Promise((resolve) => setTimeout(resolve, 300));
  const gone = runCli(['ui', '--stop', '--port', port, '--json'], { root });
  assert.equal(JSON.parse(gone.stdout).running, false);
});
