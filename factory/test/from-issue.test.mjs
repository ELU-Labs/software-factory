// Starting a thread from a GitHub issue: `thread new --from-issue`, GET /api/issue and the New thread form.
// A stand-in `gh` on PATH prints a canned issue, so nothing reaches GitHub.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import { fileURLToPath } from 'node:url';
import { openStore } from '../lib/store.mjs';
import { issueArg, issueRequest, ISSUE_TEXT_MAX } from '../lib/github-issue.mjs';
import { startServer } from '../../tools/factory-ui/server.mjs';
import { runCli, assertExit, makeTempDir } from './helpers.mjs';

const UI_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../tools/factory-ui');

/** A temp root, and a bin dir whose `gh` prints issue 42 (or fails for any other number), logging its arguments. */
function setup(t) {
  const root = makeTempDir('factory-issue-');
  const bin = makeTempDir('factory-issue-gh-');
  t.after(() => {
    fs.rmSync(root, { recursive: true, force: true });
    fs.rmSync(bin, { recursive: true, force: true });
  });
  const issue = JSON.stringify({ number: 42, title: 'Retry failed payments', body: 'Card declines are final today.\n\nRetry twice.', url: 'https://github.com/acme/shop/issues/42' });
  fs.writeFileSync(path.join(bin, 'gh'), [
    '#!/bin/sh',
    `printf '%s\\n' "$*" >> "${path.join(bin, 'gh.log')}"`,
    'case "$3" in',
    `  42|https://github.com/acme/shop/issues/42) printf '%s' '${issue}' ;;`,
    '  *) echo "GraphQL: Could not resolve to an issue or pull request with the number of $3." >&2; exit 1 ;;',
    'esac',
  ].join('\n'), { mode: 0o755 });
  assertExit(runCli(['init'], { root }), 0);
  const env = { PATH: `${bin}:${process.env.PATH}` };
  const calls = () => (fs.existsSync(path.join(bin, 'gh.log')) ? fs.readFileSync(path.join(bin, 'gh.log'), 'utf8').trim().split('\n') : []);
  return { root, bin, env, calls };
}

test('thread new --from-issue: the issue titles the thread and is posted as the kickoff to its lead', async (t) => {
  const { root, env, calls } = setup(t);
  const r = runCli(['thread', 'new', 'payments/retry', '--from-issue', '#42', '--as', 'you'], { root, env });
  assertExit(r, 0);
  assert.match(r.stdout, /Posted issue #42 as its request to fable\./);
  assert.deepEqual(calls(), ['issue view 42 --json number,title,body,url']);
  const store = openStore({ root });
  const th = store.thread('payments/retry');
  assert.equal(th.title, 'Retry failed payments');
  const kickoff = store.threadView('payments/retry').messages.find((m) => m.type === 'kickoff');
  assert.equal(kickoff.from, 'you');
  assert.deepEqual(kickoff.to, ['fable']);
  assert.equal(kickoff.body.trim(), 'From GitHub issue [#42: Retry failed payments](https://github.com/acme/shop/issues/42):\n\nCard declines are final today.\n\nRetry twice.');
  assert.ok(store.openTurns({ member: 'fable' }).some((o) => o.message.id === kickoff.id), 'the lead holds the kickoff');
});

test('thread new --from-issue by the lead records the request without addressing anyone; --title wins; a link works', async (t) => {
  const { root, env } = setup(t);
  const r = runCli(['thread', 'new', 'payments/retry', '--from-issue', 'https://github.com/acme/shop/issues/42', '--title', 'Payment retries', '--as', 'fable'], { root, env });
  assertExit(r, 0);
  const store = openStore({ root });
  assert.equal(store.thread('payments/retry').title, 'Payment retries');
  const kickoff = store.threadView('payments/retry').messages.find((m) => m.type === 'kickoff');
  assert.equal(kickoff.from, 'fable');
  assert.deepEqual(kickoff.to ?? [], []);
});

test('thread new --from-issue on a single-agent thread asks its agent', async (t) => {
  const { root, env } = setup(t);
  assertExit(runCli(['thread', 'new', 'triage/bug-42', '--kind', 'solo', '--owner', 'opus-solo', '--from-issue', '42', '--as', 'you'], { root, env }), 0);
  const q = openStore({ root }).threadView('triage/bug-42').messages.find((m) => m.type === 'question');
  assert.deepEqual(q.to, ['opus-solo']);
  assert.match(q.body, /^From GitHub issue \[#42/);
});

test('thread new --from-issue refuses what is not an issue before gh runs, and creates nothing when gh fails', async (t) => {
  const { root, env, calls } = setup(t);
  let r = runCli(['thread', 'new', 'payments/retry', '--from-issue', '--repo=evil', '--as', 'you'], { root, env });
  assert.notEqual(r.code, 0);
  r = runCli(['thread', 'new', 'payments/retry', '--from-issue', 'issues; rm -rf ~', '--as', 'you'], { root, env });
  assertExit(r, 2);
  assert.match(r.stderr, /is not an issue/);
  r = runCli(['thread', 'new', 'payments/retry', '--kind', 'watch', '--from-issue', '42', '--as', 'you'], { root, env });
  assertExit(r, 2);
  assert.deepEqual(calls(), [], 'gh never ran');
  r = runCli(['thread', 'new', 'payments/retry', '--from-issue', '7', '--as', 'you'], { root, env });
  assertExit(r, 1);
  assert.match(r.stderr, /could not read issue 7: GraphQL: Could not resolve/);
  assert.equal(fs.existsSync(path.join(root, 'teams', 'payments')), false, 'no team or thread was created');
});

test('issueArg takes a number or an issue link only; issueRequest cuts long text and keeps the link label intact', () => {
  assert.equal(issueArg('42'), '42');
  assert.equal(issueArg(' #42 '), '42');
  assert.equal(issueArg('https://github.com/acme/shop/issues/42'), 'https://github.com/acme/shop/issues/42');
  for (const bad of ['', '-1', '--help', '42; ls', 'https://github.com/acme/shop/pull/42', 'file:///etc/passwd']) assert.equal(issueArg(bad), null, bad);
  const long = issueRequest({ number: 1, title: 'A [b] c', body: 'x'.repeat(ISSUE_TEXT_MAX + 50), url: 'https://github.com/a/b/issues/1' });
  assert.ok(long.startsWith('From GitHub issue [#1: A b c](https://github.com/a/b/issues/1):'));
  assert.match(long, /_\(cut here; the rest is on GitHub\)_$/);
  assert.ok(long.length < ISSUE_TEXT_MAX + 200);
  assert.match(issueRequest({ number: 2, title: 'T', body: '  ', url: 'u' }), /_The issue has no description._$/);
});

test('GET /api/issue reads the issue for the New thread form; a bad ref is a 400', async (t) => {
  const { root, bin } = setup(t);
  const saved = process.env.PATH;
  process.env.PATH = `${bin}:${saved}`;
  t.after(() => { process.env.PATH = saved; });
  const srv = await startServer({ root, port: 0 });
  t.after(() => srv.close());
  let res = await fetch(`${srv.url}/api/issue?ref=42`);
  assert.equal(res.status, 200);
  const j = await res.json();
  assert.equal(j.title, 'Retry failed payments');
  assert.equal(j.url, 'https://github.com/acme/shop/issues/42');
  assert.match(j.request, /^From GitHub issue \[#42: Retry failed payments\]/);
  res = await fetch(`${srv.url}/api/issue?ref=nope`);
  assert.equal(res.status, 400);
  assert.match((await res.json()).error, /is not an issue/);
});

test('the New thread form offers a GitHub issue field above the title', () => {
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
  hooks.state.board = { teams: [], members: [] };
  hooks.state.newThread = null;
  hooks.newForm('').open = true;
  const out = String(hooks.viewNew());
  assert.match(out, /<input class="field" id="nf-issue" data-new="issue" placeholder="Issue number or link"/);
  assert.match(out, /data-act="nf-issue">Use issue</);
  assert.ok(out.indexOf('nf-issue') < out.indexOf('id="nf-title"'));
});
