// CLI: --json, exit codes, bodies, env vars, repeated flags, human output, worktree.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import { spawn, spawnSync } from 'node:child_process';
import {
  plain, useRoot, projectCtx, setupTeam, makeTempDir, runCli, cliFor, assertExit, threadTasks, threadIssues, driveTo,
  CLI_PATH, FACTORY_DIR, editFrontmatterFile,
} from './helpers.mjs';

const REF = 'checkout/checkout-v2';

function assertFactoryStderr(res) {
  assert.ok(res.stderr.startsWith('factory: '), `stderr starts with "factory: "\n--- stderr ---\n${res.stderr}`);
}

async function notes(store, ref = REF) {
  return (await store.messages(ref)).filter((m) => m.type === 'note');
}

test('init on an empty directory needs no --as, creates the layout, and is idempotent', async (t) => {
  const dir = makeTempDir('factory-cli-init-');
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  let r = runCli(['init'], { root: dir });
  assertExit(r, 0);
  for (const f of ['teams/README.md', 'teams/.gitignore', 'factory/members.yaml', 'factory/templates/team.md',
    'factory/templates/thread-project.md', 'factory/templates/thread-watch.md']) {
    assert.ok(fs.existsSync(path.join(dir, f)), `${f} exists`);
  }
  const members = fs.readFileSync(path.join(dir, 'factory', 'members.yaml'), 'utf8');
  r = runCli(['init'], { root: dir });
  assertExit(r, 0);
  assert.equal(fs.readFileSync(path.join(dir, 'factory', 'members.yaml'), 'utf8'), members);
  r = runCli(['init', '--json'], { root: dir });
  assertExit(r, 0);
  r.json();
});

test('--json prints exactly one JSON document for reads and writes', async (t) => {
  const ctx = await useRoot(t);
  const cli = cliFor(ctx);
  let r = cli(['team', 'new', 'checkout', '--title', 'Checkout', '--lead', 'fable', '--as', 'you', '--json']);
  assertExit(r, 0);
  assert.ok(Array.isArray(r.json().events), 'write results carry events');
  r = cli(['thread', 'new', REF, '--title', 'Checkout v2', '--as', 'fable', '--json']);
  assertExit(r, 0);
  const created = r.json();
  assert.ok(Array.isArray(created.events));
  assert.ok(created.events.some((e) => e.event && e.event.kind === 'thread_created'), 'thread_created among the events');

  r = cli(['members', '--json']);
  assertExit(r, 0);
  const members = r.json();
  const list = Array.isArray(members) ? members : members.members;
  assert.ok(list.some((m) => m.id === 'fable'));

  r = cli(['board', '--json']);
  assertExit(r, 0);
  const board = r.json();
  assert.ok(Array.isArray(board.teams));
  assert.ok(board.teams[0].threads.some((x) => x.id === 'checkout-v2'));

  r = cli(['inbox', 'fable', '--json']);
  assertExit(r, 0);
  const inbox = r.json();
  assert.ok(Array.isArray(inbox), 'inbox --json is the openTurns array');
  assert.ok(inbox.some((x) => x.message && x.message.from === 'factory'));

  for (const args of [['team', 'list'], ['thread', 'list'], ['thread', 'show', REF], ['log', REF], ['turns', REF],
    ['task', 'list', REF], ['issue', 'list', REF], ['watch', 'due'], ['worktree', REF]]) {
    r = cli([...args, '--json']);
    assertExit(r, 0);
    r.json();
  }
  r = cli(['validate', '--json']);
  assertExit(r, 0);
  const v = r.json();
  assert.equal(v.ok, true);
  assert.deepEqual(v.errors, []);
});

test('usage errors exit 2', async (t) => {
  const ctx = await projectCtx(t);
  const cli = cliFor(ctx);
  for (const args of [
    ['frobnicate'],
    ['team', 'new', 'payments', '--as', 'you'],
    ['review', REF, '--verdict', 'maybe', '--as', 'you'],
    ['advance', REF, '--as', 'fable'],
  ]) {
    const r = cli(args);
    assertExit(r, 2);
  }
  const r = cli(['review', REF, '--verdict', 'approve', '--point', 'high: Must fix', '--as', 'you']);
  assertExit(r, 2);
  assert.match(r.stderr, /changes_requested/);
  assert.equal((await ctx.store.thread(REF)).phase, 'brief');
});

test('permission and not-found errors exit 1 with "factory: " on stderr', async (t) => {
  const ctx = await projectCtx(t);
  const cli = cliFor(ctx);
  const before = (await ctx.store.messages(REF)).length;
  for (const args of [
    ['post', REF, '--type', 'note', '--body', 'hi', '--as', 'factory'],
    ['post', REF, '--type', 'note', '--body', 'hi', '--as', 'mallory'],
    ['post', REF, '--type', 'event', '--body', 'fake', '--as', 'fable'],
    ['task', 'new', REF, '--title', 'Rogue', '--as', 'opus-1'],
    ['review', REF, '--verdict', 'approve', '--as', 'openai'],
    ['decide', REF, '--title', 'Lead override', '--gate', 'brief', '--verdict', 'approve', '--as', 'fable'],
    ['thread', 'show', 'checkout/nope'],
  ]) {
    const r = cli(args);
    assertExit(r, 1);
    assertFactoryStderr(r);
  }
  assert.equal((await ctx.store.messages(REF)).length, before, 'refused commands write nothing');
  const missingAs = cli(['post', REF, '--type', 'note', '--body', 'who?']);
  assert.ok(missingAs.code === 1 || missingAs.code === 2, `a write without --as fails (exit ${missingAs.code})`);
});

test('bodies come from --body, --body-file or piped stdin', async (t) => {
  const ctx = await projectCtx(t);
  const cli = cliFor(ctx);
  assertExit(cli(['post', REF, '--type', 'note', '--body', 'alpha from flag', '--as', 'fable']), 0);
  const file = path.join(ctx.root, 'body-input.md');
  fs.writeFileSync(file, '# Beta\n\nbeta from file\n');
  assertExit(cli(['post', REF, '--type', 'note', '--body-file', file, '--as', 'fable']), 0);
  assertExit(cli(['post', REF, '--type', 'note', '--as', 'fable'], { input: 'gamma from stdin\n' }), 0);
  const bodies = (await notes(ctx.store)).map((m) => m.body);
  assert.ok(bodies.some((b) => b.includes('alpha from flag')), 'body from --body');
  assert.ok(bodies.some((b) => b.includes('beta from file') && b.includes('# Beta')), 'body from --body-file');
  assert.ok(bodies.some((b) => b.includes('gamma from stdin')), 'body from stdin');
});

test('$FACTORY_AS, $FACTORY_ROOT and $FACTORY_NOW are honoured; --as beats $FACTORY_AS', async (t) => {
  const ctx = await projectCtx(t);
  let r = runCli(['post', REF, '--type', 'note', '--body', 'env driven', '--json'], {
    env: { FACTORY_ROOT: ctx.root, FACTORY_AS: 'fable', FACTORY_NOW: '2031-06-15T08:09:10.123Z' },
  });
  assertExit(r, 0);
  r.json();
  const note = (await notes(ctx.store)).find((m) => m.body.includes('env driven'));
  assert.ok(note, 'the note landed in the FACTORY_ROOT root');
  assert.equal(note.from, 'fable');
  assert.ok(note.ts.startsWith('2031-06-15T08:09:10.'), `ts follows FACTORY_NOW (${note.ts})`);
  assert.ok(note.id.startsWith('20310615T080910Z-fable-'), `id follows FACTORY_NOW (${note.id})`);

  r = runCli(['post', REF, '--type', 'note', '--body', 'flag wins', '--as', 'opus-2'], {
    root: ctx.root, env: { FACTORY_AS: 'opus-1', FACTORY_NOW: '2031-06-15T08:10:00.000Z' },
  });
  assertExit(r, 0);
  assert.equal((await notes(ctx.store)).find((m) => m.body.includes('flag wins')).from, 'opus-2');

  r = runCli(['post', REF, '--type', 'question', '--to', 'fable', '--body', 'env question', '--as', 'opus-2'], { root: ctx.root });
  assertExit(r, 0);
  r = runCli(['inbox'], { root: ctx.root, env: { FACTORY_AS: 'fable' } });
  assertExit(r, 0);
  assert.match(r.stdout, /checkout-v2/, 'inbox defaults to $FACTORY_AS');
});

test('review --point, respond --stance and the task commands drive the loop', async (t) => {
  const ctx = await projectCtx(t);
  const { store } = ctx;
  const cli = cliFor(ctx);
  assertExit(cli(['review', REF, '--verdict', 'approve', '--body', 'Brief ok', '--as', 'you']), 0);
  assert.equal((await store.thread(REF)).phase, 'design');
  assertExit(cli(['advance', REF, '--body', 'Design ready', '--as', 'fable']), 0);
  assert.equal((await store.thread(REF)).phase, 'design_review');
  assertExit(cli(['review', 'checkout-v2', '--verdict', 'changes_requested', '--point', 'high: Retry loop has no backoff',
    '--point', 'low: Rename the helper', '--as', 'openai']), 0);
  const review = (await store.messages(REF)).filter((m) => m.type === 'review').at(-1);
  assert.equal(review.gate, 'design_review');
  assert.deepEqual(plain(review.points), [
    { n: 1, severity: 'high', text: 'Retry loop has no backoff' },
    { n: 2, severity: 'low', text: 'Rename the helper' },
  ]);

  assertExit(cli(['respond', 'checkout-v2', '--stance', '1=accepted: Add exponential backoff',
    '--stance', '2=rejected: Name matches the module', '--as', 'fable']), 0);
  const response = (await store.messages(REF)).filter((m) => m.type === 'review_response').at(-1);
  assert.equal(response.reply_to, review.id, 'respond without --review answers the latest review');
  assert.deepEqual(plain(response.stances), [
    { point: 1, stance: 'accepted', action: 'Add exponential backoff' },
    { point: 2, stance: 'rejected', reason: 'Name matches the module' },
  ]);
  assert.equal((await store.thread(REF)).phase, 'design');
  const [task] = await threadTasks(store, REF);
  assert.equal(task.title, 'Add exponential backoff');
  assert.equal(task.issue, 'I-001');

  let r = cli(['task', 'list', 'checkout-v2']);
  assertExit(r, 0);
  assert.match(r.stdout, /T-001/);
  assert.match(r.stdout, /Add exponential backoff/);
  r = cli(['issue', 'list', 'checkout-v2']);
  assertExit(r, 0);
  assert.match(r.stdout, /I-001/);
  assert.match(r.stdout, /I-002/);

  assertExit(cli(['dispatch', 'T-001', '--to', 'opus-1', '--body', 'Yours', '--as', 'fable']), 0);
  assertExit(cli(['result', 'T-001', '--outcome', 'done', '--body', 'Backoff added', '--as', 'opus-1']), 0);
  assertExit(cli(['task', 'accept', 'checkout/T-001', '--as', 'fable']), 0);
  assert.equal((await store.task('checkout/T-001')).status, 'done');
  assert.equal((await store.issue('checkout/I-001')).status, 'fixed');
  assertExit(cli(['advance', 'checkout-v2', '--as', 'fable']), 0);
  assert.equal((await store.thread(REF)).phase, 'design_review');

  assertExit(cli(['issue', 'new', REF, '--severity', 'medium', '--title', 'Spinner never stops', '--as', 'opus-2']), 0);
  assertExit(cli(['issue', 'defer', 'I-003', '--reason', 'Next sprint', '--as', 'fable']), 0);
  assert.equal((await store.issue('checkout/I-003')).status, 'deferred');
  assertExit(cli(['decide', REF, '--title', 'Hosted checkout', '--body', 'Simpler', '--as', 'you']), 0);
  assert.equal((await store.decisions('checkout'))[0].title, 'Hosted checkout');
  const issues = await threadIssues(store, REF);
  assert.equal(issues.length, 3);
});

test('thread new --kind watch parses --threshold; watch run/pause via the CLI', async (t) => {
  const ctx = await useRoot(t);
  await setupTeam(ctx);
  const { store } = ctx;
  const cli = cliFor(ctx);
  assertExit(cli(['thread', 'new', 'checkout/checkout-health', '--title', 'Checkout health', '--kind', 'watch',
    '--owner', 'opus-monitor', '--cadence', 'daily', '--threshold', 'error_rate<=0.02', '--threshold', 'success_rate>=0.98',
    '--as', 'fable']), 0);
  const th = await store.thread('checkout/checkout-health');
  assert.equal(th.kind, 'watch');
  assert.equal(th.owner, 'opus-monitor');
  assert.equal(th.cadence, 'daily');
  assert.deepEqual(plain(th.thresholds), { error_rate: { max: 0.02 }, success_rate: { min: 0.98 } });

  let r = cli(['watch', 'due', '--json']);
  assertExit(r, 0);
  assert.match(r.stdout, /checkout-health/);

  ctx.clock.hours(1);
  assertExit(cli(['watch', 'run', 'checkout-health', '--metrics', '{"error_rate":0.031,"success_rate":0.99}',
    '--note', 'Spike after deploy', '--as', 'opus-monitor']), 0);
  const rows = await store.metrics('checkout/checkout-health');
  assert.equal(rows.length, 1);
  assert.deepEqual(plain(rows[0].breaches), ['error_rate']);

  const metricsFile = path.join(ctx.root, 'run-metrics.json');
  fs.writeFileSync(metricsFile, JSON.stringify({ error_rate: 0.01, success_rate: 0.99 }));
  ctx.clock.hours(1);
  assertExit(cli(['watch', 'run', 'checkout-health', '--metrics-file', metricsFile, '--as', 'fable']), 0);
  assert.equal((await store.metrics('checkout/checkout-health')).length, 2);

  assertExit(cli(['watch', 'pause', 'checkout-health', '--as', 'fable']), 0);
  assert.equal((await store.thread('checkout/checkout-health')).phase, 'paused');
  r = cli(['watch', 'run', 'checkout-health', '--metrics', '{"error_rate":0.01,"success_rate":0.99}', '--as', 'opus-monitor']);
  assert.notEqual(r.code, 0, 'a paused thread refuses runs');
  assertExit(cli(['watch', 'resume', 'checkout-health', '--as', 'you']), 0);
  assert.equal((await store.thread('checkout/checkout-health')).phase, 'active');
});

test('inbox, log, board, thread show, show, turns and members print the key facts', async (t) => {
  const ctx = await projectCtx(t);
  const { store } = ctx;
  const cli = cliFor(ctx);
  await store.editSection({ as: 'fable', ref: REF, section: 'Brief', body: 'Problem: carts time out at payment.' });
  assertExit(cli(['post', REF, '--type', 'question', '--to', 'openai', '--cc', 'you', '--body', 'Which retry policy should we use?', '--as', 'fable']), 0);
  assertExit(cli(['post', REF, '--type', 'note', '--body', 'Grok checking in', '--as', 'grok']), 0);
  const q = (await store.messages(REF)).find((m) => m.type === 'question');
  assert.deepEqual(plain(q.to), ['openai'], '--to takes a comma list');

  let r = cli(['inbox', 'openai']);
  assertExit(r, 0);
  assert.match(r.stdout, /checkout-v2/);
  assert.match(r.stdout, /fable/);
  assert.ok(r.stdout.includes(q.id) || r.stdout.includes('Which retry policy'), `inbox shows the message\n${r.stdout}`);

  r = cli(['log', REF]);
  assertExit(r, 0);
  const qAt = r.stdout.indexOf('Which retry policy should we use?');
  const nAt = r.stdout.indexOf('Grok checking in');
  assert.ok(qAt >= 0 && nAt >= 0, `log shows both messages\n${r.stdout}`);
  assert.ok(qAt < nAt, 'log is oldest first');
  assert.match(r.stdout, /fable/);
  assert.match(r.stdout, /grok/);

  r = cli(['board']);
  assertExit(r, 0);
  assert.ok(/Checkout v2|checkout-v2/.test(r.stdout), `board names the thread\n${r.stdout}`);
  assert.match(r.stdout, /brief/);

  r = cli(['thread', 'show', REF]);
  assertExit(r, 0);
  assert.match(r.stdout, /Checkout v2/);
  assert.match(r.stdout, /brief/);
  assert.match(r.stdout, /carts time out at payment/);

  r = cli(['thread', 'show', REF, '--section', 'Brief']);
  assertExit(r, 0);
  assert.match(r.stdout, /carts time out at payment/);
  assert.ok(!r.stdout.includes('## Plan'), '--section prints just that section');

  r = cli(['show', q.id]);
  assertExit(r, 0);
  assert.match(r.stdout, /Which retry policy should we use\?/);

  r = cli(['turns', REF]);
  assertExit(r, 0);
  assert.match(r.stdout, /openai/);

  r = cli(['members']);
  assertExit(r, 0);
  for (const id of ['you', 'fable', 'opus-1', 'opus-2', 'opus-monitor', 'openai', 'grok']) assert.match(r.stdout, new RegExp(id));

  await driveTo(ctx, REF, 'build');
  r = cli(['thread', 'list', '--phase', 'build']);
  assertExit(r, 0);
  assert.match(r.stdout, /checkout-v2/);
  r = cli(['thread', 'list', '--kind', 'watch']);
  assertExit(r, 0);
  assert.ok(!r.stdout.includes('checkout-v2'), 'kind filter excludes project threads');
});

test('worktree prints the commands and never runs git', async (t) => {
  const ctx = await projectCtx(t);
  const bin = makeTempDir('factory-cli-fakegit-');
  t.after(() => fs.rmSync(bin, { recursive: true, force: true }));
  const log = path.join(bin, 'git.log');
  fs.writeFileSync(path.join(bin, 'git'), `#!/bin/sh\nprintf '%s\\n' "$*" >> "${log}"\nexit 1\n`, { mode: 0o755 });
  const env = { PATH: `${bin}:${process.env.PATH}`, FACTORY_NOW: ctx.clock.seconds(1).iso() };
  const wtPath = path.join(path.dirname(ctx.root), `${path.basename(ctx.root)}-factory`, 'checkout--checkout-v2');

  let r = runCli(['worktree', REF], { root: ctx.root, env });
  assertExit(r, 0);
  assert.ok(r.stdout.includes('factory/checkout/checkout-v2'), 'prints the branch');
  assert.ok(r.stdout.includes(wtPath), `prints the worktree path ${wtPath}\n${r.stdout}`);
  assert.ok(r.stdout.includes(`git -C ${ctx.root} fetch origin main`), 'prints the fetch command');
  assert.ok(r.stdout.includes(`git -C ${ctx.root} worktree add ${wtPath}`), 'prints the worktree add command');
  assert.match(r.stdout, /main/);

  r = runCli(['worktree', REF, '--json'], { root: ctx.root, env });
  assertExit(r, 0);
  const doc = r.json();
  assert.equal(doc.branch, 'factory/checkout/checkout-v2');
  assert.equal(doc.path, wtPath);
  assert.ok(doc.commands.includes(`git -C ${ctx.root} fetch origin main`), JSON.stringify(doc.commands));
  assert.ok(doc.commands.some((c) => c.startsWith(`git -C ${ctx.root} worktree add ${wtPath} `) && c.includes('factory/checkout/checkout-v2')));
  const stored = await ctx.store.worktreeCommands(REF);
  assert.equal(stored.path, wtPath);
  assert.equal(stored.branch, 'factory/checkout/checkout-v2');

  assert.ok(!fs.existsSync(wtPath), 'no worktree was created');
  const calls = fs.existsSync(log) ? fs.readFileSync(log, 'utf8').split('\n').filter(Boolean) : [];
  for (const c of calls) assert.match(c, /rev-parse/, `only read-only rev-parse may run; saw: git ${c}`);
});

test('help never writes state', async (t) => {
  const ctx = await projectCtx(t);
  const before = (await ctx.store.messages(REF)).length;
  for (const args of [['--help'], ['-h'], ['post', '--help'], ['review', '-h']]) {
    const r = runCli(args, { root: ctx.root });
    assert.ok(`${r.stdout}${r.stderr}`.trim().length > 0, `factory ${args.join(' ')} prints help`);
  }
  assert.equal((await ctx.store.messages(REF)).length, before);
});

test('notification turns in the CLI: no --resolves hint; the inbox footer says notification turns close on the next write; the next write closes them', async (t) => {
  const ctx = await useRoot(t);
  const cli = cliFor(ctx);
  await setupTeam(ctx);
  let r = cli(['thread', 'new', REF, '--title', 'Checkout v2', '--as', 'fable']);
  assertExit(r, 0);
  const created = (await ctx.store.messages(REF)).find((m) => m.type === 'event' && m.event.kind === 'thread_created');
  assert.ok(created, 'thread_created event');
  assert.ok(!r.stdout.includes('--resolves'), `no hint to resolve by hand\n${r.stdout}`);
  assert.ok(!/still holds/.test(r.stdout), r.stdout);

  r = cli(['inbox', 'fable']);
  assertExit(r, 0);
  assert.ok(r.stdout.includes(created.id), 'the lead holds the thread_created turn');
  assert.match(r.stdout, /Event, alert and report turns close by themselves on your next write in that thread/);

  r = cli(['thread', 'edit', REF, '--section', 'Notes', '--body', 'x', '--as', 'fable', '--json']);
  assertExit(r, 0);
  const out = r.json();
  const ev = out.events.find((e) => e.event.kind === 'section_updated');
  assert.deepEqual(ev.resolves, [created.id], 'the section_updated event closes the turn');

  r = cli(['inbox', 'fable']);
  assertExit(r, 0);
  assert.match(r.stdout, /No open turns for fable/);

  r = cli(['post', REF, '--type', 'proposal', '--to', 'you', '--body', 'Brief ready.', '--as', 'fable']);
  assertExit(r, 0);
  r = cli(['inbox', 'you']);
  assertExit(r, 0);
  assert.match(r.stdout, /^you have 1 open turn/m);
});

// ---- flags, help and exit codes ---------------------------------------------

test('repeated flags: list flags accumulate; any other value flag given twice is a usage error', async (t) => {
  const ctx = await projectCtx(t);
  const cli = cliFor(ctx);
  let r = cli(['post', REF, '--type', 'question', '--to', 'openai', '--to', 'grok', '--cc', 'you', '--cc', 'opus-1', '--body', 'Q?', '--as', 'fable', '--json']);
  assertExit(r, 0);
  const msg = r.json().message;
  assert.deepEqual(msg.to, ['openai', 'grok']);
  assert.deepEqual(msg.cc, ['you', 'opus-1']);
  const before = (await ctx.store.tasks()).length;
  r = cli(['task', 'new', REF, '--title', 'One', '--title', 'Two', '--as', 'fable']);
  assertExit(r, 2);
  assert.match(r.stderr, /--title was given twice/);
  assert.equal((await ctx.store.tasks()).length, before);
});

test('--json: help is one JSON document; a bare call is a JSON usage error', async (t) => {
  const ctx = await projectCtx(t);
  let r = runCli(['--json'], { root: ctx.root });
  assertExit(r, 2);
  assert.equal(r.json().code, 'usage');
  r = runCli(['--help', '--json'], { root: ctx.root });
  assertExit(r, 0);
  assert.ok(r.json().commands.some((c) => c.command === 'thread set'));
  r = runCli(['members', '--help', '--json'], { root: ctx.root });
  assertExit(r, 0);
  assert.equal(r.json().command, 'members');
  r = runCli(['help', 'post', '--json'], { root: ctx.root });
  assertExit(r, 0);
  assert.ok(r.json().flags.includes('type'));
});

test('caller input errors exit 2: stances, metric values and thresholds', async (t) => {
  const ctx = await projectCtx(t);
  const cli = cliFor(ctx);
  await driveTo(ctx, REF, 'code_review');
  await ctx.store.review({ as: 'openai', ref: REF, verdict: 'changes_requested', points: [{ severity: 'high', text: 'No backoff' }] });
  for (const stance of ['9=accepted', '1=rejected']) {
    const r = cli(['respond', REF, '--stance', stance, '--as', 'fable']);
    assertExit(r, 2);
  }
  assertExit(cli(['thread', 'new', 'checkout/health', '--title', 'Health', '--kind', 'watch', '--owner', 'opus-monitor',
    '--threshold', 'error_rate<=.5', '--threshold', 'a.b/c<=+1', '--threshold', 'p95_ms<=1e3', '--as', 'fable']), 0);
  assert.deepEqual(plain((await ctx.store.thread('checkout/health')).thresholds), { error_rate: { max: 0.5 }, 'a.b/c': { max: 1 }, p95_ms: { max: 1000 } });
  for (const pair of [['a<=1', 'a<=2'], ['a>=5', 'a<=1']]) {
    const r = cli(['thread', 'new', 'checkout/health-2', '--title', 'H2', '--kind', 'watch', '--owner', 'opus-monitor', '--threshold', pair[0], '--threshold', pair[1], '--as', 'fable']);
    assertExit(r, 2);
  }
  const r = cli(['watch', 'run', 'checkout/health', '--metrics', '{"error_rate":"0.01"}', '--as', 'opus-monitor']);
  assertExit(r, 2);
});

test('a trailing ref is refused instead of becoming the body; plain trailing words are still a body', async (t) => {
  const ctx = await projectCtx(t);
  const cli = cliFor(ctx);
  await driveTo(ctx, REF, 'build');
  const before = (await ctx.store.messages(REF)).length;
  for (const args of [
    ['task', 'accept', 'checkout/T-001', 'checkout/T-002', '--as', 'fable'],
    ['dispatch', 'T-001', 'T-002', '--to', 'opus-1', '--as', 'fable'],
    ['post', REF, 'checkout/other-thread', '--type', 'note', '--as', 'fable'],
  ]) {
    const r = cli(args);
    assertExit(r, 2);
    assert.match(r.stderr, /unexpected argument/);
  }
  assert.equal((await ctx.store.messages(REF)).length, before, 'nothing was written');
  assertExit(cli(['post', REF, '--type', 'note', 'hello', 'world', '--as', 'fable']), 0);
  assert.ok((await notes(ctx.store)).some((m) => m.body.trim() === 'hello world'));
});

test('--body-file - reads stdin to the end; a pipe that sends nothing in time is refused, never replaced by a default body', async (t) => {
  const ctx = await projectCtx(t);
  const env = { ...process.env, FACTORY_NOW: ctx.clock.seconds(1).iso() };
  delete env.FACTORY_ROOT;
  delete env.FACTORY_AS;
  delete env.FACTORY_ACTOR;
  const sh = (cmd) => spawnSync('/bin/sh', ['-c', cmd], { env, encoding: 'utf8', timeout: 60000 });
  const cliCmd = `"${process.execPath}" "${CLI_PATH}" post ${REF} --type note --as fable --root "${ctx.root}"`;
  let r = sh(`(sleep 1.5; printf 'slow body') | ${cliCmd} --body-file -`);
  assert.equal(r.status, 0, r.stderr);
  assert.ok((await notes(ctx.store)).some((m) => m.body.trim() === 'slow body'), 'the late stdin became the body');
  r = sh(`(sleep 1.5; printf 'late') | ${cliCmd}`);
  assert.equal(r.status, 2, r.stderr);
  assert.match(r.stderr, /stdin is a pipe that sent nothing/);
  assert.match(r.stderr, /--body-file -/);
  // A command whose body is optional does not fall back to its default text either.
  const before = (await ctx.store.tasks()).length;
  r = sh(`(sleep 1.5; printf 'npm test: 212 passed') | "${process.execPath}" "${CLI_PATH}" task new ${REF} --title Evidence --as fable --root "${ctx.root}"`);
  assert.equal(r.status, 2, r.stderr);
  assert.equal((await ctx.store.tasks()).length, before, 'nothing was written');
  r = sh(`${cliCmd} --body-file - < /dev/null`);
  assert.equal(r.status, 2, 'an empty --body-file - is a missing body');
});

test('an inherited stdin socket that sends nothing (an agent shell) is no stdin: the default body is used', async (t) => {
  const ctx = await projectCtx(t);
  const env = { ...process.env, FACTORY_NOW: ctx.clock.seconds(1).iso() };
  delete env.FACTORY_ROOT;
  delete env.FACTORY_AS;
  delete env.FACTORY_ACTOR;
  const before = (await ctx.store.tasks()).length;
  // A spawned child's 'pipe' stdin is a socket; it stays open and silent, like
  // the stdin a harness hands to the shell it runs commands in.
  const child = spawn(process.execPath, [CLI_PATH, 'task', 'new', REF, '--title', 'No body', '--as', 'fable', '--root', ctx.root], { env, stdio: ['pipe', 'pipe', 'pipe'] });
  let stderr = '';
  child.stderr.on('data', (c) => { stderr += c; });
  const code = await new Promise((resolve) => {
    const kill = setTimeout(() => { child.kill(); resolve('timeout'); }, 20000);
    child.on('exit', (c) => { clearTimeout(kill); resolve(c); });
  });
  child.stdin.destroy();
  assert.equal(code, 0, stderr);
  assert.equal((await ctx.store.tasks()).length, before + 1, 'the task was created with its default body');
});

test('ui forwards --allow-host to the board and warns on a network bind', async (t) => {
  const ctx = await projectCtx(t);
  const child = spawn(process.execPath, [CLI_PATH, 'ui', '--port', '0', '--host', '0.0.0.0', '--allow-host', 'factory-box.example', '--root', ctx.root], { stdio: ['ignore', 'pipe', 'pipe'] });
  t.after(() => child.kill());
  let out = '';
  let err = '';
  child.stderr.on('data', (c) => { err += c; });
  const url = await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`no start line\n${out}\n${err}`)), 15000);
    child.stdout.on('data', (c) => {
      out += c;
      const m = /Factory board: (http:\/\/\S+)/.exec(out);
      if (m) { clearTimeout(timer); resolve(m[1]); }
    });
  });
  assert.match(out, /listening on 0\.0\.0\.0:\d+/);
  const port = new URL(url).port;
  const get = (host) => new Promise((resolve, reject) => {
    const req = http.get({ host: '127.0.0.1', port, path: '/api/board', headers: { Host: `${host}:${port}` } }, (res) => { res.resume(); resolve(res.statusCode); });
    req.on('error', reject);
  });
  assert.equal(await get('factory-box.example'), 200, 'an --allow-host name is served');
  assert.equal(await get('elsewhere.example'), 403, 'any other Host is refused');
  assert.match(err, /no sign-in/);
  assert.match(err, /factory-box\.example/);
});

// ---- worktree ------------------------------------------------------------------

test('worktree: the branch comes from the ids and is quoted; a branch only on origin is tracked; a tampered branch is refused', async (t) => {
  const ctx = await projectCtx(t);
  const bin = makeTempDir('factory-cli-fakegit-remote-');
  t.after(() => fs.rmSync(bin, { recursive: true, force: true }));
  fs.writeFileSync(path.join(bin, 'git'), '#!/bin/sh\ncase "$*" in *refs/remotes/origin/factory/checkout/checkout-v2*) exit 0;; esac\nexit 1\n', { mode: 0o755 });
  const env = { PATH: `${bin}:${process.env.PATH}` };
  let r = runCli(['worktree', REF, '--json'], { root: ctx.root, env });
  assertExit(r, 0);
  const doc = r.json();
  assert.equal(doc.remote, true);
  assert.ok(doc.commands[0].endsWith('fetch origin main factory/checkout/checkout-v2'), doc.commands[0]);
  assert.match(doc.commands[1], /worktree add --track -b factory\/checkout\/checkout-v2 .* origin\/factory\/checkout\/checkout-v2$/);

  const file = path.join(ctx.root, 'teams', 'checkout', 'threads', 'checkout-v2.md');
  editFrontmatterFile(file, (d) => { d.branch = 'x; touch /tmp/pwned'; });
  r = runCli(['worktree', REF], { root: ctx.root, env });
  assertExit(r, 1);
  assert.match(r.stderr, /its branch must be factory\/checkout\/checkout-v2/);
  assert.ok(!r.stdout.includes('touch'), 'no command carries the tampered branch');
});

test('a CLI copy inside a linked git worktree refuses writes and names the shared checkout', async (t) => {
  const base = makeTempDir('factory-cli-linked-');
  t.after(() => fs.rmSync(base, { recursive: true, force: true }));
  const main = path.join(base, 'main');
  const wt = path.join(base, 'wt');
  fs.mkdirSync(path.join(main, '.git', 'worktrees', 'wt'), { recursive: true });
  fs.writeFileSync(path.join(main, '.git', 'worktrees', 'wt', 'commondir'), '../..\n');
  fs.mkdirSync(path.join(wt, 'factory'), { recursive: true });
  fs.writeFileSync(path.join(wt, '.git'), `gitdir: ${path.join(main, '.git', 'worktrees', 'wt')}\n`);
  for (const part of ['bin', 'lib', 'templates', 'members.yaml']) {
    fs.cpSync(path.join(FACTORY_DIR, part), path.join(wt, 'factory', part), { recursive: true });
  }
  const env = { ...process.env };
  delete env.FACTORY_ROOT;
  delete env.FACTORY_AS;
  delete env.FACTORY_ACTOR;
  const copy = path.join(wt, 'factory', 'bin', 'factory.mjs');
  let r = spawnSync(process.execPath, [copy, 'team', 'new', 'demo', '--title', 'Demo', '--as', 'you'], { cwd: wt, env, encoding: 'utf8' });
  assert.equal(r.status, 1, r.stderr);
  assert.match(r.stderr, /linked git worktree/);
  assert.ok(r.stderr.includes(main), `names the shared checkout ${main}\n${r.stderr}`);
  assert.ok(!fs.existsSync(path.join(wt, 'teams')), 'nothing was written in the worktree');
  r = spawnSync(process.execPath, [copy, 'members'], { cwd: wt, env, encoding: 'utf8' });
  assert.equal(r.status, 0, 'reads still work');
  const scratch = makeTempDir('factory-cli-linked-root-');
  t.after(() => fs.rmSync(scratch, { recursive: true, force: true }));
  r = spawnSync(process.execPath, [copy, 'init', '--root', scratch], { cwd: wt, env, encoding: 'utf8' });
  assert.equal(r.status, 0, `an explicit --root is honoured\n${r.stderr}`);
});

// ---- human output --------------------------------------------------------------

test('hints print the runnable CLI path with the --root in use', async (t) => {
  const ctx = await useRoot(t);
  const cli = cliFor(ctx);
  let r = cli(['team', 'list']);
  assertExit(r, 0);
  assert.ok(r.stdout.includes(`node factory/bin/factory.mjs --root ${ctx.root} team new`), r.stdout);
  r = cli(['board']);
  assert.ok(r.stdout.includes(`node factory/bin/factory.mjs --root ${ctx.root} team new`), r.stdout);
  await setupTeam(ctx);
  assertExit(cli(['thread', 'new', REF, '--title', 'Checkout v2', '--as', 'fable']), 0);
  assertExit(cli(['thread', 'edit', REF, '--section', 'Notes', '--body', 'x', '--as', 'fable']), 0);
  r = cli(['thread', 'show', REF]);
  assert.match(r.stdout, new RegExp(`next: .*node factory/bin/factory\\.mjs --root ${ctx.root.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')} thread edit`));
});

test('log and show print an event\'s note; a watch thread shows its creation and the next window start', async (t) => {
  const ctx = await projectCtx(t);
  const cli = cliFor(ctx);
  await driveTo(ctx, REF, 'design');
  assertExit(cli(['advance', REF, '--body', 'Design ready for review: see the retry section', '--as', 'fable']), 0);
  const ev = (await ctx.store.messages(REF)).filter((m) => m.type === 'event' && m.event.kind === 'phase').at(-1);
  let r = cli(['log', REF]);
  assert.match(r.stdout, /Design ready for review: see the retry section/);
  r = cli(['show', ev.id]);
  assert.match(r.stdout, /Design ready for review: see the retry section/);

  assertExit(cli(['thread', 'new', 'checkout/checkout-health', '--title', 'Health', '--kind', 'watch', '--owner', 'opus-monitor', '--threshold', 'error_rate<=0.02', '--as', 'fable']), 0);
  const th = await ctx.store.thread('checkout/checkout-health');
  r = cli(['thread', 'show', 'checkout/checkout-health']);
  assert.match(r.stdout, /created \d{4}-\d\d-\d\d/);
  assert.match(r.stdout, /window starts/);
  assert.ok(r.stdout.includes(th.created.slice(0, 16).replace('T', ' ')), `shows the creation time\n${r.stdout}`);
});

test('team list and board show a team whose team.md cannot be read; a byte-order mark is fine', async (t) => {
  const ctx = await projectCtx(t);
  const cli = cliFor(ctx);
  await setupTeam(ctx, { id: 'payments', title: 'Payments' });
  const checkoutMd = path.join(ctx.root, 'teams', 'checkout', 'team.md');
  fs.writeFileSync(checkoutMd, `﻿${fs.readFileSync(checkoutMd, 'utf8')}`);
  fs.writeFileSync(path.join(ctx.root, 'teams', 'payments', 'team.md'), '---\nid: payments\nlead: [fable\n---\n');
  let r = cli(['team', 'list']);
  assertExit(r, 0);
  assert.match(r.stdout, /^checkout\s+lead fable/m, 'the BOM team still lists normally');
  assert.match(r.stdout, /^payments\s+BROKEN/m);
  r = cli(['board']);
  assert.match(r.stdout, /payments · BROKEN/);
  const b = r.code === 0 ? cli(['board', '--json']).json() : null;
  assert.equal(b.brokenTeams[0].id, 'payments');
});

// ---- configuration commands -------------------------------------------------------

test('thread set changes a watch thread\'s cadence, thresholds, owner and members; team edit and task edit', async (t) => {
  const ctx = await projectCtx(t);
  const cli = cliFor(ctx);
  const W = 'checkout/checkout-health';
  assertExit(cli(['thread', 'new', W, '--title', 'Health', '--kind', 'watch', '--owner', 'opus-monitor',
    '--threshold', 'error_rate<=0.02', '--threshold', 'success_rate>=0.98', '--as', 'fable']), 0);
  let r = cli(['thread', 'set', W, '--cadence', '6h', '--threshold', 'error_rate<=0.05', '--clear-threshold', 'success_rate', '--as', 'fable', '--json']);
  assertExit(r, 0);
  let th = await ctx.store.thread(W);
  assert.equal(th.cadence, '6h');
  assert.deepEqual(plain(th.thresholds), { error_rate: { max: 0.05 } });
  const ev = r.json().events.find((e) => e.event.kind === 'thread_config');
  assert.ok(ev, 'a thread_config event');
  assert.equal(ev.event.cadence.to, '6h');
  assertExit(cli(['thread', 'set', W, '--owner', 'fable', '--members', 'opus-1', '--as', 'you']), 0);
  th = await ctx.store.thread(W);
  assert.equal(th.owner, 'fable');
  assert.ok(th.members.includes('opus-1') && th.members.includes('fable'));
  assertExit(cli(['thread', 'set', W, '--threshold', 'a>=5', '--threshold', 'a<=1', '--as', 'fable']), 2);
  assertExit(cli(['thread', 'set', W, '--cadence', 'sometimes', '--as', 'fable']), 2);
  assertExit(cli(['thread', 'set', W, '--cadence', 'daily', '--as', 'opus-1']), 1);
  assertExit(cli(['thread', 'set', REF, '--cadence', 'daily', '--as', 'fable']), 2);
  assertExit(cli(['thread', 'set', W, '--cadence', '6h', '--as', 'fable']), 1);

  r = cli(['team', 'edit', 'checkout', '--eval-cmd', 'node scripts/eval.mjs', '--data-source', 'usage=analytics weekly starts', '--as', 'you']);
  assertExit(r, 0);
  const team = await ctx.store.team('checkout');
  assert.equal(team.eval_cmd, 'node scripts/eval.mjs');
  assert.deepEqual(plain(team.data_sources), { usage: 'analytics weekly starts', traces: null, latency: null, feedback: null });
  assertExit(cli(['team', 'edit', 'checkout', '--data-source', 'bogus=x', '--as', 'you']), 2);
  assertExit(cli(['team', 'edit', 'checkout', '--grader', 'g', '--as', 'openai']), 1);

  await driveTo(ctx, REF, 'build');
  const [task] = await threadTasks(ctx.store, REF);
  r = cli(['task', 'edit', `checkout/${task.id}`, '--section', 'Acceptance', '--body', '- [ ] retries 3 times with backoff', '--as', 'fable']);
  assertExit(r, 0);
  const edited = await ctx.store.task(`checkout/${task.id}`);
  assert.equal((edited.body.match(/^## Acceptance$/gm) || []).length, 1);
  assert.match(edited.body, /retries 3 times with backoff/);
  assertExit(cli(['task', 'edit', `checkout/${task.id}`, '--title', 'Renamed', '--as', 'opus-1']), 1);
  assert.deepEqual((await ctx.store.validate()).errors, []);
});

test('trailing words with a slash are body text unless they name a thread of an existing team', async (t) => {
  const ctx = await projectCtx(t);
  const cli = cliFor(ctx);
  assertExit(cli(['post', REF, '--type', 'note', 'retry', 'and/or', 'backoff', '--as', 'fable']), 0);
  assert.ok((await notes(ctx.store)).some((m) => m.body.trim() === 'retry and/or backoff'));
  assertExit(cli(['post', REF, '--type', 'note', 'see', 'checkout/other', '--as', 'fable']), 2);
});
