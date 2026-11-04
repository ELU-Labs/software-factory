// `factory merge`: once `you` sign a project thread off, its lead merges the PR
// (PROTOCOL §15). gh is a fake here ($FACTORY_GH_BIN): no test touches GitHub.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { projectCtx, driveTo, runCli, makeTempDir } from './helpers.mjs';

/** A fake gh that answers `pr view` from a JSON state file and logs every call. */
function fakeGh(t, pr) {
  const dir = makeTempDir('factory-gh-');
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const state = path.join(dir, 'pr.json');
  const log = path.join(dir, 'calls.log');
  fs.writeFileSync(state, JSON.stringify(pr));
  const bin = path.join(dir, 'gh');
  fs.writeFileSync(bin, `#!${process.execPath}
const fs = require('fs');
const [a, b, n] = process.argv.slice(2);
fs.appendFileSync(${JSON.stringify(log)}, process.argv.slice(2).join(' ') + '\\n');
const pr = JSON.parse(fs.readFileSync(${JSON.stringify(state)}, 'utf8'));
const save = () => fs.writeFileSync(${JSON.stringify(state)}, JSON.stringify(pr));
if (a === 'pr' && b === 'view') { if (n !== pr.headRefName) { console.error('no pull requests found for branch ' + n); process.exit(1); } console.log(JSON.stringify(pr)); }
else if (a === 'pr' && b === 'ready') { pr.isDraft = process.argv.includes('--undo'); save(); }
else if (a === 'pr' && b === 'merge') { if (pr.failMerge) { console.error(pr.failMerge); process.exit(1); } pr.state = 'MERGED'; pr.mergeCommit = { oid: 'f00dfeed1234567890' }; save(); }
else { console.error('unexpected gh call'); process.exit(1); }
`);
  fs.chmodSync(bin, 0o755);
  return { env: { FACTORY_GH_BIN: bin }, calls: () => (fs.existsSync(log) ? fs.readFileSync(log, 'utf8').trim().split('\n') : []) };
}

const prFor = (th, over = {}) => ({
  number: 973, url: 'https://github.com/acme/shop/pull/973', state: 'OPEN', isDraft: true, mergeable: 'MERGEABLE', baseRefName: 'main',
  headRefName: th.branch, headRefOid: 'abc123abc123abc123', mergeCommit: null,
  commits: [{ oid: 'abc123abc123abc123', committedDate: new Date(Date.parse(th.gates.signoff.at || th.created) - 60000).toISOString() }],
  ...over,
});

test('merge: the lead merges a signed-off PR (draft made ready, exact head, merge commit) and a merged event is copied to you', async (t) => {
  const ctx = await projectCtx(t);
  const { store, ref, root } = ctx;
  let th = await driveTo(ctx, ref, 'done');
  const done = (await store.messages(ref)).filter((m) => m.type === 'event' && m.event?.kind === 'phase').at(-1);
  assert.deepEqual(done.to, [th.lead], 'the sign-off hands the lead a turn: merge the PR');
  const gh = fakeGh(t, prFor(th));
  const r = runCli(['merge', ref, '--as', th.lead], { root, env: gh.env });
  assert.equal(r.code, 0, r.stderr);
  assert.match(r.stdout, /Merged PR #973 into main as f00dfeed1/);
  assert.deepEqual(gh.calls(), [
    `pr view ${th.branch} --json number,url,state,isDraft,mergeable,baseRefName,headRefName,headRefOid,mergeCommit,commits`,
    'pr ready 973',
    'pr merge 973 --merge --match-head-commit abc123abc123abc123',
    `pr view ${th.branch} --json number,url,state,isDraft,mergeable,baseRefName,headRefName,headRefOid,mergeCommit,commits`,
  ]);
  const ev = (await store.messages(ref)).filter((m) => m.type === 'event' && m.event?.kind === 'merged').at(-1);
  assert.equal(ev.event.pr, 973);
  assert.equal(ev.event.commit, 'f00dfeed1234567890');
  assert.deepEqual(ev.cc, ['you']);
  assert.deepEqual(ev.to, []);
  // Again: already merged, nothing more runs.
  const again = runCli(['merge', ref, '--as', th.lead], { root, env: gh.env });
  assert.equal(again.code, 0, again.stderr);
  assert.match(again.stdout, /already merged/);
  assert.equal(gh.calls().filter((c) => c.startsWith('pr merge')).length, 1);
  th = await store.thread(ref);
  assert.equal(th.phase, 'done');
});

test('merge: refused before the sign-off, for anyone but the lead or you, and when the PR changed after the sign-off', async (t) => {
  const ctx = await projectCtx(t);
  const { store, ref, root } = ctx;
  let th = await driveTo(ctx, ref, 'signoff');
  const early = fakeGh(t, prFor(th));
  let r = runCli(['merge', ref, '--as', th.lead], { root, env: early.env });
  assert.notEqual(r.code, 0);
  assert.match(r.stderr, /only after you sign it off/);
  assert.deepEqual(early.calls(), [], 'gh is never called before the sign-off');

  th = await driveTo(ctx, ref, 'done');
  r = runCli(['merge', ref, '--as', 'openai'], { root, env: early.env });
  assert.notEqual(r.code, 0);
  assert.match(r.stderr, /for its lead \(fable\) or you; openai cannot/);

  const late = fakeGh(t, prFor(th, { commits: [{ oid: 'beef00beef00', committedDate: new Date(Date.parse(th.gates.signoff.at) + 60000).toISOString() }] }));
  r = runCli(['merge', ref, '--as', th.lead], { root, env: late.env });
  assert.notEqual(r.code, 0);
  assert.match(r.stderr, /commit from after the sign-off \(beef00bee/);
  assert.ok(!late.calls().some((c) => c.startsWith('pr merge') || c.startsWith('pr ready')), 'nothing merged');

  const other = fakeGh(t, prFor(th, { baseRefName: 'release' }));
  r = runCli(['merge', ref, '--as', 'you'], { root, env: other.env });
  assert.notEqual(r.code, 0);
  assert.match(r.stderr, /targets release, not main/);
  assert.ok(!(await store.messages(ref)).some((m) => m.event?.kind === 'merged'), 'no merged event');
});

test('merge: a conflicting PR is refused before anything changes; a failed merge puts the draft back', async (t) => {
  const ctx = await projectCtx(t);
  const { store, ref, root } = ctx;
  const th = await driveTo(ctx, ref, 'done');
  const conflicting = fakeGh(t, prFor(th, { mergeable: 'CONFLICTING' }));
  let r = runCli(['merge', ref, '--as', th.lead], { root, env: conflicting.env });
  assert.notEqual(r.code, 0);
  assert.match(r.stderr, /has merge conflicts with main; resolve them on/);
  assert.equal(conflicting.calls().length, 1, 'only the view ran: the draft was not made ready');

  const failing = fakeGh(t, prFor(th, { mergeable: 'UNKNOWN', failMerge: 'GraphQL: Pull Request has merge conflicts' }));
  r = runCli(['merge', ref, '--as', th.lead], { root, env: failing.env });
  assert.notEqual(r.code, 0);
  assert.match(r.stderr, /gh pr merge failed: GraphQL: Pull Request has merge conflicts/);
  assert.deepEqual(failing.calls().slice(1), ['pr ready 973', 'pr merge 973 --merge --match-head-commit abc123abc123abc123', 'pr ready 973 --undo']);
  assert.ok(!(await store.messages(ref)).some((m) => m.event?.kind === 'merged'), 'no merged event');
});

test('merge: a PR merged outside the factory is recorded once on the thread', async (t) => {
  const ctx = await projectCtx(t);
  const { store, ref, root } = ctx;
  const th = await driveTo(ctx, ref, 'done');
  // Merged by hand, with a commit after the sign-off: recording it is still right; nothing is merged again.
  const gh = fakeGh(t, prFor(th, { state: 'MERGED', isDraft: false, mergeCommit: { oid: '59cbccfb7aaaa' }, commits: [{ oid: 'ddd970093', committedDate: new Date(Date.parse(th.gates.signoff.at) + 60000).toISOString() }] }));
  let r = runCli(['merge', ref, '--as', 'you'], { root, env: gh.env });
  assert.equal(r.code, 0, r.stderr);
  assert.match(r.stdout, /already merged; recorded it on the thread/);
  const evs = (await store.messages(ref)).filter((m) => m.event?.kind === 'merged');
  assert.equal(evs.length, 1);
  assert.equal(evs[0].event.outside, true);
  assert.equal(evs[0].event.commit, '59cbccfb7aaaa');
  assert.match(evs[0].body, /was merged outside the factory/);
  r = runCli(['merge', ref, '--as', 'you'], { root, env: gh.env });
  assert.equal(r.code, 0, r.stderr);
  assert.doesNotMatch(r.stdout, /recorded/);
  assert.equal((await store.messages(ref)).filter((m) => m.event?.kind === 'merged').length, 1, 'recorded once');
  assert.ok(!gh.calls().some((c) => c.startsWith('pr merge') || c.startsWith('pr ready')));
  assert.deepEqual((await store.validate()).errors, []);
});
