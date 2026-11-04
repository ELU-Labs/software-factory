// Message format and the chat view: the CLI notes a wall of text (PROTOCOL §9, "Format"), long
// bodies fold, and the chat shows what the owner reads.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import { fileURLToPath } from 'node:url';
import { wallOfText } from '../bin/factory.mjs';
import { projectCtx, runCli, assertExit, driveTo } from './helpers.mjs';

const UI_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../tools/factory-ui');

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

const WALL = `W3 done in a1b2c3d. ${'A failed payment is now retried with backoff before the user sees an error. '.repeat(9)}`;

test('wallOfText finds a long prose paragraph and ignores structure, code and tables', () => {
  assert.ok(WALL.length > 600);
  assert.equal(wallOfText(WALL), WALL.trim().length);
  assert.equal(wallOfText(''), 0);
  assert.equal(wallOfText(undefined), 0);
  const tidy = ['T-001 done in `a1b2c3d`.', '', '**Changed**', ...Array.from({ length: 30 }, (_, i) => `- \`file-${i}.ts\`: one short fact about it.`)].join('\n');
  assert.equal(wallOfText(tidy), 0, 'many short bullets are fine');
  assert.equal(wallOfText(`Logs:\n\n\`\`\`\n${'x'.repeat(2000)}\n\`\`\`\n`), 0, 'a code block is not prose');
  assert.equal(wallOfText(`| a | b |\n|---|---|\n| ${'y'.repeat(900)} | z |`), 0, 'nor is a table row');
  assert.ok(wallOfText(`- ${'z'.repeat(700)}`) > 600, 'a bullet can be a wall too');
});

test('a write with a wall-of-text body succeeds and prints a note; a tidy body prints none', async (t) => {
  const ctx = await projectCtx(t);
  const wall = runCli(['post', ctx.ref, '--type', 'note', '--body', WALL, '--as', 'fable'], { root: ctx.root });
  assertExit(wall, 0);
  assert.match(wall.stderr, /note: this body has a \d+-character paragraph/);
  assert.match(wall.stderr, /--body-file/);
  const tidy = runCli(['post', ctx.ref, '--type', 'note', '--body', 'Done.\n\n- one\n- two', '--as', 'fable'], { root: ctx.root });
  assertExit(tidy, 0);
  assert.doesNotMatch(tidy.stderr, /wall of text/);
});

test('board: a long message folds behind Show more and unfolds; a short one never folds', async (t) => {
  const ctx = await projectCtx(t);
  ctx.clock.seconds(1);
  const long = (await ctx.store.post({ as: 'fable', ref: ctx.ref, type: 'note', body: WALL })).message ?? null;
  ctx.clock.seconds(1);
  await ctx.store.post({ as: 'fable', ref: ctx.ref, type: 'note', body: 'Short note.' });
  const page = loadPage();
  const render = () => page.messageEntries(ctx.store.threadView(ctx.ref)).map((e) => String(e.html));
  const entryOf = (html, text) => html.find((h) => h.includes(text));
  let html = render();
  const longId = long?.id ?? entryOf(html, 'W3 done').match(/data-id="([^"]+)"/)[1];
  assert.match(entryOf(html, 'W3 done'), /class="md msg-body folded"/);
  assert.match(entryOf(html, 'W3 done'), /data-act="msg-more"[^>]*aria-expanded="false"[^>]*>Show more</);
  assert.doesNotMatch(entryOf(html, 'Short note.'), /msg-more|folded/);
  page.state.unfolded.add(longId);
  html = render();
  assert.match(entryOf(html, 'W3 done'), /class="md msg-body"/);
  assert.match(entryOf(html, 'W3 done'), />Show less</);
});

test('chat: agent-to-agent messages and automatic events stay out unless they involve you; a linked one shows', async (t) => {
  const page = loadPage();
  const shown = (m) => page.shownInChat({ to: [], cc: [], internal: false, type: 'note', from: 'fable', id: 'x', ...m });
  assert.equal(shown({}), true, 'a plain message');
  assert.equal(shown({ from: 'you', internal: true }), true, 'anything you wrote');
  assert.equal(shown({ internal: true, type: 'dispatch', to: ['opus-1'] }), false, 'a dispatch between agents');
  assert.equal(shown({ internal: true, type: 'result', from: 'opus-1', to: ['fable'] }), false, 'a builder result');
  assert.equal(shown({ type: 'event', from: 'factory', event: { kind: 'task_status' } }), false, 'an automatic event');
  assert.equal(shown({ type: 'event', from: 'factory', to: ['you'], event: { kind: 'phase' } }), true, 'an event waiting on you');
  assert.equal(shown({ type: 'event', from: 'factory', cc: ['you'], event: { kind: 'phase' } }), true, 'or cc you');
  assert.equal(shown({ type: 'event', from: 'factory', event: { kind: 'permission_denied' } }), true, 'a permission request');
  page.state.revealed.add('linked');
  assert.equal(shown({ id: 'linked', internal: true, type: 'dispatch' }), true, 'one you opened from a link');

  const ctx = await projectCtx(t);
  await driveTo(ctx, ctx.ref, 'build');
  ctx.clock.seconds(1);
  const { task } = await ctx.store.createTask({ as: 'fable', ref: ctx.ref, title: 'Wire the button' });
  ctx.clock.seconds(1);
  await ctx.store.dispatch({ as: 'fable', task: `${task.team}/${task.id}`, to: 'opus-1', body: 'Dispatch body only agents read.' });
  ctx.clock.seconds(1);
  await ctx.store.post({ as: 'fable', ref: ctx.ref, type: 'note', body: 'A note in the open.' });
  const chat = page.messageEntries(ctx.store.threadView(ctx.ref)).map((e) => String(e.html)).join('\n');
  assert.match(chat, /A note in the open\./);
  assert.doesNotMatch(chat, /Dispatch body only agents read/);
  assert.doesNotMatch(chat, /moved T-\d+/, 'no task_status lines');
});
