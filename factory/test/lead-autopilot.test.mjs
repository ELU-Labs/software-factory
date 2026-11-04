// The lead (fable) started headless by the autopilot, like a single-agent
// thread's agent (PROTOCOL §16, "Autopilot"). A fake Claude Code stands in for
// the real one; no test ever starts a model.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { useRoot, runCli, assertExit, openStore, makeTempDir, CLI_PATH, setupTeam, setupProject, driveTo } from './helpers.mjs';
import { kickoffPrompt, mayStart, launchers, leadMcpConfig, strandedDispatches, CLAUDE_LEAD_ALLOW, CLAUDE_LEAD_TOOLS, LEAD_RUN_TIMEOUT_MS, RUN_TIMEOUT_MS, MAX_BUILDER_RESTARTS } from '../lib/autopilot.mjs';
import { refusal } from '../lib/subagent-guard.mjs';

const REF = 'chat/latency';
const ROOT = '/repo';
const GUARD = path.join(path.dirname(CLI_PATH), '..', 'lib', 'subagent-guard.mjs');

/** A stand-in for `claude -p`: logs its argv and FACTORY_ACTOR, answers its open turns as the bound actor, prints stream-json. */
function fakeClaude() {
  const dir = makeTempDir('factory-fake-lead-');
  const bin = path.join(dir, 'claude');
  fs.writeFileSync(bin, `#!/usr/bin/env node
import fs from 'node:fs';
import { spawnSync } from 'node:child_process';
const argv = process.argv.slice(2);
const at = (f) => (argv.includes(f) ? argv[argv.indexOf(f) + 1] : null);
const session = at('--resume') || at('--session-id');
const cli = process.env.FAKE_FACTORY_CLI;
const root = process.cwd();
const run = (...a) => spawnSync(process.execPath, [cli, ...a, '--root', root], { encoding: 'utf8' });
const asBuilder = run('post', '${REF}', '--type', 'note', '--body', 'builder note', '--as', 'opus-1').status;
const waited = run('wait', '${REF}', '--timeout', '1s').status;
fs.appendFileSync(process.env.FAKE_CLAUDE_CALLS, JSON.stringify({ argv, actor: process.env.FACTORY_ACTOR || null, asBuilder, waited }) + '\\n');
console.log(JSON.stringify({ type: 'system', subtype: 'init', session_id: session }));
const turns = JSON.parse(run('inbox', 'fable', '--json').stdout);
for (const t of turns) run('post', t.team + '/' + t.thread, '--type', 'answer', '--reply-to', t.message.id, '--to', 'you', '--body', 'Done.');
console.log(JSON.stringify({ type: 'result', subtype: 'success', session_id: session, total_cost_usd: 0.5, result: 'Answered ' + turns.length + ' turn(s).' }));
`);
  fs.chmodSync(bin, 0o755);
  const calls = path.join(dir, 'calls.jsonl');
  const env = () => ({ FACTORY_CLAUDE_BIN: bin, FACTORY_CODEX_BIN: path.join(dir, 'no-codex'), FAKE_CLAUDE_CALLS: calls, FAKE_FACTORY_CLI: CLI_PATH, CLAUDECODE: '1' });
  const runs = () => (fs.existsSync(calls) ? fs.readFileSync(calls, 'utf8').trim().split('\n').filter(Boolean).map((l) => JSON.parse(l)) : []);
  return { env, runs, bin };
}

test('kickoffPrompt: the lead reads the factory skill and its role, and a headless run never waits', () => {
  const fresh = kickoffPrompt('fable', REF, { kind: 'lead' });
  assert.match(fresh, /You are fable, the lead of the software factory/);
  assert.match(fresh, /\.claude\/skills\/factory\/SKILL\.md and factory\/roles\/lead\.md/);
  const auto = kickoffPrompt('fable', REF, { kind: 'lead', auto: true, resumed: true });
  assert.match(auto, /^New turns for you on thread chat\/latency/);
  assert.match(auto, /Never run `factory wait`/);
  assert.match(auto, /Wait for every builder or monitor you start before you stop/);
});

test('mayStart: a Claude Code run on a project or watch thread only for the lead that leads it', () => {
  assert.equal(mayStart('claude', 'fable', { kind: 'project', lead: 'fable' }, 'lead'), true);
  assert.equal(mayStart('claude', 'fable', { kind: 'watch', lead: 'fable' }, 'lead'), true);
  assert.equal(mayStart('claude', 'fable', { kind: 'project', lead: 'someone-else' }, 'lead'), false);
  assert.equal(mayStart('claude', 'fable', { kind: 'solo', owner: 'opus-solo', lead: 'opus-solo' }, 'lead'), false, 'never on a single-agent thread');
  assert.equal(mayStart('claude', 'opus-solo', { kind: 'project', lead: 'opus-solo' }, 'solo'), false, 'a solo agent only answers its own thread');
  assert.equal(mayStart('claude', 'fable', undefined, 'lead'), false);
});

test('launchers: the lead runs in auto mode with its own tools, guard and run limit', async (t) => {
  const { root } = await useRoot(t);
  const fake = fakeClaude();
  const l = launchers(root, fake.env());
  assert.equal(l.fable.enabled, true);
  assert.equal(l.fable.role, 'lead');
  assert.equal(l.fable.timeoutMs, LEAD_RUN_TIMEOUT_MS);
  assert.equal(l['opus-solo'].timeoutMs, RUN_TIMEOUT_MS, 'a single agent keeps the 60-minute limit');
  assert.ok(!('opus-1' in l) && !('opus-monitor' in l), 'builders and the monitor run as the lead\'s subagents, never by themselves');
  const a = l.fable.argv({ prompt: 'p', fresh: '11111111-1111-4111-8111-111111111111' });
  const flag = (f) => a[a.indexOf(f) + 1];
  assert.equal(flag('--model'), 'claude-fable-5-1');
  assert.equal(flag('--permission-mode'), 'auto');
  assert.equal(flag('--tools'), CLAUDE_LEAD_TOOLS);
  assert.equal(flag('--setting-sources'), 'project');
  assert.ok(a.includes('--strict-mcp-config'));
  const hook = JSON.parse(flag('--settings')).hooks.PreToolUse[0];
  assert.equal(hook.matcher, 'Agent|Task|Bash');
  assert.match(hook.hooks[0].command, /subagent-guard\.mjs" "lead"$/);
  assert.deepEqual(a.filter((x) => x.startsWith('--allowedTools=')).map((x) => x.slice(15)), CLAUDE_LEAD_ALLOW);
  const solo = l['opus-solo'].argv({ prompt: 'p', fresh: '11111111-1111-4111-8111-111111111111' });
  assert.equal(solo[solo.indexOf('--permission-mode') + 1], 'dontAsk', 'the single agent is unchanged');
});

test('autopilot: a turn for fable starts it headless; it writes as itself and its builders, and never waits', async (t) => {
  const { root, store } = await useRoot(t);
  await store.createThread({ as: 'fable', ref: REF, title: 'Cut latency' });
  const q = await store.post({ as: 'you', ref: REF, type: 'question', to: ['fable'], body: 'Merged; I will run the eval.' });
  const fake = fakeClaude();
  assertExit(runCli(['autopilot', '--once', '--settle', '0s'], { root, env: fake.env() }), 0);
  const [run] = fake.runs();
  assert.ok(run, 'fable was started');
  assert.equal(run.argv.at(-1), kickoffPrompt('fable', REF, { auto: true, kind: 'lead' }));
  assert.equal(run.actor, 'fable,opus-1,opus-2,opus-monitor');
  assert.equal(run.asBuilder, 0, 'a builder subagent posts as itself');
  assert.equal(run.waited, 1, '`factory wait` is refused in an autopilot run');
  const v = openStore({ root }).threadView(REF);
  const answer = v.messages.find((x) => x.type === 'answer' && x.reply_to === q.message.id);
  assert.equal(answer?.from, 'fable', 'the owner\'s question is answered by fable');
  assert.equal(v.messages.find((x) => x.body?.includes('builder note'))?.from, 'opus-1');
  assert.equal(openStore({ root }).autopilot().members.fable.last.outcome, 'answered');
});

test('FACTORY_ACTOR list: the first id is the default; anyone outside it is refused', async (t) => {
  const { root, store } = await useRoot(t);
  await store.createThread({ as: 'fable', ref: REF, title: 'Cut latency' });
  const env = { FACTORY_ACTOR: 'fable,opus-1,opus-2,opus-monitor', FACTORY_ROOT: root };
  const me = runCli(['post', REF, '--type', 'note', '--body', 'hi', '--json'], { root, env });
  assertExit(me, 0);
  assert.equal(me.json().message.from, 'fable');
  const you = runCli(['post', REF, '--type', 'note', '--body', 'hi', '--as', 'you'], { root, env });
  assertExit(you, 1);
  assert.match(you.stderr, /started by the autopilot as fable; it cannot write --as you/);
  assertExit(runCli(['post', REF, '--type', 'note', '--body', 'hi', '--as', 'openai'], { root, env }), 1);
});

test('lead guard: builder and monitor subagents; the owner\'s Git and release steps are refused', () => {
  const agent = (input) => refusal({ tool_name: 'Agent', tool_input: input }, { lead: true, root: ROOT });
  assert.equal(agent({ subagent_type: 'builder', name: 'opus-1', prompt: 'T-001' }), null);
  assert.equal(agent({ subagent_type: 'monitor', prompt: 'watch' }), null);
  assert.match(agent({ subagent_type: 'builder', prompt: 'x', isolation: 'worktree' }), /leave out isolation/);
  assert.match(agent({ subagent_type: 'custom-agent', prompt: 'x' }), /not available to the lead/);
  assert.match(refusal({ tool_name: 'Agent', tool_input: { subagent_type: 'builder', prompt: 'x' } }), /not available on a single-agent thread/, 'a single agent still gets only the built-in types');

  const sh = (command) => refusal({ tool_name: 'Bash', tool_input: { command } }, { lead: true, root: ROOT });
  for (const ok of [
    'git -C /wt/chat-latency push -u origin factory/chat/latency',
    'git -C /wt/chat-latency push',
    'git -C /wt/chat-latency commit -m "Chat: cut latency" -- src/a.ts',
    'git -C /repo fetch origin main && git -C /repo worktree add /wt/x -b factory/chat/x origin/main',
    'git log --oneline -5 && git tag --contains abc123 && git tag',
    'gh pr create --draft --base main --head factory/chat/latency --title "Chat: cut latency" --body "x"',
    'node factory/bin/factory.mjs post chat/latency --type note --body "next: git push origin main, then npm run deploy" --as fable',
    "node factory/bin/factory.mjs post chat/latency --type question --to you --body-file - --as fable <<'EOF'\nMerge it, then run npm run deploy and gh pr merge 940.\nEOF",
  ]) assert.equal(sh(ok), null, ok);
  for (const [bad, why] of [
    ['git push origin main', /git push main/],
    ['git -C /wt push origin HEAD:main', /git push HEAD:main/],
    ['git -C /wt push --force', /git push --force/],
    ['git push --follow-tags', /git push --follow-tags/],
    ['git tag v2026.11.5', /tag/],
    ['git tag -d v2026.11.4', /tag/],
    ['gh pr merge 940 --squash', /factory\.mjs merge <thread-ref>/],
    ['gh workflow run deploy.yml', /gh workflow run/],
    ['gh release create v1', /gh release create/],
    ['./deploy.sh', /deploying/],
    ['npm --prefix api run deploy', /deploying/],
    ['cd web && npx firebase deploy', /deploying/],
    ['git checkout -b feature', /shared checkout: it never leaves main/],
    ['git -C /repo stash', /shared checkout/],
    ['git commit -m "x" -- a.ts', /shared checkout/],
  ]) assert.match(sh(bad) ?? 'allowed', why, bad);
  assert.equal(refusal({ tool_name: 'Bash', tool_input: { command: 'gh pr merge 1' } }), null, 'a single agent\'s shell is left to its permission rules');

  // As a hook with the `lead` argument: exit 2 and the reason on stderr.
  const hook = (call) => spawnSync(process.execPath, [GUARD, 'lead'], { input: JSON.stringify({ cwd: ROOT, ...call }), encoding: 'utf8' });
  const no = hook({ tool_name: 'Bash', tool_input: { command: 'gh pr merge 940' } });
  assert.equal(no.status, 2);
  assert.match(no.stderr, /Refused by the factory: merge a thread's PR with `node factory\/bin\/factory\.mjs merge <thread-ref>` once `you` signed it off/);
  assert.equal(hook({ tool_name: 'Agent', tool_input: { subagent_type: 'builder', prompt: 'x' } }).status, 0);
});

test('launchers: a lead run loads the MCP config $FACTORY_LEAD_MCP_CONFIG names, only from outside the root', async (t) => {
  const { root } = await useRoot(t);
  const fake = fakeClaude();
  const outside = path.join(makeTempDir('factory-mcp-'), 'mcp.json');
  fs.writeFileSync(outside, '{"mcpServers":{}}');
  const inside = path.join(root, 'mcp.json');
  fs.writeFileSync(inside, '{"mcpServers":{}}');
  const fresh = '11111111-1111-4111-8111-111111111111';
  const mcp = (env) => {
    const l = launchers(root, { ...fake.env(), ...env });
    const a = l.fable.argv({ prompt: 'p', fresh });
    const solo = l['opus-solo'].argv({ prompt: 'p', fresh });
    assert.ok(a.includes('--strict-mcp-config') && !solo.includes('--mcp-config'), 'strict stays; the single agent never loads it');
    return a.includes('--mcp-config') ? a[a.indexOf('--mcp-config') + 1] : null;
  };
  assert.equal(mcp({ FACTORY_LEAD_MCP_CONFIG: outside }), outside);
  assert.equal(mcp({}), null, 'unset');
  assert.equal(mcp({ FACTORY_LEAD_MCP_CONFIG: outside + '.missing' }), null, 'missing file');
  assert.equal(mcp({ FACTORY_LEAD_MCP_CONFIG: inside }), null, 'never a file inside the root');
  assert.equal(leadMcpConfig(root, { FACTORY_LEAD_MCP_CONFIG: path.dirname(outside) }), null, 'a directory is not a config');
  // Unset, it is ~/.config/software-factory/mcp.json, so a board that restarts the autopilot keeps it; empty turns it off.
  const home = makeTempDir('factory-home-');
  assert.equal(mcp({ HOME: home }), null, 'no file under HOME');
  fs.mkdirSync(path.join(home, '.config', 'software-factory'), { recursive: true });
  fs.writeFileSync(path.join(home, '.config', 'software-factory', 'mcp.json'), '{"mcpServers":{}}');
  assert.equal(mcp({ HOME: home }), path.join(home, '.config', 'software-factory', 'mcp.json'));
  assert.equal(mcp({ HOME: home, FACTORY_LEAD_MCP_CONFIG: '' }), null, 'set empty: none');
  assert.equal(mcp({ HOME: home, FACTORY_LEAD_MCP_CONFIG: outside }), outside, 'the variable wins');
});

/** A stand-in for `codex exec`: logs its argv, FACTORY_ACTOR and the MCP header variable, answers fable's turns, writes its last message. */
function fakeCodex() {
  const dir = makeTempDir('factory-fake-codex-');
  const bin = path.join(dir, 'codex');
  fs.writeFileSync(bin, `#!/usr/bin/env node
import fs from 'node:fs';
import { spawnSync } from 'node:child_process';
const argv = process.argv.slice(2);
const cli = process.env.FAKE_FACTORY_CLI;
const root = process.cwd();
const run = (...a) => spawnSync(process.execPath, [cli, ...a, '--root', root], { encoding: 'utf8' });
fs.appendFileSync(process.env.FAKE_CODEX_CALLS, JSON.stringify({ argv, actor: process.env.FACTORY_ACTOR || null, mcpAuth: process.env.FACTORY_MCP_TRACKER_AUTHORIZATION || null }) + '\\n');
console.log('session id: 22222222-2222-4222-8222-222222222222');
const turns = JSON.parse(run('inbox', 'fable', '--json').stdout);
for (const t of turns) run('post', t.team + '/' + t.thread, '--type', 'answer', '--reply-to', t.message.id, '--to', 'you', '--body', 'Done on Codex.');
fs.writeFileSync(argv[argv.indexOf('-o') + 1], 'Answered ' + turns.length + ' turn(s).');
`);
  fs.chmodSync(bin, 0o755);
  const calls = path.join(dir, 'calls.jsonl');
  const runs = () => (fs.existsSync(calls) ? fs.readFileSync(calls, 'utf8').trim().split('\n').filter(Boolean).map((l) => JSON.parse(l)) : []);
  return { bin, calls, runs };
}

const OPENAI_LEAD = { lead: { model: 'gpt-6.1-sol' }, subagents: null, pair: null, code_review: { agent: 'you' }, final_check: { agent: 'you' } };

test('autopilot: a thread whose lead is an OpenAI model runs the lead on Codex, alone, with the guard, auto review and its MCP servers', async (t) => {
  const { root, store } = await useRoot(t);
  await store.createThread({ as: 'you', ref: REF, title: 'Cut latency', kind: 'project', roles: OPENAI_LEAD });
  const q = await store.post({ as: 'you', ref: REF, type: 'question', to: ['fable'], body: 'Go.' });
  const claude = fakeClaude();
  const codex = fakeCodex();
  const mcp = path.join(makeTempDir('factory-mcp-'), 'mcp.json');
  fs.writeFileSync(mcp, JSON.stringify({ mcpServers: { tracker: { type: 'http', url: 'https://tracker.example/api/mcp', headers: { Authorization: 'Bearer secret-key' } } } }));
  const env = { ...claude.env(), FACTORY_CODEX_BIN: codex.bin, FAKE_CODEX_CALLS: codex.calls, FACTORY_LEAD_MCP_CONFIG: mcp, FACTORY_CODEX_MODEL: '', FACTORY_CODEX_EFFORT: 'high' };
  assertExit(runCli(['autopilot', '--once', '--settle', '0s'], { root, env }), 0);
  assert.equal(claude.runs().length, 0, 'Claude Code is not started for this thread');
  const [run] = codex.runs();
  assert.ok(run, 'the lead was started on Codex');
  const a = run.argv;
  const flag = (f) => a[a.indexOf(f) + 1];
  assert.deepEqual(a.slice(0, 1), ['exec']);
  assert.equal(flag('-m'), 'gpt-6.1-sol', 'the model the owner picked for the lead');
  const cfg = a.filter((x, i) => a[i - 1] === '-c');
  for (const c of ['approval_policy="on-request"', 'approvals_reviewer="auto_review"', 'sandbox_mode="workspace-write"', 'sandbox_workspace_write.network_access=true', 'model_reasoning_effort="high"']) assert.ok(cfg.includes(c), c);
  assert.match(cfg.find((c) => c.startsWith('hooks.PreToolUse=')), /matcher="Bash".*subagent-guard\.mjs\\" \\"lead\\"/, 'the lead guard runs on every shell command');
  assert.ok(a.includes('--dangerously-bypass-hook-trust') && a.includes('--ignore-user-config'));
  assert.equal(flag('--cd'), root);
  assert.ok(cfg.includes('mcp_servers.tracker.url="https://tracker.example/api/mcp"'));
  assert.ok(cfg.includes('mcp_servers.tracker.env_http_headers={"Authorization"="FACTORY_MCP_TRACKER_AUTHORIZATION"}'));
  assert.ok(!a.some((x) => x.includes('secret-key')), 'the key never goes on the command line');
  assert.equal(run.mcpAuth, 'Bearer secret-key', 'it reaches the run through its environment');
  assert.equal(run.actor, 'fable', 'no builders or monitor: a Codex lead writes only as itself');
  assert.equal(a.at(-1), kickoffPrompt('fable', REF, { auto: true, kind: 'lead', codex: true }));
  assert.match(a.at(-1), /You run in Codex/);
  const v = openStore({ root }).threadView(REF);
  assert.equal(v.messages.find((x) => x.type === 'answer' && x.reply_to === q.message.id)?.from, 'fable');
  const ap = openStore({ root }).autopilot().members.fable;
  assert.equal(ap.last.outcome, 'answered');
  assert.match(ap.last.said, /^Answered \d+ turn/, 'its last message, from the -o file');
  assert.equal(ap.last.session, '22222222-2222-4222-8222-222222222222', 'its next run resumes the Codex session');
});

test('autopilot: an OpenAI-lead thread waits when there is no Codex CLI; a Claude-lead thread beside it still starts', async (t) => {
  const { root, store } = await useRoot(t);
  await store.createThread({ as: 'you', ref: REF, title: 'On OpenAI', kind: 'project', roles: OPENAI_LEAD });
  await store.createThread({ as: 'fable', ref: 'chat/other', title: 'On Claude' });
  await store.post({ as: 'you', ref: REF, type: 'question', to: ['fable'], body: 'Go.' });
  await store.post({ as: 'you', ref: 'chat/other', type: 'question', to: ['fable'], body: 'Go.' });
  const claude = fakeClaude();
  assertExit(runCli(['autopilot', '--once', '--settle', '0s'], { root, env: claude.env() }), 0);
  const runs = claude.runs();
  assert.equal(runs.length, 1);
  assert.match(runs[0].argv.at(-1), /chat\/other/);
});

// ---------------------------------------------------------------------------
// Builders a lead run left mid-task: they end with the run, so the autopilot starts the lead again.
// ---------------------------------------------------------------------------

/** A stand-in for `claude -p` that only logs its argv and ends: whatever builders it would start never run. */
function idleClaude() {
  const dir = makeTempDir('factory-idle-lead-');
  const bin = path.join(dir, 'claude');
  fs.writeFileSync(bin, `#!/usr/bin/env node
import fs from 'node:fs';
const argv = process.argv.slice(2);
const at = (f) => (argv.includes(f) ? argv[argv.indexOf(f) + 1] : null);
const session = at('--resume') || at('--session-id');
fs.appendFileSync(process.env.FAKE_CLAUDE_CALLS, JSON.stringify({ argv, actor: process.env.FACTORY_ACTOR || null }) + '\\n');
console.log(JSON.stringify({ type: 'system', subtype: 'init', session_id: session }));
console.log(JSON.stringify({ type: 'result', subtype: 'success', session_id: session, total_cost_usd: 0.1, result: 'Looked.' }));
`);
  fs.chmodSync(bin, 0o755);
  const calls = path.join(dir, 'calls.jsonl');
  const env = () => ({ FACTORY_CLAUDE_BIN: bin, FACTORY_CODEX_BIN: path.join(dir, 'no-codex'), FAKE_CLAUDE_CALLS: calls });
  const runs = () => (fs.existsSync(calls) ? fs.readFileSync(calls, 'utf8').trim().split('\n').filter(Boolean).map((l) => JSON.parse(l)) : []);
  return { env, runs };
}

/** A project thread in build whose task T-001 is dispatched to opus-1. */
async function dispatchedCtx(t) {
  const ctx = await useRoot(t);
  await setupTeam(ctx);
  const ref = await setupProject(ctx);
  await driveTo(ctx, ref, 'build');
  ctx.clock.seconds(5);
  const d = (await ctx.store.dispatch({ as: 'fable', task: 'checkout/T-001', to: 'opus-1', body: 'Take T-001.' })).message;
  return { ...ctx, ref, d };
}

/** The lead's latest run on a thread, as an earlier autopilot recorded it in state.json. */
function recordLeadRun(root, ref, rec) {
  const dir = path.join(root, 'teams', '.autopilot');
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'state.json'), `${JSON.stringify({ pid: null, root, members: { fable: { by_thread: { [ref]: rec }, stuck: [], failed: [], notes: {}, runs: [], runs_by_ref: {} } } }, null, 2)}\n`);
}

const around = (ts, outcome, extra = {}) => ({ started_at: new Date(Date.parse(ts) - 60000).toISOString(), ended_at: new Date(Date.parse(ts) + 60000).toISOString(), outcome, ...extra });

test('strandedDispatches: per doing task its builder owns, the newest open dispatch the lead made before its last run ended', () => {
  const th = { team: 'checkout', id: 'v2', lead: 'fable', kind: 'project', phase: 'build' };
  const turn = (id, member, ts, extra = {}) => ({ team: 'checkout', thread: 'v2', member, message: { id, ts, from: 'fable', type: 'dispatch', ...extra } });
  const ts = '2026-11-04T19:31:01.000Z';
  const turns = [
    turn('T1-new', 'opus-1', ts),
    turn('T1-old', 'opus-1', '2026-11-04T08:00:00.000Z'),
    turn('T2', 'opus-2', '2026-11-04T09:00:00.000Z'),
    turn('answer', 'opus-1', ts, { type: 'answer' }),
    turn('by-you', 'opus-2', ts, { from: 'you' }),
    { ...turn('elsewhere', 'opus-1', ts), thread: 'other' },
    turn('reviewing', 'opus-2', ts),
    turn('moved', 'opus-2', ts),
    turn('later', 'opus-2', '2026-11-04T19:40:00.000Z'),
  ];
  const tasks = {
    'T1-new': { id: 'T-001', status: 'doing', owner: 'opus-1' }, 'T1-old': { id: 'T-001', status: 'doing', owner: 'opus-1' },
    T2: { id: 'T-002', status: 'doing', owner: 'opus-2' }, reviewing: { id: 'T-003', status: 'review', owner: 'opus-2' },
    moved: { id: 'T-004', status: 'doing', owner: 'opus-1' }, later: { id: 'T-005', status: 'doing', owner: 'opus-2' },
  };
  const taskOf = (t) => tasks[t.message.id] || { id: `T-${t.message.id}`, status: 'doing', owner: t.member };
  const last = { ended_at: '2026-11-04T19:33:51.000Z', outcome: 'timed_out', restarts: 0 };
  const ids = (x) => x.map((t) => t.message.id);
  assert.deepEqual(ids(strandedDispatches({ turns, lead: 'fable', th, last, taskOf })), ['T2', 'T1-new'], 'one per task, oldest task first; a re-dispatch replaces the old one; none posted after the run (an owner\'s session)');
  assert.deepEqual(strandedDispatches({ turns, lead: 'fable', th, last: { ...last, outcome: 'stopped' }, taskOf }), [], 'the owner stopped that run');
  assert.deepEqual(strandedDispatches({ turns, lead: 'fable', th: { ...th, phase: 'done' }, last, taskOf }), [], 'a finished thread');
  assert.deepEqual(strandedDispatches({ turns, lead: 'fable', th: { ...th, lead: 'opus-solo' }, last, taskOf }), [], 'another lead\'s thread');
  assert.deepEqual(strandedDispatches({ turns, lead: 'fable', th, last: { ...last, outcome: 'left_open', restarts: 1 }, taskOf }), [], 'a restart the lead ended by itself: it saw them and left them');
  assert.deepEqual(ids(strandedDispatches({ turns, lead: 'fable', th, last: { ...last, outcome: 'failed', restarts: 1 }, taskOf })), ['T2', 'T1-new'], 'a restart cut off goes on');
  assert.deepEqual(ids(strandedDispatches({ turns, lead: 'fable', th, last: { ...last, outcome: 'answered' }, taskOf })), ['T2', 'T1-new'], 'a run that ended by itself with a builder\'s task unfinished');
  assert.deepEqual(strandedDispatches({ turns, lead: 'fable', th, last: { outcome: 'failed' }, taskOf }), [], 'a run whose end is unknown');
  assert.deepEqual(strandedDispatches({ turns, lead: 'fable', th, last: null, taskOf }), []);
});

test('kickoffPrompt: a restart for stranded builders names the dispatches and asks for a builder again on each', () => {
  const stranded = { outcome: 'timed_out', dispatches: [{ id: 'D1', member: 'opus-2' }, { id: 'D2', member: 'opus-1' }] };
  const resumed = kickoffPrompt('fable', REF, { auto: true, resumed: true, kind: 'lead', stranded });
  assert.match(resumed, /^Your builders stopped on thread chat\/latency: your last run there ran out of time while they worked on dispatches D1 \(opus-2\), D2 \(opus-1\)/);
  assert.match(resumed, /as the same builder on the same dispatch id/);
  assert.match(resumed, /Then work your inbox for thread chat\/latency until it is empty/);
  assert.match(resumed, /Never run `factory wait`/);
  const fresh = kickoffPrompt('fable', REF, { auto: true, kind: 'lead', stranded: { outcome: 'failed', dispatches: [{ id: 'D1', member: 'opus-1' }] } });
  assert.match(fresh, /^You are fable, the lead of the software factory\. Read .* Your builders stopped .* ended before it finished .* dispatch D1 \(opus-1\)/);
  assert.equal(kickoffPrompt('fable', REF, { auto: true, kind: 'lead', stranded: { outcome: 'timed_out', dispatches: [] } }), kickoffPrompt('fable', REF, { auto: true, kind: 'lead' }), 'no dispatches: the usual prompt');
});

test('autopilot: a lead run that ended with a builder mid-task starts the lead again, once for that dispatch', async (t) => {
  const { root, ref, d } = await dispatchedCtx(t);
  recordLeadRun(root, ref, around(d.ts, 'timed_out'));
  const claude = idleClaude();
  assertExit(runCli(['autopilot', '--once', '--settle', '0s'], { root, env: claude.env() }), 0);
  const [run] = claude.runs();
  assert.ok(run, 'fable was started for its builder\'s dispatch');
  assert.match(run.argv.at(-1), new RegExp(`your last run there ran out of time while they worked on dispatch ${d.id} \\(opus-1\\)`));
  assert.equal(run.actor, 'fable,opus-1,opus-2,opus-monitor', 'the builders it starts write as themselves');
  const fable = openStore({ root }).autopilot().members.fable;
  assert.deepEqual(fable.last.turns, [d.id]);
  assert.equal(fable.last.outcome, 'left_open', 'the dispatch is still open: nobody built it');
  assert.equal(fable.by_thread[ref].restarts, 1);
  assert.match(fs.readFileSync(path.join(root, 'teams', '.autopilot', 'runs', path.basename(fable.last.log)), 'utf8'), /Looked\./);
  assertExit(runCli(['autopilot', '--once', '--settle', '0s'], { root, env: claude.env() }), 0);
  assert.equal(claude.runs().length, 1, 'the restart ended by itself with the dispatch open: the lead left it, so not again');
});

test('autopilot: the owner stopping the run, or restarts in a row running out, starts nothing', async (t) => {
  const { root, ref, d } = await dispatchedCtx(t);
  const claude = idleClaude();
  recordLeadRun(root, ref, around(d.ts, 'stopped'));
  assertExit(runCli(['autopilot', '--once', '--settle', '0s'], { root, env: claude.env() }), 0);
  assert.equal(claude.runs().length, 0, 'a run the owner stopped');
  recordLeadRun(root, ref, around(d.ts, 'timed_out', { restarts: MAX_BUILDER_RESTARTS }));
  assertExit(runCli(['autopilot', '--once', '--settle', '0s'], { root, env: claude.env() }), 0);
  assert.equal(claude.runs().length, 0, `after ${MAX_BUILDER_RESTARTS} restarts in a row it waits for a new turn`);
  recordLeadRun(root, ref, around(d.ts, 'failed', { restarts: MAX_BUILDER_RESTARTS - 1 }));
  assertExit(runCli(['autopilot', '--once', '--settle', '0s'], { root, env: claude.env() }), 0);
  assert.equal(claude.runs().length, 1, 'a run a reboot ended, with a restart left');
  assert.match(claude.runs()[0].argv.at(-1), /ended before it finished/);
});
