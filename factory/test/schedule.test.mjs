// Schedules: a thread repeats one message of the owner's (the clock beside Send). The autopilot sends
// it as the owner's question when it is due, one at a time, and tells a watch thread's lead when the
// watch comes due. Only the owner sets them.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import { fileURLToPath } from 'node:url';
import { openStore, everyText, nextSlot } from '../lib/store.mjs';
import { decide } from '../lib/autopilot.mjs';
import { useRoot, runCli, assertExit, makeTempDir, editFrontmatterFile, plain } from './helpers.mjs';

const UI_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../tools/factory-ui');
const SOLO = 'ops/triage';
const H = 3600 * 1000;

async function solo(t) {
  const ctx = await useRoot(t);
  ctx.store.createThread({ as: 'you', ref: SOLO, title: 'Triage', kind: 'solo' });
  ctx.agent = ctx.store.thread(SOLO).owner;
  return ctx;
}

const scheduled = (store, ref = SOLO) => store.messages(ref).filter((m) => m.scheduled === true);

test('everyText and nextSlot', () => {
  assert.equal(everyText('5h'), 'every 5 hours');
  assert.equal(everyText('1h'), 'every hour');
  assert.equal(everyText('hourly'), 'every hour');
  assert.equal(everyText('daily'), 'every day');
  assert.equal(everyText('2d'), 'every 2 days');
  assert.equal(nextSlot(100, 10, 50), 100, 'a slot still ahead stays');
  assert.equal(nextSlot(100, 10, 100), 110);
  assert.equal(nextSlot(100, 10, 135), 140, 'several missed slots: the first one after now, on the same grid');
});

test('the owner sets a schedule on a single-agent thread; it goes to its agent and starts now', async (t) => {
  const { store, clock, agent } = await solo(t);
  const r = store.setSchedule({ as: 'you', ref: SOLO, every: '5h', body: 'Read new issues, then fix or close each one.' });
  assert.deepEqual(plain(r.schedule), { every: '5h', to: [agent], body: 'Read new issues, then fix or close each one.', next: clock.iso(), paused: false, last: null });
  assert.deepEqual(plain(store.thread(SOLO).schedule), plain(r.schedule));
  const ev = r.events.at(-1);
  assert.equal(ev.event.kind, 'schedule');
  assert.equal(ev.event.action, 'set');
  assert.deepEqual(ev.to, [], 'the change opens no turn');
  assert.equal(store.validate().errors.length, 0, JSON.stringify(store.validate().errors));
  assert.deepEqual(plain(store.schedules().map((x) => [x.ref, x.every])), [[SOLO, '5h']]);
});

test('only the owner sets, pauses or clears a schedule; watch threads and bad intervals are refused', async (t) => {
  const { store, agent } = await solo(t);
  assert.throws(() => store.setSchedule({ as: agent, ref: SOLO, every: '5h', body: 'x' }), (e) => e.code === 'permission' && /only you set a schedule/.test(e.message));
  assert.throws(() => store.setSchedule({ as: 'fable', ref: SOLO, every: '5h', body: 'x' }), (e) => e.code === 'permission');
  assert.throws(() => store.setSchedule({ as: 'you', ref: SOLO, every: '5m', body: 'x' }), (e) => e.code === 'usage' && /hourly, daily, weekly, <n>h or <n>d/.test(e.message));
  assert.throws(() => store.setSchedule({ as: 'you', ref: SOLO, every: '5h', body: '  ' }), (e) => e.code === 'usage');
  assert.throws(() => store.setSchedule({ as: 'you', ref: SOLO, every: '5h', body: 'x', next: 'tomorrow' }), (e) => e.code === 'usage');
  store.setSchedule({ as: 'you', ref: SOLO, every: '5h', body: 'x' });
  assert.throws(() => store.setScheduleState({ as: agent, ref: SOLO, paused: true }), (e) => e.code === 'permission');
  assert.throws(() => store.clearSchedule({ as: agent, ref: SOLO }), (e) => e.code === 'permission');
  store.createThread({ as: 'fable', ref: 'ops/health', title: 'Health', kind: 'watch', owner: 'opus-monitor', cadence: 'daily', thresholds: { error_rate: { max: 0.02 } } });
  assert.throws(() => store.setSchedule({ as: 'you', ref: 'ops/health', every: '5h', body: 'x' }), (e) => e.code === 'usage' && /runs on its cadence/.test(e.message));
});

test('the autopilot pass sends a due schedule as the owner\'s question, then moves it to its next slot', async (t) => {
  const { store, clock, agent } = await solo(t);
  const t0 = clock.ms();
  store.setSchedule({ as: 'you', ref: SOLO, every: '5h', body: 'Triage now.' });
  const r = store.runSchedules();
  assert.equal(r.sent.length, 1);
  const [m] = scheduled(store);
  assert.equal(m.from, 'you');
  assert.equal(m.type, 'question');
  assert.deepEqual(m.to, [agent]);
  assert.equal(m.body.trim(), 'Triage now.');
  assert.ok(store.openTurns({ member: agent }).some((x) => x.message.id === m.id), 'it opens the agent\'s turn, which starts it');
  const sc = store.thread(SOLO).schedule;
  assert.equal(sc.last, m.ts);
  assert.equal(sc.next, new Date(t0 + 5 * H).toISOString());
  assert.equal(store.validate().errors.length, 0, JSON.stringify(store.validate().errors));

  clock.hours(1);
  assert.deepEqual(plain(store.runSchedules()), { sent: [], skipped: [], due: [], failed: [] }, 'not due yet: nothing');
});

test('one at a time: while the last one waits on its answer, the next slot sends nothing', async (t) => {
  const { store, clock, agent } = await solo(t);
  const t0 = clock.ms();
  store.setSchedule({ as: 'you', ref: SOLO, every: '5h', body: 'Triage now.' });
  store.runSchedules();
  clock.hours(5);
  const r = store.runSchedules();
  assert.equal(r.sent.length, 0);
  assert.equal(r.skipped.length, 1);
  assert.equal(scheduled(store).length, 1);
  assert.equal(store.thread(SOLO).schedule.next, new Date(t0 + 10 * H).toISOString());
  store.post({ as: agent, ref: SOLO, type: 'answer', reply_to: scheduled(store)[0].id, to: ['you'], body: 'Closed two.' });
  clock.hours(5);
  assert.equal(store.runSchedules().sent.length, 1, 'answered: the next slot sends');
  assert.equal(scheduled(store).length, 2);
});

test('a machine that slept through several slots sends one, and keeps the schedule\'s times', async (t) => {
  const { store, clock, agent } = await solo(t);
  const t0 = clock.ms();
  store.setSchedule({ as: 'you', ref: SOLO, every: '5h', body: 'Triage now.' });
  store.runSchedules();
  store.post({ as: agent, ref: SOLO, type: 'answer', reply_to: scheduled(store)[0].id, to: ['you'], body: 'Done.' });
  clock.set(t0 + 23 * H);
  assert.equal(store.runSchedules().sent.length, 1);
  assert.equal(store.runSchedules().sent.length, 0);
  assert.equal(scheduled(store).length, 2);
  assert.equal(store.thread(SOLO).schedule.next, new Date(t0 + 25 * H).toISOString());
});

test('a scheduled message is not the owner writing: what waits on the owner stays open', async (t) => {
  const { store, clock, agent } = await solo(t);
  const q = store.post({ as: 'you', ref: SOLO, type: 'question', to: [agent], body: 'Look at the 500s.' }).message;
  const ask = store.post({ as: agent, ref: SOLO, type: 'question', reply_to: q.id, to: ['you'], body: 'Close the duplicate?' }).message;
  clock.minutes(1);
  store.setSchedule({ as: 'you', ref: SOLO, every: 'daily', body: 'Triage now.', next: clock.iso() });
  // Setting it is the owner acting: its event closes notices only, never the agent's question.
  assert.ok(store.openTurns({ member: 'you' }).some((x) => x.message.id === ask.id));
  clock.minutes(1);
  store.runSchedules();
  assert.equal(scheduled(store).length, 1);
  assert.ok(store.openTurns({ member: 'you' }).some((x) => x.message.id === ask.id), 'the agent\'s question still waits on the owner');
});

test('pause stops it, resume restarts it at its next slot after now, clear removes it; edits keep or move the next send', async (t) => {
  const { store, clock, agent } = await solo(t);
  const t0 = clock.ms();
  store.setSchedule({ as: 'you', ref: SOLO, every: '5h', body: 'Triage now.' });
  store.runSchedules();
  store.post({ as: agent, ref: SOLO, type: 'answer', reply_to: scheduled(store)[0].id, to: ['you'], body: 'Done.' });
  store.setScheduleState({ as: 'you', ref: SOLO, paused: true });
  assert.throws(() => store.setScheduleState({ as: 'you', ref: SOLO, paused: true }), (e) => e.code === 'conflict');
  clock.set(t0 + 12 * H);
  assert.equal(store.runSchedules().sent.length, 0, 'paused: nothing');
  const r = store.setScheduleState({ as: 'you', ref: SOLO, paused: false });
  assert.equal(r.schedule.next, new Date(t0 + 15 * H).toISOString(), 'missed sends are not made up');
  assert.equal(store.runSchedules().sent.length, 0);

  // Same interval, new words: the next send keeps its time.
  store.setSchedule({ as: 'you', ref: SOLO, every: '5h', body: 'Triage now, and say what you closed.' });
  assert.equal(store.thread(SOLO).schedule.next, new Date(t0 + 15 * H).toISOString());
  assert.throws(() => store.setSchedule({ as: 'you', ref: SOLO, every: '5h', body: 'Triage now, and say what you closed.' }), (e) => e.code === 'conflict');
  // A new interval: the next send counts from the last one.
  store.setSchedule({ as: 'you', ref: SOLO, every: '1d', body: 'Triage now, and say what you closed.' });
  const { last, next } = store.thread(SOLO).schedule;
  assert.equal(next, new Date(Date.parse(last) + 24 * H).toISOString());

  const c = store.clearSchedule({ as: 'you', ref: SOLO });
  assert.equal(c.thread.schedule, undefined);
  assert.equal(c.events.at(-1).event.action, 'cleared');
  assert.throws(() => store.clearSchedule({ as: 'you', ref: SOLO }), (e) => e.code === 'not_found');
  clock.days(3);
  assert.equal(store.runSchedules().sent.length, 0);
  assert.equal(store.validate().errors.length, 0, JSON.stringify(store.validate().errors));
});

test('a project thread\'s schedule goes to its lead, or to the agents --to names, never to you', async (t) => {
  const { store } = await useRoot(t);
  store.createThread({ as: 'fable', ref: 'web/retry', title: 'Retry payments', kind: 'project' });
  assert.deepEqual(plain(store.setSchedule({ as: 'you', ref: 'web/retry', every: 'daily', body: 'Post where it stands.' }).schedule.to), ['fable']);
  assert.deepEqual(plain(store.setSchedule({ as: 'you', ref: 'web/retry', every: 'daily', to: ['fable', 'openai'], body: 'Post where it stands.' }).schedule.to), ['fable', 'openai']);
  assert.throws(() => store.setSchedule({ as: 'you', ref: 'web/retry', every: 'daily', to: ['you'], body: 'x' }), (e) => e.code === 'usage');
  const r = store.runSchedules();
  assert.deepEqual(plain(r.sent.map((x) => x.to)), [['fable', 'openai']]);
});

test('a due watch thread: one notice to its lead per due period, which a run closes; the autopilot starts the lead for it', async (t) => {
  const { store, clock } = await useRoot(t);
  const W = 'ops/health';
  store.createThread({ as: 'fable', ref: W, title: 'Health', kind: 'watch', owner: 'opus-monitor', cadence: 'daily', thresholds: { error_rate: { max: 0.02 } } });
  const r1 = store.runSchedules();
  assert.equal(r1.due.length, 1, 'never run: due');
  assert.deepEqual(plain(r1.due[0].to), ['fable']);
  assert.equal(store.runSchedules().due.length, 0, 'told once');
  const notice = store.openTurns({ member: 'fable', thread: W }).find((x) => x.message.kind === 'watch_due');
  assert.ok(notice, 'it waits on the lead');

  const now = clock.ms();
  const asTurn = { team: 'ops', thread: 'health', member: 'fable', message: notice.message, age_seconds: 60 };
  assert.deepEqual(decide({ turns: [asTurn], mstate: { running: null, last: null, stuck: [], runs: [] }, nowMs: now, settleMs: 20000 }).launch, { ref: W, turnIds: [notice.message.id] });
  const otherEvent = { ...asTurn, message: { ...notice.message, kind: 'thread_config' } };
  assert.equal(decide({ turns: [otherEvent], mstate: { running: null, last: null, stuck: [], runs: [] }, nowMs: now, settleMs: 20000 }).reason, 'idle');

  store.watchRun({ as: 'opus-monitor', ref: W, metrics: { error_rate: 0.01 } });
  assert.ok(!store.openTurns({ member: 'fable', thread: W }).some((x) => x.message.kind === 'watch_due'), 'the run closes the notice');
  assert.equal(store.runSchedules().due.length, 0, 'just ran: not due');
  clock.days(1).minutes(1);
  assert.equal(store.runSchedules().due.length, 1, 'due again a day later');
  store.setWatchState({ as: 'fable', ref: W, state: 'paused' });
  clock.days(2);
  assert.equal(store.runSchedules().due.length, 0, 'paused: never due');
  assert.equal(store.validate().errors.length, 0, JSON.stringify(store.validate().errors));
});

test('a broken schedule fails alone: the other threads\' schedules still send', async (t) => {
  const { store, root } = await solo(t);
  store.createThread({ as: 'fable', ref: 'web/retry', title: 'Retry payments', kind: 'project' });
  store.setSchedule({ as: 'you', ref: 'web/retry', every: 'daily', body: 'Post where it stands.' });
  store.setSchedule({ as: 'you', ref: SOLO, every: '5h', body: 'Triage now.' });
  editFrontmatterFile(path.join(root, 'teams/web/threads/retry.md'), (d) => { d.schedule.to = ['nobody']; });
  const r = store.runSchedules();
  assert.deepEqual(plain(r.sent.map((x) => x.ref)), [SOLO]);
  assert.equal(r.failed.length, 1);
  assert.equal(r.failed[0].ref, 'web/retry');
  assert.match(r.failed[0].error, /nobody/);
});

test('validate checks a schedule and the scheduled mark', async (t) => {
  const { store, root } = await solo(t);
  store.setSchedule({ as: 'you', ref: SOLO, every: '5h', body: 'Triage now.' });
  store.runSchedules();
  const file = path.join(root, 'teams/ops/threads/triage.md');
  editFrontmatterFile(file, (d) => { d.schedule.every = '5m'; d.schedule.to = ['you']; d.schedule.extra = 1; });
  const errs = store.validate().errors.map((e) => e.message).join('\n');
  assert.match(errs, /schedule\.every "5m"/);
  assert.match(errs, /schedule\.to must list the agents/);
  assert.match(errs, /schedule has an unknown key "extra"/);
  const msgFile = path.join(root, 'teams/ops/comms', `${scheduled(store)[0].id}.md`);
  editFrontmatterFile(msgFile, (d) => { d.scheduled = 'yes'; });
  assert.match(store.validate().errors.map((e) => e.message).join('\n'), /scheduled: true goes only on a message from you/);
});

test('CLI: schedule set, list, pause, resume and clear', (t) => {
  const root = makeTempDir('factory-sched-');
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  assertExit(runCli(['init'], { root }), 0);
  openStore({ root }).createThread({ as: 'you', ref: SOLO, title: 'Triage', kind: 'solo' });
  const set = runCli(['schedule', 'set', SOLO, '--every', '5h', '--body', 'Triage now.', '--as', 'you'], { root });
  assertExit(set, 0);
  assert.match(set.stdout, /^Scheduled on ops\/triage: to \S+ every 5 hours; next /);
  const list = runCli(['schedule', 'list'], { root });
  assertExit(list, 0);
  assert.match(list.stdout, /ops\/triage\s+every 5 hours\s+to \S+\s+next .* Triage now\./);
  assertExit(runCli(['schedule', 'pause', SOLO, '--as', 'you'], { root }), 0);
  assert.match(runCli(['schedule', 'list'], { root }).stdout, /paused/);
  assertExit(runCli(['schedule', 'resume', SOLO, '--as', 'you'], { root }), 0);
  assertExit(runCli(['schedule', 'clear', SOLO, '--as', 'you'], { root }), 0);
  assert.match(runCli(['schedule', 'list'], { root }).stdout, /No schedules/);
  const refused = runCli(['schedule', 'set', SOLO, '--every', '5h', '--body', 'x', '--as', 'fable'], { root });
  assert.equal(refused.code, 1);
  assert.match(refused.stderr, /only you set a schedule/);
});

function loadPage() {
  const noop = () => {};
  const hooks = {};
  const sandbox = {
    __factoryUiTest: hooks,
    document: { addEventListener: noop, querySelector: () => null, querySelectorAll: () => [], documentElement: { dataset: {} }, title: '', visibilityState: 'visible', hasFocus: () => true },
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
  return hooks;
}

test('board: the clock beside Send, the schedule row, the header chip, the sidebar clock and the scheduled tag', (t) => {
  const root = makeTempDir('factory-sched-ui-');
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  assertExit(runCli(['init'], { root }), 0);
  const store = openStore({ root });
  store.createThread({ as: 'you', ref: SOLO, title: 'Triage', kind: 'solo' });
  const hooks = loadPage();
  const view = () => JSON.parse(JSON.stringify(store.threadView(SOLO)));

  // No schedule yet: a plain clock, and the row offers to start one.
  let v = view();
  hooks.state.route = { view: 'thread', ref: SOLO, tab: 'chat' };
  const d = hooks.draft(SOLO);
  assert.match(String(hooks.composerFoot(v, d)), /<button class="icon-btn sched-btn" type="button" data-act="sched-open" aria-expanded="false" title="Repeat this message on a schedule"/);
  assert.equal(String(hooks.scheduleChip(v)), '');
  d.sched = { every: '5h' };
  const row = String(hooks.scheduleRow(v.thread, d));
  assert.match(row, /data-act="sched-every" data-every="5h" aria-pressed="true"/);
  assert.match(row, /Send now, then every 5 hours/);
  d.sched = { every: '3x' };
  assert.match(String(hooks.scheduleRow(v.thread, d)), /data-act="sched-save" disabled[^>]*>[\s\S]*Pick how often/);

  // Scheduled and sent once.
  store.setSchedule({ as: 'you', ref: SOLO, every: '5h', body: 'Triage now.' });
  store.runSchedules();
  v = view();
  const chip = String(hooks.scheduleChip(v));
  assert.match(chip, /class="sched-chip"/);
  assert.match(chip, /Every 5 hours · next /);
  assert.match(chip, /data-act="sched-edit">Edit</);
  assert.match(chip, /data-act="sched-pause">Pause</);
  assert.match(chip, /data-act="sched-clear-ask">Cancel</);
  assert.match(String(hooks.composerFoot(v, hooks.draft(SOLO))), /class="icon-btn sched-btn on"/);
  d.sched = { every: '5h' };
  assert.match(String(hooks.scheduleRow(v.thread, d)), />Save schedule</);
  hooks.state.confirmSched = SOLO;
  assert.match(String(hooks.scheduleChip(v)), /data-act="sched-keep">Keep<\/button><button type="button" class="sched-a danger" data-act="sched-clear">Cancel it</);
  hooks.state.confirmSched = null;

  const m = v.messages.find((x) => x.scheduled);
  assert.match(String(hooks.messageItem(m, hooks.threadCtx(v))), /class="chip sched-tag"[^>]*>[\s\S]*scheduled<\/span>/);
  hooks.state.board = JSON.parse(JSON.stringify(store.board()));
  assert.match(String(hooks.railTeams()), /title="Triage"[\s\S]*class="titem-sched" title="Repeats every 5 hours; next /);

  store.setScheduleState({ as: 'you', ref: SOLO, paused: true });
  v = view();
  assert.match(String(hooks.scheduleChip(v)), /class="sched-chip paused"[\s\S]*Paused · every 5 hours[\s\S]*data-act="sched-resume">Resume</);
  hooks.state.board = JSON.parse(JSON.stringify(store.board()));
  assert.doesNotMatch(String(hooks.railTeams()), /titem-sched/, 'a paused schedule shows no clock in the sidebar');

  // A watch thread: its cadence instead, and no clock beside Send.
  store.createThread({ as: 'fable', ref: 'ops/health', title: 'Health', kind: 'watch', owner: 'opus-monitor', cadence: 'daily', thresholds: { error_rate: { max: 0.02 } } });
  const w = JSON.parse(JSON.stringify(store.threadView('ops/health')));
  assert.match(String(hooks.scheduleChip(w)), /Runs every day · due now/);
  assert.doesNotMatch(String(hooks.composerFoot(w, hooks.draft('ops/health'))), /sched-btn/);
});
