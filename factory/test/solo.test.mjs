// Single-agent threads (kind solo): one agent that works only when someone
// asks it there, started headless by the autopilot (PROTOCOL §5, §16).
// A fake Claude Code stands in for the real one; no test ever starts a model.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { useRoot, runCli, assertExit, openStore, makeTempDir, editFrontmatterFile, CLI_PATH } from './helpers.mjs';
import { kickoffPrompt, readSessions, CLAUDE_BASE_ALLOW, claudeEnv, mayStart } from '../lib/autopilot.mjs';

const REF = 'chat/monitoring';
const AUDIT = 'Bash(npm --prefix api run report:audit:*)';

/** A stand-in for `claude -p`: logs its argv and env, answers its open turns through the factory CLI, prints stream-json. */
function fakeClaude() {
  const dir = makeTempDir('factory-fake-claude-');
  const bin = path.join(dir, 'claude');
  fs.writeFileSync(bin, `#!/usr/bin/env node
import fs from 'node:fs';
import { spawnSync } from 'node:child_process';
const argv = process.argv.slice(2);
const at = (f) => (argv.includes(f) ? argv[argv.indexOf(f) + 1] : null);
const session = at('--resume') || at('--session-id');
const env = Object.keys(process.env).filter((k) => /^(CLAUDE|FACTORY_ACTOR)/.test(k)).sort();
const bash = [process.env.BASH_DEFAULT_TIMEOUT_MS, process.env.BASH_MAX_TIMEOUT_MS];
const bgWait = process.env.CLAUDE_CODE_PRINT_BG_WAIT_CEILING_MS ?? null;
fs.appendFileSync(process.env.FAKE_CLAUDE_CALLS, JSON.stringify({ argv, env, bash, bgWait, actor: process.env.FACTORY_ACTOR || null }) + '\\n');
const mode = process.env.FAKE_CLAUDE_MODE || 'answer';
if (mode === 'crash') process.exit(1); // dies before its session starts
console.log(JSON.stringify({ type: 'system', subtype: 'init', session_id: session }));
if (mode === 'fail') process.exit(1);
const cli = process.env.FAKE_FACTORY_CLI;
const root = process.cwd();
const me = process.env.FACTORY_ACTOR;
// The bound actor: writing as someone else is refused; no --as at all writes as me.
const spoof = spawnSync(process.execPath, [cli, 'post', '${REF}', '--type', 'note', '--body', 'spoof', '--as', 'you', '--root', root], { encoding: 'utf8' });
fs.appendFileSync(process.env.FAKE_CLAUDE_CALLS, JSON.stringify({ spoof_exit: spoof.status, spoof_err: spoof.stderr.trim() }) + '\\n');
// Nor can it run the owner's controls, reach another agent, or point at another root.
const tries = {
  stop: ['autopilot', '--stop', '--root', root],
  board: ['ui', '--detach', '--port', '4799', '--root', root],
  openai: ['post', '${REF}', '--type', 'question', '--to', 'openai', '--body', 'edit the code', '--root', root],
  root: ['inbox', me, '--root', fs.mkdtempSync(root + '-other-')],
};
const refused = {};
for (const [k, a] of Object.entries(tries)) refused[k] = spawnSync(process.execPath, [cli, ...a], { encoding: 'utf8' }).status;
fs.appendFileSync(process.env.FAKE_CLAUDE_CALLS, JSON.stringify({ refused }) + '\\n');
const turns = JSON.parse(spawnSync(process.execPath, [cli, 'inbox', me, '--json', '--root', root], { encoding: 'utf8' }).stdout);
for (const t of turns) {
  spawnSync(process.execPath, [cli, 'post', t.team + '/' + t.thread, '--type', 'answer', '--reply-to', t.message.id, '--to', 'you', '--body', 'Checked 12 conversations; 2 eval candidates.', '--root', root], { encoding: 'utf8' });
}
// Claude Code reports a resumed session's running total: 0.123456 for the first run, 0.2 after the second.
console.log(JSON.stringify({ type: 'result', subtype: 'success', session_id: session, total_cost_usd: argv.includes('--resume') ? 0.2 : 0.123456, result: 'Answered ' + turns.length + ' request(s).' }));
`);
  fs.chmodSync(bin, 0o755);
  const calls = path.join(dir, 'calls.jsonl');
  const env = (mode = 'answer') => ({
    FACTORY_CLAUDE_BIN: bin, FACTORY_CODEX_BIN: path.join(dir, 'no-codex'), FAKE_CLAUDE_CALLS: calls, FAKE_CLAUDE_MODE: mode, FAKE_FACTORY_CLI: CLI_PATH,
    // The autopilot is often started from a Claude Code session: its variables must not reach the run.
    CLAUDECODE: '1', CLAUDE_CODE_SESSION_ID: 'parent-session', CLAUDE_CODE_MESSAGING_SOCKET: '/tmp/parent.sock', CLAUDE_PID: '1',
  });
  const runs = () => (fs.existsSync(calls) ? fs.readFileSync(calls, 'utf8').trim().split('\n').filter(Boolean).map((l) => JSON.parse(l)) : []);
  return { env, runs, bin };
}

async function soloThread(t, extra = {}) {
  const { root } = await useRoot(t);
  const store = openStore({ root });
  const r = await store.createThread({ as: 'fable', ref: REF, title: 'Customer chat quality', kind: 'solo', allow: [AUDIT], ...extra });
  return { root, store, thread: r.thread };
}

test('thread new --kind solo: its agent is the solo member and leads it, members are you and the agent, no tasks and no gates', async (t) => {
  const { root, store, thread } = await soloThread(t);
  assert.equal(thread.kind, 'solo');
  assert.equal(thread.phase, 'active');
  assert.equal(thread.owner, 'opus-solo');
  assert.equal(thread.lead, 'opus-solo', 'the agent leads its own thread');
  assert.deepEqual(thread.members, ['you', 'opus-solo']);
  assert.deepEqual(thread.allow, [AUDIT]);
  assert.equal(thread.gates, null);
  assert.ok(!('cadence' in thread) && !('thresholds' in thread) && !('last_run' in thread), 'no watch keys');
  assert.match(thread.body, /^## Instructions$/m);
  assert.match(thread.body, /^## Notes$/m);
  assert.equal(store.validate().ok, true, JSON.stringify(store.validate().errors));
  const created = store.threadView(REF).messages.find((m) => m.type === 'event');
  assert.equal(created.event.thread_kind, 'solo');
  assert.deepEqual(created.to, [], 'nobody holds a turn on its creation');

  const fail = (args, code, re) => {
    const r = runCli(args, { root });
    assertExit(r, code);
    assert.match(r.stderr, re);
  };
  fail(['thread', 'new', 'chat/other', '--title', 'X', '--kind', 'solo', '--owner', 'you', '--as', 'fable'], 2, /not an agent|is a human/);
  fail(['thread', 'new', 'chat/other', '--title', 'X', '--kind', 'solo', '--cadence', 'daily', '--as', 'fable'], 2, /--cadence only applies to watch threads/);
  fail(['thread', 'new', 'chat/other', '--title', 'X', '--kind', 'solo', '--lead', 'fable', '--as', 'fable'], 2, /led by its own agent \(opus-solo\); leave --lead out/);
  fail(['thread', 'new', 'chat/other', '--title', 'X', '--allow', 'Read', '--as', 'fable'], 2, /--allow only applies to single-agent threads/);
  fail(['advance', REF, '--as', 'fable'], 2, /single-agent thread/);
  fail(['task', 'new', REF, '--title', 'x', '--as', 'fable'], 2, /single-agent threads hold no tasks/);
  fail(['watch', 'run', REF, '--metrics', '{"x":1}', '--as', 'fable'], 2, /is a single-agent thread; `watch run` only applies to watch threads/);
  fail(['thread', 'set', REF, '--cadence', 'daily', '--as', 'fable'], 2, /cadence and thresholds belong to watch threads/);
  fail(['thread', 'set', REF, '--allow', 'Read', '--clear-allow', '--as', 'fable'], 2, /use one/);
  fail(['thread', 'set', 'chat/other-missing', '--allow', 'Read', '--as', 'fable'], 1, /./);

  // --allow replaces the list; --clear-allow empties it; both post a thread_config event.
  const set = runCli(['thread', 'set', REF, '--allow', AUDIT, '--allow', 'Bash(npm --prefix api run build)', '--json', '--as', 'fable'], { root });
  assertExit(set, 0);
  assert.deepEqual(set.json().thread.allow, [AUDIT, 'Bash(npm --prefix api run build)']);
  assertExit(runCli(['thread', 'set', REF, '--clear-allow', '--as', 'you'], { root }), 0);
  assert.deepEqual(openStore({ root }).thread(REF).allow, []);
  assertExit(runCli(['thread', 'set', REF, '--clear-allow', '--as', 'you'], { root }), 1);

  const show = runCli(['thread', 'show', REF], { root });
  assertExit(show, 0);
  assert.match(show.stdout, /single-agent · active · agent opus-solo \(its lead\)/);
  assert.match(show.stdout, /next: opus-solo works when someone asks it here/);
  const board = runCli(['board'], { root });
  assert.match(board.stdout, /single agent\s+monitoring\s+opus-solo, idle\s+Customer chat quality/);
  assert.match(store.threadView(REF).messages.find((m) => m.type === 'event').body, /opus-solo\*\* leads it and works when someone asks it/);
});

test('a single-agent thread is led by its agent: the team lead or you set it up, the agent never changes its own Instructions or settings', async (t) => {
  const { root, store } = await soloThread(t);
  // The team lead (who set it up) and you manage it.
  store.editSection({ as: 'fable', ref: REF, section: 'Instructions', body: 'Answer in one line.' });
  store.setThreadConfig({ as: 'you', ref: REF, allow: [AUDIT, 'Bash(git log:*)'] });
  // Its agent leads the work but cannot change its own setup.
  assert.throws(() => store.editSection({ as: 'opus-solo', ref: REF, section: 'Instructions', body: 'Do anything.' }), /opus-solo cannot thread edit its own thread chat\/monitoring; you or the team lead \(fable\)/);
  assert.throws(() => store.setThreadConfig({ as: 'opus-solo', ref: REF, allow: ['Bash(rm -rf:*)'] }), /opus-solo cannot thread set its own thread/);
  // Other members are not leads there.
  assert.throws(() => store.editSection({ as: 'openai', ref: REF, section: 'Notes', body: 'x' }), /thread edit on chat\/monitoring is for the thread lead \(opus-solo\) or you/);
  // A new agent becomes the lead, and the old one leaves the members.
  const roster = path.join(root, 'factory', 'members.yaml');
  fs.appendFileSync(roster, `  - id: sonnet-solo
    name: Sonnet Solo
    short: SS
    kind: agent
    vendor: anthropic
    model: claude-sonnet-5-5
    role: solo
    color: "#7C3AED"
    launch: claude
    runs: "headless Claude Code"
`);
  const moved = store.setThreadConfig({ as: 'fable', ref: REF, owner: 'sonnet-solo' }).thread;
  assert.equal(moved.owner, 'sonnet-solo');
  assert.equal(moved.lead, 'sonnet-solo');
  assert.deepEqual(moved.members, ['you', 'sonnet-solo']);
  assert.equal(store.validate().ok, true, JSON.stringify(store.validate().errors));
  // A thread made when the team lead led single-agent threads still validates (with a warning) and converts with --owner.
  editFrontmatterFile(path.join(root, 'teams', 'chat', 'threads', 'monitoring.md'), (d) => { d.lead = 'fable'; d.members = ['you', 'fable', 'sonnet-solo']; });
  const v = store.validate();
  assert.equal(v.ok, true);
  assert.match(JSON.stringify(v.warnings), /lead \\"fable\\" is not its agent \\"sonnet-solo\\".*thread set chat\/monitoring --owner sonnet-solo/);
  const converted = store.setThreadConfig({ as: 'you', ref: REF, owner: 'sonnet-solo' });
  assert.deepEqual(converted.changes, ['lead fable → sonnet-solo', 'members → you, sonnet-solo']);
  assert.equal(converted.thread.lead, 'sonnet-solo');
  assert.deepEqual(converted.thread.members, ['you', 'sonnet-solo']);
  assert.deepEqual(store.validate().warnings, []);
});

test('single-agent threads: only you record decisions, its agent keeps its open requests, a conversion closes the old lead\'s turns and keeps what it settled', async (t) => {
  const { root, store } = await soloThread(t);
  fs.appendFileSync(path.join(root, 'factory', 'members.yaml'), `  - id: sonnet-solo
    name: Sonnet Solo
    short: SS
    kind: agent
    vendor: anthropic
    model: claude-sonnet-5-5
    role: solo
    color: "#7C3AED"
    launch: claude
    runs: "headless Claude Code"
`);
  // Decisions: you only, not its agent (now the thread lead) and not the team lead.
  assert.throws(() => store.decide({ as: 'opus-solo', ref: REF, title: 'Drop the eval gate' }), /only you record decisions on the single-agent thread chat\/monitoring/);
  assert.throws(() => store.decide({ as: 'fable', ref: REF, title: 'Drop the eval gate' }), /only you record decisions/);
  store.decide({ as: 'you', ref: REF, title: 'Weekly window by default' });
  // --members never applies: you and its agent.
  assert.throws(() => store.setThreadConfig({ as: 'you', ref: REF, members: 'you,opus-1' }), /its members are you and its agent; change the agent with --owner/);
  assert.throws(() => store.createThread({ as: 'fable', ref: 'chat/other', title: 'X', kind: 'solo', members: 'you,opus-1' }), /--members: a single-agent thread has two members/);
  // Its agent keeps an open request: changing the agent waits until it answers.
  const q = await store.post({ as: 'you', ref: REF, type: 'question', to: ['opus-solo'], body: 'What did customers ask this week?' });
  assert.throws(() => store.setThreadConfig({ as: 'you', ref: REF, owner: 'sonnet-solo' }), new RegExp(`opus-solo has 1 open request on chat/monitoring \\(${q.message.id}\\); let it answer first`));
  await store.post({ as: 'opus-solo', ref: REF, type: 'answer', reply_to: q.message.id, to: ['you'], body: 'Three themes.' });
  assert.deepEqual(store.setThreadConfig({ as: 'you', ref: REF, owner: 'sonnet-solo' }).thread.members, ['you', 'sonnet-solo']);

  // A thread made when the team lead led single-agent threads: fable relayed, and settled a question to you.
  editFrontmatterFile(path.join(root, 'teams', 'chat', 'threads', 'monitoring.md'), (d) => { d.lead = 'fable'; d.members = ['you', 'fable', 'sonnet-solo']; });
  const relay = await store.post({ as: 'sonnet-solo', ref: REF, type: 'answer', to: ['fable'], body: 'For the owner: two themes.' });
  const ask = await store.post({ as: 'sonnet-solo', ref: REF, type: 'question', to: ['you'], body: 'Which window?' });
  await store.post({ as: 'fable', ref: REF, type: 'note', resolves: [ask.message.id], body: 'Settled: 7 days.' });
  assert.deepEqual(store.openTurns({ member: 'fable', thread: REF }).map((o) => o.message.id), [relay.message.id]);
  const converted = store.setThreadConfig({ as: 'you', ref: REF, owner: 'sonnet-solo' });
  assert.deepEqual(converted.changes, ['lead fable → sonnet-solo', 'members → you, sonnet-solo', 'closed 1 turn held by fable']);
  assert.deepEqual(store.openTurns({ member: 'fable', thread: REF }), [], 'the old lead can no longer write there: its turns are closed');
  assert.ok(!store.openTurns({ member: 'you', thread: REF }).some((o) => o.message.id === ask.message.id), 'what the old lead settled stays settled');
  const v = store.validate();
  assert.equal(v.ok, true, JSON.stringify(v.errors));
  assert.deepEqual(v.warnings, []);
  // The old lead cannot settle anything new there.
  assert.throws(() => store.post({ as: 'fable', ref: REF, type: 'note', body: 'x' }), /fable is not a member of chat\/monitoring/);
  // A member added by hand is flagged.
  editFrontmatterFile(path.join(root, 'teams', 'chat', 'threads', 'monitoring.md'), (d) => { d.members = ['you', 'sonnet-solo', 'opus-1']; });
  assert.match(JSON.stringify(store.validate().warnings), /members opus-1: a single-agent thread's members are you and its agent/);
});

test('subagent guard: only the built-in types, in this checkout', async () => {
  const { refusal, SUBAGENT_TYPES } = await import('../lib/subagent-guard.mjs');
  const call = (input, tool_name = 'Agent') => refusal({ tool_name, tool_input: input });
  assert.deepEqual(SUBAGENT_TYPES, ['Explore', 'general-purpose', 'Plan']);
  assert.equal(call({ subagent_type: 'Explore', prompt: 'find x' }), null);
  assert.equal(call({ prompt: 'no type: general-purpose' }), null);
  assert.equal(call({ command: 'mkdir x' }, 'Bash'), null, 'other tools pass through to the permission rules');
  assert.match(call({ subagent_type: 'general-purpose', prompt: 'x', isolation: 'worktree' }), /leave out isolation/);
  assert.match(call({ subagent_type: 'general-purpose', prompt: 'x', isolation: 'remote' }), /leave out isolation/);
  assert.match(call({ subagent_type: 'Explore', prompt: 'x', cwd: '/tmp', mode: 'acceptEdits' }), /leave out cwd, mode/);
  assert.match(call({ subagent_type: 'custom-agent', prompt: 'x' }), /subagent type "custom-agent" is not available/);
  assert.match(call({ subagent_type: 'general-purpose', prompt: 'x' }, 'Task') ?? 'allowed', /allowed/);
  assert.match(refusal(null), /could not be read/);
  // As a hook: exit 2 refuses, with the reason on stderr; unreadable input is refused.
  const { spawnSync } = await import('node:child_process');
  const guard = path.join(path.dirname(CLI_PATH), '..', 'lib', 'subagent-guard.mjs');
  const run = (input) => spawnSync(process.execPath, [guard], { input, encoding: 'utf8' });
  assert.equal(run(JSON.stringify({ tool_name: 'Agent', tool_input: { subagent_type: 'Explore', prompt: 'x' } })).status, 0);
  const no = run(JSON.stringify({ tool_name: 'Agent', tool_input: { prompt: 'x', isolation: 'worktree' } }));
  assert.equal(no.status, 2);
  assert.match(no.stderr, /Refused by the factory: .*leave out isolation/);
  assert.equal(run('not json').status, 2);
});

test('validate: a solo thread needs an agent owner and one-line allow rules', async (t) => {
  const { root, store } = await soloThread(t);
  const file = path.join(root, 'teams', 'chat', 'threads', 'monitoring.md');
  const text = fs.readFileSync(file, 'utf8');
  fs.writeFileSync(file, text.replace(/^owner: .*$/m, 'owner: you').replace(/^allow:[\s\S]*?(?=^created:)/m, 'allow: 7\n'));
  const v = store.validate();
  assert.ok(v.errors.some((e) => /owner "you" is not an agent/.test(e.message)), JSON.stringify(v.errors));
  assert.ok(v.errors.some((e) => /allow must be a list/.test(e.message)), JSON.stringify(v.errors));
});

test('a solo thread\'s issue is fixed from a project thread, like a watch issue', async (t) => {
  const { root, store } = await soloThread(t);
  await store.createThread({ as: 'fable', ref: 'chat/fix-answers', title: 'Fix answers' });
  const is = await store.createIssue({ as: 'opus-solo', ref: REF, title: 'Answer contradicts its tool result', severity: 'medium' });
  const r = runCli(['issue', 'accept', `chat/${is.issue.id}`, '--thread', 'chat/fix-answers', '--as', 'fable'], { root });
  assertExit(r, 1);
  assert.match(r.stderr, /is in brief; a fix for chat\/I-001 needs a project thread in plan or later/, 'not "its task goes on that thread"');
});

test('FACTORY_ACTOR: a session the autopilot started writes as its own member only', async (t) => {
  const { root } = await soloThread(t);
  const env = { FACTORY_ACTOR: 'opus-solo', FACTORY_ROOT: root };
  for (const [args, why] of [
    [['autopilot', '--stop'], /`autopilot` is for the owner/],
    [['autopilot', '--session', `${REF}=11111111-1111-4111-8111-111111111111`], /`autopilot` is for the owner/],
    [['ui', '--detach', '--port', '4799'], /`ui` is for the owner/],
    [['init'], /`init` is for the owner/],
  ]) {
    const r = runCli(args, { root, env });
    assertExit(r, 1);
    assert.match(r.stderr, why);
  }
  const elsewhere = runCli(['inbox', 'opus-solo'], { root: makeTempDir('factory-other-'), env });
  assertExit(elsewhere, 1);
  assert.match(elsewhere.stderr, /cannot use --root/);
  assertExit(runCli(['autopilot', '--dry-run'], { root, env }), 0);
  const spoof = runCli(['post', REF, '--type', 'note', '--body', 'hi', '--as', 'you'], { root, env });
  assertExit(spoof, 1);
  assert.match(spoof.stderr, /started by the autopilot as opus-solo; it cannot write --as you/);
  const ok = runCli(['post', REF, '--type', 'note', '--body', 'hi', '--json'], { root, env });
  assertExit(ok, 0);
  assert.equal(ok.json().message.from, 'opus-solo');
  assertExit(runCli(['post', REF, '--type', 'note', '--body', 'hi again', '--as', 'opus-solo'], { root, env }), 0);
});

test('autopilot: a question to the agent starts headless Claude with the thread\'s permissions; the next one resumes its session', async (t) => {
  const { root, store } = await soloThread(t);
  const fake = fakeClaude();
  const q = await store.post({ as: 'you', ref: REF, type: 'question', to: ['opus-solo'], body: 'Check the last 7 days of customer chats.' });
  const run = runCli(['autopilot', '--once', '--settle', '0s'], { root, env: fake.env() });
  assertExit(run, 0);
  const [first, spoof] = fake.runs();
  const a = first.argv;
  const flag = (f) => a[a.indexOf(f) + 1];
  assert.equal(a[0], '-p');
  assert.equal(flag('--model'), 'claude-opus-5-5');
  assert.equal(flag('--effort'), 'xhigh');
  assert.equal(flag('--setting-sources'), 'project', 'never the owner\'s user or local allow lists');
  assert.ok(a.includes('--strict-mcp-config'), 'no MCP servers');
  assert.equal(flag('--tools'), 'Bash,Read,Grep,Glob,Agent', 'subagents, with the run\'s own permissions');
  const settings = JSON.parse(flag('--settings'));
  assert.equal(settings.hooks.PreToolUse[0].matcher, 'Agent|Task');
  assert.match(settings.hooks.PreToolUse[0].hooks[0].command, /subagent-guard\.mjs"$/, 'every run gets the subagent guard');
  assert.equal(flag('--permission-mode'), 'dontAsk');
  assert.ok(!a.includes('--allowedTools'), 'never the variadic form: a value could be read as another option');
  const rules = a.filter((x) => x.startsWith('--allowedTools=')).map((x) => x.slice('--allowedTools='.length));
  assert.deepEqual(rules, [...CLAUDE_BASE_ALLOW, AUDIT]);
  assert.ok(!CLAUDE_BASE_ALLOW.some((x) => /factory\.mjs (autopilot|ui|init|thread set|decide)/.test(x)) && !CLAUDE_BASE_ALLOW.includes('Bash(node factory/bin/factory.mjs:*)'), 'only the commands a single agent needs');
  const session = flag('--session-id');
  assert.match(session, /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
  assert.equal(a.at(-1), kickoffPrompt('opus-solo', REF, { auto: true, kind: 'solo' }));
  assert.match(a.at(-1), /factory\/roles\/solo\.md/);
  assert.equal(first.actor, 'opus-solo');
  assert.deepEqual(first.env, ['CLAUDE_CODE_PRINT_BG_WAIT_CEILING_MS', 'FACTORY_ACTOR'], 'the parent Claude Code session\'s variables are dropped');
  assert.equal(first.bgWait, '0', 'background subagents are not stopped 10 minutes after the last turn');
  assert.deepEqual(first.bash, ['600000', '3300000'], 'a long command (an audit that builds first) is not cut off at 2 minutes');
  assert.equal(spoof.spoof_exit, 1, 'the run cannot post as you');
  const refused = Object.fromEntries(Object.entries(fake.runs().find((x) => x.refused).refused).map(([k, code]) => [k, code !== 0]));
  assert.deepEqual(refused, { stop: true, board: true, openai: true, root: true }, 'nor stop the autopilot, start a board, ask openai, or use another root');

  const m = openStore({ root }).autopilot().members['opus-solo'];
  assert.equal(m.last.outcome, 'answered');
  assert.equal(m.last.said, 'Answered 1 request(s).');
  assert.equal(m.last.cost_usd, 0.1235);
  assert.equal(m.last.session, session);
  assert.equal(readSessions(root)['opus-solo'][REF], session);
  const v = openStore({ root }).threadView(REF);
  const answer = v.messages.find((x) => x.type === 'answer');
  assert.equal(answer.from, 'opus-solo');
  assert.equal(answer.reply_to, q.message.id);
  assert.deepEqual(v.openTurns.map((o) => [o.member, o.message.type]), [['you', 'answer']], 'the answer waits on you; the question is closed');

  // A second request resumes the same session with the short prompt.
  await store.post({ as: 'you', ref: REF, type: 'question', to: ['opus-solo'], reply_to: answer.id, body: 'Now only the disliked ones.' });
  assertExit(runCli(['autopilot', '--once', '--settle', '0s'], { root, env: fake.env() }), 0);
  const second = fake.runs().filter((x) => x.argv).at(-1).argv;
  assert.equal(openStore({ root }).autopilot().members['opus-solo'].by_thread[REF].outcome, 'answered', 'the board knows each thread\'s last run');
  assert.equal(second[second.indexOf('--resume') + 1], session);
  assert.ok(!second.includes('--session-id'));
  assert.equal(second.at(-1), kickoffPrompt('opus-solo', REF, { auto: true, resumed: true, kind: 'solo' }));
  assert.match(second.at(-1), /Re-read its Instructions/);
  // Each finished run lands in the cost ledger the board totals.
  const ledger = fs.readFileSync(path.join(root, 'teams', '.autopilot', 'costs.jsonl'), 'utf8').trim().split('\n').map((l) => JSON.parse(l));
  // Each line holds its run's own cost: the second run resumed the session, which then reported 0.2 in all.
  assert.deepEqual(ledger.map((x) => [x.member, x.ref, x.outcome, x.cost_usd, x.session, x.session_usd]), [['opus-solo', REF, 'answered', 0.1235, session, 0.1235], ['opus-solo', REF, 'answered', 0.0765, session, 0.2]]);
  assert.deepEqual(openStore({ root }).threadView(REF).cost, { usd: 0.2, runs: 2, unpriced: 0 });
  assert.equal(openStore({ root }).autopilot().members['opus-solo'].last.cost_usd, 0.0765);

  const dry = runCli(['autopilot', '--dry-run'], { root, env: fake.env() });
  assert.match(dry.stdout, /opus-solo: nothing to do/);
  assert.match(dry.stdout, new RegExp(`opus-solo session on ${REF}: ${session}`));
  const seed = runCli(['autopilot', '--session', `${REF}=`], { root });
  assertExit(seed, 0);
  assert.match(seed.stdout, /opus-solo's next run on chat\/monitoring starts a new session/);
});

test('autopilot: a solo agent with no Claude Code is off and says why; a failed run is retried once', async (t) => {
  const { root, store } = await soloThread(t);
  const fake = fakeClaude();
  await store.post({ as: 'you', ref: REF, type: 'question', to: ['opus-solo'], body: 'Check.' });
  const off = runCli(['autopilot', '--dry-run'], { root, env: { ...fake.env(), FACTORY_CLAUDE_BIN: path.join(root, 'missing') } });
  assert.match(off.stdout, /opus-solo: off \(no Claude Code found/);
  assertExit(runCli(['autopilot', '--once', '--settle', '0s'], { root, env: fake.env('crash') }), 0);
  assert.equal(readSessions(root)['opus-solo']?.[REF], undefined, 'a run that died before its session started leaves none to resume');
  assertExit(runCli(['autopilot', '--once', '--settle', '0s'], { root, env: fake.env('fail') }), 0);
  const m = openStore({ root }).autopilot().members['opus-solo'];
  const [, retry] = fake.runs().filter((x) => x.argv);
  assert.ok(retry.argv.includes('--session-id') && !retry.argv.includes('--resume'), 'so the retry starts a new one');
  assert.equal(fake.runs().filter((x) => x.argv).length, 2, 'one run and one retry');
  assert.equal(m.stuck.length, 1, 'then the turn waits for the owner');
  assert.equal(m.notes[m.stuck[0]].outcome, 'failed');
});

test('single-agent threads: only you, the lead and its agent are addressed there, and its agent works nowhere else', async (t) => {
  const { root, store } = await soloThread(t);
  await store.createThread({ as: 'fable', ref: 'chat/fix-answers', title: 'Fix answers' });
  assert.throws(() => store.post({ as: 'you', ref: REF, type: 'question', to: ['openai'], body: 'Review this.' }), /single-agent thread: address opus-solo, you only/);
  assert.throws(() => store.post({ as: 'opus-solo', ref: REF, type: 'note', cc: ['opus-1'], body: 'x' }), /address opus-solo, you only/);
  assert.throws(() => store.post({ as: 'you', ref: REF, type: 'question', to: ['fable'], body: 'x' }), /address opus-solo, you only/, 'the team lead is not on it');
  assert.throws(() => store.post({ as: 'fable', ref: REF, type: 'note', body: 'x' }), /fable is not a member of chat\/monitoring/, 'a /factory session posts the owner\'s words as you');
  assert.throws(() => store.post({ as: 'fable', ref: 'chat/fix-answers', type: 'question', to: ['opus-solo'], body: 'Help.' }), /opus-solo answers only on the single-agent threads it owns/);
  assert.throws(() => store.post({ as: 'opus-solo', ref: 'chat/fix-answers', type: 'question', to: ['openai'], body: 'Edit the code.' }), /opus-solo works only on the single-agent threads it answers/);
  assert.throws(() => store.createIssue({ as: 'opus-solo', ref: 'chat/fix-answers', title: 'x', severity: 'low' }), /works only on the single-agent threads it answers/);
  const asked = await store.post({ as: 'you', ref: REF, type: 'question', to: ['opus-solo'], body: 'Count the role files.' });
  await store.post({ as: 'opus-solo', ref: REF, type: 'answer', reply_to: asked.message.id, to: ['you'], body: '6.' });
  assert.deepEqual(store.openTurns({ member: 'you', thread: REF }).map((o) => o.message.type), ['answer']);

  // The agent must be one whose runs keep to the thread's allowed commands.
  assert.throws(() => store.createThread({ as: 'fable', ref: 'chat/other', title: 'x', kind: 'solo', owner: 'openai' }), /role solo and launch: claude \(opus-solo\)/);
  assert.throws(() => store.setThreadConfig({ as: 'fable', ref: REF, owner: 'opus-1' }), /role solo and launch: claude/);

  // An allow entry is a permission rule and nothing else.
  for (const bad of ['--permission-mode=bypassPermissions', '--', '-x', 'Bash', 'Bash(*)', 'Bash(:*)', 'Read Write', 'Bash(ls) --setting-sources=user']) {
    assert.throws(() => store.setThreadConfig({ as: 'fable', ref: REF, allow: [bad] }), /--allow/, bad);
  }
  assert.equal((await store.setThreadConfig({ as: 'fable', ref: REF, allow: [AUDIT, 'Bash(git log:*)'] })).thread.allow.length, 2);

  // A hand edit is caught by validate, and the autopilot never passes such an entry on.
  const file = path.join(root, 'teams', 'chat', 'threads', 'monitoring.md');
  editFrontmatterFile(file, (d) => { d.owner = 'openai'; d.allow = [...d.allow, '--permission-mode=bypassPermissions']; });
  const v = runCli(['validate'], { root });
  assertExit(v, 1);
  assert.match(v.stdout + v.stderr, /owner "openai" needs role solo and launch: claude/);
  assert.match(v.stdout + v.stderr, /allow "--permission-mode=bypassPermissions": not a permission rule/);
});

test('autopilot: a hand-edited allow entry that is not a rule never reaches claude', async (t) => {
  const { root, store } = await soloThread(t);
  const fake = fakeClaude();
  const file = path.join(root, 'teams', 'chat', 'threads', 'monitoring.md');
  editFrontmatterFile(file, (d) => { d.allow = [...d.allow, '--permission-mode=bypassPermissions', '--setting-sources=user,project,local']; });
  assert.equal(openStore({ root }).thread(REF).allow.length, 3, 'the hand edit is in the thread file');
  await store.post({ as: 'you', ref: REF, type: 'question', to: ['opus-solo'], body: 'Check.' });
  assertExit(runCli(['autopilot', '--once', '--settle', '0s'], { root, env: fake.env() }), 0);
  const a = fake.runs().find((x) => x.argv).argv;
  assert.deepEqual(a.filter((x) => /permission-mode|setting-sources/.test(x)), ['--setting-sources', '--permission-mode']);
  assert.equal(a[a.indexOf('--permission-mode') + 1], 'dontAsk');
  assert.equal(a[a.indexOf('--setting-sources') + 1], 'project');
  assert.deepEqual(a.filter((x) => x.startsWith('--allowedTools=')).map((x) => x.slice('--allowedTools='.length)), [...CLAUDE_BASE_ALLOW, AUDIT]);
});

test('mayStart: a single-agent thread starts only its agent, and a Claude Code run only answers single-agent threads', () => {
  const solo = { kind: 'solo', owner: 'opus-solo' };
  assert.equal(mayStart('claude', 'opus-solo', solo), true);
  assert.equal(mayStart('codex', 'openai', solo), false, 'a turn for openai there never starts Codex');
  assert.equal(mayStart('claude', 'opus-solo', { kind: 'project' }), false);
  assert.equal(mayStart('claude', 'opus-solo', undefined), false);
  assert.equal(mayStart('codex', 'openai', { kind: 'project' }), true);
  assert.equal(mayStart('codex', 'openai', undefined), true);
});

test('claudeEnv drops only the parent Claude Code session\'s variables', () => {
  const env = claudeEnv({ PATH: '/bin', HOME: '/h', CLAUDECODE: '1', CLAUDE_CODE_ENTRYPOINT: 'cli', CLAUDE_PID: '3', CLAUDE_EFFORT: 'high', CLAUDE_CONFIG_DIR: '/c', ANTHROPIC_API_KEY: 'k' });
  assert.deepEqual(Object.keys(env).sort(), ['ANTHROPIC_API_KEY', 'CLAUDE_CONFIG_DIR', 'HOME', 'PATH']);
});
