// Presence (the board's agent badges) and who a `wait` wakes for.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { useRoot, runCli, assertExit, CLI_PATH, openStore } from './helpers.mjs';
import { signature } from '../../tools/factory-ui/server.mjs';

const REF = 'chat/quality';
const pause = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/** Start `wait` in a child process; resolves to its parsed JSON result. */
function startWait(root, as, timeout = '8s') {
  const env = { ...process.env };
  delete env.FACTORY_ACTOR; // the suite may itself run inside an autopilot run
  const child = spawn(process.execPath, [CLI_PATH, 'wait', REF, '--as', as, '--timeout', timeout, '--json', '--root', root], { stdio: ['ignore', 'pipe', 'pipe'], env });
  let out = '';
  let err = '';
  child.stdout.on('data', (c) => { out += c; });
  child.stderr.on('data', (c) => { err += c; });
  const done = new Promise((resolve, reject) => child.on('close', (code) => {
    if (code !== 0) reject(new Error(`wait exited ${code}: ${err}`));
    else resolve(JSON.parse(out));
  }));
  return { child, done };
}

/** Poll until the member's presence record shows `state` (the child writes it once it starts). */
async function presenceOf(root, member, state) {
  for (let i = 0; i < 40; i += 1) {
    const p = openStore({ root }).presence()[member];
    if (p && (!state || p.state === state)) return p;
    await pause(100);
  }
  return openStore({ root }).presence()[member];
}

test('every factory command an agent runs records what it did; you and failed commands record nothing', async (t) => {
  const { root, store } = await useRoot(t);
  await store.createThread({ as: 'fable', ref: REF, title: 'Quality' });

  assertExit(runCli(['post', REF, '--type', 'note', '--body', 'On it: reading the eval run', '--as', 'fable'], { root }), 0);
  assertExit(runCli(['inbox', 'openai'], { root }), 0);
  assertExit(runCli(['post', REF, '--type', 'note', '--body', 'Looks good', '--as', 'you'], { root }), 0);
  assertExit(runCli(['post', REF, '--type', 'note', '--body', 'x', '--to', 'nobody', '--as', 'grok'], { root }), 2);

  const p = openStore({ root }).presence();
  assert.deepEqual(Object.keys(p).sort(), ['fable', 'openai']);
  assert.equal(p.fable.state, 'working');
  assert.equal(p.fable.thread, REF);
  assert.equal(p.fable.activity, 'note: On it: reading the eval run');
  assert.equal(p.fable.alive, null);
  assert.equal(p.openai.activity, 'inbox');
  assert.equal(p.openai.thread, null);
  assert.ok(!fs.existsSync(path.join(root, 'teams', '.presence', 'you.json')), 'the owner has no badge');

  const fresh = openStore({ root });
  assert.equal(fresh.validate().ok, true);
  assert.deepEqual(fresh.validate().warnings, [], 'teams/.presence is not an unknown team folder');
  assert.equal(fresh.board().presence.fable.activity, 'note: On it: reading the eval run');
  assert.equal(fresh.threadView(REF).presence.openai.state, 'working');
  assert.equal(fresh.notePresence('nobody', { state: 'working' }), null);
  assert.equal(fresh.notePresence('you', { state: 'working' }), null);
});

test('a non-lead wait wakes only for messages addressed to it; a running wait shows as watching', async (t) => {
  const { root, store } = await useRoot(t);
  await store.createThread({ as: 'fable', ref: REF, title: 'Quality' });

  const w = startWait(root, 'openai');
  const watching = await presenceOf(root, 'openai', 'watching');
  assert.equal(watching.alive, true);
  assert.equal(watching.thread, REF);

  await store.post({ as: 'fable', ref: REF, type: 'note', body: 'On it: writing the design' });
  await store.post({ as: 'you', ref: REF, type: 'note', body: 'Owner note to nobody' });
  await pause(1200);
  const q = await store.post({ as: 'fable', ref: REF, type: 'question', to: ['openai'], body: 'Ideas to cut latency?' });
  const r = await w.done;
  assert.equal(r.timed_out, false);
  assert.deepEqual(r.messages.map((m) => m.id), [q.message.id], 'the unaddressed notes did not wake openai');
  assert.equal(r.waiting_on_you.length, 1);
  const after = openStore({ root }).presence().openai;
  assert.equal(after.state, 'working');
  assert.match(after.activity, /reading a new message/);
});

test('the lead wakes for replies to its messages and anything the owner writes, not for unaddressed notes', async (t) => {
  const { root, store } = await useRoot(t);
  await store.createThread({ as: 'fable', ref: REF, title: 'Quality' });
  const q = await store.post({ as: 'fable', ref: REF, type: 'question', to: ['openai'], body: 'Ideas to cut latency?' });

  const first = startWait(root, 'fable');
  await presenceOf(root, 'fable', 'watching');
  await store.post({ as: 'openai', ref: REF, type: 'note', body: 'On it: reading the chat agent' });
  await pause(1200);
  const a = await store.post({ as: 'openai', ref: REF, type: 'answer', reply_to: q.message.id, body: '1. Skip the second author call.' });
  assert.deepEqual(a.message.to, [], 'an answer addresses nobody; it wakes the asker as a reply');
  const r1 = await first.done;
  assert.deepEqual(r1.messages.map((m) => m.id), [a.message.id]);

  const second = startWait(root, 'fable');
  await presenceOf(root, 'fable', 'watching');
  const n = await store.post({ as: 'you', ref: REF, type: 'note', body: 'Here is the latest eval.' });
  const r2 = await second.done;
  assert.deepEqual(r2.messages.map((m) => m.id), [n.message.id], 'the owner wakes the lead without addressing it');
});

test('a wait that times out leaves the agent idle; a dead watcher shows as not alive and changes the board signature', async (t) => {
  const { root, store } = await useRoot(t);
  await store.createThread({ as: 'fable', ref: REF, title: 'Quality' });

  const r = runCli(['wait', REF, '--as', 'grok', '--timeout', '1s', '--json'], { root });
  assertExit(r, 0);
  assert.equal(JSON.parse(r.stdout).timed_out, true);
  const idle = openStore({ root }).presence().grok;
  assert.equal(idle.state, 'idle');
  assert.match(idle.activity, /stopped waiting/);

  const s = openStore({ root });
  s.notePresence('openai', { state: 'watching', thread: REF, pid: process.pid });
  assert.equal(s.presence().openai.alive, true);
  const live = signature(root);
  assert.match(live, /:1$/);

  const gone = spawn(process.execPath, ['-e', '0']);
  await new Promise((resolve) => gone.on('close', resolve));
  const rec = path.join(root, 'teams', '.presence', 'openai.json');
  const data = JSON.parse(fs.readFileSync(rec, 'utf8'));
  fs.writeFileSync(rec, `${JSON.stringify({ ...data, pid: gone.pid })}\n`);
  assert.equal(openStore({ root }).presence().openai.alive, false, 'a killed wait is not watching any more');
  const dead = signature(root);
  assert.match(dead, /:0$/);
  assert.notEqual(live.replace(/:[01]$/, ''), '', 'signature still covers the files');
});

test('an agent that posts while its wait runs still shows as waiting until that wait ends', async (t) => {
  const { root, store } = await useRoot(t);
  await store.createThread({ as: 'fable', ref: REF, title: 'Quality' });
  const w = startWait(root, 'fable', '20s');
  t.after(() => w.child.kill());
  assert.equal((await presenceOf(root, 'fable', 'watching'))?.alive, true);
  // fable posts from another process while the wait runs: the record becomes working and keeps the wait.
  assertExit(runCli(['post', REF, '--type', 'note', '--body', 'On it.', '--as', 'fable'], { root }), 0);
  const p = openStore({ root }).presence().fable;
  assert.equal(p.state, 'working');
  assert.deepEqual(p.waiting, { thread: REF });
  const sig = signature(root);
  assert.match(sig, /w1/);
  // A second command carries it on.
  assertExit(runCli(['inbox', 'fable'], { root }), 0);
  assert.deepEqual(openStore({ root }).presence().fable.waiting, { thread: REF });
  w.child.kill();
  await w.done.catch(() => {});
  assert.equal(openStore({ root }).presence().fable.waiting, null, 'a wait that ended is not counted');
  assert.notEqual(signature(root), sig, 'the board repaints when the wait ends');
});
