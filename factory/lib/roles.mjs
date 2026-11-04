// Thread roles: who plays each role on one thread, and on which model
// (PROTOCOL §6, "Roles"). The owner picks them when they start a thread on the
// board; the thread file keeps them under `roles`. Everyone works from the
// thread's one request (the kickoff); a role has no prompt of its own.
//
// A project thread's roles:
//   lead         {model}            the lead's model for its headless runs: a Claude model
//                                   (Claude Code) or an OpenAI model (Codex)
//   subagents    {model} | null     the lead designs and coordinates, and starts as many
//                                   builder subagents as it decides, on this model;
//                                   null: the lead designs and builds by itself (always,
//                                   under an OpenAI lead: Codex cannot start the builders)
//   pair         {agent, model?} | null
//                                   openai, grok, a Claude model (a subagent of a Claude
//                                   lead), or nobody
//   code_review  {agent, model?}    openai, grok or you: owns design_review and code_review
//   final_check  {agent, model?}    grok, openai or you: owns final_review
//   security     {agent, model?} | null
//                                   the security member on a Claude model, openai or
//                                   grok: owns security_review (after code_review);
//                                   null: the thread has no security_review gate
// `model` on an openai role is the OpenAI model its runs use there; without one,
// the roster's (codexModel in autopilot.mjs). An OpenAI model id given as the
// agent reads as openai on that model.
// A single-agent thread's: agent {model}.
// Threads made before subagents stored `builders: [{member, model}]`; they read
// as subagents on the first builder's model.

/** The Claude models a role can run on, with the Agent tool's alias for a subagent. */
export const CLAUDE_MODELS = Object.freeze([
  { id: 'claude-fable-5-1', name: 'Fable 5.1', alias: 'fable' },
  { id: 'claude-opus-5-5', name: 'Opus 5.5', alias: 'opus' },
  { id: 'claude-sonnet-5-5', name: 'Sonnet 5.5', alias: 'sonnet' },
  { id: 'claude-haiku-5-5', name: 'Haiku 5.5', alias: 'haiku' },
]);
const MODEL_IDS = new Set(CLAUDE_MODELS.map((m) => m.id));
/** The OpenAI models a role can run on (Codex's listed models, newest first). */
export const OPENAI_MODELS = Object.freeze([
  { id: 'gpt-6.1-sol', name: 'GPT-6.1 Sol' },
  { id: 'gpt-6.1-terra', name: 'GPT-6.1 Terra' },
  { id: 'gpt-6-astra', name: 'GPT-6 Astra' },
  { id: 'gpt-6-sol', name: 'GPT-6 Sol' },
  { id: 'gpt-6-luna', name: 'GPT-6 Luna' },
]);
const OPENAI_IDS = new Set(OPENAI_MODELS.map((m) => m.id));
/** Whether a model id is an OpenAI model the factory runs (on Codex). */
export const isOpenAIModel = (id) => OPENAI_IDS.has(String(id ?? '').trim());
/** The member that plays OpenAI's roles. */
export const OPENAI_AGENT = 'openai';

const bad = (message) => Object.assign(new Error(message), { code: 'usage' });

function claudeModel(v, what) {
  const id = String(v ?? '').trim();
  if (!MODEL_IDS.has(id)) throw bad(`${what}: "${id}" is not a Claude model the factory runs (${[...MODEL_IDS].join(', ')})`);
  return id;
}

function openaiModel(v, what) {
  const id = String(v ?? '').trim();
  if (!OPENAI_IDS.has(id)) throw bad(`${what}: "${id}" is not an OpenAI model the factory runs (${[...OPENAI_IDS].join(', ')})`);
  return id;
}

/** The lead's model: a Claude model, or an OpenAI model (the lead then runs on Codex). */
function leadModel(v) {
  const id = String(v ?? '').trim();
  if (MODEL_IDS.has(id) || OPENAI_IDS.has(id)) return id;
  throw bad(`lead: "${id}" is not a model the factory runs (${[...MODEL_IDS, ...OPENAI_IDS].join(', ')})`);
}

/**
 * Who plays a role, as given: an OpenAI model id reads as openai on that model,
 * and openai keeps the model it was given. Returns {agent, model?}.
 */
function agentOn(r, fallback, what) {
  const given = typeof r === 'string' ? r : r?.agent;
  let agent = String(given ?? fallback).trim();
  let model = typeof r === 'object' && r ? r.model : undefined;
  if (OPENAI_IDS.has(agent)) {
    model = agent;
    agent = OPENAI_AGENT;
  }
  if (agent !== OPENAI_AGENT || model == null || model === '') return { agent };
  return { agent, model: openaiModel(model, what) };
}

/** Whether a thread's lead runs on an OpenAI model (Codex) rather than Claude Code. */
export const leadOnOpenAI = (th) => th?.kind === 'project' && isOpenAIModel(th.roles?.lead?.model);

/** Who may play each review role: its default first, then the other agent, then you. */
export const PAIR_AGENTS = Object.freeze(['openai', 'grok']);
export const CODE_REVIEWERS = Object.freeze(['openai', 'grok', 'you']);
export const FINAL_CHECKERS = Object.freeze(['grok', 'openai', 'you']);
/** The roster's security reviewer: headless Claude Code, read-only (members.yaml, role security). */
export const SECURITY_MEMBER = 'security';
/** Who may own security_review: the security member (on a Claude model), or the other vendors' agents. */
export const SECURITY_AGENTS = Object.freeze([SECURITY_MEMBER, 'openai', 'grok']);

/** {agent, model} for the security member, {agent} for openai or grok; a Claude model id picks the security member. */
function securityRole(s) {
  if (s == null || s === false) return null;
  if (typeof s !== 'object' || Array.isArray(s)) throw bad('security must be {agent} or {agent, model}, or null');
  let agent = String(s.agent ?? SECURITY_MEMBER).trim();
  let { model } = s;
  if (MODEL_IDS.has(agent)) {
    model = agent;
    agent = SECURITY_MEMBER;
  }
  if (OPENAI_IDS.has(agent)) return { agent: OPENAI_AGENT, model: agent };
  if (!SECURITY_AGENTS.includes(agent)) throw bad(`security review: "${agent}" is not a Claude model, ${SECURITY_AGENTS.slice(1).join(' or ')}`);
  if (agent === SECURITY_MEMBER) return { agent, model: claudeModel(model, 'security review') };
  return agent === OPENAI_AGENT && model ? { agent, model: openaiModel(model, 'security review') } : { agent };
}

/**
 * Validate and normalize the roles the owner picked.
 * @returns {object|null} the roles to store, or null when none were given
 */
export function normalizeRoles(kind, input) {
  if (input == null) return null;
  if (typeof input !== 'object' || Array.isArray(input)) throw bad('roles must be a map of role to who plays it');
  if (kind === 'solo') return { agent: { model: claudeModel(input.agent?.model, 'agent') } };
  if (kind !== 'project') throw bad(`roles apply to project and single-agent threads, not ${kind} threads`);
  const lead = input.lead || {};
  const theLead = leadModel(lead.model);
  const openaiLead = OPENAI_IDS.has(theLead);
  let sub = input.subagents;
  if (sub === undefined && Array.isArray(input.builders)) sub = input.builders.find((b) => b && b.model) || null;
  if (sub != null && (typeof sub !== 'object' || Array.isArray(sub))) throw bad('subagents must be {model} or null');
  if (sub && openaiLead) throw bad('subagents: an OpenAI lead builds by itself (Codex cannot start the builder subagents); turn subagents off or pick a Claude lead');
  const p = input.pair;
  let pair = null;
  if (p && p.agent) {
    pair = agentOn(p, null, 'pair engineer');
    if (!PAIR_AGENTS.includes(pair.agent) && !MODEL_IDS.has(pair.agent)) throw bad(`pair engineer: "${pair.agent}" is not ${PAIR_AGENTS.join(', ')}, an OpenAI model or a Claude model`);
    if (openaiLead && MODEL_IDS.has(pair.agent)) throw bad('pair engineer: a Claude pair is a subagent of the lead, and an OpenAI lead cannot start one; pick openai, grok or nobody');
  }
  const pick = (r, allowed, what) => {
    const role = agentOn(r, allowed[0], what);
    if (!allowed.includes(role.agent)) throw bad(`${what}: "${role.agent}" must be one of ${allowed.join(', ')} or an OpenAI model`);
    return role;
  };
  return {
    lead: { model: theLead },
    subagents: sub ? { model: claudeModel(sub.model, 'subagents') } : null,
    pair,
    code_review: pick(input.code_review, CODE_REVIEWERS, 'code review'),
    final_check: pick(input.final_check, FINAL_CHECKERS, 'final check'),
    security: securityRole(input.security),
  };
}

/** The members and gate owners a project thread's roles imply; `builders` are the roster's builder ids. */
export function rolesStaffing(roles, lead, builders = []) {
  const members = ['you', lead, ...(roles.subagents ? builders : [])];
  if (PAIR_AGENTS.includes(roles.pair?.agent)) members.push(roles.pair.agent);
  members.push(roles.code_review.agent, roles.final_check.agent);
  if (roles.security) members.push(roles.security.agent);
  return {
    members: [...new Set(members)],
    gates: {
      design_review: roles.code_review.agent,
      code_review: roles.code_review.agent,
      final_review: roles.final_check.agent,
      ...(roles.security ? { security_review: roles.security.agent } : {}),
    },
  };
}

const modelName = (id) => {
  const m = CLAUDE_MODELS.find((x) => x.id === id);
  if (m) return `${m.name} (${m.id}; Agent tool model "${m.alias}")`;
  const o = OPENAI_MODELS.find((x) => x.id === id);
  return o ? `${o.name} (${o.id}, on Codex)` : id;
};
/** "openai" or "openai on GPT-6.1 Sol (...)": an openai role as `thread show` prints it. */
const agentText = (r) => (r.agent === OPENAI_AGENT && r.model ? `${r.agent} on ${modelName(r.model)}` : r.agent);

/** The roles as `thread show` prints them: one line per role, for the agents to read. */
export function rolesLines(th) {
  const r = th.roles;
  if (!r || typeof r !== 'object') return [];
  if (th.kind === 'solo') return r.agent ? ['roles:', `  agent: ${th.owner} on ${modelName(r.agent.model)}`] : [];
  const out = ['roles:'];
  if (r.lead) out.push(`  lead: ${th.lead} on ${modelName(r.lead.model)}${isOpenAIModel(r.lead.model) ? '; you run in Codex, so you design and build by yourself' : ''}`);
  const sub = r.subagents !== undefined ? r.subagents : (Array.isArray(r.builders) && r.builders.find((b) => b && b.model)) || null;
  out.push(sub
    ? `  subagents: on ${modelName(sub.model)}; the lead designs and coordinates, and starts as many builder subagents as it decides`
    : '  subagents: none; the lead designs and builds by itself');
  out.push(r.pair ? `  pair engineer: ${PAIR_AGENTS.includes(r.pair.agent) ? agentText(r.pair) : `a ${modelName(r.pair.agent)} subagent of the lead`}` : '  pair engineer: none (no brainstorm)');
  if (r.code_review) out.push(`  code review (design_review, code_review): ${agentText(r.code_review)}`);
  if (r.security) out.push(`  security review (security_review): ${r.security.model && r.security.agent !== OPENAI_AGENT ? `${r.security.agent} on ${modelName(r.security.model)}` : agentText(r.security)}`);
  else if (r.code_review) out.push('  security review: none (no security_review gate)');
  if (r.final_check) out.push(`  final check (final_review): ${agentText(r.final_check)}`);
  return out;
}

/**
 * The openai role a project thread's phase calls on: code_review for design and
 * code review, security for security_review, final_check from final_review on,
 * and the pair engineer before that.
 */
const OPENAI_ROLE_BY_PHASE = { design_review: 'code_review', code_review: 'code_review', security_review: 'security', final_review: 'final_check', signoff: 'final_check', done: 'final_check' };

/**
 * The model a headless run of this member uses on this thread, when its roles
 * name one. openai keeps one session per thread across its roles there, so a
 * run takes the model of the role the thread's phase calls on, else of the
 * first openai role that names one.
 */
export function roleModel(th, member) {
  const r = th?.roles;
  if (!r) return null;
  if (th.kind === 'solo') return th.owner === member ? r.agent?.model || null : null;
  if (th.lead === member) return r.lead?.model || null;
  if (r.security?.agent === member && r.security.model && member !== OPENAI_AGENT) return r.security.model;
  if (member !== OPENAI_AGENT) return null;
  const order = ['code_review', 'security', 'final_check', 'pair'];
  const now = OPENAI_ROLE_BY_PHASE[th.phase] || 'pair';
  for (const k of [now, ...order]) {
    const x = r[k];
    if (x && x.agent === OPENAI_AGENT && isOpenAIModel(x.model)) return x.model;
  }
  return null;
}
