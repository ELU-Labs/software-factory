// Permission requests on single-agent threads: a headless run can never stop to
// ask, so the commands it was refused become a permission card (a
// permission_denied event to you) that the owner answers on the board; and the
// list of what an agent may run is edited per thread or per team, with a warning
// (and a second click on the board) for any rule that reaches beyond reading.
// A fake Claude Code stands in for the real one; no test ever starts a model.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import vm from 'node:vm';
import { fileURLToPath } from 'node:url';
import { useRoot, runCli, assertExit, openStore, makeTempDir, editFrontmatterFile, CLI_PATH } from './helpers.mjs';
import { suggestAllowRules, allowRuleRisk, shellSegments } from '../lib/store.mjs';
import { deniedIn, CLAUDE_BASE_ALLOW } from '../lib/autopilot.mjs';
import { startServer } from '../../tools/factory-ui/server.mjs';

const REF = 'chat/questions';
const LOGS = 'Bash(gcloud logging read:*)';
const GCLOUD = "gcloud logging read 'jsonPayload.message=\"[weeklyReport] done\"' --project=p --format=json | head -50";
const UI_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../tools/factory-ui');

async function soloThread(t, extra = {}) {
  const { root } = await useRoot(t);
  const store = openStore({ root });
  await store.createThread({ as: 'fable', ref: REF, title: 'What customers asked', kind: 'solo', ...extra });
  return { root, store };
}

/** Open turns of a member in the thread: [{id, kind}]. */
const turnsOf = (store, member) => store.openTurns({ member, thread: REF }).map((x) => ({ id: x.message.id, kind: x.message.kind ?? null, type: x.message.type }));
const cardsIn = (store) => store.threadView(REF).messages.filter((m) => m.type === 'event' && m.event.kind === 'permission_denied');

test('suggestAllowRules: one prefix rule per part of a command that is not read-only', () => {
  assert.deepEqual(suggestAllowRules(GCLOUD), [LOGS], 'the quoted filter ends the prefix; head is read-only');
  assert.deepEqual(suggestAllowRules('npm --prefix api run report:weekly -- --days 7'), ['Bash(npm --prefix api run report:weekly:*)']);
  assert.deepEqual(suggestAllowRules('cd /x && node -e "console.log(1)"'), ['Bash(node:*)'], 'cd is read-only; a trailing flag is dropped');
  assert.deepEqual(suggestAllowRules('FOO=1 gcloud logging read x'), ['Bash(gcloud logging read x:*)'], 'an env assignment is not part of the rule');
  assert.deepEqual(suggestAllowRules('git log --oneline | wc -l'), [], 'read-only git needs no rule');
  assert.deepEqual(suggestAllowRules('cat a.txt; grep x b.txt'), []);
  assert.deepEqual(suggestAllowRules('gcloud logging read a; gcloud logging read b'), ['Bash(gcloud logging read a:*)', 'Bash(gcloud logging read b:*)']);
  assert.deepEqual(suggestAllowRules('"quoted" thing'), []);
  assert.deepEqual(suggestAllowRules(''), []);
  assert.deepEqual(shellSegments("a 'x | y' | b && c; d\ne"), ["a 'x | y'", 'b', 'c', 'd', 'e'], 'quoted separators stay inside their part');
});

test('allowRuleRisk: any code, broad, changes, or nothing to flag', () => {
  const level = (r) => allowRuleRisk(r)?.level ?? null;
  for (const r of ['Bash(node:*)', 'Bash(node -e:*)', 'Bash(python3 -c:*)', 'Bash(npx:*)', 'Bash(npm run:*)', 'Bash(npm install:*)', 'Bash(env FOO=1 ls:*)', 'Bash(xargs:*)', 'Bash(bash:*)']) {
    assert.equal(level(r), 'any', r);
  }
  for (const r of ['Bash(gcloud:*)', 'Bash(git:*)', 'Bash(kubectl:*)']) assert.equal(level(r), 'broad', r);
  for (const r of ['Bash(curl:*)', 'Bash(git push:*)', 'Bash(gcloud firestore documents delete:*)', 'Bash(rm -rf build:*)']) assert.equal(level(r), 'changes', r);
  for (const r of [LOGS, 'Bash(npm --prefix api run report:weekly:*)', 'Bash(npm test:*)', 'Bash(node scripts/x.mjs:*)', 'Bash(git log:*)', 'Read', 'Bash(ls:*)']) {
    assert.equal(level(r), null, r);
  }
  assert.match(allowRuleRisk('Bash(node:*)').text, /run any code/);
});

test('deniedIn reads the refused tool calls from a stream-json result line', () => {
  assert.deepEqual(deniedIn({ type: 'result', permission_denials: [{ tool_name: 'Bash', tool_use_id: 'x', tool_input: { command: GCLOUD } }, { tool_name: 'WebFetch', tool_input: { url: 'u' } }, null, { nope: 1 }] }), [
    { tool: 'Bash', command: GCLOUD, input: { command: GCLOUD } },
    { tool: 'WebFetch', input: { url: 'u' } },
  ]);
  assert.deepEqual(deniedIn(null), []);
  assert.deepEqual(deniedIn({ type: 'result' }), []);
});

test('notePermissionDenied: one card to you with the refused command and its rule; read-only, allowed or foreign refusals ask nothing', async (t) => {
  const { store } = await soloThread(t);
  const q = await store.post({ as: 'you', ref: REF, type: 'question', to: ['opus-solo'], body: 'What did customers ask last week?' });
  // Not the thread's agent, read-only, or a tool with no rule to suggest: nothing to ask.
  assert.equal(store.notePermissionDenied({ ref: REF, member: 'openai', denials: [{ tool: 'Bash', command: GCLOUD }] }).event, null);
  assert.equal(store.notePermissionDenied({ ref: REF, member: 'opus-solo', denials: [{ tool: 'Bash', command: 'cat x | head' }] }).event, null);
  assert.equal(store.notePermissionDenied({ ref: REF, member: 'opus-solo', denials: [{ tool: 'WebFetch', input: { url: 'u' } }] }).event, null);
  assert.equal(cardsIn(store).length, 0);

  const ev = store.notePermissionDenied({ ref: REF, member: 'opus-solo', denials: [{ tool: 'Bash', command: GCLOUD }, { tool: 'Bash', command: GCLOUD }], turns: [q.message.id, 'nope'] }).event;
  assert.equal(ev.from, 'factory');
  assert.deepEqual(ev.to, ['you']);
  assert.deepEqual(ev.refs, [q.message.id], 'only turns that exist');
  assert.equal(ev.event.kind, 'permission_denied');
  assert.equal(ev.event.by, 'opus-solo');
  assert.deepEqual(ev.event.commands, [{ tool: 'Bash', command: GCLOUD }], 'one entry per command');
  assert.deepEqual(ev.event.rules, [{ rule: LOGS, risk: null }]);
  assert.match(ev.body, /\*\*opus-solo\*\* was refused a command/);
  assert.match(ev.body, /thread set chat\/questions --add-allow "Bash\(gcloud logging read:\*\)" --as you/);
  assert.deepEqual(turnsOf(store, 'you').filter((x) => x.kind === 'permission_denied').map((x) => x.id), [ev.id], 'you hold the card');
  assert.equal(store.validate().ok, true, JSON.stringify(store.validate().errors));

  // A second refusal adds its rule to one open card and closes the older one.
  const ev2 = store.notePermissionDenied({ ref: REF, member: 'opus-solo', denials: [{ tool: 'Bash', command: 'node -e "x"' }] }).event;
  assert.deepEqual(ev2.event.rules.map((r) => r.rule), [LOGS, 'Bash(node:*)']);
  assert.equal(ev2.event.rules[1].risk.level, 'any');
  assert.deepEqual(ev2.resolves, [ev.id]);
  assert.deepEqual(turnsOf(store, 'you').filter((x) => x.kind === 'permission_denied').map((x) => x.id), [ev2.id]);

  // Once allowed (here, by the team), the same refusal asks nothing new.
  store.editTeam({ as: 'you', id: 'chat', allowAdd: [LOGS] });
  assert.equal(store.notePermissionDenied({ ref: REF, member: 'opus-solo', denials: [{ tool: 'Bash', command: GCLOUD }] }).event, null);

  // A project thread never gets one.
  await store.createThread({ as: 'fable', ref: 'chat/proj', title: 'P' });
  assert.equal(store.notePermissionDenied({ ref: 'chat/proj', member: 'opus-solo', denials: [{ tool: 'Bash', command: GCLOUD }] }).event, null);
});

test('thread set --add-allow / --remove-allow change the list; risky rules print a note; the agent still cannot change its own', async (t) => {
  const { root, store } = await soloThread(t, { allow: [LOGS] });
  const add = runCli(['thread', 'set', REF, '--add-allow', 'Bash(node:*)', '--add-allow', 'Bash(npm test:*)', '--as', 'you'], { root });
  assertExit(add, 0);
  assert.match(add.stdout, /allowed `Bash\(node:\*\)`; `Bash\(npm test:\*\)`/);
  assert.match(add.stdout, /note: Bash\(node:\*\): `node` runs whatever code it is given/);
  assert.doesNotMatch(add.stdout, /note: Bash\(npm test/);
  assert.deepEqual(openStore({ root }).thread(REF).allow, [LOGS, 'Bash(node:*)', 'Bash(npm test:*)']);
  const rm = runCli(['thread', 'set', REF, '--remove-allow', 'Bash(node:*)', '--as', 'fable'], { root });
  assertExit(rm, 0);
  assert.match(rm.stdout, /stopped allowing `Bash\(node:\*\)`/);
  assert.deepEqual(openStore({ root }).thread(REF).allow, [LOGS, 'Bash(npm test:*)']);
  const missing = runCli(['thread', 'set', REF, '--remove-allow', 'Bash(node:*)', '--as', 'you'], { root });
  assertExit(missing, 1);
  assert.match(missing.stderr, /does not allow "Bash\(node:\*\)"/);
  const both = runCli(['thread', 'set', REF, '--allow', LOGS, '--add-allow', 'Read', '--as', 'you'], { root });
  assertExit(both, 2);
  assert.match(both.stderr, /--allow replaces the whole list/);
  const bad = runCli(['thread', 'set', REF, '--add-allow', 'Bash(:*)', '--as', 'you'], { root });
  assertExit(bad, 2);
  assert.match(bad.stderr, /--add-allow "Bash\(:\*\)": it allows every shell command/);
  assert.throws(() => store.setThreadConfig({ as: 'opus-solo', ref: REF, allowAdd: ['Bash(node:*)'] }), /opus-solo cannot thread set its own thread/);
  assert.throws(() => store.setThreadConfig({ as: 'openai', ref: REF, allowAdd: ['Bash(node:*)'] }), /is for the thread lead/);
  const ev = store.threadView(REF).messages.filter((m) => m.type === 'event' && m.event.kind === 'thread_config').at(-1);
  assert.match(ev.body, /stopped allowing/);
});

test('team allow: every single-agent thread of the team may run it, on top of its own list; shown, validated, and used by runs', async (t) => {
  const { root, store } = await soloThread(t, { allow: ['Bash(npm test:*)'] });
  const add = runCli(['team', 'edit', 'chat', '--add-allow', LOGS, '--add-allow', 'Bash(gcloud:*)', '--as', 'fable'], { root });
  assertExit(add, 0);
  assert.match(add.stdout, /Updated team chat: allow/);
  assert.match(add.stdout, /note: Bash\(gcloud:\*\): it covers every `gcloud` command/);
  assert.deepEqual(store.teamAllow('chat'), [LOGS, 'Bash(gcloud:*)']);
  assert.deepEqual(store.soloAllow(REF), [LOGS, 'Bash(gcloud:*)', 'Bash(npm test:*)']);
  const v = store.threadView(REF);
  assert.deepEqual(v.allowRules.map((r) => [r.rule, r.scope, r.risk?.level ?? null]), [[LOGS, 'team', null], ['Bash(gcloud:*)', 'team', 'broad'], ['Bash(npm test:*)', 'thread', null]]);
  assert.match(runCli(['thread', 'show', REF], { root }).stdout, /allowed commands beyond the factory CLI and read-only tools: Bash\(npm test:\*\); for the whole team: Bash\(gcloud logging read:\*\), Bash\(gcloud:\*\)/);
  assert.equal(store.validate().ok, true, JSON.stringify(store.validate().errors));

  assertExit(runCli(['team', 'edit', 'chat', '--remove-allow', 'Bash(gcloud:*)', '--as', 'you'], { root }), 0);
  assert.deepEqual(openStore({ root }).teamAllow('chat'), [LOGS]);
  assertExit(runCli(['team', 'edit', 'chat', '--add-allow', 'Read', '--clear-allow', '--as', 'you'], { root }), 2);
  assertExit(runCli(['team', 'edit', 'chat', '--add-allow', 'Read', '--as', 'openai'], { root }), 1);
  assert.throws(() => store.editTeam({ as: 'you', id: 'chat', allowAdd: [LOGS] }), /already allows exactly that/);
  assertExit(runCli(['team', 'edit', 'chat', '--clear-allow', '--as', 'you'], { root }), 0);
  assert.deepEqual(openStore({ root }).teamAllow('chat'), []);

  // A hand edit that is not a rule is a validation error, and never reaches a run.
  editFrontmatterFile(path.join(root, 'teams', 'chat', 'team.md'), (d) => { d.allow = ['--dangerously-skip-permissions']; });
  assert.ok(openStore({ root }).validate().errors.some((e) => /allow "--dangerously-skip-permissions": not a permission rule/.test(e.message)));
  // An older team.md with no allow key still validates.
  editFrontmatterFile(path.join(root, 'teams', 'chat', 'team.md'), (d) => { delete d.allow; });
  assert.equal(openStore({ root }).validate().ok, true);
});

/** A stand-in for `claude -p`: logs its argv, tries a refused command (reported in permission_denials), answers its turns. */
function fakeClaude() {
  const dir = makeTempDir('factory-fake-claude-');
  const bin = path.join(dir, 'claude');
  fs.writeFileSync(bin, `#!/usr/bin/env node
import fs from 'node:fs';
import { spawnSync } from 'node:child_process';
const argv = process.argv.slice(2);
const at = (f) => (argv.includes(f) ? argv[argv.indexOf(f) + 1] : null);
const session = at('--resume') || at('--session-id');
fs.appendFileSync(process.env.FAKE_CLAUDE_CALLS, JSON.stringify({ argv }) + '\\n');
console.log(JSON.stringify({ type: 'system', subtype: 'init', session_id: session }));
const cli = process.env.FAKE_FACTORY_CLI;
const root = process.cwd();
const me = process.env.FACTORY_ACTOR;
const turns = JSON.parse(spawnSync(process.execPath, [cli, 'inbox', me, '--json', '--root', root], { encoding: 'utf8' }).stdout);
for (const t of turns) spawnSync(process.execPath, [cli, 'post', t.team + '/' + t.thread, '--type', 'answer', '--reply-to', t.message.id, '--to', 'you', '--body', 'Not done: the logs read was refused.', '--root', root], { encoding: 'utf8' });
const denied = process.env.FAKE_CLAUDE_DENY ? [{ tool_name: 'Bash', tool_use_id: 'toolu_1', tool_input: { command: process.env.FAKE_CLAUDE_DENY } }] : [];
console.log(JSON.stringify({ type: 'result', subtype: 'success', session_id: session, total_cost_usd: 0.01, result: 'Answered.', permission_denials: denied }));
`);
  fs.chmodSync(bin, 0o755);
  const calls = path.join(dir, 'calls.jsonl');
  const env = (deny) => ({ FACTORY_CLAUDE_BIN: bin, FACTORY_CODEX_BIN: path.join(dir, 'no-codex'), FAKE_CLAUDE_CALLS: calls, FAKE_FACTORY_CLI: CLI_PATH, ...(deny ? { FAKE_CLAUDE_DENY: deny } : {}) });
  const runs = () => (fs.existsSync(calls) ? fs.readFileSync(calls, 'utf8').trim().split('\n').filter(Boolean).map((l) => JSON.parse(l)) : []);
  return { env, runs };
}

test('autopilot: a refused command becomes a card for you; after Allow the next run gets the rule (team rules too)', async (t) => {
  const { root, store } = await soloThread(t);
  const fake = fakeClaude();
  const q = await store.post({ as: 'you', ref: REF, type: 'question', to: ['opus-solo'], body: 'What did customers ask?' });
  const first = runCli(['autopilot', '--once', '--settle', '0s'], { root, env: fake.env(GCLOUD) });
  assertExit(first, 0);
  const s = openStore({ root });
  const [card] = cardsIn(s);
  assert.ok(card, 'a permission card was posted');
  assert.deepEqual(card.event.rules.map((r) => r.rule), [LOGS]);
  assert.deepEqual(card.refs, [q.message.id]);
  assert.equal(s.autopilot().members['opus-solo'].last.denied, 1);
  assert.match(first.stdout + first.stderr, /opus-solo was refused 1 command on chat\/questions; asked you on the board/);

  // The owner allows it (thread) and the team allows another; the next run gets both, team rules first.
  s.setThreadConfig({ as: 'you', ref: REF, allowAdd: [LOGS] });
  s.editTeam({ as: 'you', id: 'chat', allowAdd: ['Bash(npm test:*)'] });
  await s.post({ as: 'you', ref: REF, type: 'question', to: ['opus-solo'], body: 'Carry on.' });
  assertExit(runCli(['autopilot', '--once', '--settle', '0s'], { root, env: fake.env() }), 0);
  const last = fake.runs().at(-1).argv;
  const rules = last.filter((x) => x.startsWith('--allowedTools=')).map((x) => x.slice('--allowedTools='.length));
  assert.deepEqual(rules, [...CLAUDE_BASE_ALLOW, 'Bash(npm test:*)', LOGS]);
  assert.equal(cardsIn(openStore({ root })).length, 1, 'a run with nothing refused posts no card');
});

// ---------------------------------------------------------------------------
// The board: answering a card, and editing the list
// ---------------------------------------------------------------------------

function request(port, method, pathname, { headers = {}, body } = {}) {
  return new Promise((resolve, reject) => {
    const payload = body === undefined ? null : JSON.stringify(body);
    const req = http.request({
      host: '127.0.0.1', port, method, path: pathname,
      headers: { ...(payload != null ? { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(payload) } : {}), ...headers },
    }, (res) => {
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => {
        const text = Buffer.concat(chunks).toString('utf8');
        let json = null;
        try {
          json = JSON.parse(text);
        } catch {
          json = null;
        }
        resolve({ status: res.statusCode, json });
      });
    });
    req.on('error', reject);
    if (payload != null) req.write(payload);
    req.end();
  });
}

async function board(t, extra) {
  const ctx = await soloThread(t, extra);
  const srv = await startServer({ root: ctx.root, port: 0, warn: () => {} });
  t.after(() => srv.close());
  const port = Number(new URL(srv.url).port);
  const write = (p, body, headers = { 'X-Factory-UI': '1' }) => request(port, 'POST', p, { body, headers });
  return { ...ctx, write, port };
}

test('board: Allow adds the rule and asks the agent to carry on; a risky rule needs confirm; Don\'t allow closes the card without starting it', async (t) => {
  const { store, root, write } = await board(t);
  const q = await store.post({ as: 'you', ref: REF, type: 'question', to: ['opus-solo'], body: 'What did customers ask?' });
  await store.post({ as: 'opus-solo', ref: REF, type: 'answer', reply_to: q.message.id, to: ['you'], body: 'Refused.' });
  const card = store.notePermissionDenied({ ref: REF, member: 'opus-solo', denials: [{ tool: 'Bash', command: GCLOUD }], turns: [q.message.id] }).event;

  // Guarded like every board write.
  assert.equal((await write('/api/permission', { ref: REF, event: card.id, action: 'allow', rules: [LOGS] }, { 'X-Factory-UI': '1', Origin: 'http://evil.example' })).status, 403);
  assert.equal((await write('/api/permission', { ref: REF, event: card.id, action: 'allow', rules: [LOGS] }, {})).status, 403);
  // Not a permission card, unknown, or a bad rule.
  assert.equal((await write('/api/permission', { ref: REF, event: q.message.id, action: 'allow', rules: [LOGS] })).status, 404);
  assert.equal((await write('/api/permission', { ref: REF, event: '20991231T000000Z-you-0000', action: 'allow', rules: [LOGS] })).status, 404);
  assert.equal((await write('/api/permission', { ref: REF, event: card.id, action: 'allow', rules: ['Bash(:*)'] })).status, 400);
  assert.equal((await write('/api/permission', { ref: REF, event: card.id, action: 'allow', rules: 'Bash(x:*)' })).status, 400, 'rules is a list');
  assert.equal((await write('/api/permission', { ref: REF, event: card.id, action: 'maybe' })).status, 400);

  // A rule that runs any code: refused until confirmed, and nothing changes meanwhile.
  const risky = await write('/api/permission', { ref: REF, event: card.id, action: 'allow', rules: ['Bash(node:*)'] });
  assert.equal(risky.status, 409);
  assert.equal(risky.json.code, 'confirm');
  assert.match(risky.json.error, /lets the agent run any code.*Allow anyway\?/);
  assert.deepEqual(openStore({ root }).thread(REF).allow, []);

  // Allow: the rule is added, a request goes to the agent (so the autopilot starts it), and the card closes.
  const ok = await write('/api/permission', { ref: REF, event: card.id, action: 'allow', rules: [LOGS] });
  assert.equal(ok.status, 200, JSON.stringify(ok.json));
  const s = openStore({ root });
  assert.deepEqual(s.thread(REF).allow, [LOGS]);
  const ask = s.message(ok.json.message.id);
  assert.equal(ask.type, 'question');
  assert.deepEqual(ask.to, ['opus-solo']);
  assert.deepEqual(ask.refs, [card.id, q.message.id]);
  assert.match(ask.body, /Allowed `Bash\(gcloud logging read:\*\)` on this thread\. Carry on/);
  assert.deepEqual(turnsOf(s, 'you').filter((x) => x.kind === 'permission_denied'), [], 'the card is closed');
  assert.deepEqual(turnsOf(s, 'opus-solo').map((x) => x.id), [ask.id], 'the agent has the request');
  assert.equal(s.validate().ok, true, JSON.stringify(s.validate().errors));

  // Don't allow: a note to nobody closes the next card; the agent is not started.
  const card2 = s.notePermissionDenied({ ref: REF, member: 'opus-solo', denials: [{ tool: 'Bash', command: 'node -e "x"' }] }).event;
  const no = await write('/api/permission', { ref: REF, event: card2.id, action: 'deny' });
  assert.equal(no.status, 200);
  const s2 = openStore({ root });
  const note = s2.message(no.json.message.id);
  assert.equal(note.type, 'note');
  assert.deepEqual(note.to, []);
  assert.match(note.body, /Not allowed: `Bash\(node:\*\)`/);
  assert.deepEqual(turnsOf(s2, 'you').filter((x) => x.kind === 'permission_denied'), []);
  assert.deepEqual(turnsOf(s2, 'opus-solo').map((x) => x.id), [ask.id], 'no new request for the agent');

  // Confirmed risky rule, for the whole team.
  const card3 = s2.notePermissionDenied({ ref: REF, member: 'opus-solo', denials: [{ tool: 'Bash', command: 'gcloud --project=x logging read y' }] }).event;
  const team = await write('/api/permission', { ref: REF, event: card3.id, action: 'allow', rules: ['Bash(gcloud:*)'], scope: 'team', confirm: true });
  assert.equal(team.status, 200, JSON.stringify(team.json));
  assert.equal(team.json.scope, 'team');
  const s3 = openStore({ root });
  assert.deepEqual(s3.teamAllow('chat'), ['Bash(gcloud:*)']);
  assert.deepEqual(s3.thread(REF).allow, [LOGS], 'the thread list is unchanged');
  assert.match(s3.message(team.json.message.id).body, /for every single-agent thread in /);
  assert.deepEqual(turnsOf(s3, 'you').filter((x) => x.kind === 'permission_denied'), [], 'the team grant also closes the card');
});

test('board: /api/allow adds and removes rules for the thread or the team, single-agent threads only', async (t) => {
  const { store, root, write } = await board(t, { allow: [LOGS] });
  assert.equal((await write('/api/allow', { ref: REF, add: ['Bash(npm test:*)'] }, { 'X-Factory-UI': '1', 'Sec-Fetch-Site': 'cross-site' })).status, 403);
  const added = await write('/api/allow', { ref: REF, add: ['Bash(npm test:*)'] });
  assert.equal(added.status, 200, JSON.stringify(added.json));
  assert.deepEqual(added.json.thread, [LOGS, 'Bash(npm test:*)']);
  const risky = await write('/api/allow', { ref: REF, add: ['Bash(curl:*)'] });
  assert.equal(risky.status, 409);
  assert.equal(risky.json.code, 'confirm');
  assert.equal((await write('/api/allow', { ref: REF, add: ['Bash(curl:*)'], scope: 'team', confirm: true })).status, 200);
  assert.deepEqual(openStore({ root }).teamAllow('chat'), ['Bash(curl:*)']);
  const removed = await write('/api/allow', { ref: REF, remove: ['Bash(curl:*)'], scope: 'team' });
  assert.equal(removed.status, 200);
  assert.deepEqual(removed.json.team, []);
  assert.equal((await write('/api/allow', { ref: REF, remove: ['Bash(curl:*)'] })).status, 404, 'not on the thread list');
  assert.equal((await write('/api/allow', { ref: REF })).status, 400);
  await store.createThread({ as: 'fable', ref: 'chat/proj', title: 'P' });
  assert.equal((await write('/api/allow', { ref: 'chat/proj', add: ['Bash(npm test:*)'] })).status, 400);
});

/** app.js in a VM: its pure render helpers, the page never starts. */
function loadPage() {
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

test('page: the card shows even with events hidden, offers Allow while open and shows the outcome once answered; the banner names it', async (t) => {
  const { store } = await soloThread(t);
  const card = store.notePermissionDenied({ ref: REF, member: 'opus-solo', denials: [{ tool: 'Bash', command: 'node -e "x"' }] }).event;
  const page = loadPage();
  page.state.showEvents = false;
  const text = (entries) => entries.map((e) => String(e.html)).join('\n');
  const open = text(page.messageEntries(store.threadView(REF)));
  assert.match(open, /needs permission/);
  assert.match(open, /data-act="perm-allow"/);
  assert.match(open, /value="Bash\(node:\*\)"/);
  assert.match(open, /class="risk any"/);
  assert.match(open, /node -e &quot;x&quot;/);
  const held = page.heldItems([{ ...store.thread(REF), team: 'chat' }], () => store.threadView(REF).openTurns);
  assert.equal(held.filter((h) => h.member === 'you').map((h) => h.what).join('|'), 'permission request');

  store.setThreadConfig({ as: 'you', ref: REF, allowAdd: ['Bash(node:*)'] });
  const done = text(page.messageEntries(store.threadView(REF)));
  assert.doesNotMatch(done, /data-act="perm-allow"/);
  assert.match(done, /perm-ok/);
  const editor = String(page.allowEditor(store.threadView(REF)));
  assert.match(editor, /data-act="allow-remove" data-rule="Bash\(node:\*\)" data-scope="thread"/);
  assert.match(editor, /class="risk any"/);
  void card;
});
