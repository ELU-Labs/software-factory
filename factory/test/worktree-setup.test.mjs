// A team's worktree setup (team.md `setup`): `worktree` prints it last, as one command run in the new worktree.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { projectCtx, runCli, assertExit, readFrontmatterFile, editFrontmatterFile } from './helpers.mjs';

const REF = 'checkout/checkout-v2';

test('worktree prints the team\'s setup last, run inside the new worktree; without one it prints only git', async (t) => {
  const ctx = await projectCtx(t);
  const wt = path.join(path.dirname(ctx.root), `${path.basename(ctx.root)}-factory`, 'checkout--checkout-v2');
  let doc = runCli(['worktree', REF, '--json'], { root: ctx.root }).json();
  assert.equal(doc.setup, null);
  assert.ok(doc.commands.every((c) => c.startsWith('git ')), JSON.stringify(doc.commands));

  assertExit(runCli(['team', 'edit', 'checkout', '--setup', 'npm ci && npm run build', '--as', 'you'], { root: ctx.root }), 0);
  assert.equal(readFrontmatterFile(path.join(ctx.root, 'teams/checkout/team.md')).data.setup, 'npm ci && npm run build');
  doc = runCli(['worktree', REF, '--json'], { root: ctx.root }).json();
  assert.equal(doc.setup, 'npm ci && npm run build');
  assert.equal(doc.commands.at(-1), `cd ${wt} && npm ci && npm run build`);
  assert.match(runCli(['worktree', REF], { root: ctx.root }).stdout, /cd .*checkout--checkout-v2 && npm ci && npm run build/);
  assertExit(runCli(['validate'], { root: ctx.root }), 0);

  // An empty value clears it.
  assertExit(runCli(['team', 'edit', 'checkout', '--setup', '', '--as', 'you'], { root: ctx.root }), 0);
  doc = runCli(['worktree', REF, '--json'], { root: ctx.root }).json();
  assert.equal(doc.setup, null);
  assert.ok(doc.commands.every((c) => c.startsWith('git ')));
});

test('setup is one command line: a second line is refused, and validate flags one written by hand', async (t) => {
  const ctx = await projectCtx(t);
  const r = runCli(['team', 'edit', 'checkout', '--setup', 'npm ci\nrm -rf /', '--as', 'you'], { root: ctx.root });
  assertExit(r, 2);
  assert.match(r.stderr, /one command line/);
  editFrontmatterFile(path.join(ctx.root, 'teams/checkout/team.md'), (d) => { d.setup = 'npm ci\nrm -rf x'; });
  const v = runCli(['validate'], { root: ctx.root });
  assertExit(v, 1);
  assert.match(v.stdout + v.stderr, /setup must be one command line/);
  // worktree never prints a multi-line setup.
  const doc = runCli(['worktree', REF, '--json'], { root: ctx.root }).json();
  assert.equal(doc.setup, null);
  assert.ok(fs.existsSync(ctx.root));
});

test('a new team.md carries setup: null', async (t) => {
  const ctx = await projectCtx(t);
  assert.ok('setup' in readFrontmatterFile(path.join(ctx.root, 'teams/checkout/team.md')).data);
});
