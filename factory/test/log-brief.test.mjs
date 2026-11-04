// `log --brief`: the cheap way for agents to read a thread.
import test from 'node:test';
import assert from 'node:assert/strict';
import { useRoot, runCli, assertExit } from './helpers.mjs';

test('log --brief prints one line per message, drops events, and applies --limit after the drop', async (t) => {
  const { root, store, clock } = await useRoot(t);
  await store.createThread({ as: 'fable', ref: 'chat/quality', title: 'Quality' });
  clock.seconds(1);
  const long = 'Idea one.\n\n' + 'x'.repeat(4000);
  const q = await store.post({ as: 'fable', ref: 'chat/quality', type: 'question', to: ['openai'], body: 'Ideas?' });
  clock.seconds(1);
  const a = await store.post({ as: 'openai', ref: 'chat/quality', type: 'answer', reply_to: q.message.id, body: long });

  const full = runCli(['log', 'chat/quality'], { root });
  assertExit(full, 0);
  const brief = runCli(['log', 'chat/quality', '--brief'], { root });
  assertExit(brief, 0);
  const lines = brief.stdout.trim().split('\n');
  assert.equal(lines.length, 3, 'two messages and the show hint; the thread_created event is dropped');
  assert.match(lines[0], new RegExp(`${q.message.id}  fable → openai  question: Ideas\\?`));
  assert.match(lines[1], new RegExp(`${a.message.id}  openai  answer ↩ ${q.message.id}: Idea one\\.`));
  assert.ok(brief.stdout.length < full.stdout.length / 5, 'the long body is not printed');
  assert.match(lines[2], /show <msg-id>/);

  const one = runCli(['log', 'chat/quality', '--brief', '--limit', '1', '--json'], { root });
  assertExit(one, 0);
  const rows = JSON.parse(one.stdout);
  assert.deepEqual(rows.map((r) => r.id), [a.message.id], '--limit counts messages, not events');
  assert.deepEqual(Object.keys(rows[0]).sort(), ['from', 'id', 'reply_to', 'summary', 'to', 'ts', 'type']);
});
