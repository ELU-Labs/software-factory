// Thread roles: the owner picks who plays each role, and on which model, when
// they start a thread on the board (lib/roles.mjs). No test ever starts a model.
import test from 'node:test';
import assert from 'node:assert/strict';
import { useRoot, runCli, assertExit, openStore, expectError } from './helpers.mjs';
import { normalizeRoles, rolesStaffing, rolesLines, roleModel } from '../lib/roles.mjs';
import { launchers } from '../lib/autopilot.mjs';

const PICK = {
  lead: { model: 'claude-sonnet-5-5' },
  subagents: { model: 'claude-opus-5-5' },
  pair: { agent: 'claude-haiku-5-5' },
  code_review: { agent: 'you' },
  final_check: { agent: 'grok' },
};

test('normalizeRoles: one subagents pick for the lead, only who and which model are kept, bad picks are refused', () => {
  const r = normalizeRoles('project', { ...PICK, lead: { model: 'claude-sonnet-5-5', prompt: 'ignored' } });
  assert.deepEqual(r, {
    lead: { model: 'claude-sonnet-5-5' },
    subagents: { model: 'claude-opus-5-5' },
    pair: { agent: 'claude-haiku-5-5' },
    code_review: { agent: 'you' },
    final_check: { agent: 'grok' },
    security: null,
  });
  assert.equal(normalizeRoles('project', { ...PICK, subagents: null }).subagents, null, 'the lead builds by itself');
  assert.equal(normalizeRoles('project', { ...PICK, pair: null }).pair, null, 'no pair engineer');
  assert.deepEqual(normalizeRoles('project', { ...PICK, pair: { agent: 'grok' }, code_review: { agent: 'grok' }, final_check: { agent: 'openai' } }),
    { ...normalizeRoles('project', PICK), pair: { agent: 'grok' }, code_review: { agent: 'grok' }, final_check: { agent: 'openai' } }, 'openai and grok can take any review role');
  // A thread made before subagents stored builders: it reads as subagents on the first builder's model.
  const { subagents: _s, ...old } = PICK;
  assert.deepEqual(normalizeRoles('project', { ...old, builders: [{ member: 'opus-1', model: 'claude-haiku-5-5' }] }).subagents, { model: 'claude-haiku-5-5' });
  assert.equal(normalizeRoles('project', { ...old, builders: [] }).subagents, null);
  assert.deepEqual(normalizeRoles('solo', { agent: { model: 'claude-haiku-5-5' } }), { agent: { model: 'claude-haiku-5-5' } });
  assert.equal(normalizeRoles('project', null), null);
  assert.throws(() => normalizeRoles('project', { ...PICK, subagents: { model: 'gpt-9' } }), /subagents: "gpt-9" is not a Claude model/);
  assert.throws(() => normalizeRoles('project', { ...PICK, lead: { model: 'gpt-9' } }), /lead: "gpt-9" is not a model the factory runs/);
  assert.throws(() => normalizeRoles('project', { ...PICK, code_review: { agent: 'claude-opus-5-5' } }), /code review: "claude-opus-5-5" must be one of openai, grok, you/);
  assert.throws(() => normalizeRoles('project', { ...PICK, final_check: { agent: 'fable' } }), /final check/);
  assert.throws(() => normalizeRoles('project', { ...PICK, pair: { agent: 'fable' } }), /pair engineer/);
  assert.throws(() => normalizeRoles('watch', PICK), /not watch threads/);
});

test('rolesStaffing: the picks set the members and the review gate owners', () => {
  assert.deepEqual(rolesStaffing(normalizeRoles('project', PICK), 'fable', ['opus-1', 'opus-2']), {
    members: ['you', 'fable', 'opus-1', 'opus-2', 'grok'],
    gates: { design_review: 'you', code_review: 'you', final_review: 'grok' },
  });
  const solo = rolesStaffing(normalizeRoles('project', { ...PICK, subagents: null, pair: { agent: 'grok' }, code_review: { agent: 'openai' }, final_check: { agent: 'openai' } }), 'fable', ['opus-1', 'opus-2']);
  assert.deepEqual(solo.members, ['you', 'fable', 'grok', 'openai'], 'no subagents: no builder slots');
  assert.deepEqual(solo.gates, { design_review: 'openai', code_review: 'openai', final_review: 'openai' });
});

test('createThread with roles: gates, members and roles land in the thread file, and it validates clean', async (t) => {
  const { root, store } = await useRoot(t);
  const { thread: th } = await store.createThread({ as: 'you', ref: 'chat/latency', title: 'Cut latency', teamTitle: 'Chat', roles: PICK });
  assert.deepEqual(th.members, ['you', 'fable', 'opus-1', 'opus-2', 'grok']);
  assert.equal(th.gates.design_review.by, 'you');
  assert.equal(th.gates.code_review.by, 'you');
  assert.equal(th.gates.final_review.by, 'grok');
  assert.equal(th.gates.build.by, 'fable');
  assert.equal(th.roles.lead.model, 'claude-sonnet-5-5');
  assert.equal(roleModel(th, 'fable'), 'claude-sonnet-5-5');
  assert.equal(roleModel(th, 'opus-1'), null, 'builders run as the lead\'s subagents, not headless');
  const health = openStore({ root }).validate();
  assert.deepEqual(health.errors, [], JSON.stringify(health.errors));
  // A thread made without roles keeps the old shape: no roles key at all.
  const { thread: plain } = await store.createThread({ as: 'you', ref: 'chat/plain', title: 'Plain' });
  assert.ok(!('roles' in plain), 'no roles key');
  assert.deepEqual(plain.gates.code_review.by, 'openai');
  // The board payload carries the picks, so the board names the lead by the model picked ("Sonnet 5.5", not "Fable").
  const cards = openStore({ root }).board().teams.find((x) => x.id === 'chat').threads;
  assert.equal(cards.find((x) => x.id === 'latency').roles.lead.model, 'claude-sonnet-5-5');
  assert.equal(cards.find((x) => x.id === 'plain').roles, null);
  // Bad picks are refused before a missing team is made.
  await expectError(() => store.createThread({ as: 'you', ref: 'nope/x', title: 'X', roles: { ...PICK, subagents: { model: 'gpt-9' } } }), 'usage', /subagents: "gpt-9"/);
  assert.throws(() => openStore({ root }).team('nope'));
  await expectError(() => store.createThread({ as: 'you', ref: 'chat/y', title: 'Y', roles: PICK, members: ['you'] }), 'usage', /leave --members out/);
  // A hand-edited thread file with a bad pick is reported by validate.
  const s2 = openStore({ root });
  const bad = s2.thread('chat/latency');
  bad.roles.lead.model = 'gpt-9';
  s2._saveThread(bad);
  assert.ok(openStore({ root }).validate().errors.some((e) => /roles: lead: "gpt-9"/.test(e.message || e)), 'validate reports it');
});

test('thread show prints each role and its model for the agents', async (t) => {
  const { root, store } = await useRoot(t);
  await store.createThread({ as: 'you', ref: 'chat/latency', title: 'Cut latency', teamTitle: 'Chat', roles: PICK });
  const r = runCli(['thread', 'show', 'chat/latency'], { root });
  assertExit(r, 0);
  assert.match(r.stdout, /lead: fable on Sonnet 5\.5 \(claude-sonnet-5-5; Agent tool model "sonnet"\)\n/);
  assert.match(r.stdout, /subagents: on Opus 5\.5 \(claude-opus-5-5; Agent tool model "opus"\); the lead designs and coordinates, and starts as many builder subagents as it decides\n/);
  assert.match(r.stdout, /pair engineer: a Haiku 5\.5 .* subagent of the lead\n/);
  assert.match(r.stdout, /code review \(design_review, code_review\): you/);
  assert.match(r.stdout, /final check \(final_review\): grok/);
  const th = openStore({ root }).thread('chat/latency');
  assert.match(r.stdout, /security review: none \(no security_review gate\)/);
  assert.equal(rolesLines(th).length, 7);
});

test('launcher: a headless run uses the model picked for its role, ahead of the roster default', async (t) => {
  const { root } = await useRoot(t);
  const l = launchers(root, { FACTORY_CLAUDE_BIN: process.execPath });
  const model = (args) => args[args.indexOf('--model') + 1];
  const fresh = '11111111-1111-4111-8111-111111111111';
  assert.equal(model(l.fable.argv({ prompt: 'p', fresh })), 'claude-fable-5-1', 'the roster default');
  assert.equal(model(l.fable.argv({ prompt: 'p', fresh, model: 'claude-haiku-5-5' })), 'claude-haiku-5-5');
  const solo = { kind: 'solo', owner: 'opus-solo', lead: 'opus-solo', roles: { agent: { model: 'claude-sonnet-5-5' } } };
  assert.equal(roleModel(solo, 'opus-solo'), 'claude-sonnet-5-5');
  assert.equal(roleModel(solo, 'fable'), null);
  assert.equal(roleModel({ kind: 'project', lead: 'fable' }, 'fable'), null, 'no roles: the roster model');
  // openai's Codex runs take the thread's model for it, else the roster's (FACTORY_CODEX_MODEL here).
  const cx = launchers(root, { FACTORY_CODEX_BIN: process.execPath, FACTORY_CODEX_MODEL: 'gpt-6-sol' }).openai;
  const m = (args) => args[args.indexOf('-m') + 1];
  assert.equal(m(cx.argv({ prompt: 'p', lastFile: '/x' })), 'gpt-6-sol');
  assert.equal(m(cx.argv({ prompt: 'p', lastFile: '/x', model: 'gpt-6-astra' })), 'gpt-6-astra');
  assert.equal(m(cx.argv({ prompt: 'p', lastFile: '/x', resume: '22222222-2222-4222-8222-222222222222', model: 'gpt-6-astra' })), 'gpt-6-astra', 'a resumed session too');
});

test('OpenAI models: the lead may run on one (alone, no Claude pair), and any openai role keeps the model picked', () => {
  const lead = normalizeRoles('project', { lead: { model: 'gpt-6.1-sol' }, subagents: null, pair: { agent: 'grok' }, code_review: { agent: 'gpt-6-astra' }, final_check: { agent: 'grok' } });
  assert.deepEqual(lead.lead, { model: 'gpt-6.1-sol' });
  assert.deepEqual(lead.code_review, { agent: 'openai', model: 'gpt-6-astra' }, 'an OpenAI model id reads as openai on it');
  assert.throws(() => normalizeRoles('project', { ...PICK, lead: { model: 'gpt-6.1-sol' } }), /an OpenAI lead builds by itself/);
  assert.throws(() => normalizeRoles('project', { ...PICK, lead: { model: 'gpt-6.1-sol' }, subagents: null }), /a Claude pair is a subagent of the lead/);
  assert.throws(() => normalizeRoles('project', { ...PICK, lead: { model: 'gpt-4' } }), /lead: "gpt-4" is not a model the factory runs/);
  assert.deepEqual(normalizeRoles('project', { ...PICK, pair: { agent: 'openai', model: 'gpt-6-luna' } }).pair, { agent: 'openai', model: 'gpt-6-luna' });
  assert.deepEqual(normalizeRoles('project', { ...PICK, pair: { agent: 'openai' } }).pair, { agent: 'openai' }, 'no model: the roster decides');
  assert.throws(() => normalizeRoles('project', { ...PICK, final_check: { agent: 'openai', model: 'gpt-2' } }), /final check: "gpt-2" is not an OpenAI model/);
  assert.deepEqual(normalizeRoles('project', { ...PICK, security: { agent: 'gpt-6.1-terra' } }).security, { agent: 'openai', model: 'gpt-6.1-terra' });
  assert.deepEqual(rolesStaffing(lead, 'fable', ['opus-1']).members, ['you', 'fable', 'grok', 'openai']);

  const r = normalizeRoles('project', { ...PICK, pair: { agent: 'gpt-6-luna' }, code_review: { agent: 'gpt-6-astra' }, security: { agent: 'gpt-6.1-terra' }, final_check: { agent: 'gpt-6.1-sol' } });
  const at = (phase) => roleModel({ kind: 'project', lead: 'fable', phase, roles: r }, 'openai');
  assert.equal(at('design'), 'gpt-6-luna', 'brainstorm: the pair engineer');
  assert.equal(at('design_review'), 'gpt-6-astra');
  assert.equal(at('code_review'), 'gpt-6-astra');
  assert.equal(at('security_review'), 'gpt-6.1-terra');
  assert.equal(at('final_review'), 'gpt-6.1-sol');
  assert.equal(roleModel({ kind: 'project', lead: 'fable', phase: 'design', roles: lead }, 'openai'), 'gpt-6-astra', 'the only openai role');
  assert.equal(roleModel({ kind: 'project', lead: 'fable', phase: 'build', roles: lead }, 'fable'), 'gpt-6.1-sol');
  const lines = rolesLines({ kind: 'project', lead: 'fable', roles: lead }).join('\n');
  assert.match(lines, /lead: fable on GPT-6\.1 Sol \(gpt-6\.1-sol, on Codex\); you run in Codex, so you design and build by yourself/);
  assert.match(lines, /code review \(design_review, code_review\): openai on GPT-6 Astra \(gpt-6-astra, on Codex\)/);
});
