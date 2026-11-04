// Talking between teams: `tell` posts into another team's thread with a copy in the sender's, and replies are relayed back.
import test from 'node:test';
import assert from 'node:assert/strict';
import { useRoot, setupTeam, setupProject, openTurnIds, runCli, assertExit } from './helpers.mjs';

async function twoTeams(t) {
  const ctx = await useRoot(t);
  await setupTeam(ctx, { id: 'triage', title: 'Triage' });
  const triage = await setupProject(ctx, { team: 'triage', thread: 'bug-triage', title: 'Bug triage' });
  await setupTeam(ctx, { id: 'chat', title: 'Chat' });
  const chat = await setupProject(ctx, { team: 'chat', thread: 'chat', title: 'Chat' });
  return { ...ctx, triage, chat };
}
// Open turns other than notices (each new thread's thread_created event stays open until its lead writes there itself).
const turnsOn = async (store, member, ref) => (await store.openTurns({ member })).filter((x) => `${x.team}/${x.thread}` === ref && x.message.type !== 'event').map((x) => x.message.id);

test('tell: a question to another team is a turn for its lead, and the answer comes back as a turn on the asking thread', async (t) => {
  const ctx = await twoTeams(t);
  const { store, triage, chat, clock } = ctx;
  clock.seconds(30);
  const r = await store.tell({ as: 'fable', from: triage, target: 'chat', body: 'Can chat close these MCP gaps?\n1. the search tool asks which account.' });
  assert.equal(r.thread, chat, 'a team name picks its one open thread');
  assert.deepEqual(r.message.to, ['fable'], 'addressed to that thread\'s lead');
  assert.deepEqual(r.message.link, { dir: 'from', thread: triage, msg: r.copy.id });
  assert.deepEqual(r.copy.link, { dir: 'to', thread: chat, msg: null });
  assert.deepEqual(r.copy.to, [], 'the copy opens no turn');
  assert.deepEqual(await turnsOn(store, 'fable', chat), [r.message.id], 'a turn for the chat lead');
  assert.deepEqual(await turnsOn(store, 'fable', triage), []);

  // Its lead writing elsewhere in its thread does not answer a question.
  clock.seconds(30);
  await store.post({ as: 'fable', ref: chat, type: 'note', body: 'Reading the gaps.' });
  assert.deepEqual(await turnsOn(store, 'fable', chat), [r.message.id]);

  // The answer is relayed to triage, addressed to the asker, replying to the copy.
  clock.seconds(30);
  const a = await store.post({ as: 'fable', ref: chat, type: 'answer', reply_to: r.message.id, body: 'Yes: 1-5 go into the capabilities part.' });
  assert.ok(a.relayed, 'the answer was relayed');
  assert.equal(`${a.relayed.team}/${a.relayed.thread}`, triage);
  assert.deepEqual(a.relayed.to, ['fable']);
  assert.equal(a.relayed.reply_to, r.copy.id);
  assert.deepEqual(a.relayed.link, { dir: 'from', thread: chat, msg: a.message.id });
  assert.equal(a.relayed.body.trim(), 'Yes: 1-5 go into the capabilities part.');
  assert.deepEqual(await turnsOn(store, 'fable', chat), [], 'the reply closed the chat lead\'s turn');
  assert.deepEqual(await turnsOn(store, 'fable', triage), [a.relayed.id], 'the answer is a turn on the asking thread');

  // A relayed answer closes on the recipient's next own write in that thread.
  clock.seconds(30);
  await store.post({ as: 'fable', ref: triage, type: 'note', body: 'Chat has it.' });
  assert.deepEqual(await turnsOn(store, 'fable', triage), []);

  // A follow-up question replying to the relayed answer goes back to chat, to the writer of the answer.
  clock.seconds(30);
  const relayedAnswer = (await store.messages(triage)).find((m) => m.id === a.relayed.id);
  const f = await store.post({ as: 'you', ref: triage, type: 'question', reply_to: relayedAnswer.id, body: 'When?' });
  assert.equal(`${f.relayed.team}/${f.relayed.thread}`, chat);
  assert.deepEqual(f.relayed.to, ['fable']);
  assert.equal(f.relayed.reply_to, a.message.id);
  assert.equal(f.relayed.from, 'you');
  assert.deepEqual((await store.validate()).errors, []);
});

test('tell: a note is a turn closed by their lead\'s next write; a relayed write closes nothing; who may tell, and which thread', async (t) => {
  const ctx = await twoTeams(t);
  const { store, triage, chat, clock } = ctx;
  clock.seconds(30);
  const n = await store.tell({ as: 'fable', from: triage, target: chat, type: 'note', body: 'FYI: the 10 MCP gaps are in triage Notes.' });
  assert.deepEqual(await turnsOn(store, 'fable', chat), [n.message.id]);
  // Another tell from triage into chat is not the chat lead writing there.
  clock.seconds(30);
  const n2 = await store.tell({ as: 'fable', from: triage, target: chat, type: 'note', body: 'One more gap.' });
  assert.deepEqual(await turnsOn(store, 'fable', chat), [n.message.id, n2.message.id]);
  clock.seconds(30);
  await store.post({ as: 'fable', ref: chat, type: 'note', body: 'Added both to the brief.' });
  assert.deepEqual(await turnsOn(store, 'fable', chat), [], 'the lead\'s own write closes notes from another team');

  assert.throws(() => store.tell({ as: 'opus-1', from: triage, target: 'chat', body: 'x' }), /only the lead or owner of triage\/bug-triage, or you/);
  assert.throws(() => store.tell({ as: 'fable', from: triage, target: triage, body: 'x' }), /the thread you speak from/);
  assert.throws(() => store.tell({ as: 'fable', from: triage, target: 'nope', body: 'x' }), /no team "nope"; teams: .*chat.*triage/);
  assert.throws(() => store.tell({ as: 'fable', from: triage, target: 'chat', type: 'answer', body: 'x' }), /--type is question .* or note/);
  // A team with several open threads: name one.
  await setupProject(ctx, { team: 'chat', thread: 'slack', title: 'Slack' });
  assert.throws(() => store.tell({ as: 'fable', from: triage, target: 'chat', body: 'x' }), /team chat has 2 open threads; name one: chat\/chat \(Chat\), chat\/slack \(Slack\)/);
  // The owner may tell from any thread.
  clock.seconds(30);
  const y = await store.tell({ as: 'you', from: triage, target: 'chat/slack', body: 'Does Slack have the same gap?' });
  assert.equal(y.message.from, 'you');
  assert.deepEqual((await store.validate()).errors, []);
});

test('tell from the CLI says where it went and where the answer comes back', async (t) => {
  const ctx = await twoTeams(t);
  const r = runCli(['tell', 'chat', '--from', ctx.triage, '--body', 'Can chat take these gaps?', '--as', 'fable'], { root: ctx.root });
  assertExit(r, 0);
  assert.match(r.stdout, /^Told chat\/chat: question \S+ to fable; the copy in triage\/bug-triage is \S+\. Their reply comes back to triage\/bug-triage\.$/m);
});
