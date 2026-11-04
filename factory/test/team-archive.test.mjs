// Archiving a team (store.archiveTeam, `factory team archive`): the folder
// moves under teams/.archive/, nothing is deleted, and the id is free again.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { useRoot, runCli, assertExit, openStore, expectError } from './helpers.mjs';
import { setSession, readSessions } from '../lib/autopilot.mjs';

test('team archive moves the whole team out of the board, keeps every file, frees the id and drops its saved sessions', async (t) => {
  const { root, store } = await useRoot(t);
  await store.createThread({ as: 'you', ref: 'chat/latency', title: 'Cut latency', teamTitle: 'Chat' });
  await store.createThread({ as: 'you', ref: 'other/keep', title: 'Keep me', teamTitle: 'Other' });
  await store.post({ as: 'you', ref: 'chat/latency', type: 'question', to: ['fable'], body: 'Status?' });
  setSession(root, 'fable', 'chat/latency', '11111111-1111-4111-8111-111111111111');
  setSession(root, 'fable', 'other/keep', '22222222-2222-4222-8222-222222222222');

  await expectError(() => openStore({ root }).archiveTeam({ as: 'fable', id: 'chat' }), 'permission', /only you archive a team/);
  await expectError(() => openStore({ root }).archiveTeam({ as: 'you', id: 'nope' }), 'not_found');

  const r = runCli(['team', 'archive', 'chat', '--as', 'you', '--json'], { root });
  assertExit(r, 0);
  const out = r.json();
  assert.equal(out.team.id, 'chat');
  assert.equal(out.threads, 1);
  assert.equal(out.sessions_dropped, 1);
  assert.match(out.path, /^teams\/\.archive\/chat-\d{8}T\d{6}Z$/);
  const moved = path.join(root, out.path);
  assert.ok(fs.existsSync(path.join(moved, 'team.md')), 'team.md kept');
  assert.ok(fs.existsSync(path.join(moved, 'threads', 'latency.md')), 'threads kept');
  assert.ok(!fs.existsSync(path.join(moved, '.lock')), 'no lock left behind');
  assert.ok(!fs.existsSync(path.join(root, 'teams', 'chat')), 'gone from teams/');

  const s = openStore({ root });
  assert.deepEqual(s.teams().map((x) => x.id), ['other']);
  assert.ok(!s.openTurns({ member: 'fable' }).some((x) => x.message.thread?.startsWith?.('chat/')), 'its turns are gone from the inbox');
  assert.deepEqual(readSessions(root).fable, { 'other/keep': '22222222-2222-4222-8222-222222222222' }, 'only the archived team\'s sessions are dropped');
  const health = s.validate();
  assert.deepEqual(health.errors, []);
  assert.ok(!health.warnings.some((w) => /\.archive/.test(w.file)), 'validate ignores the archive');

  // The id is free: a new chat team starts empty.
  await s.createThread({ as: 'you', ref: 'chat/fresh', title: 'Fresh start', teamTitle: 'Chat' });
  assert.deepEqual(openStore({ root }).threads({ team: 'chat' }).map((x) => x.id), ['fresh']);
});

test('team archive is refused while an agent run works in the team', async (t) => {
  const { root, store } = await useRoot(t);
  await store.createThread({ as: 'you', ref: 'chat/latency', title: 'Cut latency', teamTitle: 'Chat' });
  const s = openStore({ root });
  // A live autopilot with fable running on this team (a real one needs the autopilot process).
  s.autopilot = () => ({ alive: true, members: { fable: { running: { ref: 'chat/latency' } }, openai: { running: { ref: 'other/x' } } } });
  await expectError(() => s.archiveTeam({ as: 'you', id: 'chat' }), 'conflict', /fable \(chat\/latency\) is working in chat/);
  assert.ok(fs.existsSync(path.join(root, 'teams', 'chat', 'team.md')), 'nothing moved');
  // Per-thread runs: any of a member's runs in the team blocks it.
  s.autopilot = () => ({ alive: true, members: { fable: { running: { ref: 'other/x' }, runs: [{ ref: 'other/x' }, { ref: 'chat/latency' }] } } });
  await expectError(() => s.archiveTeam({ as: 'you', id: 'chat' }), 'conflict', /fable \(chat\/latency\) is working in chat/);
  // A run in another team does not block it.
  s.autopilot = () => ({ alive: true, members: { openai: { running: { ref: 'other/x' } } } });
  await s.archiveTeam({ as: 'you', id: 'chat' });
  assert.ok(!fs.existsSync(path.join(root, 'teams', 'chat')), 'archived');
});

test('team archived lists archived teams newest first; team restore brings one back as it was, and never over a team on the board', async (t) => {
  const { root, store } = await useRoot(t);
  await store.createThread({ as: 'you', ref: 'chat/latency', title: 'Cut latency', teamTitle: 'Chat' });
  await store.post({ as: 'you', ref: 'chat/latency', type: 'question', to: ['fable'], body: 'Status?' });
  const first = openStore({ root }).archiveTeam({ as: 'you', id: 'chat' });
  await openStore({ root }).createThread({ as: 'you', ref: 'chat/fresh', title: 'Fresh start', teamTitle: 'Chat Two' });

  const empty = runCli(['team', 'archived'], { root: (await useRoot(t)).root });
  assertExit(empty, 0);
  assert.match(empty.stdout, /No archived teams/);
  const listed = runCli(['team', 'archived', '--json'], { root });
  assertExit(listed, 0);
  const [entry] = listed.json();
  assert.deepEqual({ ...entry, archived_at: undefined }, {
    name: path.basename(first.path), id: 'chat', title: 'Chat', threads: 1, archived_at: undefined, path: first.path,
  });
  assert.match(entry.archived_at, /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$/);
  assert.deepEqual(openStore({ root }).board().archivedTeams.map((x) => x.name), [entry.name], 'the board payload carries the list');

  // A team with the same id is on the board: restore is refused and nothing moves.
  await expectError(() => openStore({ root }).restoreTeam({ as: 'you', name: entry.name }), 'conflict', /already on the board; archive it first/);
  await expectError(() => openStore({ root }).restoreTeam({ as: 'fable', name: entry.name }), 'permission', /only you restore a team/);
  await expectError(() => openStore({ root }).restoreTeam({ as: 'you', name: 'chat-nope' }), 'not_found');
  await expectError(() => openStore({ root }).restoreTeam({ as: 'you', name: '../chat' }), 'not_found');

  // Archive the new one, then the old one comes back with its thread and its open turn.
  openStore({ root }).archiveTeam({ as: 'you', id: 'chat' });
  assert.equal(openStore({ root }).archivedTeams().length, 2);
  const r = runCli(['team', 'restore', entry.name, '--as', 'you'], { root });
  assertExit(r, 0);
  assert.match(r.stdout, /Restored team chat \(Chat, 1 thread\)/);
  const s = openStore({ root });
  assert.deepEqual(s.threads({ team: 'chat' }).map((x) => x.id), ['latency']);
  assert.ok(s.openTurns({ member: 'fable' }).length > 0, 'its open turn is back in the inbox');
  assert.deepEqual(s.archivedTeams().map((x) => x.title), ['Chat Two']);
  assert.deepEqual(s.validate().errors, []);
});
