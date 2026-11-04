// The Security role: an optional security_review gate between code_review and
// final_review, owned by the read-only `security` member (or openai or grok) when
// the owner picks it on the board (PROTOCOL §6, "Roles"). No test starts a model.
import test from 'node:test';
import assert from 'node:assert/strict';
import { projectCtx, driveTo, runCli, assertExit, expectError, openStore } from './helpers.mjs';
import { normalizeRoles, rolesStaffing, rolesLines, roleModel } from '../lib/roles.mjs';
import { launchers, mayStart, SECURITY_ALLOW } from '../lib/autopilot.mjs';
import { threadPhases } from '../lib/store.mjs';

const ROLES = {
  lead: { model: 'claude-fable-5-1' },
  subagents: { model: 'claude-opus-5-5' },
  pair: null,
  code_review: { agent: 'openai' },
  security: { agent: 'claude-opus-5-5' },
  final_check: { agent: 'grok' },
};

test('normalizeRoles: Security takes a Claude model (the security member), openai or grok, or nobody', () => {
  assert.deepEqual(normalizeRoles('project', ROLES).security, { agent: 'security', model: 'claude-opus-5-5' });
  assert.deepEqual(normalizeRoles('project', { ...ROLES, security: { agent: 'security', model: 'claude-sonnet-5-5' } }).security, { agent: 'security', model: 'claude-sonnet-5-5' }, 'the stored shape reads back');
  assert.deepEqual(normalizeRoles('project', { ...ROLES, security: { agent: 'openai' } }).security, { agent: 'openai' });
  assert.deepEqual(normalizeRoles('project', { ...ROLES, security: { agent: 'grok' } }).security, { agent: 'grok' });
  assert.equal(normalizeRoles('project', { ...ROLES, security: null }).security, null);
  const { security: _s, ...older } = ROLES;
  assert.equal(normalizeRoles('project', older).security, null, 'a page from before the role sends none');
  assert.throws(() => normalizeRoles('project', { ...ROLES, security: { agent: 'fable' } }), /security review: "fable" is not a Claude model, openai or grok/);
  assert.throws(() => normalizeRoles('project', { ...ROLES, security: { agent: 'security' } }), /security review: "" is not a Claude model/);
  assert.throws(() => normalizeRoles('project', { ...ROLES, security: 'openai' }), /security must be/);
});

test('rolesStaffing and roleModel: the security reviewer joins the thread, owns security_review and runs on the model picked', () => {
  const r = normalizeRoles('project', ROLES);
  const s = rolesStaffing(r, 'fable', ['opus-1', 'opus-2']);
  assert.ok(s.members.includes('security'));
  assert.equal(s.gates.security_review, 'security');
  assert.equal(rolesStaffing(normalizeRoles('project', { ...ROLES, security: null }), 'fable', []).gates.security_review, undefined);
  const th = { kind: 'project', lead: 'fable', roles: { ...r, security: { agent: 'security', model: 'claude-haiku-5-5' } } };
  assert.equal(roleModel(th, 'security'), 'claude-haiku-5-5');
  assert.equal(roleModel(th, 'fable'), 'claude-fable-5-1');
});

test('a thread with Security goes code_review → security_review → final_review; only its owner reviews it', async (t) => {
  const ctx = await projectCtx(t, { roles: ROLES });
  const { store, clock, ref } = ctx;
  let th = await store.thread(ref);
  assert.deepEqual(th.gates.security_review, { by: 'security', status: 'pending', at: null, ref: null });
  assert.ok(th.members.includes('security'));
  assert.deepEqual(threadPhases(th), ['brief', 'design', 'design_review', 'plan', 'build', 'code_review', 'security_review', 'final_review', 'signoff', 'done']);
  await driveTo(ctx, ref, 'code_review');
  clock.seconds(1);
  await store.review({ as: 'openai', ref, verdict: 'approve', points: [], body: 'Code is fine.' });
  th = await store.thread(ref);
  assert.equal(th.phase, 'security_review');
  const entry = (await store.messages(ref)).filter((m) => m.type === 'event' && m.event?.kind === 'phase').at(-1);
  assert.deepEqual(entry.to, ['security'], 'the phase event opens the security reviewer\'s turn');
  await expectError(() => store.review({ as: 'openai', ref, verdict: 'approve', points: [] }), 'permission');
  clock.seconds(1);
  await store.review({ as: 'security', ref, verdict: 'approve', points: [{ severity: 'low', text: 'Add a size cap on the note field' }], body: 'No holes.' });
  th = await store.thread(ref);
  assert.equal(th.phase, 'final_review');
  assert.equal(th.gates.security_review.status, 'approved');
  assert.equal(openStore({ root: ctx.root }).validate().errors.length, 0);
});

test('accepted security findings send the thread back to build and reset security_review', async (t) => {
  const ctx = await projectCtx(t, { roles: ROLES });
  const { store, clock, ref } = ctx;
  await driveTo(ctx, ref, 'security_review');
  clock.seconds(1);
  await store.review({ as: 'security', ref, verdict: 'changes_requested', body: 'One hole.', points: [{ severity: 'high', text: 'route.ts:41 trusts orgId from the body; check membership' }] });
  const review = (await store.messages(ref)).filter((m) => m.type === 'review').at(-1);
  clock.seconds(1);
  await store.respond({ as: 'fable', ref, review: review.id, body: 'Fixing it.', stances: [{ point: 1, stance: 'accepted' }] });
  const th = await store.thread(ref);
  assert.equal(th.phase, 'build');
  assert.equal(th.gates.security_review.status, 'pending');
  assert.equal(th.gates.code_review.status, 'pending', 'the fix is reviewed again from code_review');
});

test('a thread without Security has no security_review gate and skips it', async (t) => {
  const ctx = await projectCtx(t, { roles: { ...ROLES, security: null } });
  const { store, clock, ref } = ctx;
  let th = await store.thread(ref);
  assert.equal(th.gates.security_review, undefined);
  assert.ok(!th.members.includes('security'));
  await expectError(() => store.setThreadEta({ as: 'fable', ref, eta: 'security_review=30m' }), 'usage');
  await driveTo(ctx, ref, 'code_review');
  clock.seconds(1);
  await store.review({ as: 'openai', ref, verdict: 'approve', points: [], body: 'Fine.' });
  th = await store.thread(ref);
  assert.equal(th.phase, 'final_review');
  assert.equal(openStore({ root: ctx.root }).validate().errors.length, 0);
  // A thread made without roles (the CLI, or before the role existed) has none either.
  const plain = await projectCtx(t);
  assert.equal((await plain.store.thread(plain.ref)).gates.security_review, undefined);
});

test('thread show names the security reviewer and its model', async (t) => {
  const ctx = await projectCtx(t, { roles: ROLES });
  const r = runCli(['thread', 'show', ctx.ref], { root: ctx.root });
  assertExit(r, 0);
  assert.match(r.stdout, /security review \(security_review\): security on Opus 5\.5/);
  assert.ok(rolesLines(await ctx.store.thread(ctx.ref)).some((l) => l.includes('security_review')));
});

test('autopilot: the security member starts only on threads whose security_review it owns, read-only, with its review and Git reads allowed', async (t) => {
  const withGate = { kind: 'project', lead: 'fable', gates: { security_review: { by: 'security' } } };
  assert.equal(mayStart('claude', 'security', withGate, 'security'), true);
  assert.equal(mayStart('claude', 'security', { kind: 'project', lead: 'fable', gates: {} }, 'security'), false);
  assert.equal(mayStart('claude', 'security', { kind: 'project', lead: 'fable', gates: { security_review: { by: 'openai' } } }, 'security'), false);
  assert.equal(mayStart('claude', 'security', { kind: 'solo', owner: 'opus-solo' }, 'security'), false);
  const ctx = await projectCtx(t);
  const l = launchers(ctx.root, { FACTORY_CLAUDE_BIN: process.execPath }).security;
  assert.equal(l.enabled, true);
  assert.equal(l.role, 'security');
  const argv = l.argv({ prompt: 'p', fresh: '11111111-1111-4111-8111-111111111111', allow: [...SECURITY_ALLOW], model: 'claude-sonnet-5-5' });
  assert.equal(argv[argv.indexOf('--permission-mode') + 1], 'dontAsk');
  assert.equal(argv[argv.indexOf('--tools') + 1], 'Bash,Read,Grep,Glob,Agent', 'no Edit or Write');
  assert.equal(argv[argv.indexOf('--model') + 1], 'claude-sonnet-5-5');
  for (const rule of ['Bash(node factory/bin/factory.mjs review:*)', 'Bash(git diff:*)', 'Bash(npm audit:*)']) assert.ok(argv.includes(`--allowedTools=${rule}`), rule);
  const rules = argv.filter((x) => x.startsWith('--allowedTools=')).map((x) => x.slice('--allowedTools='.length));
  assert.ok(!rules.some((x) => x === 'Bash' || x === 'Bash(*)' || /push|commit|merge |checkout|reset/.test(x)), 'never a write or an open shell');
});
