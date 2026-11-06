// The autopilot: starts openai by itself when it holds a turn (PROTOCOL §16, "Autopilot").
// A fake Codex stands in for the real one; no test ever starts a model.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { useRoot, runCli, assertExit, openStore, makeTempDir, CLI_PATH } from './helpers.mjs';
import { pidAlive } from '../lib/store.mjs';
import { decide, kickoffPrompt, readSessions, codexModel, MAX_PARALLEL_RUNS } from '../lib/autopilot.mjs';

const REF = 'chat/quality';
const pause = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/** A stand-in for `codex exec`: logs its argv, then answers every open turn, does nothing, or fails. */
function fakeCodex() {
  const dir = makeTempDir('factory-fake-codex-');
  const bin = path.join(dir, 'codex');
  fs.writeFileSync(bin, `#!/usr/bin/env node
import fs from 'node:fs';
import { spawnSync } from 'node:child_process';
const argv = process.argv.slice(2);
const resume = argv[1] === 'resume';
const root = argv.includes('--cd') ? argv[argv.indexOf('--cd') + 1] : process.cwd();
const last = argv[argv.indexOf('-o') + 1];
fs.appendFileSync(process.env.FAKE_CODEX_CALLS, JSON.stringify(argv) + '\\n');
const calls = fs.readFileSync(process.env.FAKE_CODEX_CALLS, 'utf8').trim().split('\\n').length;
console.log('session id: ' + (resume ? argv.at(-2) : '00000000-0000-4000-8000-' + String(calls).padStart(12, '0')));
const mode = process.env.FAKE_CODEX_MODE || 'answer';
if (mode === 'sleep') await new Promise((r) => setTimeout(r, 60000));
// slow: answers like answer, after 3 seconds (a run another autopilot takes over while it works).
if (mode === 'slow') await new Promise((r) => setTimeout(r, 3000));
if (mode === 'fail' || (mode === 'fail-resume' && resume)) process.exit(3);
if (mode === 'fail-resume') {
  const cli = process.env.FAKE_FACTORY_CLI;
  const turns = JSON.parse(spawnSync(process.execPath, [cli, 'inbox', 'openai', '--json', '--root', root], { encoding: 'utf8' }).stdout);
  for (const t of turns) spawnSync(process.execPath, [cli, 'post', t.team + '/' + t.thread, '--type', 'answer', '--reply-to', t.message.id, '--body', 'Done.', '--as', 'openai', '--root', root], { encoding: 'utf8' });
}
if (mode === 'answer' || mode === 'slow') {
  const cli = process.env.FAKE_FACTORY_CLI;
  const turns = JSON.parse(spawnSync(process.execPath, [cli, 'inbox', 'openai', '--json', '--root', root], { encoding: 'utf8' }).stdout);
  for (const t of turns) {
    spawnSync(process.execPath, [cli, 'post', t.team + '/' + t.thread, '--type', 'answer', '--reply-to', t.message.id, '--body', 'Done.', '--as', 'openai', '--root', root], { encoding: 'utf8' });
  }
}
fs.writeFileSync(last, 'I answered (' + mode + ').');
`);
  fs.chmodSync(bin, 0o755);
  const calls = path.join(dir, 'calls.jsonl');
  // FACTORY_CLAUDE_BIN too: no test may reach the real Claude Code either.
  const env = (mode) => ({ FACTORY_CODEX_BIN: bin, FACTORY_CLAUDE_BIN: path.join(dir, 'no-claude'), FAKE_CODEX_CALLS: calls, FAKE_CODEX_MODE: mode, FAKE_FACTORY_CLI: CLI_PATH, FACTORY_CODEX_EFFORT: 'high' });
  const argvs = () => (fs.existsSync(calls) ? fs.readFileSync(calls, 'utf8').trim().split('\n').filter(Boolean).map((l) => JSON.parse(l)) : []);
  return { env, argvs, bin };
}

/** A thread with one question to openai, posted on the real clock (the autopilot reads real time). */
async function questionToOpenai(t) {
  const { root } = await useRoot(t);
  const store = openStore({ root });
  await store.createThread({ as: 'fable', ref: REF, title: 'Quality' });
  const q = await store.post({ as: 'fable', ref: REF, type: 'question', to: ['openai'], body: 'Ideas to cut latency?' });
  return { root, q: q.message };
}

const turn = (id, { thread = 'quality', type = 'question', age = 60 } = {}) => ({ team: 'chat', thread, member: 'openai', message: { id, type }, age_seconds: age });
const fresh = () => ({ running: null, last: null, stuck: [], runs: [] });

test('decide: starts the oldest thread with all its turns; notices, settling, stuck, running, manual sessions and the hourly cap hold it back', () => {
  const now = Date.parse('2026-11-02T08:00:00Z');
  const go = (turns, mstate = fresh(), presence = undefined) => decide({ turns, mstate, presence, nowMs: now, settleMs: 20000 });

  assert.deepEqual(go([]), { launch: null, reason: 'idle' });
  assert.equal(go([turn('e1', { type: 'event' }), turn('a1', { type: 'alert' })]).reason, 'idle', 'notices never start a run');
  const handoff = (id, phase) => ({ ...turn(id, { type: 'event' }), message: { id, type: 'event', kind: 'phase', phase } });
  assert.deepEqual(go([handoff('p1', 'plan')]).launch, { ref: 'chat/quality', turnIds: ['p1'] }, 'a phase event that hands the thread to its lead starts it');
  assert.deepEqual(go([handoff('p1', 'design')]).launch.turnIds, ['p1']);
  assert.equal(go([handoff('p2', 'code_review')]).reason, 'idle', 'a gate-entry phase event is a notice: the lead\'s proposal is the work');
  assert.equal(go([{ ...turn('g1', { type: 'event' }), message: { id: 'g1', type: 'event', kind: 'gate' } }]).reason, 'idle');
  assert.equal(go([turn('q1', { age: 5 })]).reason, 'settling');
  assert.deepEqual(go([turn('q1'), turn('q2', { thread: 'other' }), turn('q3', { age: 1 })]).launch, { ref: 'chat/quality', turnIds: ['q1', 'q3'] });
  assert.equal(go([turn('q1')], { ...fresh(), stuck: ['q1'] }).reason, 'stuck');
  assert.deepEqual(go([turn('q1'), turn('q2')], { ...fresh(), stuck: ['q1'] }).launch.turnIds, ['q2'], 'a new turn still starts a run');
  assert.equal(go([turn('q1')], { ...fresh(), running: { pid: 1, ref: 'chat/quality' } }).reason, 'running', 'state from before per-thread runs still counts');

  // One run per thread: a thread with a run going waits; another thread starts beside it.
  const busy = { ...fresh(), running_by_ref: { 'chat/quality': { pid: 1, ref: 'chat/quality', started_at: '2026-11-02T07:58:00Z' } } };
  assert.equal(go([turn('q1')], busy).reason, 'running', 'a thread with a run going waits for it');
  assert.deepEqual(go([turn('q1'), turn('o1', { thread: 'other' })], busy).launch, { ref: 'chat/other', turnIds: ['o1'] }, 'another thread starts its own run');
  const full = { ...fresh(), running_by_ref: Object.fromEntries(['a', 'b', 'c', 'd'].map((x, i) => [`chat/${x}`, { pid: i + 1, ref: `chat/${x}` }])) };
  assert.equal(go([turn('o1', { thread: 'other' })], full).reason, 'running', `at most ${MAX_PARALLEL_RUNS} runs at once`);

  const watching = { state: 'watching', alive: true, at: '2026-11-02T07:00:00Z' };
  assert.equal(go([turn('q1')], fresh(), watching).reason, 'manual', 'an owner session waiting on the thread');
  const recent = { state: 'working', alive: null, at: '2026-11-02T07:55:00Z' };
  assert.equal(go([turn('q1')], fresh(), recent).reason, 'manual', 'an owner session that just ran a command');
  const ownRun = { ...fresh(), last: { ended_at: '2026-11-02T07:56:00Z' } };
  assert.equal(go([turn('q1')], ownRun, recent).reason, 'launch', 'presence written by the last autopilot run does not block');
  assert.equal(go([turn('q1')], fresh(), { ...recent, at: '2026-11-02T07:40:00Z' }).reason, 'launch', 'a stale presence does not block');
  assert.equal(go([turn('o1', { thread: 'other' })], busy, recent).reason, 'launch', 'presence written while a run goes is that run\'s, not an owner session');

  const runs = Array.from({ length: 6 }, (_, i) => new Date(now - (i + 1) * 60000).toISOString());
  assert.equal(go([turn('q1')], { ...fresh(), runs_by_ref: { 'chat/quality': runs } }).reason, 'capped');
  assert.deepEqual(go([turn('q1'), turn('o1', { thread: 'other' })], { ...fresh(), runs_by_ref: { 'chat/quality': runs } }).launch.ref, 'chat/other', 'the hourly cap is per thread');
  assert.equal(go([turn('q1')], { ...fresh(), runs_by_ref: { 'chat/quality': runs.map((ts) => new Date(Date.parse(ts) - 3600000).toISOString()) } }).reason, 'launch', 'old runs age out of the cap');
});

test('turns on two threads start two runs side by side, each with its own session', async (t) => {
  const { root } = await questionToOpenai(t);
  const store = openStore({ root });
  await store.createThread({ as: 'fable', ref: 'chat/speed', title: 'Speed' });
  await store.post({ as: 'fable', ref: 'chat/speed', type: 'question', to: ['openai'], body: 'Where does the time go?' });
  const fake = fakeCodex();
  const r = runCli(['autopilot', '--once', '--settle', '0s', '--json'], { root, env: fake.env('answer') });
  assertExit(r, 0);
  assert.equal(fake.argvs().length, 2, 'one run per thread, started in the same pass');
  assert.deepEqual(openStore({ root }).openTurns({ member: 'openai' }), [], 'both questions answered');
  const m = openStore({ root }).autopilot().members.openai;
  assert.equal(m.running, null);
  assert.deepEqual(m.runs, []);
  assert.deepEqual(Object.keys(m.by_thread).sort(), ['chat/quality', 'chat/speed']);
});

test('--once starts one sandboxed Codex run per thread; the run answers and the state says so', async (t) => {
  const { root, q } = await questionToOpenai(t);
  const fake = fakeCodex();
  const gcloud = makeTempDir('factory-gcloud-config-');
  const r = runCli(['autopilot', '--once', '--settle', '0s', '--json'], { root, env: { ...fake.env('answer'), CLOUDSDK_CONFIG: gcloud } });
  assertExit(r, 0);

  const [argv] = fake.argvs();
  assert.equal(fake.argvs().length, 1);
  assert.equal(argv[0], 'exec');
  assert.ok(argv.includes('--ignore-user-config'), 'none of the owner\'s MCP servers or plugins load');
  assert.deepEqual(argv.slice(argv.indexOf('--cd'), argv.indexOf('--cd') + 4), ['--cd', root, '-s', 'workspace-write']);
  assert.ok(argv.includes('sandbox_workspace_write.network_access=true'));
  assert.ok(argv.includes(`sandbox_workspace_write.writable_roots=[${JSON.stringify(gcloud)}]`), 'gcloud can write its sign-in and token databases');
  assert.ok(argv.includes('model_reasoning_effort="high"'), 'effort comes from $FACTORY_CODEX_EFFORT first');
  assert.equal(argv.at(-1), kickoffPrompt('openai', REF, { auto: true }));
  assert.match(argv.at(-1), /factory-openai\/SKILL\.md.*thread chat\/quality.*nobody reads it/);

  const store = openStore({ root });
  assert.deepEqual(store.openTurns({ member: 'openai' }), [], 'the fake answered the question');
  const ap = store.autopilot();
  assert.equal(ap.alive, false, 'a --once pass exits');
  const m = ap.members.openai;
  assert.equal(m.enabled, true);
  assert.equal(m.running, null);
  assert.equal(m.last.outcome, 'answered');
  assert.deepEqual(m.last.turns, [q.id]);
  assert.equal(m.last.said, 'I answered (answer).');
  assert.equal(m.last.session, '00000000-0000-4000-8000-000000000001', 'the new session is recorded');
  assert.deepEqual(readSessions(root), { openai: { [REF]: '00000000-0000-4000-8000-000000000001' } });
  assert.ok(fs.existsSync(path.join(root, m.last.log)), 'the run log is kept');
  assert.equal(ap.members.grok.enabled, false);
  assert.equal(store.validate().ok, true);
  assert.deepEqual(store.validate().warnings, [], 'teams/.autopilot is not an unknown team folder');
  assert.equal(store.board().autopilot.members.openai.last.outcome, 'answered');
  assert.equal(store.threadView(REF).autopilot.members.openai.last.outcome, 'answered');
});

test('a run that leaves its turn open is not started again; the turn waits for the owner', async (t) => {
  const { root, q } = await questionToOpenai(t);
  const fake = fakeCodex();
  assertExit(runCli(['autopilot', '--once', '--settle', '0s'], { root, env: fake.env('nothing') }), 0);
  const m = openStore({ root }).autopilot().members.openai;
  assert.equal(m.last.outcome, 'left_open');
  assert.deepEqual(m.last.left_open, [q.id]);

  // A restart retries a stuck turn once; it knows its own last run, so that run's presence does not look like an owner session.
  assertExit(runCli(['autopilot', '--once', '--settle', '0s'], { root, env: fake.env('nothing') }), 0);
  assert.equal(fake.argvs().length, 2, 'a restarted autopilot tries once more');
  assert.equal(openStore({ root }).autopilot().members.openai.last.outcome, 'left_open');
});

test('a failed run is retried once, then waits for the owner; --dry-run explains it', async (t) => {
  const { root, q } = await questionToOpenai(t);
  const fake = fakeCodex();
  const env = fake.env('fail');
  // One long-lived autopilot sees both runs, so it keeps its retry count.
  const proc = (await import('node:child_process')).spawn(process.execPath, [CLI_PATH, 'autopilot', '--settle', '0s', '--root', root], { env: { ...process.env, ...env }, stdio: 'ignore' });
  t.after(() => proc.kill('SIGTERM'));
  for (let i = 0; i < 150 && fake.argvs().length < 2; i++) await pause(100);
  await pause(7000);
  assert.equal(fake.argvs().length, 2, 'one retry, then no more');
  const m = openStore({ root }).autopilot().members.openai;
  assert.equal(m.last.outcome, 'failed');
  assert.equal(m.last.exit_code, 3);
  assert.deepEqual(m.stuck, [q.id]);
  proc.kill('SIGTERM');
  await new Promise((resolve) => proc.on('close', resolve));
  assert.equal(openStore({ root }).autopilot().alive, false);

  const dry = runCli(['autopilot', '--dry-run', '--settle', '0s'], { root, env });
  assertExit(dry, 0);
  assert.match(dry.stdout, /Autopilot is not running\.\n(?:.*\n)*openai: would start on chat\/quality/);
  assert.match(dry.stdout, /grok: off \(Grok Bot has no headless mode/);

  const none = runCli(['autopilot', '--dry-run'], { root, env: { FACTORY_CODEX_BIN: path.join(root, 'no-such-codex') } });
  assert.match(none.stdout, /openai: off \(no Codex CLI found/);
});

test('--detach runs in the background, answers new turns, refuses a second copy and stops with --stop', async (t) => {
  const { root } = await questionToOpenai(t);
  const fake = fakeCodex();
  const env = fake.env('answer');
  // Registered before anything can fail, so a failing run never leaves a detached autopilot behind.
  let pid = null;
  t.after(() => {
    runCli(['autopilot', '--stop', '--runs'], { root });
    try {
      if (pid) process.kill(pid, 'SIGTERM');
    } catch {
      // already stopped
    }
  });
  const up = runCli(['autopilot', '--detach', '--settle', '0s', '--json'], { root, env });
  assertExit(up, 0);
  ({ pid } = up.json());
  assert.equal(openStore({ root }).autopilot().alive, true);
  assert.equal(runCli(['autopilot', '--detach', '--json'], { root, env }).json().already_running, true);

  for (let i = 0; i < 300 && openStore({ root }).openTurns({ member: 'openai' }).length; i++) await pause(100);
  assert.deepEqual(openStore({ root }).openTurns({ member: 'openai' }), [], 'the first question was answered');
  const second = await openStore({ root }).post({ as: 'fable', ref: REF, type: 'question', to: ['openai'], body: 'And for Slack?' });
  for (let i = 0; i < 300 && openStore({ root }).openTurns({ member: 'openai' }).length; i++) await pause(100);
  assert.deepEqual(openStore({ root }).openTurns({ member: 'openai' }), [], 'the second question was answered by a new run');
  // The run's record is written when its process exits, a moment after it answers.
  for (let i = 0; i < 100 && !openStore({ root }).autopilot().members.openai.last?.turns.includes(second.message.id); i++) await pause(100);
  assert.equal(fake.argvs().length, 2);
  assert.equal(fake.argvs()[1][1], 'resume', 'the second run resumes the thread\'s session');
  assert.deepEqual(openStore({ root }).autopilot().members.openai.last.turns, [second.message.id]);

  // Idle: nothing changes, so the state file is not rewritten and open boards do not redraw.
  const stateFile = path.join(root, 'teams', '.autopilot', 'state.json');
  const before = fs.statSync(stateFile).mtimeMs;
  await pause(6000);
  assert.equal(fs.statSync(stateFile).mtimeMs, before, 'an idle pass writes nothing');

  const stop = runCli(['autopilot', '--stop', '--json'], { root, env });
  assertExit(stop, 0);
  assert.equal(stop.json().stopped, true);
  assert.equal(openStore({ root }).autopilot().alive, false);
  assert.equal(runCli(['autopilot', '--stop', '--json'], { root }).json().running, false);
});

test('openai keeps one Codex session per thread: later turns resume it, --session seeds one, a failed resume starts fresh', async (t) => {
  const { root } = await questionToOpenai(t);
  const fake = fakeCodex();
  const seed = '01a19ada-3769-7b20-8fb7-b9935cdd550f';
  const set = runCli(['autopilot', '--session', `${REF}=${seed}`], { root });
  assertExit(set, 0);
  assert.match(set.stdout, /resumes session 01a19ada/);
  assertExit(runCli(['autopilot', '--session', `${REF}=not-a-session`], { root }), 2);
  assertExit(runCli(["autopilot", "--session", `chat/nope=${seed}`], { root }), 1);

  assertExit(runCli(['autopilot', '--once', '--settle', '0s'], { root, env: fake.env('answer') }), 0);
  let [argv] = fake.argvs();
  assert.deepEqual(argv.slice(0, 2), ['exec', 'resume']);
  assert.equal(argv.at(-2), seed);
  assert.equal(argv.at(-1), kickoffPrompt('openai', REF, { auto: true, resumed: true }));
  assert.ok(argv.includes('sandbox_mode="workspace-write"') && argv.includes('--ignore-user-config'));
  assert.ok(!argv.includes('--cd'), 'resume takes no --cd; the run starts in the root');

  // A resume that fails is forgotten; the retry starts a new session and records it.
  await openStore({ root }).post({ as: 'fable', ref: REF, type: 'question', to: ['openai'], body: 'And for Slack?' });
  assertExit(runCli(['autopilot', '--once', '--settle', '0s'], { root, env: fake.env('fail-resume') }), 0);
  assert.equal(openStore({ root }).autopilot().members.openai.last.outcome, 'failed');
  assert.deepEqual(readSessions(root).openai, {}, 'the failed session is forgotten');
  assertExit(runCli(['autopilot', '--once', '--settle', '0s'], { root, env: fake.env('fail-resume') }), 0);
  argv = fake.argvs().at(-1);
  assert.equal(argv[1] === 'resume', false, 'the retry starts a new session');
  assert.deepEqual(openStore({ root }).openTurns({ member: 'openai' }), []);
  const fresh = readSessions(root).openai[REF];
  assert.equal(fresh, '00000000-0000-4000-8000-000000000003');
  const dry = runCli(['autopilot', '--dry-run'], { root, env: fake.env('answer') });
  assert.match(dry.stdout, new RegExp(`openai session on ${REF}: ${fresh}`));

  assertExit(runCli(['autopilot', '--session', `${REF}=`], { root }), 0);
  assert.deepEqual(readSessions(root).openai, {});
});

/** Run the CLI without blocking the test (two at once, or one we signal). */
function cliAsync(args, { root, env }) {
  const child = spawn(process.execPath, [CLI_PATH, ...args, '--root', root], { env: { ...process.env, ...env }, stdio: ['ignore', 'pipe', 'pipe'] });
  let out = '';
  child.stdout.on('data', (c) => { out += c; });
  const done = new Promise((resolve) => child.on('close', (code) => resolve({ code, stdout: out })));
  return { child, done };
}

async function until(fn, ms = 15000) {
  for (let i = 0; i < ms / 100 && !fn(); i++) await pause(100);
  return fn();
}

test('a run left going is taken over by the next autopilot, which records how it ended; --stop leaves it, --stop --runs stops it; a reused pid is not an autopilot', async (t) => {
  const { root, q } = await questionToOpenai(t);
  const fake = fakeCodex();
  const dir = path.join(root, 'teams', '.autopilot');
  fs.mkdirSync(path.join(dir, 'runs'), { recursive: true });
  // state.json as an autopilot leaves it when it stops (or dies) with a run going.
  const orphanState = (pid, turns = [q.id]) => {
    const dead = spawn(process.execPath, ['-e', '0']);
    return new Promise((resolve) => dead.on('close', () => {
      fs.writeFileSync(path.join(dir, 'state.json'), JSON.stringify({ pid: dead.pid, root, started_at: new Date().toISOString(), members: {
        openai: { enabled: true, running: { pid, bin: fake.bin, ref: REF, turns, started_at: new Date().toISOString(), log: 'teams/.autopilot/runs/x.log' }, last: null, stuck: [], failed: [], runs: [] },
      } }));
      resolve();
    }));
  };
  // Its -o file is the one the run's log names (runs/x.last.txt), as for a run the autopilot started.
  const orphan = (mode) => spawn(process.execPath, [fake.bin, 'exec', '--cd', root, '-o', path.join(dir, 'runs', 'x.last.txt'), 'x'], { env: { ...process.env, ...fake.env(mode) }, detached: true, stdio: 'ignore' });

  let o = orphan('sleep');
  t.after(() => { try { process.kill(-o.pid, 'SIGKILL'); } catch {} });
  await orphanState(o.pid);
  // A plain --stop leaves it going and says so.
  const keep = runCli(['autopilot', '--stop', '--json'], { root });
  assertExit(keep, 0);
  assert.deepEqual(keep.json().runs_going.map((x) => x.pid), [o.pid]);
  assert.ok(pidAlive(o.pid), '--stop leaves the run going');
  assert.match(runCli(['autopilot', '--stop'], { root }).stdout, /A run keeps going: openai on chat\/quality .*The next autopilot takes it over; --stop --runs stops it\./);
  // --stop --runs stops it, and records it as stopped, so the board reads that run's presence as the run's, not a session's.
  const stop = runCli(['autopilot', '--stop', '--runs', '--json'], { root });
  assertExit(stop, 0);
  assert.deepEqual(stop.json().leftover_runs.map((x) => x.pid), [o.pid]);
  assert.ok(await until(() => !pidAlive(o.pid)), '--stop --runs reached the run');
  const after = JSON.parse(fs.readFileSync(path.join(dir, 'state.json'), 'utf8')).members.openai;
  assert.equal(after.running, null);
  assert.equal(after.last.outcome, 'stopped');
  assert.equal(after.last.pid, o.pid);
  assert.deepEqual(openStore({ root }).autopilot().leftover_runs, []);

  // The next start takes a run over: it starts no second run on that thread, waits for it, and records how it ended.
  o = orphan('slow');
  await orphanState(o.pid);
  const once = runCli(['autopilot', '--once', '--settle', '0s'], { root, env: fake.env('answer') });
  assertExit(once, 0);
  assert.match(once.stdout, /took over openai's run on chat\/quality/);
  assert.ok(await until(() => !pidAlive(o.pid)), 'the run ended (and --once waited for it)');
  let m = openStore({ root }).autopilot().members.openai;
  assert.equal(m.last.outcome, 'answered', 'its -o file says it finished, and its turn is answered');
  assert.equal(m.last.said, 'I answered (slow).');
  assert.deepEqual(m.last.turns, [q.id]);
  assert.equal(fake.argvs().length, 2, 'the autopilot started no run of its own (the two calls are the orphans)');
  assert.deepEqual(openStore({ root }).openTurns({ member: 'openai' }), []);

  // A run that ended while no autopilot ran, without finishing: recorded as failed, so its turn gets the one retry.
  const q2 = (await openStore({ root }).post({ as: 'fable', ref: REF, type: 'question', to: ['openai'], body: 'And for Slack?' })).message;
  fs.rmSync(path.join(dir, 'runs', 'x.last.txt'));
  const gone = spawn(process.execPath, ['-e', '0']);
  await new Promise((resolve) => gone.on('close', resolve));
  await orphanState(gone.pid, [q2.id]);
  const retry = runCli(['autopilot', '--once', '--settle', '0s'], { root, env: fake.env('answer') });
  assertExit(retry, 0);
  assert.match(retry.stdout, /ended while no autopilot was running; recording it/);
  m = openStore({ root }).autopilot().members.openai;
  assert.equal(m.last.outcome, 'answered', 'then the retry answered it');
  assert.equal(fake.argvs().length, 3);
  assert.deepEqual(openStore({ root }).openTurns({ member: 'openai' }), []);

  // A stranger that got the dead autopilot's pid is not an autopilot: nothing waits on it and --stop leaves it alone.
  const stranger = spawn('sleep', ['30']);
  t.after(() => stranger.kill('SIGKILL'));
  const rec = JSON.parse(fs.readFileSync(path.join(dir, 'state.json'), 'utf8'));
  fs.writeFileSync(path.join(dir, 'state.json'), JSON.stringify({ ...rec, pid: stranger.pid }));
  assert.equal(openStore({ root }).autopilot().alive, false);
  assert.equal(runCli(['autopilot', '--stop', '--runs', '--json'], { root }).json().running, false);
  assert.ok(pidAlive(stranger.pid));
});

test('a turn that failed keeps its one retry across restarts; --detach --once is refused; two --detach at once start one autopilot', async (t) => {
  const { root, q } = await questionToOpenai(t);
  const fake = fakeCodex();
  for (let i = 0; i < 3; i++) assertExit(runCli(['autopilot', '--once', '--settle', '0s'], { root, env: fake.env('fail') }), 0);
  assert.equal(fake.argvs().length, 3, 'one run, one retry, then one run per restart (not two)');
  const m = openStore({ root }).autopilot().members.openai;
  assert.deepEqual(m.stuck, [q.id], 'the third failure leaves the turn to the owner');
  assert.equal(m.notes[q.id].outcome, 'failed', 'with the reason the board shows');

  assertExit(runCli(['autopilot', '--detach', '--once'], { root }), 2);

  const env = fake.env('sleep');
  t.after(() => runCli(['autopilot', '--stop', '--runs'], { root }));
  const a = cliAsync(['autopilot', '--detach', '--json'], { root, env });
  const b = cliAsync(['autopilot', '--detach', '--json'], { root, env });
  const [ra, rb] = await Promise.all([a.done, b.done]);
  assert.equal(ra.code, 0, ra.stdout);
  assert.equal(rb.code, 0, rb.stdout);
  const pids = [JSON.parse(ra.stdout).pid, JSON.parse(rb.stdout).pid];
  assert.equal(pids[0], pids[1], 'both report the same autopilot');
  assertExit(runCli(['autopilot', '--stop', '--runs'], { root }), 0);
});

test('closing the terminal (SIGHUP) stops the autopilot and leaves its run going; --stop --runs ends it', async (t) => {
  const { root } = await questionToOpenai(t);
  const fake = fakeCodex();
  const ap = cliAsync(['autopilot', '--settle', '0s'], { root, env: fake.env('sleep') });
  t.after(() => ap.child.kill('SIGKILL'));
  assert.ok(await until(() => openStore({ root }).autopilot().members.openai?.running), 'a run started');
  const run = openStore({ root }).autopilot().members.openai.running;
  t.after(() => { try { process.kill(-run.pid, 'SIGKILL'); } catch {} });
  ap.child.kill('SIGHUP');
  await ap.done;
  assert.ok(pidAlive(run.pid), 'the run keeps going');
  const m = JSON.parse(fs.readFileSync(path.join(root, 'teams', '.autopilot', 'state.json'), 'utf8'));
  assert.equal(m.pid, null);
  assert.equal(m.members.openai.running_by_ref[REF].pid, run.pid, 'recorded for the next autopilot to take over');
  assert.equal(m.members.openai.last, null, 'not recorded as ended');
  assert.ok(!fs.existsSync(path.join(root, 'teams', '.autopilot', 'lock')), 'the lock is released');
  assert.deepEqual(openStore({ root }).autopilot().leftover_runs.map((x) => x.pid), [run.pid], 'the board shows it going');

  assertExit(runCli(['autopilot', '--stop', '--runs'], { root }), 0);
  assert.ok(await until(() => !pidAlive(run.pid)), 'the run stopped');
  assert.equal(openStore({ root }).autopilot().members.openai.last.outcome, 'stopped');
});

test('codexModel: the environment wins, then openai\'s roster model and effort, then ~/.codex/config.toml', async (t) => {
  const { root } = await useRoot(t);
  const home = makeTempDir('factory-codex-home-');
  fs.writeFileSync(path.join(home, 'config.toml'), 'model = "m-config"\nmodel_reasoning_effort = "ultra"\n\n[mcp_servers.x]\nmodel = "not-top-level"\n');
  const env = { CODEX_HOME: home };
  const roster = path.join(root, 'factory', 'members.yaml');
  const text = fs.readFileSync(roster, 'utf8');
  const OPENAI_EFFORT = /(  - id: openai\n(?:    .*\n)*?)    effort: xhigh\n/;
  assert.match(text, OPENAI_EFFORT, 'the shipped roster runs openai at xhigh');
  fs.writeFileSync(roster, text.replace(OPENAI_EFFORT, '$1    effort: null\n'));
  assert.deepEqual(codexModel(env, root), { model: 'm-config', effort: 'ultra' }, 'a null roster effort defers to the Codex config');
  fs.writeFileSync(roster, text);
  assert.deepEqual(codexModel(env, root), { model: 'm-config', effort: 'xhigh' });
  assert.equal(openStore({ root }).validate().ok, true, 'effort is a valid roster key');
  assert.deepEqual(codexModel({ ...env, FACTORY_CODEX_EFFORT: 'low', FACTORY_CODEX_MODEL: 'm-env' }, root), { model: 'm-env', effort: 'low' });
});

test('a detached autopilot whose repo folder is deleted stops by itself and does not recreate it', async (t) => {
  const { root } = await questionToOpenai(t);
  const fake = fakeCodex();
  let pid = null;
  t.after(() => {
    try {
      if (pid) process.kill(pid, 'SIGKILL');
    } catch {
      // already stopped
    }
  });
  const up = runCli(['autopilot', '--detach', '--json'], { root, env: fake.env('answer') });
  assertExit(up, 0);
  ({ pid } = up.json());
  assert.ok(pidAlive(pid));
  fs.rmSync(root, { recursive: true, force: true });
  for (let i = 0; i < 250 && pidAlive(pid); i++) await pause(100);
  assert.equal(pidAlive(pid), false, 'it exits within a couple of passes');
  assert.equal(fs.existsSync(root), false, 'its last state write does not bring the folder back');
});

test('a deleted repo folder stays deleted when the autopilot there holds failed-run state', async (t) => {
  const { root } = await questionToOpenai(t);
  const fake = fakeCodex();
  let pid = null;
  t.after(() => {
    try {
      if (pid) process.kill(pid, 'SIGKILL');
    } catch {
      // already stopped
    }
  });
  const up = runCli(['autopilot', '--detach', '--settle', '0s', '--json'], { root, env: fake.env('fail') });
  assertExit(up, 0);
  ({ pid } = up.json());
  const statePath = path.join(root, 'teams', '.autopilot', 'state.json');
  const failedOnce = () => {
    try {
      const m = JSON.parse(fs.readFileSync(statePath, 'utf8')).members.openai;
      return Boolean(m && !m.running && m.last && m.last.outcome === 'failed');
    } catch {
      return false;
    }
  };
  for (let i = 0; i < 200 && !failedOnce(); i++) await pause(100);
  assert.ok(failedOnce(), 'the run failed and the state says so');
  fs.rmSync(root, { recursive: true, force: true });
  for (let i = 0; i < 250 && pidAlive(pid); i++) await pause(100);
  assert.equal(pidAlive(pid), false);
  assert.equal(fs.existsSync(root), false, 'no state write brought the folder back');
});
