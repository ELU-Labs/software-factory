// The factory autopilot: starts every member with a headless launcher
// (members.yaml `launch`: openai on Codex, a single-agent thread's agent on
// Claude Code) whenever it holds a turn, so the owner does not relay prompts.
// It polls the thread files every few seconds and calls no model while idle;
// each turn gets one fresh agent run that works the inbox and exits.
// PROTOCOL §16, "Autopilot".
import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import crypto from 'node:crypto';
import os from 'node:os';
import { fileURLToPath } from 'node:url';
import { leadOnOpenAI, OPENAI_AGENT, roleModel } from './roles.mjs';
import { openStore, pidAlive, processCommand, isAutopilotPid, isRunPid, writeAtomic, allowRuleProblem, FactoryError, AUTOPILOT_DIR, COSTS_FILE, NOTICE_TYPES, LEAD_PHASES } from './store.mjs';

/** Where the ChatGPT desktop app keeps its bundled Codex CLI on macOS. */
export const CODEX_APP_BIN = '/Applications/ChatGPT.app/Contents/Resources/codex-cli/bin/codex';
export const TICK_MS = 5000;
/** A new turn waits this long, so a lead posting several messages gets one run, not several. */
export const SETTLE_MS = 20000;
export const RUN_TIMEOUT_MS = 60 * 60000;
/** Runs per member per rolling hour; past it the board asks the owner. */
export const MAX_RUNS_PER_HOUR = 6;
/**
 * How many threads one member works at once. Each thread gets its own run (its own
 * session, worktree and turns), so a long run on one thread never holds up another.
 */
export const MAX_PARALLEL_RUNS = 4;
/** How often the autopilot looks at a run it took over from an earlier one (not its child, so no exit event). */
const ADOPT_POLL_MS = 2000;
/** A member's live runs, {thread ref: run}, from a state record of either shape (`running` alone is the old one). */
export function runsOf(m) {
  if (!m || typeof m !== 'object') return {};
  const by = m.running_by_ref && typeof m.running_by_ref === 'object' && !Array.isArray(m.running_by_ref) ? { ...m.running_by_ref } : {};
  if (m.running && typeof m.running === 'object' && typeof m.running.ref === 'string' && !Object.values(by).some((r) => r && r.pid === m.running.pid)) by[m.running.ref] = m.running;
  return Object.fromEntries(Object.entries(by).filter(([, r]) => r && typeof r === 'object'));
}
/** The newest of a member's live runs (state.json's `running`, kept for readers of one run), or null. */
const newestRun = (by) => Object.values(by).reduce((a, b) => (!a || String(b.started_at) > String(a.started_at) ? b : a), null);
/** A member who ran a factory command this recently, outside an autopilot run, has a session open. */
const MANUAL_ACTIVE_MS = 10 * 60000;

/** How the lead's last run ended, in the prompt that restarts it for its builders. */
const STRANDED_HOW = { timed_out: 'ran out of time', failed: 'ended before it finished (a crash or a restart of this machine)', left_open: 'ended', answered: 'ended' };

/**
 * Runs in a row the autopilot starts on one thread only because the lead's last
 * run there left builders mid-task. Past it, the thread waits for a new turn
 * (a message from the owner, say), so a lead that keeps running out of time
 * never runs on by itself without end.
 */
export const MAX_BUILDER_RESTARTS = 2;

/**
 * The dispatches the lead's last run on a thread left without a builder: for
 * each task a builder still owns in `doing`, its newest open dispatch from the
 * lead, posted before that run ended. Builders run inside the lead's run and end
 * with it (its process group is killed), so nobody works on these, and nothing
 * else asks the lead to go on. None after a run the owner stopped, on a finished
 * thread, or after a restart for them that the lead ended by itself (it saw them
 * and left them; only a restart cut off by its time limit or a crash goes on).
 * A dispatch posted after the run ended came from a session of the owner's,
 * whose builders may still work. `last` is the thread's latest lead run
 * ({ended_at, outcome, restarts}); `taskOf(turn)` returns the dispatched task
 * ({id, status, owner}) or null.
 */
export function strandedDispatches({ turns, lead, th, last, taskOf = () => null }) {
  if (!th || th.lead !== lead || th.kind === 'solo' || th.phase === 'done') return [];
  if (!last || last.outcome === 'stopped') return [];
  if (Number(last.restarts) > 0 && !['timed_out', 'failed'].includes(last.outcome)) return [];
  const end = Date.parse(last.ended_at || '');
  if (!Number.isFinite(end)) return [];
  const ref = `${th.team}/${th.id}`;
  const newest = new Map(); // task id -> its newest open dispatch
  for (const t of turns) {
    if (`${t.team}/${t.thread}` !== ref || t.member === lead || t.message.type !== 'dispatch' || t.message.from !== lead) continue;
    if (!(Date.parse(t.message.ts) <= end)) continue;
    const task = taskOf(t);
    if (!task || task.status !== 'doing' || task.owner !== t.member) continue;
    const had = newest.get(task.id);
    if (!had || String(t.message.ts) >= String(had.message.ts)) newest.set(task.id, t);
  }
  return [...newest.values()].sort((a, b) => String(a.message.ts).localeCompare(String(b.message.ts)));
}

/**
 * The prompt that starts one member on one thread. The board's Copy prompt
 * button uses the same text (tools/factory-ui/app.js, kickoffPrompt). A resumed
 * session already knows its role, so it gets the short form. `stranded`
 * ({outcome, dispatches: [{id, member}]}) restarts the lead for the builders its
 * last run left mid-task.
 */
export function kickoffPrompt(member, ref, { auto = false, resumed = false, kind = 'project', codex = false, stranded = null } = {}) {
  if (kind === 'solo') {
    const solo = resumed
      ? `New requests for you on thread ${ref}. Re-read its Instructions first (node factory/bin/factory.mjs thread show ${ref}): they may have changed. Then work your inbox for it until it is empty, and stop and tell me what you did. Your role is factory/roles/solo.md; read it again if this session has not read it yet.`
      : `You are ${member}, the agent and lead of the single-agent thread ${ref} in the software factory. Read factory/roles/solo.md and follow it. Work your inbox for thread ${ref} until it is empty, then stop and tell me what you did.`;
    return auto
      ? `${solo} The factory autopilot started this session and nobody reads it: if you need something, post a question to \`you\` (the owner) in the thread, never here.`
      : solo;
  }
  if (kind === 'lead' && stranded?.dispatches?.length) {
    // Builders end with the run that started them: the lead's last run here ended while they worked.
    const list = stranded.dispatches.map((x) => `${x.id} (${x.member})`).join(', ');
    const how = STRANDED_HOW[stranded.outcome] || 'ended';
    const work = `Your builders stopped on thread ${ref}: your last run there ${how} while they worked on dispatch${stranded.dispatches.length === 1 ? '' : 'es'} ${list}, and builders end with your run. Read each dispatch (node factory/bin/factory.mjs show <dispatch-id>) and what its builder committed in the thread worktree, then spawn a builder again on every dispatch whose task is not finished, as the same builder on the same dispatch id (.claude/skills/factory/SKILL.md, "Builders"), and wait for them. Then work your inbox for thread ${ref} until it is empty, then stop and tell me what you did.`;
    const lead = resumed
      ? `${work} Your instructions are .claude/skills/factory/SKILL.md and factory/roles/lead.md; read them again if this session has not read them yet.`
      : `You are ${member}, the lead of the software factory. Read .claude/skills/factory/SKILL.md and factory/roles/lead.md and follow them. ${work}`;
    return auto
      ? `${lead} The factory autopilot started this session and nobody reads it: ask the owner in the thread (a question to \`you\`), never here. Never run \`factory wait\`: stop when your inbox is empty, and the autopilot starts you again on your next turn. Wait for every builder or monitor you start before you stop: they end with your run.`
      : lead;
  }
  if (kind === 'lead') {
    const lead = resumed
      ? `New turns for you on thread ${ref}. Work your inbox for it until it is empty, then stop and tell me what you did. Your instructions are .claude/skills/factory/SKILL.md and factory/roles/lead.md; read them again if this session has not read them yet.`
      : `You are ${member}, the lead of the software factory. Read .claude/skills/factory/SKILL.md and factory/roles/lead.md and follow them. Work your inbox for thread ${ref} until it is empty, then stop and tell me what you did.`;
    const where = codex
      ? ' You run in Codex, not Claude Code: there is no Agent tool, so you design and build by yourself and start no builder or monitor subagents. The sandbox keeps .git read-only and has no GitHub sign-in: request escalated permissions for Git commands that write (worktree add, commit, push) and for gh.'
      : '';
    return auto
      ? `${lead}${where} The factory autopilot started this session and nobody reads it: ask the owner in the thread (a question to \`you\`), never here. Never run \`factory wait\`: stop when your inbox is empty, and the autopilot starts you again on your next turn.${codex ? '' : ' Wait for every builder or monitor you start before you stop: they end with your run.'}`
      : `${lead}${where}`;
  }
  const base = resumed
    ? `New turns for you on thread ${ref}. Work your inbox for it until it is empty, then stop and tell me what you did. Your instructions are factory/skills/factory-${member}/SKILL.md; read it again if this session has not read it yet.`
    : `You are ${member} in the software factory. Read factory/skills/factory-${member}/SKILL.md and follow it. Work your inbox for thread ${ref} until it is empty, then stop and tell me what you did.`;
  return auto
    ? `${base} The factory autopilot started this session and nobody reads it: ask anything you need in the thread (a question to fable), never here.`
    : base;
}

/**
 * The model and reasoning effort for openai's runs, first set wins:
 * $FACTORY_CODEX_MODEL / $FACTORY_CODEX_EFFORT, then openai's `model` / `effort`
 * in factory/members.yaml, then the top-level `model` / `model_reasoning_effort`
 * in ~/.codex/config.toml (runs ignore the rest of that file). Read on every
 * run, so a roster edit applies to the next run.
 */
export function codexModel(env = process.env, root = null, id = 'openai') {
  let member = {};
  if (root) {
    try {
      member = openStore({ root }).members().find((m) => m.id === id) || {};
    } catch {
      // no roster: fall through to the Codex config
    }
  }
  const fromRoster = (k) => (typeof member[k] === 'string' && member[k].trim() ? member[k].trim() : null);
  let text = '';
  try {
    text = fs.readFileSync(path.join(env.CODEX_HOME || path.join(env.HOME || '', '.codex'), 'config.toml'), 'utf8');
  } catch {
    // no user config: Codex defaults
  }
  const top = text.split(/^\s*\[/m)[0];
  const read = (key) => (new RegExp(`^\\s*${key}\\s*=\\s*"([^"]+)"`, 'm').exec(top) || [])[1] || null;
  return {
    model: env.FACTORY_CODEX_MODEL || fromRoster('model') || read('model'),
    effort: env.FACTORY_CODEX_EFFORT || fromRoster('effort') || read('model_reasoning_effort'),
  };
}

/** A Codex session id ("session id: <uuid>" in a run's log), or null. */
export function sessionIdIn(text) {
  return (/^session id: ([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})\s*$/m.exec(text) || [])[1] || null;
}

export const SESSION_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

/** The Codex CLI: $FACTORY_CODEX_BIN, else `codex` on PATH, else the copy inside the ChatGPT app. */
export function findCodex(env = process.env) {
  if (env.FACTORY_CODEX_BIN) return fs.existsSync(env.FACTORY_CODEX_BIN) ? env.FACTORY_CODEX_BIN : null;
  for (const dir of String(env.PATH || '').split(path.delimiter)) {
    if (!dir) continue;
    const p = path.join(dir, 'codex');
    try {
      fs.accessSync(p, fs.constants.X_OK);
      return p;
    } catch {
      // not here
    }
  }
  return fs.existsSync(CODEX_APP_BIN) ? CODEX_APP_BIN : null;
}

/** Claude Code: $FACTORY_CLAUDE_BIN, else `claude` on PATH, else the native installer's ~/.local/bin/claude. */
export function findClaude(env = process.env) {
  if (env.FACTORY_CLAUDE_BIN) return fs.existsSync(env.FACTORY_CLAUDE_BIN) ? env.FACTORY_CLAUDE_BIN : null;
  for (const dir of String(env.PATH || '').split(path.delimiter)) {
    if (!dir) continue;
    const p = path.join(dir, 'claude');
    try {
      fs.accessSync(p, fs.constants.X_OK);
      return p;
    } catch {
      // not here
    }
  }
  const local = path.join(env.HOME || os.homedir(), '.local', 'bin', 'claude');
  return fs.existsSync(local) ? local : null;
}

/**
 * The only tools a headless Claude run has: reading, a shell, and subagents.
 * Subagents get the run's permissions; CLAUDE_SETTINGS limits them to the
 * built-in types, in this checkout (subagent-guard.mjs).
 */
export const CLAUDE_TOOLS = 'Bash,Read,Grep,Glob,Agent';
/** The lead's tools: its builders edit code, so Edit and Write too. */
export const CLAUDE_LEAD_TOOLS = 'Bash,Read,Grep,Glob,Agent,Edit,Write';
const SUBAGENT_GUARD = fileURLToPath(new URL('./subagent-guard.mjs', import.meta.url));
const guardCommand = (...args) => [process.execPath, SUBAGENT_GUARD, ...args].map((x) => JSON.stringify(x)).join(' ');
/** Settings every headless Claude run gets (--settings): the subagent guard as a PreToolUse hook. */
export const CLAUDE_SETTINGS = JSON.stringify({
  hooks: { PreToolUse: [{ matcher: 'Agent|Task', hooks: [{ type: 'command', command: guardCommand() }] }] },
});
/**
 * The lead's settings: the guard in lead mode, on Bash too. Its subagents may be
 * the factory's builder and monitor types, and its shell refuses the owner's
 * Git and release steps (merge, tag, push to main, release, deploy).
 */
export const CLAUDE_LEAD_SETTINGS = JSON.stringify({
  hooks: { PreToolUse: [{ matcher: 'Agent|Task|Bash', hooks: [{ type: 'command', command: guardCommand('lead') }] }] },
});
/** What a lead run may do without the auto-mode check: read, search, subagents and the factory CLI. */
export const CLAUDE_LEAD_ALLOW = Object.freeze(['Read', 'Grep', 'Glob', 'Agent', 'Bash(node factory/bin/factory.mjs:*)']);
/** Where a lead run's MCP config is looked for under $HOME when $FACTORY_LEAD_MCP_CONFIG is not set. */
export const LEAD_MCP_CONFIG_HOME = path.join('.config', 'software-factory', 'mcp.json');
/**
 * The MCP servers a lead run may load: the JSON file $FACTORY_LEAD_MCP_CONFIG names
 * (empty: none), else ~/.config/software-factory/mcp.json, when it is readable and lies
 * outside the factory root (it holds the owner's keys, which never go in the repo).
 * The default keeps the access when the board restarts the autopilot without the
 * variable. `--strict-mcp-config` stays, so nothing else loads.
 */
export function leadMcpConfig(root, env = process.env) {
  const raw = typeof env.FACTORY_LEAD_MCP_CONFIG === 'string' ? env.FACTORY_LEAD_MCP_CONFIG.trim()
    : env.HOME ? path.join(env.HOME, LEAD_MCP_CONFIG_HOME) : '';
  if (!raw) return null;
  const file = path.resolve(raw);
  const rel = path.relative(path.resolve(root), file);
  if (!rel.startsWith('..') && !path.isAbsolute(rel)) return null;
  try {
    fs.accessSync(file, fs.constants.R_OK);
    return fs.statSync(file).isFile() ? file : null;
  } catch {
    return null;
  }
}
/** A lead run dispatches builders and waits for them, so it gets longer than one answer. */
export const LEAD_RUN_TIMEOUT_MS = 3 * 60 * 60000;

/**
 * The lead's MCP servers for a Codex run, from the same JSON file a Claude lead
 * loads (leadMcpConfig). Only HTTP servers carry over. A header's value goes in
 * the run's environment, never on the command line (where `ps` shows it): the
 * args name the variable through env_http_headers.
 * @returns {{args: string[], env: object, names: string[]}}
 */
export function codexMcp(file) {
  const out = { args: [], env: {}, names: [] };
  if (!file) return out;
  let servers = {};
  try {
    servers = JSON.parse(fs.readFileSync(file, 'utf8'))?.mcpServers || {};
  } catch {
    return out;
  }
  for (const [name, sv] of Object.entries(servers)) {
    if (!/^[A-Za-z0-9_-]+$/.test(name) || !sv || typeof sv.url !== 'string' || !/^https?:\/\//.test(sv.url)) continue;
    const headers = sv.headers && typeof sv.headers === 'object' ? sv.headers : {};
    const vars = [];
    for (const [h, v] of Object.entries(headers)) {
      if (typeof v !== 'string' || !/^[A-Za-z0-9-]+$/.test(h)) continue;
      const envName = `FACTORY_MCP_${name}_${h}`.toUpperCase().replace(/[^A-Z0-9]/g, '_');
      out.env[envName] = v;
      vars.push(`${JSON.stringify(h)}=${JSON.stringify(envName)}`);
    }
    out.args.push('-c', `mcp_servers.${name}.url=${JSON.stringify(sv.url)}`);
    if (vars.length) out.args.push('-c', `mcp_servers.${name}.env_http_headers={${vars.join(', ')}}`);
    out.names.push(name);
  }
  return out;
}
/** The members a lead run writes as: itself, and the builders and monitor it starts as subagents. */
export function leadActors(roster, id) {
  return [id, ...roster.filter((m) => m.kind === 'agent' && ['builder', 'monitor'].includes(m.role)).map((m) => m.id)];
}
/** The factory commands a single-agent thread's agent needs: read state, post, raise and verify issues. */
const SOLO_CLI = ['inbox', 'turns', 'thread show', 'thread list', 'log', 'show', 'board', 'members', 'team list', 'task list', 'task show', 'issue list', 'issue show', 'issue new', 'verify', 'post', 'tell', 'validate'];
/**
 * What every headless Claude run may do without asking (anything else is
 * refused, never prompted): read files, search, and run those factory commands
 * as itself (never the board, the autopilot or a lead's command). Claude Code
 * also lets read-only shell commands through. A single-agent thread's `allow`
 * adds to this.
 */
export const CLAUDE_BASE_ALLOW = Object.freeze(['Read', 'Grep', 'Glob', 'Agent', ...SOLO_CLI.map((c) => `Bash(node factory/bin/factory.mjs ${c}:*)`)]);
/**
 * What the security reviewer's runs add to that (PROTOCOL §16): its review, Git's
 * read commands for the thread's diff, and npm audit for the dependency check.
 * It never edits, commits or pushes.
 */
export const SECURITY_ALLOW = Object.freeze([
  'Bash(node factory/bin/factory.mjs review:*)',
  'Bash(node factory/bin/factory.mjs worktree:*)',
  'Bash(git diff:*)',
  'Bash(git log:*)',
  'Bash(git show:*)',
  'Bash(git merge-base:*)',
  'Bash(npm audit:*)',
]);

/**
 * The environment of a headless Claude run: without the variables of the
 * Claude Code session that started the autopilot, so the run is a session of
 * its own and cannot reach back into that one.
 */
export function claudeEnv(env = process.env) {
  return Object.fromEntries(Object.entries(env).filter(([k]) => !/^(CLAUDECODE|CLAUDE_CODE_.*|CLAUDE_PID|CLAUDE_EFFORT)$/.test(k)));
}

/** The JSON lines of a `claude -p --output-format stream-json` log; the last `result` line holds the run's answer. */
function claudeResult(text) {
  const lines = String(text || '').split('\n');
  for (let i = lines.length - 1; i >= 0; i--) {
    const l = lines[i].trim();
    if (!l.startsWith('{') || !l.includes('"result"')) continue;
    try {
      const d = JSON.parse(l);
      if (d && d.type === 'result') return d;
    } catch {
      // a partial line
    }
  }
  return null;
}

/** Dollars to 4 places, as a run's cost is reported. */
const round4 = (n) => Math.round(n * 10000) / 10000;

/** A run log's start (its name begins with the time it started), in ms; NaN for another name. */
function logStart(name) {
  const m = /^(\d{4})(\d\d)(\d\d)T(\d\d)(\d\d)(\d\d)\.(\d{3})Z-/.exec(name);
  return m ? Date.UTC(+m[1], +m[2] - 1, +m[3], +m[4], +m[5], +m[6], +m[7]) : NaN;
}

/** The end of a file: a run log's result line is its last line, and a log can be megabytes long. */
function readTail(file, size = 262144) {
  const fd = fs.openSync(file, 'r');
  try {
    const len = fs.fstatSync(fd).size;
    const n = Math.min(size, len);
    const buf = Buffer.alloc(n);
    fs.readSync(fd, buf, 0, n, len - n);
    return buf.toString('utf8');
  } finally {
    fs.closeSync(fd);
  }
}

/**
 * The finished Claude runs whose logs are in teams/.autopilot/runs, oldest first:
 * [{log, member, session, total}], total being what the run reported (a resumed
 * session reports its running total, every earlier run of it included).
 */
function reportedTotals(root) {
  const dir = path.join(autopilotDir(root), 'runs');
  let names;
  try {
    names = fs.readdirSync(dir).filter((n) => n.endsWith('.log')).sort();
  } catch {
    return [];
  }
  const out = [];
  for (const log of names) {
    let r = null;
    try {
      r = claudeResult(readTail(path.join(dir, log)));
    } catch {
      continue;
    }
    const member = /^\d{8}T\d{6}\.\d{3}Z-[0-9a-f]*-(.+)\.log$/.exec(log)?.[1];
    if (!member || typeof r?.session_id !== 'string' || typeof r.total_cost_usd !== 'number' || !Number.isFinite(r.total_cost_usd)) continue;
    out.push({ log, member, session: r.session_id, total: round4(r.total_cost_usd) });
  }
  return out;
}

/** The cost ledger's lines (teams/.autopilot/costs.jsonl), skipping any that do not parse. */
function readLedger(root) {
  let text;
  try {
    text = fs.readFileSync(path.join(autopilotDir(root), COSTS_FILE), 'utf8');
  } catch {
    return [];
  }
  return text.split('\n').flatMap((l) => {
    try {
      const r = JSON.parse(l);
      return r && typeof r === 'object' ? [r] : [];
    } catch {
      return [];
    }
  });
}

/**
 * What one run cost on its own, from the total it reported. Claude Code reports a
 * resumed session's running total, so a run's own cost is that total less the
 * session's total when its previous run ended: from the ledger, else from that
 * run's log. null when the run reported no cost, or resumed a session whose
 * earlier total is nowhere to be found (counting it whole would count earlier runs again).
 */
export function ownCost(root, { total, session, resumed, log }) {
  if (total == null) return null;
  if (!session) return total;
  let before = null;
  for (const row of readLedger(root)) if (row.session === session && typeof row.session_usd === 'number') before = row.session_usd;
  if (before == null) {
    const name = path.basename(String(log || ''));
    before = reportedTotals(root).filter((x) => x.session === session && x.log < name).at(-1)?.total ?? null;
  }
  if (before == null) return resumed ? null : total;
  return total >= before ? round4(total - before) : total;
}

/**
 * Ledger lines written before runs were priced on their own (no session_usd) hold
 * their session's running total. Each is rewritten from its run's log with the
 * run's own cost, its session and that total; a line whose log is gone stays as
 * it was. Members' last and by_thread runs (which can predate the ledger) are
 * corrected the same way. Returns how many lines changed.
 */
export function repairCostLedger(root, members = {}) {
  const file = path.join(autopilotDir(root), COSTS_FILE);
  let text;
  try {
    text = fs.readFileSync(file, 'utf8');
  } catch {
    return 0;
  }
  const lines = text.split('\n').filter((l) => l.trim());
  const rows = lines.map((l) => {
    try {
      const r = JSON.parse(l);
      return r && typeof r === 'object' && !Array.isArray(r) ? r : null;
    } catch {
      return null;
    }
  });
  if (!rows.some((r) => r && !('session_usd' in r))) return 0;
  const runs = reportedTotals(root);
  // The run a recorded total came from (the same member and total, started before it ended), priced on its own.
  const price = (member, cost, endedAt) => {
    if (typeof cost !== 'number') return null;
    const at = Date.parse(endedAt);
    const run = runs.filter((x) => x.member === member && x.total === cost && logStart(x.log) <= at).at(-1);
    if (!run) return null;
    const before = runs.filter((x) => x.session === run.session && x.log < run.log).at(-1)?.total;
    return { own: before != null && run.total >= before ? round4(run.total - before) : run.total, session: run.session, total: run.total };
  };
  let changed = 0;
  const out = rows.map((r, i) => {
    if (!r || 'session_usd' in r) return lines[i];
    const p = price(r.member, r.cost_usd, r.at);
    if (p && p.own !== r.cost_usd) changed += 1;
    return JSON.stringify({ ...r, cost_usd: p ? p.own : r.cost_usd, session: p?.session ?? null, session_usd: p?.total ?? null });
  });
  writeAtomic(file, `${out.join('\n')}\n`);
  for (const [id, m] of Object.entries(members)) {
    if (!m || typeof m !== 'object') continue;
    const fix = (x) => {
      const p = x && typeof x === 'object' ? price(id, x.cost_usd, x.ended_at) : null;
      return p ? { ...x, cost_usd: p.own } : x;
    };
    if (m.last) m.last = fix(m.last);
    if (m.by_thread && typeof m.by_thread === 'object') m.by_thread = Object.fromEntries(Object.entries(m.by_thread).map(([ref, x]) => [ref, fix(x)]));
  }
  return changed;
}

/** Text of a run's final message, at most 600 chars. */
const clip = (s) => String(s || '').trim().slice(0, 600);

const NO_HEADLESS = { grok: 'Grok Bot has no headless mode: start it from the board when it has a turn' };

/** A member's `launch` (members.yaml): codex, claude or null. Rosters from before the key: openai runs on Codex. */
function launchOf(m) {
  if ('launch' in m) return m.launch ?? null;
  return m.id === 'openai' ? 'codex' : null;
}

/**
 * Who the autopilot can start, and the command for one run, from the roster's
 * `launch` keys. Each launcher: {enabled, reason, bin, argv({prompt, lastFile,
 * resume, fresh, allow}), newSession(), env(env), sessionIn(log), saidIn(log,
 * lastFile), costIn(log)}.
 *
 * Codex (openai): the workspace-write sandbox with network on, so it can run the
 * factory CLI and read code but has no GitHub sign-in (fable posts its PR
 * comments). gcloud's configuration folder is writable too, so gcloud runs with
 * the owner's sign-in. Runs ignore ~/.codex/config.toml, so none of the owner's MCP
 * servers or plugins load; model and effort as codexModel says.
 *
 * Claude (a single-agent thread's agent): `claude -p` with the member's model
 * and effort, the project's settings only (never the owner's user or local
 * allow lists), no MCP servers, only CLAUDE_TOOLS, and permission mode dontAsk:
 * what CLAUDE_BASE_ALLOW and the thread's `allow` do not cover is refused. Its
 * subagents are the built-in types only, in this checkout (CLAUDE_SETTINGS).
 *
 * A thread's first run starts a session; later runs resume it, so the agent
 * keeps the thread's context.
 */
export function launchers(root, env = process.env) {
  let roster = [];
  try {
    roster = openStore({ root }).members();
  } catch {
    roster = [{ id: 'openai', kind: 'agent', role: 'reviewer' }];
  }
  const out = {};
  let codex;
  let claude;
  for (const m of roster) {
    if (m.kind !== 'agent' || typeof m.id !== 'string') continue;
    const kind = launchOf(m);
    if (kind === 'codex') {
      if (codex === undefined) codex = findCodex(env);
      out[m.id] = codex ? codexLauncher(root, env, codex, m.id) : { enabled: false, reason: 'no Codex CLI found: install it or set FACTORY_CODEX_BIN' };
    } else if (kind === 'claude') {
      if (claude === undefined) claude = findClaude(env);
      out[m.id] = claude ? claudeLauncher(root, env, claude, m) : { enabled: false, reason: 'no Claude Code found: install it or set FACTORY_CLAUDE_BIN' };
      // A thread whose roles put the lead on an OpenAI model runs the lead on Codex instead.
      if (claude && m.role === 'lead') {
        if (codex === undefined) codex = findCodex(env);
        if (codex) out[m.id].codex = codexLeadLauncher(root, env, codex);
      }
    } else if (['reviewer', 'gatekeeper', 'solo'].includes(m.role)) {
      out[m.id] = { enabled: false, reason: NO_HEADLESS[m.id] || `${m.name || m.id} has no launch in factory/members.yaml: start it from the board when it has a turn` };
    }
  }
  return out;
}

/**
 * gcloud's configuration folder. gcloud writes its credential and token
 * databases and its logs there on every command, so a sandbox that can only
 * read it fails before any API call ("Unable to create private file
 * credentials.db").
 */
export const gcloudConfigDir = (env = process.env) => env.CLOUDSDK_CONFIG || path.join(os.homedir(), '.config', 'gcloud');

function codexLauncher(root, env, codex, id) {
  const common = (picked) => {
    const { model: roster, effort } = codexModel(env, root, id);
    const model = picked || roster;
    const gcloud = gcloudConfigDir(env);
    return [
      '--ignore-user-config',
      '-c', 'sandbox_workspace_write.network_access=true',
      // The owner's gcloud sign-in, so a run can make the reads a thread approved (e.g. a host over IAP SSH).
      ...(fs.existsSync(gcloud) ? ['-c', `sandbox_workspace_write.writable_roots=[${JSON.stringify(gcloud)}]`] : []),
      ...(model ? ['-m', model] : []),
      ...(effort ? ['-c', `model_reasoning_effort="${effort}"`] : []),
    ];
  };
  return {
    kind: 'codex',
    enabled: true,
    reason: null,
    bin: codex,
    // `model`: the OpenAI model the thread's roles picked for this run (roleModel), else the roster's.
    argv: ({ prompt, lastFile, resume, model = null }) => (resume
      ? [codex, 'exec', 'resume', ...common(model), '-c', 'sandbox_mode="workspace-write"', '-o', lastFile, resume, prompt]
      : [codex, 'exec', ...common(model), '--cd', root, '-s', 'workspace-write', '-o', lastFile, prompt]),
    newSession: () => null,
    env: (e) => e,
    sessionIn: (text) => sessionIdIn(text),
    saidIn: (_text, lastFile) => {
      try {
        return clip(fs.readFileSync(lastFile, 'utf8'));
      } catch {
        return ''; // the agent wrote no final message
      }
    },
    costIn: () => null,
    deniedIn: () => [],
    // A run the autopilot took over is not its child: Codex writes the -o file only when it finishes.
    exitIn: (_text, lastFile) => (lastFile && fs.existsSync(lastFile) ? 0 : null),
  };
}

/** Where the factory's thread worktrees live (store.worktreeCommands): beside the checkout. */
export const worktreesDir = (root) => path.join(path.dirname(root), `${path.basename(root)}-factory`);

/**
 * The lead on Codex, for a thread whose roles pick an OpenAI lead model. Like
 * the Claude lead's auto mode: commands run in the workspace-write sandbox
 * (the checkout and the worktrees folder writable, network on), and what needs
 * more (a Git write under .git, a push, gh with the owner's sign-in) is asked
 * for and judged by Codex's automatic reviewer, never the owner. The factory's
 * lead guard runs as a PreToolUse hook on every shell command, so the owner's
 * steps (merge, tag, push to main, release, deploy) are refused as they are for
 * a Claude lead. The lead's MCP servers load from the same file (codexMcp).
 * Model: the thread's lead model; effort: openai's (codexModel).
 */
function codexLeadLauncher(root, env, codex) {
  const common = (picked) => {
    const { effort } = codexModel(env, root, OPENAI_AGENT);
    const wt = worktreesDir(root);
    const hook = `[{matcher="Bash", hooks=[{type="command", command=${JSON.stringify(guardCommand('lead'))}}]}]`;
    return [
      '--ignore-user-config', '--dangerously-bypass-hook-trust',
      ...(picked ? ['-m', picked] : []),
      ...(effort ? ['-c', `model_reasoning_effort="${effort}"`] : []),
      '-c', 'approval_policy="on-request"',
      '-c', 'approvals_reviewer="auto_review"',
      '-c', 'sandbox_mode="workspace-write"',
      '-c', 'sandbox_workspace_write.network_access=true',
      ...(fs.existsSync(wt) ? ['-c', `sandbox_workspace_write.writable_roots=[${JSON.stringify(wt)}]`] : []),
      '-c', `hooks.PreToolUse=${hook}`,
      ...codexMcp(leadMcpConfig(root, env)).args,
    ];
  };
  return {
    kind: 'codex',
    role: 'lead',
    enabled: true,
    reason: null,
    bin: codex,
    timeoutMs: LEAD_RUN_TIMEOUT_MS,
    argv: ({ prompt, lastFile, resume, model = null }) => (resume
      ? [codex, 'exec', 'resume', ...common(model), '-o', lastFile, resume, prompt]
      : [codex, 'exec', ...common(model), '--cd', root, '-o', lastFile, prompt]),
    newSession: () => null,
    env: (e) => ({ ...e, ...codexMcp(leadMcpConfig(root, e)).env }),
    sessionIn: (text) => sessionIdIn(text),
    saidIn: (_text, lastFile) => {
      try {
        return clip(fs.readFileSync(lastFile, 'utf8'));
      } catch {
        return ''; // the agent wrote no final message
      }
    },
    costIn: () => null,
    deniedIn: () => [],
    // A run the autopilot took over is not its child: Codex writes the -o file only when it finishes.
    exitIn: (_text, lastFile) => (lastFile && fs.existsSync(lastFile) ? 0 : null),
  };
}

function claudeLauncher(root, env, claude, member) {
  const pick = (k) => {
    let cur = member;
    try {
      cur = openStore({ root }).members().find((x) => x.id === member.id) || member;
    } catch {
      // keep the roster entry the autopilot started with
    }
    return typeof cur[k] === 'string' && cur[k].trim() ? cur[k].trim() : null;
  };
  const lead = member.role === 'lead';
  return {
    kind: 'claude',
    role: member.role || null,
    enabled: true,
    reason: null,
    bin: claude,
    timeoutMs: lead ? LEAD_RUN_TIMEOUT_MS : RUN_TIMEOUT_MS,
    argv: ({ prompt, resume, fresh, allow = [], model: picked = null }) => {
      // Read on every run, so a roster edit (or $FACTORY_CLAUDE_MODEL / _EFFORT) applies to the next one.
      // The model the owner picked for this role on this thread (its `roles`) comes first.
      const model = picked || env.FACTORY_CLAUDE_MODEL || pick('model');
      const effort = env.FACTORY_CLAUDE_EFFORT || pick('effort');
      // A thread file can be edited by hand: an entry that is not a permission rule (a flag, say) never reaches argv.
      const rules = lead ? [...CLAUDE_LEAD_ALLOW] : [...new Set([...CLAUDE_BASE_ALLOW, ...allow.filter((x) => !allowRuleProblem(x))])];
      return [
        claude, '-p',
        ...(model ? ['--model', model] : []),
        ...(effort ? ['--effort', effort] : []),
        '--setting-sources', 'project',
        '--settings', lead ? CLAUDE_LEAD_SETTINGS : CLAUDE_SETTINGS,
        '--strict-mcp-config',
        ...(lead && leadMcpConfig(root, env) ? ['--mcp-config', leadMcpConfig(root, env)] : []),
        '--tools', lead ? CLAUDE_LEAD_TOOLS : CLAUDE_TOOLS,
        // The lead works like the owner's own session in auto mode: a classifier
        // approves each action, and what it refuses is refused, never prompted.
        '--permission-mode', lead ? 'auto' : 'dontAsk',
        // One argument per rule, in --flag=value form: a value can never be read as another option.
        ...rules.map((x) => `--allowedTools=${x}`),
        '--output-format', 'stream-json', '--verbose',
        ...(resume ? ['--resume', resume] : ['--session-id', fresh]),
        prompt,
      ];
    },
    newSession: () => crypto.randomUUID(),
    // Its Bash tool stops a command after 2 minutes by default; a check that builds first needs longer.
    // 10 minutes by default and up to 55 (inside the run's 60-minute limit), unless the owner set them.
    // Headless Claude Code stops background subagents 10 minutes after the run's last turn, which killed
    // the lead's builders mid-task (they take longer). 0 waits for them; the run's own time limit still applies.
    env: (e) => ({ BASH_DEFAULT_TIMEOUT_MS: '600000', BASH_MAX_TIMEOUT_MS: '3300000', ...claudeEnv(e), CLAUDE_CODE_PRINT_BG_WAIT_CEILING_MS: '0' }),
    sessionIn: (text) => {
      const id = claudeResult(text)?.session_id;
      return typeof id === 'string' && SESSION_RE.test(id) ? id : null;
    },
    saidIn: (text) => clip(claudeResult(text)?.result),
    costIn: (text) => {
      const c = claudeResult(text)?.total_cost_usd;
      return typeof c === 'number' && Number.isFinite(c) ? Math.round(c * 10000) / 10000 : null;
    },
    deniedIn: (text) => deniedIn(claudeResult(text)),
    // A run the autopilot took over is not its child: its result line says how it ended.
    exitIn: (text) => {
      const r = claudeResult(text);
      return r ? (r.is_error ? 1 : 0) : null;
    },
  };
}

/** The tool calls a run's permission mode refused ({tool, command?, input}), from its result line's `permission_denials`. */
export function deniedIn(result) {
  const list = Array.isArray(result?.permission_denials) ? result.permission_denials : [];
  return list
    .filter((d) => d && typeof d.tool_name === 'string')
    .map((d) => ({ tool: d.tool_name, ...(typeof d.tool_input?.command === 'string' ? { command: d.tool_input.command } : {}), input: d.tool_input ?? null }));
}

/**
 * Whether to start a member now: {launch: {ref, turnIds} | null, reason}.
 * reason: idle (no turns), stuck (only turns a run already left open), running,
 * manual (the owner has a session open for it), settling, capped, launch.
 * Notices (event, alert, report) never start a run: the member's next write closes them.
 * The one exception is a phase event that hands the thread to its lead (into
 * design, plan or build): nothing else asks the lead to go on after you approve
 * the brief or the reviewer approves design_review.
 */
export function decide({ turns, mstate, presence, nowMs, settleMs = SETTLE_MS, maxRuns = MAX_RUNS_PER_HOUR, maxParallel = MAX_PARALLEL_RUNS }) {
  // Notices wait for the next run, except a phase the lead works in and a watch thread come due (§16, "Schedules").
  const work = turns.filter((t) => !NOTICE_TYPES.includes(t.message.type) || (t.message.kind === 'phase' && LEAD_PHASES.includes(t.message.phase)) || t.message.kind === 'watch_due');
  const stuck = new Set(mstate.stuck || []);
  const fresh = work.filter((t) => !stuck.has(t.message.id));
  if (!fresh.length) return { launch: null, reason: work.length ? 'stuck' : 'idle' };
  // One run per thread: a thread with a run going waits for it; every other thread may start.
  const busy = new Set(Object.keys(runsOf(mstate)));
  const free = fresh.filter((t) => !busy.has(`${t.team}/${t.thread}`));
  if (!free.length || busy.size >= maxParallel) return { launch: null, reason: 'running' };
  // The owner's own session for this member: only while no run of its own is going (a run writes that presence too).
  if (presence && !busy.size) {
    const atMs = Date.parse(presence.at);
    const lastEndMs = Date.parse(mstate.last?.ended_at || '') || 0;
    if (presence.state === 'watching' && presence.alive) return { launch: null, reason: 'manual' };
    if (presence.state === 'working' && atMs > lastEndMs && nowMs - atMs < MANUAL_ACTIVE_MS) return { launch: null, reason: 'manual' };
  }
  const settled = free.filter((t) => t.age_seconds * 1000 >= settleMs);
  if (!settled.length) return { launch: null, reason: 'settling' };
  // The hourly limit counts runs per thread: something looping on one thread never stops the others.
  const recentOn = (ref) => (mstate.runs_by_ref?.[ref] || []).filter((ts) => nowMs - Date.parse(ts) < 3600000).length;
  const open = settled.filter((t) => recentOn(`${t.team}/${t.thread}`) < maxRuns);
  if (!open.length) return { launch: null, reason: 'capped' };
  const ref = `${open[0].team}/${open[0].thread}`;
  const turnIds = free.filter((t) => `${t.team}/${t.thread}` === ref).map((t) => t.message.id);
  return { launch: { ref, turnIds }, reason: 'launch' };
}

const iso = () => new Date().toISOString();
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
// Milliseconds and a random suffix: two runs never share a log, so a log holds one session id.
const stampNow = () => `${iso().replace(/[-:]/g, '')}-${Math.random().toString(16).slice(2, 6)}`;

/** Stop a run and everything it started (it runs in its own process group). */
function killGroup(pid, signal = 'SIGTERM') {
  try {
    process.kill(-pid, signal);
  } catch {
    try {
      process.kill(pid, signal);
    } catch {
      // already gone
    }
  }
}

export function autopilotDir(root) {
  return path.join(root, 'teams', AUTOPILOT_DIR);
}

/** teams/.autopilot/sessions.json: {member: {thread-ref: session id}}, one agent session per thread. */
export function readSessions(root) {
  try {
    const rec = JSON.parse(fs.readFileSync(path.join(autopilotDir(root), 'sessions.json'), 'utf8'));
    return rec && typeof rec === 'object' && !Array.isArray(rec) ? rec : {};
  } catch {
    return {};
  }
}

/** Record (or with id null, forget) the session one member uses on one thread. */
export function setSession(root, member, ref, id) {
  const all = readSessions(root);
  const mine = all[member] && typeof all[member] === 'object' ? { ...all[member] } : {};
  if (id) mine[ref] = id;
  else delete mine[ref];
  all[member] = mine;
  writeAtomic(path.join(autopilotDir(root), 'sessions.json'), `${JSON.stringify(all, null, 2)}\n`);
  return all;
}

/** The pid of the live autopilot for this root (checked by its command line, so a reused pid does not count), or null. */
export function runningAutopilot(root) {
  try {
    const rec = JSON.parse(fs.readFileSync(path.join(autopilotDir(root), 'state.json'), 'utf8'));
    return rec && rec.pid !== process.pid && isAutopilotPid(rec.pid) ? rec.pid : null;
  } catch {
    return null;
  }
}

/**
 * Whether a recorded run's pid is still that agent run: its launcher's name and
 * its mark (the run's session id or output file, which only its command line
 * holds) are in the command line, so a reused pid (say, the owner's own Claude
 * Code session) is never taken for it.
 */

/**
 * Whether the autopilot may start this member for a turn on this thread: on a
 * single-agent thread only its agent. A Claude Code run elsewhere only for the
 * lead, on a thread it leads (its prompt and permissions are the lead's), and for
 * the security reviewer, on a thread whose security_review gate it owns.
 */
export function mayStart(launchKind, id, th, role = null) {
  if (th && th.kind === 'solo') return th.owner === id;
  if (launchKind !== 'claude') return true;
  // The security reviewer runs only on the project threads whose security_review gate it owns.
  if (role === 'security') return Boolean(th) && th.kind === 'project' && th.gates?.security_review?.by === id;
  return role === 'lead' && Boolean(th) && th.lead === id;
}

/**
 * Stop agent runs that a dead autopilot left behind (it crashed or was killed
 * before it could stop them). Returns [{member, pid, ref}] for each one stopped.
 */
export function stopLeftoverRuns(root) {
  let rec;
  try {
    rec = JSON.parse(fs.readFileSync(path.join(autopilotDir(root), 'state.json'), 'utf8'));
  } catch {
    return [];
  }
  if (!rec || isAutopilotPid(rec.pid)) return [];
  const out = [];
  let changed = false;
  for (const [member, m] of Object.entries(rec.members || {})) {
    const live = Object.values(runsOf(m));
    if (!live.length) continue;
    for (const r of live) {
      if (!isRunPid(r)) continue;
      killGroup(r.pid);
      out.push({ member, pid: r.pid, ref: r.ref });
    }
    // Recorded as ended, as the next autopilot would: the board then reads its presence as the run's, not a session's.
    m.last = { ...newestRun(runsOf(m)), ended_at: new Date().toISOString(), exit_code: null, signal: null, outcome: 'stopped', left_open: [], said: '' };
    m.running = null;
    m.running_by_ref = {};
    changed = true;
  }
  if (changed) {
    try {
      writeAtomic(path.join(autopilotDir(root), 'state.json'), `${JSON.stringify(rec, null, 2)}\n`);
    } catch {
      // the runs are stopped; the next autopilot records them
    }
  }
  return out;
}

/** teams/.autopilot/lock holds the live autopilot's pid: one autopilot per root. A dead holder's lock is taken over. */
function takeLock(root) {
  const file = path.join(autopilotDir(root), 'lock');
  fs.mkdirSync(path.dirname(file), { recursive: true });
  for (let tries = 0; tries < 2; tries++) {
    try {
      fs.writeFileSync(file, `${process.pid}\n`, { flag: 'wx' });
      return () => {
        try {
          if (fs.readFileSync(file, 'utf8').trim() === String(process.pid)) fs.unlinkSync(file);
        } catch {
          // already gone
        }
      };
    } catch (err) {
      if (err.code !== 'EEXIST') throw err;
      const holder = Number.parseInt(fs.readFileSync(file, 'utf8'), 10);
      if (holder !== process.pid && isAutopilotPid(holder)) throw new FactoryError('conflict', `the autopilot is already running (pid ${holder})`);
      fs.rmSync(file, { force: true });
    }
  }
  throw new FactoryError('conflict', 'could not take the autopilot lock');
}

const sameJson = (a, b) => JSON.stringify(a) === JSON.stringify(b);

/**
 * Run the autopilot until stop() or, with once, for one pass plus the runs it
 * started. dryRun makes one pass and only reports what it would start.
 * Returns {stop, done}: done resolves to the final state.
 */
export function startAutopilot({ root, once = false, dryRun = false, settleMs = SETTLE_MS, env = process.env, log = () => {} }) {
  const dir = autopilotDir(root);
  const statePath = path.join(dir, 'state.json');
  const launch = launchers(root, env);
  const release = dryRun ? () => {} : takeLock(root);
  const state = { pid: dryRun ? null : process.pid, root, started_at: iso(), members: {} };
  // Carried over from the previous autopilot: each member's last run (its end
  // tells that run's own presence writes apart from an owner's session), its
  // hourly run count, its failed turns (a restart does not reset the one retry)
  // and why turns are held. Stuck turns are not carried over: a restart retries
  // them once. A dry run beside a live autopilot mirrors all of it.
  let prev = {};
  let prevLive = false;
  try {
    const rec = JSON.parse(fs.readFileSync(statePath, 'utf8'));
    if (rec && rec.members && typeof rec.members === 'object') prev = rec.members;
    prevLive = Boolean(rec && rec.pid !== process.pid && isAutopilotPid(rec.pid));
  } catch {
    // first start
  }
  const mirror = dryRun && prevLive;
  // Runs the previous autopilot left going (it was restarted, stopped, or died): this one takes them
  // over below, so a restart never interrupts an agent's work. [member, run] pairs.
  const inherited = [];
  for (const [id, l] of Object.entries(launch)) {
    const p = prev[id] && typeof prev[id] === 'object' ? prev[id] : {};
    const strings = (k) => (Array.isArray(p[k]) ? p[k].filter((x) => typeof x === 'string') : []);
    const runs = strings('runs').filter((ts) => Date.now() - Date.parse(ts) < 3600000);
    const last = p.last && typeof p.last === 'object' ? p.last : null;
    const prevRuns = runsOf(p);
    let runningByRef = mirror ? Object.fromEntries(Object.entries(prevRuns).filter(([, r]) => isRunPid(r))) : {};
    if (!dryRun && Object.keys(prevRuns).length) {
      runningByRef = prevRuns;
      for (const r of Object.values(prevRuns)) inherited.push([id, r]);
    }
    const runsByRef = Object.fromEntries(Object.entries(p.runs_by_ref && typeof p.runs_by_ref === 'object' && !Array.isArray(p.runs_by_ref) ? p.runs_by_ref : {})
      .map(([ref, list]) => [ref, (Array.isArray(list) ? list : []).filter((ts) => typeof ts === 'string' && Date.now() - Date.parse(ts) < 3600000)])
      .filter(([, list]) => list.length));
    const notes = p.notes && typeof p.notes === 'object' && !Array.isArray(p.notes) ? p.notes : {};
    const byThread = p.by_thread && typeof p.by_thread === 'object' && !Array.isArray(p.by_thread) ? p.by_thread : {};
    state.members[id] = { enabled: l.enabled, reason: l.reason, running: newestRun(runningByRef), running_by_ref: runningByRef, last, by_thread: byThread, stuck: mirror ? strings('stuck') : [], failed: strings('failed'), notes, capped: false, runs, runs_by_ref: runsByRef };
  }
  if (!dryRun) {
    // A run left by a member that no longer has a launcher (the roster changed) is stopped too.
    for (const [id, p] of Object.entries(prev)) {
      if (launch[id] || !p || typeof p !== 'object') continue;
      for (const r of Object.values(runsOf(p))) {
        if (!isRunPid(r)) continue;
        killGroup(r.pid);
        setTimeout(() => killGroup(r.pid, 'SIGKILL'), 5000).unref();
        log(`stopped ${id}'s run on ${r.ref} (pid ${r.pid}): ${id} no longer has a launcher`);
      }
    }
  }
  if (!dryRun) {
    try {
      const n = repairCostLedger(root, state.members);
      if (n) log(`corrected ${n} cost ledger line${n === 1 ? '' : 's'}: each holds its run's own cost now, not its session's running total`);
    } catch (err) {
      log(`could not correct the cost ledger: ${err.message}`);
    }
  }
  let saved = null;
  const save = () => {
    // Never write into a repo that is gone: the write would recreate its folder.
    if (dryRun || sameJson(saved, state) || !fs.existsSync(path.join(root, 'factory'))) return;
    try {
      writeAtomic(statePath, `${JSON.stringify(state, null, 2)}\n`);
      saved = JSON.parse(JSON.stringify(state));
    } catch (err) {
      log(`could not write ${statePath}: ${err.message}`);
    }
  };
  const runs = new Map(); // `${member} ${thread ref}` -> {rec, child, timer, done}
  const runKey = (id, ref) => `${id} ${ref}`;
  /** Drop a finished run from the member's record; `running` stays the newest one still going. */
  const dropRun = (m, ref) => {
    const by = { ...(m.running_by_ref || {}) };
    delete by[ref];
    m.running_by_ref = by;
    m.running = newestRun(by);
  };
  const plans = [];
  let stopping = false;

  const finish = (id, run, code, signal) => {
    clearTimeout(run.timer);
    const m = state.members[id];
    const r = run.rec;
    const l = run.l || launch[id];
    let still = new Set();
    try {
      const store = openStore({ root });
      // A lead run may have been started for its builders' dispatches: those are theirs, not its own.
      const holders = l.role === 'lead' ? leadActors(store.members(), id) : [id];
      still = new Set(holders.flatMap((h) => store.openTurns({ member: h }).map((t) => t.message.id)));
    } catch (err) {
      log(`could not read ${id}'s turns after its run: ${err.message}`);
    }
    const left = r.turns.filter((x) => still.has(x));
    let text = '';
    try {
      text = fs.readFileSync(path.join(root, r.log), 'utf8');
    } catch {
      // no log
    }
    // A run taken over from an earlier autopilot is not this one's child: how it ended is read from what it wrote
    // (null: it never finished, so it counts as failed and gets the one retry).
    if (run.adopted && code === null && !signal) code = l.exitIn?.(text, run.lastFile) ?? null;
    const outcome = stopping ? 'stopped' : r.timed_out ? 'timed_out' : code !== 0 ? 'failed' : left.length ? 'left_open' : 'answered';
    const said = l.saidIn(text, run.lastFile);
    // What the run reported (a resumed Claude session reports its running total) and what it cost on its own.
    const reported = l.costIn(text);
    const reportedSession = l.sessionIn(text) || null;
    let cost = reported;
    try {
      cost = ownCost(root, { total: reported, session: reportedSession, resumed: Boolean(r.session) && reportedSession === r.session, log: r.log });
    } catch (err) {
      log(`could not price ${id}'s run on ${r.ref} on its own: ${err.message}`);
    }
    const denied = outcome === 'stopped' ? [] : (l.deniedIn?.(text) || []);
    if (denied.length) {
      // A refused command never prompts in a headless run: put a permission card in front of the owner instead.
      try {
        const ev = openStore({ root }).notePermissionDenied({ ref: r.ref, member: id, denials: denied, turns: r.turns }).event;
        const why = ev ? `; asked you on the board (${ev.id})` : l.role === 'lead' ? ` (auto mode refused it; see ${r.log})` : ' (read-only or already allowed: nothing to ask)';
        log(`${id} was refused ${denied.length} command${denied.length === 1 ? '' : 's'} on ${r.ref}${why}`);
      } catch (err) {
        log(`could not record the commands ${id} was refused on ${r.ref}: ${err.message}`);
      }
    }
    let session = r.session || null;
    try {
      if (!session) {
        // A new session counts only when the log shows it started (a run that never got going leaves none to resume).
        session = l.sessionIn(text) || (r.new_session && text.includes(r.new_session) ? r.new_session : null);
        if (session && outcome !== 'stopped') setSession(root, id, r.ref, session);
      } else if (outcome === 'failed' && code !== null) {
        // Only a resume that exited with an error is forgotten: a run that vanished (a reboot) keeps its session.
        setSession(root, id, r.ref, null);
        log(`${id}: resuming session ${session} on ${r.ref} failed; the next run starts a new session`);
      }
    } catch (err) {
      log(`could not record ${id}'s session for ${r.ref}: ${err.message}`);
    }
    m.last = { ref: r.ref, turns: r.turns, started_at: r.started_at, ended_at: iso(), exit_code: code, signal: signal || null, outcome, left_open: left, log: r.log, said, session, bin: r.bin, cost_usd: cost, denied: denied.length };
    // The cost ledger the board totals per thread and per day (store.costs); a run that reports no cost is counted too.
    // cost_usd is the run's own cost; session_usd the session's total it reported, which prices the session's next run.
    try {
      fs.appendFileSync(path.join(autopilotDir(root), COSTS_FILE), `${JSON.stringify({ at: m.last.ended_at, member: id, ref: r.ref, outcome, cost_usd: cost, session: reportedSession, session_usd: reported })}\n`);
    } catch (err) {
      log(`could not record the cost of ${id}'s run on ${r.ref}: ${err.message}`);
    }
    // Each thread's latest run, for the board (the newest 50 threads). `restarts` counts the runs in a row
    // started only for builders a run left mid-task (strandedDispatches, MAX_BUILDER_RESTARTS).
    const byThread = { ...(m.by_thread || {}) };
    const restarts = r.restart ? (Number(byThread[r.ref]?.restarts) || 0) + 1 : 0;
    delete byThread[r.ref];
    byThread[r.ref] = { ended_at: m.last.ended_at, outcome, cost_usd: cost, restarts };
    m.by_thread = Object.fromEntries(Object.entries(byThread).slice(-50));
    if (outcome === 'left_open') m.stuck = [...new Set([...m.stuck, ...left])];
    if (outcome === 'failed' || outcome === 'timed_out') {
      // One retry for a failed run (a network blip); a second failure on the same turn waits for the owner.
      const again = left.filter((x) => m.failed.includes(x));
      m.stuck = [...new Set([...m.stuck, ...again])];
      m.failed = [...new Set([...m.failed, ...left])];
    }
    if (outcome !== 'answered' && outcome !== 'stopped') {
      for (const x of left) m.notes[x] = { outcome, ref: r.ref, log: r.log, said };
    }
    dropRun(m, r.ref);
    runs.delete(runKey(id, r.ref));
    save();
    log(`${id} run on ${r.ref} ended: ${outcome}${code === null ? '' : ` (exit ${code})`}${cost == null ? '' : `, $${cost}`}${left.length ? `; still open: ${left.join(', ')}` : ''}`);
  };

  const begin = (id, plan) => {
    const m = state.members[id];
    const stamp = stampNow();
    const logFile = path.join(dir, 'runs', `${stamp}-${id}.log`);
    const lastFile = path.join(dir, 'runs', `${stamp}-${id}.last.txt`);
    fs.mkdirSync(path.dirname(logFile), { recursive: true });
    let l = launch[id];
    const session = (readSessions(root)[id] || {})[plan.ref];
    const resume = typeof session === 'string' && SESSION_RE.test(session) ? session : null;
    const fresh = resume ? null : l.newSession();
    let th = null;
    let allow = [];
    let actors = [id];
    try {
      const store = openStore({ root });
      th = store.thread(plan.ref);
      // The team's rules and the thread's own, read at every start, so a grant applies to the next run.
      if (th.kind === 'solo' && th.owner === id) allow = store.soloAllow(plan.ref);
      if (l.role === 'security') allow = [...SECURITY_ALLOW];
      if (l.role === 'lead') actors = leadActors(store.members(), id);
    } catch {
      // the thread went away; the run finds out from its inbox
    }
    // An OpenAI lead model on this thread: the lead runs on Codex, alone (it starts no subagents).
    if (l.role === 'lead' && l.codex && leadOnOpenAI(th)) {
      l = l.codex;
      actors = [id];
    }
    const solo = th?.kind === 'solo' && th.owner === id;
    const kind = solo ? 'solo' : l.role === 'lead' ? 'lead' : 'project';
    // Builders the lead's last run here left mid-task (tick): this run starts them again.
    const left = kind === 'lead' && l.kind === 'claude' ? (plan.stranded?.dispatches || []).filter((x) => plan.turnIds.includes(x.id)) : [];
    const stranded = left.length ? { outcome: plan.stranded.outcome, dispatches: left } : null;
    // Started for nothing but those: counts toward MAX_BUILDER_RESTARTS. Any other turn resets the count.
    const restart = Boolean(stranded) && left.length === plan.turnIds.length;
    const prompt = kickoffPrompt(id, plan.ref, { auto: true, resumed: Boolean(resume), kind, codex: l.kind === 'codex' && kind === 'lead', stranded });
    const model = roleModel(th, id);
    const argv = l.argv({ prompt, lastFile, resume, fresh, allow: solo || l.role === 'security' ? allow : [], model });
    const mark = argv.includes(lastFile) ? lastFile : resume || fresh || null;
    const fd = fs.openSync(logFile, 'a');
    let child;
    try {
      // FACTORY_ACTOR: the run's factory CLI writes as this member only, on this root (factory.mjs refuses another --as or --root).
      // A lead run's list adds the builders and monitor it starts as subagents; its own id comes first.
      child = spawn(argv[0], argv.slice(1), { cwd: root, env: { ...l.env(env), FACTORY_ACTOR: actors.join(','), FACTORY_ROOT: root }, detached: true, stdio: ['ignore', fd, fd] });
    } finally {
      fs.closeSync(fd);
    }
    const started = iso();
    const rec = { pid: child.pid ?? null, bin: argv[0], ref: plan.ref, turns: plan.turnIds, started_at: started, log: path.relative(root, logFile), session: resume, new_session: fresh, mark, ...(restart ? { restart: true } : {}) };
    m.running_by_ref = { ...(m.running_by_ref || {}), [plan.ref]: rec };
    m.running = newestRun(m.running_by_ref);
    m.runs = [...m.runs.filter((ts) => Date.now() - Date.parse(ts) < 3600000), started];
    m.runs_by_ref = { ...(m.runs_by_ref || {}), [plan.ref]: [...((m.runs_by_ref || {})[plan.ref] || []).filter((ts) => Date.now() - Date.parse(ts) < 3600000), started] };
    const run = { rec, child, lastFile, l, timer: null, done: null };
    run.timer = setTimeout(() => {
      rec.timed_out = true;
      killGroup(child.pid);
      setTimeout(() => killGroup(child.pid, 'SIGKILL'), 5000).unref();
    }, l.timeoutMs || RUN_TIMEOUT_MS);
    run.timer.unref();
    run.done = new Promise((resolve) => {
      let ended = false;
      const end = (code, signal) => {
        if (ended) return;
        ended = true;
        // The run is over: nothing it started may keep running (or spending).
        if (child.pid) killGroup(child.pid, 'SIGKILL');
        try {
          finish(id, run, code, signal);
        } catch (err) {
          log(`${id} run on ${plan.ref} ended, but recording it failed: ${err.message}`);
          dropRun(m, plan.ref);
          runs.delete(runKey(id, plan.ref));
        }
        resolve();
      };
      child.on('error', (err) => {
        log(`${id} run on ${plan.ref} could not start: ${err.message}`);
        end(null, null);
      });
      child.on('close', end);
    });
    runs.set(runKey(id, plan.ref), run);
    openStore({ root }).notePresence(id, { state: 'working', thread: plan.ref, activity: 'started by the autopilot' });
    save();
    log(`started ${id} on ${plan.ref} for ${plan.turnIds.join(', ')} (${stranded ? 'builders its last run left mid-task; ' : ''}${resume ? `resuming session ${resume}` : 'new session'}; log ${rec.log})`);
  };

  // Threads whose builder restarts ran out, logged once per lead run that ended there.
  const capLogged = new Set();
  /**
   * The dispatches the lead's last run on each thread it leads left without a
   * builder (strandedDispatches), as turns for the lead: {turns, byRef}, byRef
   * mapping a thread ref to {outcome, dispatches: [{id, member}]} for its prompt.
   */
  const strandedFor = (store, id, m, threads) => {
    const out = { turns: [], byRef: new Map() };
    const subs = new Set(leadActors(store.members(), id).slice(1));
    const open = store.openTurns().filter((t) => subs.has(t.member));
    if (!open.length) return out;
    const taskOf = (t) => {
      try {
        const task = store.message(t.message.id).task;
        return task ? { ...store.task(`${t.team}/${task}`), id: task } : null;
      } catch {
        return null; // the message or task went away
      }
    };
    for (const [ref, th] of threads) {
      if (th.lead !== id || leadOnOpenAI(th)) continue;
      const last = m.by_thread?.[ref] || null;
      const found = strandedDispatches({ turns: open, lead: id, th, last, taskOf });
      if (!found.length) continue;
      if ((Number(last.restarts) || 0) >= MAX_BUILDER_RESTARTS) {
        const key = `${id} ${ref} ${last.ended_at}`;
        if (!capLogged.has(key)) {
          capLogged.add(key);
          log(`${id}'s last run on ${ref} left builders mid-task again (${found.map((t) => `${t.message.id} ${t.member}`).join(', ')}); after ${MAX_BUILDER_RESTARTS} restarts in a row for them, it waits for a new turn there`);
        }
        continue;
      }
      out.turns.push(...found);
      out.byRef.set(ref, { outcome: last.outcome, dispatches: found.map((t) => ({ id: t.message.id, member: t.member })) });
    }
    return out;
  };

  // Why each thread's schedule last failed: logged when it first fails or the reason changes, not every pass.
  const scheduleFailures = new Map();
  const tick = () => {
    const store = openStore({ root });
    // The clock first (§16, "Schedules"): what it sends below is a turn this same pass sees.
    if (!dryRun) {
      try {
        const r = store.runSchedules();
        for (const x of r.sent) log(`schedule on ${x.ref}: sent ${x.message} to ${x.to.join(', ')}; next ${x.next}`);
        for (const x of r.skipped) log(`schedule on ${x.ref}: ${x.waiting.join(', ')} still waits on its answer, so none sent; next ${x.next}`);
        for (const x of r.due) log(`${x.ref} is due: told ${x.to.join(', ')}`);
        for (const x of r.failed) {
          if (scheduleFailures.get(x.ref) !== x.error) log(`schedule on ${x.ref} failed: ${x.error}`);
        }
        scheduleFailures.clear();
        for (const x of r.failed) scheduleFailures.set(x.ref, x.error);
      } catch (err) {
        log(`schedules failed: ${err.message}`);
      }
    }
    const presence = store.presence();
    const threads = new Map(store.threads().map((th) => [`${th.team}/${th.id}`, th]));
    for (const [id, l] of Object.entries(launch)) {
      const m = state.members[id];
      if (!l.enabled) continue;
      const turns = store.openTurns({ member: id }).filter((t) => {
        const th = threads.get(`${t.team}/${t.thread}`);
        // A thread that puts the lead on an OpenAI model waits when there is no Codex CLI to run it.
        if (l.role === 'lead' && leadOnOpenAI(th) && !l.codex) return false;
        return mayStart(l.kind, id, th, l.role);
      });
      // Builders its last run on a thread left mid-task: nothing else asks the lead to go on there.
      const stranded = l.role === 'lead' && l.kind === 'claude' ? strandedFor(store, id, m, threads) : null;
      if (stranded) turns.push(...stranded.turns);
      const open = new Set(turns.map((t) => t.message.id));
      m.stuck = m.stuck.filter((x) => open.has(x));
      m.failed = m.failed.filter((x) => open.has(x));
      m.notes = Object.fromEntries(Object.entries(m.notes).filter(([x]) => open.has(x)));
      let d = decide({ turns, mstate: m, presence: presence[id], nowMs: Date.now(), settleMs });
      m.capped = d.reason === 'capped';
      if (dryRun) {
        plans.push({ member: id, ...d });
        continue;
      }
      // Every thread with work starts in the same pass, each in its own run, up to MAX_PARALLEL_RUNS.
      for (let n = 0; d.launch && n < MAX_PARALLEL_RUNS; n++) {
        begin(id, { ...d.launch, stranded: stranded?.byRef.get(d.launch.ref) || null });
        d = decide({ turns, mstate: m, presence: presence[id], nowMs: Date.now(), settleMs });
      }
    }
    save();
  };

  /**
   * Take over a run an earlier autopilot started: watch its pid, keep its time
   * limit, and record it when it ends, as if this autopilot had started it.
   */
  const adopt = (id, rec) => {
    const base = launch[id];
    const name = path.basename(String(rec.bin || ''));
    // The lead's runs go to Claude Code or, on a thread with an OpenAI lead model, to Codex.
    const l = base.codex && name === path.basename(base.codex.bin) && name !== path.basename(String(base.bin || '')) ? base.codex : base;
    const lastFile = path.join(root, String(rec.log || '').replace(/\.log$/, '.last.txt'));
    const run = { rec, child: null, lastFile, l, timer: null, poll: null, done: null, adopted: true };
    let ended = false;
    let end;
    run.done = new Promise((resolve) => {
      end = (watched) => {
        if (ended) return;
        ended = true;
        clearInterval(run.poll);
        // Seen to end just now: nothing it started may keep running. A run that ended before this
        // autopilot came up is long gone, and its pid may be a stranger's by now.
        if (watched) killGroup(rec.pid, 'SIGKILL');
        try {
          finish(id, run, null, null);
        } catch (err) {
          log(`${id} run on ${rec.ref} ended, but recording it failed: ${err.message}`);
          dropRun(state.members[id], rec.ref);
          runs.delete(runKey(id, rec.ref));
        }
        resolve();
      };
    });
    runs.set(runKey(id, rec.ref), run);
    if (!isRunPid(rec)) {
      // It ended while no autopilot watched: record it now (its session, what it said, its open turns).
      log(`${id}'s run on ${rec.ref} (pid ${rec.pid}) ended while no autopilot was running; recording it`);
      end(false);
      return;
    }
    const startedMs = Date.parse(rec.started_at);
    const limit = (Number.isFinite(startedMs) ? startedMs : Date.now()) + (l.timeoutMs || RUN_TIMEOUT_MS) - Date.now();
    run.timer = setTimeout(() => {
      rec.timed_out = true;
      killGroup(rec.pid);
      setTimeout(() => killGroup(rec.pid, 'SIGKILL'), 5000).unref();
    }, Math.max(0, limit));
    run.timer.unref();
    // Kept referenced: a run taken over is not a child, so this watch is what keeps --once waiting for it. leave() and end() clear it.
    run.poll = setInterval(() => {
      if (!isRunPid(rec)) end(true);
    }, ADOPT_POLL_MS);
    log(`took over ${id}'s run on ${rec.ref} (pid ${rec.pid}, started ${rec.started_at}) from an earlier autopilot`);
  };

  // Set when a stop also ends the runs (`autopilot --stop --runs`, or the repo is gone).
  let killRuns = false;
  let wake = () => {};
  const stopped = new Promise((resolve) => {
    wake = resolve;
  });
  /**
   * Stop starting runs. The runs going keep going, so a restart never interrupts
   * an agent's work: the next autopilot takes them over. withRuns stops them too.
   */
  const stop = ({ withRuns = false } = {}) => {
    if (withRuns && !killRuns) {
      killRuns = true;
      for (const run of runs.values()) killGroup(run.rec.pid);
    }
    stopping = true;
    wake();
  };
  /** Leave the runs going for the next autopilot: stop watching them and record nothing more about them. */
  const leave = () => {
    for (const run of runs.values()) {
      clearTimeout(run.timer);
      clearInterval(run.poll);
      if (run.child) {
        run.child.removeAllListeners('close');
        run.child.removeAllListeners('error');
        run.child.unref();
      }
      log(`left ${run.rec.ref} going (pid ${run.rec.pid}); the next autopilot takes it over`);
    }
  };

  let gone = false;
  let missing = 0;
  for (const [id, rec] of inherited) adopt(id, rec);
  const done = (async () => {
    try {
      save();
      if (!dryRun) log(`autopilot started for ${root}: ${Object.entries(launch).map(([id, l]) => (l.enabled ? `${id} on` : `${id} off (${l.reason})`)).join('; ')}`);
      while (!stopping) {
        // The repo it serves is gone (a deleted checkout or test folder): nothing will ever need starting
        // again. Its factory/ folder missing on two passes in a row, so a moment mid-checkout never counts.
        missing = fs.existsSync(path.join(root, 'factory')) ? 0 : missing + 1;
        if (missing >= 2) {
          gone = true;
          stop({ withRuns: true });
          break;
        }
        // No pass while it is missing: a pass would start nothing and write state into a folder that may be gone.
        if (!missing) {
          try {
            tick();
          } catch (err) {
            log(`pass failed: ${err.message}`);
          }
        }
        if (once || dryRun) break;
        await sleep(TICK_MS);
      }
      const allDone = () => Promise.all([...runs.values()].map((r) => r.done));
      // --once waits for its runs, unless a stop comes meanwhile; a stop leaves them going, unless it ends them too.
      if (!stopping) await Promise.race([allDone(), stopped]);
      if (stopping && !killRuns) leave();
      else await allDone();
      // Writing the stop would recreate the folder of a repo that is gone.
      if (!dryRun && !gone) {
        state.pid = null;
        state.stopped_at = iso();
        save();
      }
      return { ...state, plans };
    } finally {
      release();
    }
  })();
  return { stop, done };
}
