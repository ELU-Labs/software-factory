// The shared read/write/validate layer of the software factory. The CLI
// (factory/bin/factory.mjs) and the board UI (tools/factory-ui) both go through
// it; nothing else should write teams/.
//
// Files are the truth: every read goes to disk, every write happens under the
// team lock, mutable files are replaced atomically, message files are created
// exclusively and never rewritten, decisions.md and metrics.jsonl only grow.
// Every state change posts one `event` message from `factory`.

import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { execSync, execFileSync } from 'node:child_process';
import { parseYaml, stringifyFrontmatter, parseFrontmatter } from './yaml.mjs';
import { normalizeRoles, rolesStaffing } from './roles.mjs';

const LIB_DIR = path.dirname(fileURLToPath(import.meta.url));
const CODE_FACTORY_DIR = path.resolve(LIB_DIR, '..');
const CODE_ROOT = path.resolve(LIB_DIR, '../..');

// ---------------------------------------------------------------------------
// Vocabulary
// ---------------------------------------------------------------------------

/** Project thread phases, in order. */
export const PROJECT_PHASES = Object.freeze(['brief', 'design', 'design_review', 'plan', 'build', 'code_review', 'security_review', 'final_review', 'signoff', 'done']);
/** Watch thread phases. */
export const WATCH_PHASES = Object.freeze(['active', 'paused']);
/** Single-agent thread phases: always ready for the next request. */
export const SOLO_PHASES = Object.freeze(['active']);
/** Gates moved by a review (phase name == gate name). */
export const REVIEW_GATES = Object.freeze(['brief', 'design_review', 'code_review', 'security_review', 'final_review', 'signoff']);
/** Every gate of a project thread, in order (`build` approves itself). */
export const GATES = Object.freeze(['brief', 'design_review', 'build', 'code_review', 'security_review', 'final_review', 'signoff']);
/**
 * Gates a project thread has only when its roles picked someone for them
 * (PROTOCOL §6, "Roles"). A thread without one skips that phase.
 */
export const OPTIONAL_GATES = Object.freeze(['security_review']);

/** A project thread's phases in order: PROJECT_PHASES without the optional gates it does not have. */
export function threadPhases(th) {
  return PROJECT_PHASES.filter((p) => !OPTIONAL_GATES.includes(p) || isObject(th?.gates?.[p]));
}
/** Gate statuses. */
export const GATE_STATUSES = Object.freeze(['pending', 'approved', 'changes_requested', 'blocked']);
/** Allowed message types. */
export const MESSAGE_TYPES = Object.freeze(['kickoff', 'proposal', 'review', 'review_response', 'question', 'answer', 'dispatch', 'result', 'escalation', 'decision', 'report', 'alert', 'event', 'note']);
/** Review verdicts. */
export const VERDICTS = Object.freeze(['approve', 'changes_requested', 'blocked']);
/** Review point and issue severities, most severe first. */
export const SEVERITIES = Object.freeze(['high', 'medium', 'low', 'nit']);
/** Lead stances on a review point. */
export const STANCES = Object.freeze(['accepted', 'rejected', 'deferred']);
/** Task result outcomes. */
export const OUTCOMES = Object.freeze(['done', 'blocked', 'failed']);
/** Task statuses. */
export const TASK_STATUSES = Object.freeze(['todo', 'doing', 'review', 'done', 'blocked']);
/** Issue statuses. */
export const ISSUE_STATUSES = Object.freeze(['open', 'accepted', 'rejected', 'deferred', 'fixed', 'verified']);
/** Thread kinds. */
export const THREAD_KINDS = Object.freeze(['project', 'watch', 'solo']);
/** Kinds of automatic `event` messages. */
export const EVENT_KINDS = Object.freeze(['thread_created', 'section_updated', 'thread_config', 'phase', 'gate', 'task_created', 'task_status', 'task_updated', 'issue_created', 'issue_status', 'decision', 'watch_run', 'watch_state', 'permission_denied', 'eta', 'merged']);
/**
 * Message types whose turns are notifications: no command answers them, so the
 * recipient's next write in that thread closes them (the store adds them to the
 * `resolves` of the first message that write produces).
 */
export const NOTICE_TYPES = Object.freeze(['event', 'alert', 'report']);
/** The four keys of team.md `data_sources`. */
export const DATA_SOURCE_KEYS = Object.freeze(['usage', 'traces', 'latency', 'feedback']);
/** Roster member kinds. */
export const MEMBER_KINDS = Object.freeze(['human', 'agent', 'system']);
/** Roster member roles. */
export const MEMBER_ROLES = Object.freeze(['owner', 'lead', 'builder', 'monitor', 'reviewer', 'gatekeeper', 'security', 'solo', 'system']);
/** How the autopilot starts a member without a terminal (members.yaml `launch`). */
export const LAUNCH_KINDS = Object.freeze(['codex', 'claude']);

/** Message types that have their own command (post refuses them). */
const DEDICATED_COMMANDS = {
  review: 'factory review <thread-ref> --verdict ...',
  review_response: 'factory respond <thread-ref> --stance ...',
  dispatch: 'factory dispatch <task-ref> --to <builder>',
  result: 'factory result <task-ref> --outcome done|blocked|failed',
  report: 'factory watch run <thread-ref> ...',
  alert: 'factory watch run <thread-ref> ...',
};

const ID_RE = /^[a-z0-9][a-z0-9-]{0,40}$/;
/** teams/.presence/<member>.json: what each agent is doing, written by the CLI (PROTOCOL §16, "Presence"). */
export const PRESENCE_DIR = '.presence';
export const PRESENCE_STATES = Object.freeze(['watching', 'working', 'idle']);
/** teams/.autopilot/: the autopilot's state.json, its log and one log per agent run (PROTOCOL §16, "Autopilot"). */
export const AUTOPILOT_DIR = '.autopilot';
/** teams/.archive/<team>-<stamp>/: archived teams, moved out whole by `team archive` (PROTOCOL §3). */
export const ARCHIVE_DIR = '.archive';
// An archived team's folder: <team id>-<yyyymmddThhmmssZ>[-n] (archiveTeam).
const ARCHIVED_RE = /^([a-z0-9][a-z0-9-]*?)-(\d{4})(\d{2})(\d{2})T(\d{2})(\d{2})(\d{2})Z(?:-\d+)?$/;
const MEMBER_ID_RE = /^[a-z0-9][a-z0-9-]*$/;
const MESSAGE_ID_RE = /^\d{8}T\d{6}Z-[a-z0-9][a-z0-9-]*-[0-9a-f]{4}$/;
const TASK_ID_RE = /^T-\d{3,}$/;
const ISSUE_ID_RE = /^I-\d{3,}$/;
const DECISION_ID_RE = /^D-\d{3,}$/;
const ISO_RE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d{1,3})?Z$/;
const CADENCE_RE = /^(hourly|daily|weekly|[1-9]\d*[hd])$/;
const DECISION_HEADING_RE = /^## D-(\d{3,}): (.+)$/;
const REPORT_NAME_RE = /^[a-z0-9][a-z0-9-]{0,40}-\d{8}T\d{6}Z(-\d+)?\.md$/;

const GATE_ENTRY_PHASES = new Set(['design_review', 'code_review', 'security_review', 'final_review', 'signoff']);
/** Phases the lead works in. Moving a thread into one hands it to the lead, and that phase event wakes it (autopilot). */
export const LEAD_PHASES = Object.freeze(['design', 'plan', 'build']);

/** The phases of a project thread that take an estimate (PROTOCOL §7, "Estimates"): all but done. */
export const ETA_PHASES = Object.freeze(PROJECT_PHASES.filter((p) => p !== 'done'));
/** The longest estimate: 7 days, in minutes. */
export const ETA_MAX_MINUTES = 7 * 24 * 60;

/** Minutes in a time such as 45m, 2h, 1h30m, 1.5h or 90 (minutes); null when it is not one. */
export function parseDuration(text) {
  const t = String(text ?? '').trim().toLowerCase().replace(/\s+/g, '');
  let m = t.match(/^(\d+(?:\.\d+)?)(?:m|min|mins)?$/);
  if (m) return Math.round(Number(m[1]));
  m = t.match(/^(\d+(?:\.\d+)?)h(?:(\d+)(?:m|min|mins)?)?$/);
  if (m) return Math.round(Number(m[1]) * 60 + Number(m[2] || 0));
  return null;
}

/** 45m, 2h, 1h 30m. */
export function fmtDuration(minutes) {
  const n = Math.max(0, Math.round(minutes));
  if (n < 60) return `${n}m`;
  const h = Math.floor(n / 60);
  const r = n % 60;
  return r ? `${h}h ${r}m` : `${h}h`;
}

function etaMinutes(text) {
  const m = parseDuration(text);
  if (m == null || m < 1 || m > ETA_MAX_MINUTES) fail('usage', `"${text ?? ''}" is not an estimate; give minutes or hours such as 45m, 2h or 1h30m (at most 7 days)`);
  return m;
}
/** Phases after the build: new work here is code nobody has reviewed yet, so the thread returns to build. */
const LATE_PHASES = new Set(['code_review', 'security_review', 'final_review', 'signoff', 'done']);
/** Project phases that can take a fix task for a watch issue (the brief is approved, the design is settled). */
const FIX_PHASES = new Set(['plan', 'build', 'code_review', 'security_review', 'final_review', 'signoff', 'done']);
const NOTICE_SET = new Set(NOTICE_TYPES);
const BACK_TARGET = { brief: 'brief', design_review: 'design', code_review: 'build', security_review: 'build', final_review: 'build', signoff: 'build' };
const GATE_STATUS_OF = { approve: 'approved', changes_requested: 'changes_requested', blocked: 'blocked' };
const DEFAULT_GATE_OWNERS = { brief: 'you', design_review: 'openai', code_review: 'openai', final_review: 'grok', signoff: 'you' };

const TEAM_KEYS = ['id', 'title', 'lead', 'eval_cmd', 'grader', 'data_sources', 'repo_paths', 'created'];
const PROJECT_KEYS = ['id', 'title', 'kind', 'team', 'phase', 'lead', 'members', 'gates', 'branch', 'cadence', 'thresholds', 'created', 'updated'];
const WATCH_KEYS = ['id', 'title', 'kind', 'team', 'phase', 'lead', 'owner', 'members', 'gates', 'branch', 'cadence', 'thresholds', 'last_run', 'created', 'updated'];
const SOLO_KEYS = ['id', 'title', 'kind', 'team', 'phase', 'lead', 'owner', 'members', 'gates', 'branch', 'allow', 'created', 'updated'];
const KIND_KEYS = { project: PROJECT_KEYS, watch: WATCH_KEYS, solo: SOLO_KEYS };
const KIND_PHASES = { project: PROJECT_PHASES, watch: WATCH_PHASES, solo: SOLO_PHASES };
/** How messages name a thread kind. */
const KIND_NAME = { project: 'project', watch: 'watch', solo: 'single-agent' };
const TASK_KEYS = ['id', 'title', 'thread', 'status', 'owner', 'issue', 'refs', 'created', 'updated'];
const ISSUE_KEYS = ['id', 'title', 'thread', 'gate', 'source', 'point', 'severity', 'status', 'raised_by', 'task', 'metric', 'reason', 'created', 'updated'];
const MESSAGE_KEYS = ['id', 'ts', 'thread', 'from', 'to', 'cc', 'type', 'reply_to', 'resolves', 'refs', 'internal'];
const MEMBER_KEYS = ['id', 'name', 'short', 'kind', 'vendor', 'model', 'role', 'color', 'runs'];
const ENTITY_ONLY_KEYS = new Set(['body', 'path', 'team', 'summary']);
const TEAM_DIR_ENTRIES = new Set(['team.md', 'decisions.md', 'metrics.jsonl', 'threads', 'comms', 'tasks', 'issues', 'reports', 'attachments', '.lock']);
/** Images a message can carry (§9, "Images"): type → file extension. SVG is left out (it can hold script). */
export const ATTACHMENT_TYPES = Object.freeze({ 'image/png': 'png', 'image/jpeg': 'jpg', 'image/gif': 'gif', 'image/webp': 'webp' });
export const MAX_ATTACHMENT_BYTES = 10 * 1024 * 1024;
/** An attachment's path from the root: teams/<team>/attachments/<stamp>-<from>-<4 hex>.<ext>. */
export const ATTACHMENT_PATH_RE = /^teams\/([a-z0-9][a-z0-9-]{0,40})\/attachments\/(\d{8}T\d{6}Z-[a-z0-9][a-z0-9-]*-[0-9a-f]{4}\.(png|jpg|gif|webp))$/;
/** The leading bytes of each attachment type, so a file is what its type says. */
const IMAGE_MAGIC = {
  png: (b) => b.length > 8 && b.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])),
  jpg: (b) => b.length > 3 && b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff,
  gif: (b) => b.length > 6 && /^GIF8[79]a$/.test(b.subarray(0, 6).toString('latin1')),
  webp: (b) => b.length > 12 && b.subarray(0, 4).toString('latin1') === 'RIFF' && b.subarray(8, 12).toString('latin1') === 'WEBP',
};

const LOCK_RETRY_MS = 50;
const LOCK_TIMEOUT_MS = 10_000;
const LOCK_STALE_MS = 30_000;
const EVAL_TIMEOUT_MS = 10 * 60 * 1000;

/** Last generated timestamp per root, so ts values strictly increase within a process. */
const LAST_TS = new Map();

const DEFAULT_TEAMS_README = `# teams/

Software factory state: one folder per team. Use \`node factory/bin/factory.mjs\` to change it (see factory/PROTOCOL.md).
Start a team with \`node factory/bin/factory.mjs team new <team> --title "<Title>" --as you\`.
`;
const DEFAULT_TEAMS_GITIGNORE = '# Factory state stays on this machine: everything here is ignored except this file and README.md.\n*\n!.gitignore\n!README.md\n';

/** The single-agent thread a new factory starts with (`factory init`): bug reports in, causes out. */
export const TRIAGE_REF = 'triage/triage';
const TRIAGE_INSTRUCTIONS = [
  'For each bug report, error or stack trace the owner posts:',
  '',
  '- Find where it comes from in the code: the file and line, and the path that leads there.',
  '- Say how sure you are and why. Label a cause you could not confirm as a guess.',
  '- Propose the smallest fix, and the test that would catch it.',
  '- If it is not a bug in this repo (configuration, a dependency, already fixed on main), say so.',
  '- Open an issue (`issue new`) only when the owner asks. The lead fixes it on a project thread.',
].join('\n');

// ---------------------------------------------------------------------------
// Errors and small helpers
// ---------------------------------------------------------------------------

/**
 * Every refusal the store makes. `code` is one of
 * 'usage' | 'not_found' | 'permission' | 'invalid' | 'conflict'.
 */
export class FactoryError extends Error {
  /**
   * @param {'usage'|'not_found'|'permission'|'invalid'|'conflict'} code
   * @param {string} message what went wrong and what to do next
   */
  constructor(code, message) {
    super(message);
    this.name = 'FactoryError';
    this.code = code;
  }
}

function fail(code, message) {
  throw new FactoryError(code, message);
}

const asArray = (v) => (Array.isArray(v) ? v : v == null ? [] : [v]);
const uniq = (list) => [...new Set(list)];
/** A flag that may come once (a string) or repeated (an array), blanks dropped. */
const toArrayLoose = (v) => asArray(v).map((x) => String(x ?? '').trim()).filter(Boolean);
/**
 * A single-agent thread's `allow`: one Claude Code permission rule per entry
 * ("Bash(npm run test:*)", "Read"), one line each, no duplicates.
 */
function normalizeAllow(v, flag = '--allow') {
  const list = uniq(toArrayLoose(v));
  for (const x of list) {
    const why = allowRuleProblem(x);
    if (why) fail('usage', `${flag} ${JSON.stringify(x)}: ${why}`);
  }
  return list;
}
/** A Claude Code permission rule: a tool name, optionally with its pattern in parentheses. Never a flag. */
const ALLOW_RULE_RE = /^[A-Za-z][A-Za-z0-9_]*(\([^\r\n]+\))?$/;
/** Why an `allow` entry cannot be used (null when it can): it reaches claude's argv, so it must be a rule and nothing else. */
export function allowRuleProblem(x) {
  if (typeof x !== 'string' || !x.trim()) return 'an empty rule';
  if (/[\r\n]/.test(x)) return 'one rule per flag, on one line';
  if (x.length > 300) return `too long (${x.length} chars; at most 300)`;
  if (!ALLOW_RULE_RE.test(x)) return 'not a permission rule; use a tool name with its command pattern, such as "Bash(npm run test:*)"';
  if (/^Bash(\(\s*(\*|:\*)?\s*\))?$/.test(x)) return 'it allows every shell command; name a command prefix, such as "Bash(npm run test:*)"';
  return null;
}

/** Commands that only read (Claude Code lets them through by itself): a refused command never needs a rule for these. */
const READ_ONLY_COMMANDS = new Set(['cat', 'head', 'tail', 'grep', 'egrep', 'fgrep', 'rg', 'wc', 'sort', 'uniq', 'cut', 'ls', 'echo', 'printf', 'jq', 'tr', 'true', 'false', 'date', 'pwd', 'which', 'file', 'stat', 'diff', 'column', 'nl', 'basename', 'dirname', 'realpath', 'test', '[', 'cd']);
/** Programs that run whatever code they are handed: alone, or with inline code (-e, -c), a rule for one allows any code. */
const INTERPRETERS = new Set(['node', 'nodejs', 'deno', 'bun', 'python', 'python2', 'python3', 'ruby', 'perl', 'php', 'lua', 'bash', 'sh', 'zsh', 'fish', 'dash', 'ksh', 'csh', 'tcsh', 'osascript', 'tsx', 'ts-node', 'awk', 'gawk']);
/** Flags that hand an interpreter code on the command line. */
const INLINE_CODE_FLAG_RE = /^-(?:e|c|p|r|E|-eval|-print|-command)$/;
/** Commands that run another command or download code: any rule starting with one allows any code. */
const RUNNERS = new Set(['npx', 'pnpx', 'bunx', 'env', 'xargs', 'eval', 'exec', 'source', '.', 'sudo', 'su', 'doas', 'nohup', 'timeout', 'nice', 'time', 'watch', 'command', 'builtin', 'make', 'docker', 'ssh', 'script', 'expect', 'parallel', 'find']);
/** Commands that reach other machines: they can send data out or change things on a server. */
const NETWORK_COMMANDS = new Set(['curl', 'wget', 'http', 'https', 'nc', 'ncat', 'telnet', 'scp', 'sftp', 'ftp', 'rsync']);
/** Package managers: `run <script>` runs one script of the repo; anything else may install or run any code. */
const PACKAGE_MANAGERS = new Set(['npm', 'yarn', 'pnpm']);
/** Package-manager flags that take a value (`npm --prefix api run x`). */
const PM_VALUE_FLAG_RE = /^(?:--prefix|-C|--cwd|--dir|--workspace|-w|--filter|-F)$/;
/** git subcommands that only read. */
const GIT_READS = new Set(['log', 'show', 'diff', 'status', 'blame', 'grep', 'rev-parse', 'ls-files', 'ls-tree', 'describe', 'shortlog', 'cat-file', 'rev-list', 'merge-base', 'name-rev']);
/** Words that usually change something (delete, deploy, push…) when they appear in a command. */
const CHANGE_WORD_RE = /^(?:rm|rmdir|mv|cp|ln|chmod|chown|mkdir|touch|tee|dd|truncate|kill|pkill|killall|shred|install|uninstall|publish|unpublish|deploy|delete|del|remove|create|update|set|unset|add|apply|patch|put|post|push|commit|reset|revert|merge|rebase|checkout|switch|restore|rollback|import|write|upload|cancel|stop|start|restart|enable|disable|scale|submit|send|tag|exec|ci|link|purge|drop|destroy|wipe|grant|revoke)$/i;

/** The command prefix a Bash rule allows: "Bash(gcloud logging read:*)" and "Bash(gcloud logging read *)" → "gcloud logging read". */
function bashRulePrefix(rule) {
  const m = /^Bash\((.*)\)$/s.exec(String(rule ?? '').trim());
  if (!m) return null;
  return m[1].replace(/(?::\*|\s+\*)$/, '').trim();
}

/**
 * How far a permission rule reaches beyond reading, for the owner deciding whether
 * to allow it: {level, text} or null when nothing stands out. Levels:
 * `any` (it lets the agent run any code), `broad` (one program with every
 * subcommand), `changes` (it can change or delete things, or reach the network).
 * A heuristic, not a proof: a rule with no label is not certified read-only.
 */
export function allowRuleRisk(rule) {
  const prefix = bashRulePrefix(rule);
  if (prefix == null) return null;
  const words = prefix.split(/\s+/).filter(Boolean);
  if (!words.length) return { level: 'any', text: 'it allows every shell command' };
  const first = path.basename(words[0]);
  const rest = words.slice(1);
  const args = rest.filter((w) => !w.startsWith('-'));
  const anyCode = (why) => ({ level: 'any', text: `${why}, so this lets the agent run any code, including code that changes or deletes things` });
  if (RUNNERS.has(first)) return anyCode(`\`${first}\` runs whatever command or code follows it`);
  if (INTERPRETERS.has(first)) {
    if (!args.length || rest.some((w) => INLINE_CODE_FLAG_RE.test(w))) return anyCode(`\`${first}\` runs whatever code it is given`);
    return null; // one named script: it does what that script does
  }
  if (PACKAGE_MANAGERS.has(first)) {
    let i = 0;
    while (i < rest.length && rest[i].startsWith('-')) i += PM_VALUE_FLAG_RE.test(rest[i]) ? 2 : 1;
    const sub = rest[i];
    const script = rest[i + 1];
    if ((sub === 'run' || sub === 'run-script') && script && !script.startsWith('-')) return null;
    if (sub === 'test' || sub === 't') return null;
    if (!sub || sub === 'run' || sub === 'run-script') return anyCode(`\`${first}${sub ? ` ${sub}` : ''}\` with no script named runs any script or installs packages`);
    return anyCode(`\`${first} ${sub}\` can install packages or run any code`);
  }
  if (NETWORK_COMMANDS.has(first)) return { level: 'changes', text: `\`${first}\` reaches other machines: it can send data out and change things on a server` };
  if (first === 'git' && args.length && GIT_READS.has(args[0]) && !rest.some((w) => w === '-c' || w.startsWith('--exec') || w === '--output')) return null;
  if (READ_ONLY_COMMANDS.has(first)) return null;
  if (CHANGE_WORD_RE.test(first)) return { level: 'changes', text: `\`${first}\` changes or deletes things` };
  if (!rest.length) return { level: 'broad', text: `it covers every \`${first}\` command, including ones that change or delete things` };
  const changer = [first, ...args].find((w) => CHANGE_WORD_RE.test(w));
  if (changer) return { level: 'changes', text: `\`${prefix}\` can change or delete things (${changer})` };
  if (first === 'git') return { level: 'changes', text: `\`${prefix}\` is not one of git's read-only commands` };
  return null;
}

/** Split a shell command at unquoted &&, ||, ;, |, & and newlines (quotes and backslashes respected). */
export function shellSegments(command) {
  const s = String(command ?? '');
  const out = [];
  let cur = '';
  let quote = null;
  for (let i = 0; i < s.length; i++) {
    const c = s[i];
    if (quote) {
      cur += c;
      if (c === '\\' && quote === '"' && i + 1 < s.length) cur += s[++i];
      else if (c === quote) quote = null;
      continue;
    }
    if (c === '\\' && i + 1 < s.length) {
      cur += c + s[++i];
      continue;
    }
    if (c === "'" || c === '"') {
      quote = c;
      cur += c;
      continue;
    }
    if (c === '\n' || c === ';' || c === '|' || c === '&') {
      if (cur.trim()) out.push(cur.trim());
      cur = '';
      if ((c === '|' || c === '&') && s[i + 1] === c) i++;
      continue;
    }
    cur += c;
  }
  if (cur.trim()) out.push(cur.trim());
  return out;
}

/** Words of one command segment up to the first that is quoted or a value: what a prefix rule can name. */
function prefixWords(segment) {
  const words = String(segment).trim().split(/\s+/).filter(Boolean);
  let i = 0;
  while (i < words.length && /^[A-Za-z_][A-Za-z0-9_]*=/.test(words[i])) i++; // FOO=1 cmd: the rule names cmd
  const out = [];
  for (; i < words.length && out.length < 5; i++) {
    const w = words[i];
    if (w === '--' || /^[\'"`$(<>{\\]/.test(w) || /[`$*?<>|;&]/.test(w) || (out.length && w.includes('='))) break;
    out.push(w);
  }
  while (out.length > 1 && out[out.length - 1].startsWith('-')) out.pop();
  return out;
}

/**
 * Rules that would let one refused shell command through, one per part of it
 * that is not a read-only command: Bash(<its leading words>:*). The owner can
 * edit a suggestion before allowing it.
 */
export function suggestAllowRules(command) {
  const out = [];
  for (const seg of shellSegments(command)) {
    const words = prefixWords(seg);
    if (!words.length) continue;
    if (READ_ONLY_COMMANDS.has(path.basename(words[0]))) continue;
    if (words[0] === 'git' && GIT_READS.has(words[1])) continue; // read-only git: Claude Code lets it through
    const rule = `Bash(${words.join(' ')}:*)`;
    if (!allowRuleProblem(rule) && !out.includes(rule)) out.push(rule);
  }
  return out;
}

/** Inline code for Markdown that holds any text (backticks included) on one line. */
function codeSpan(s) {
  const t = String(s ?? '').replace(/\s*\n\s*/g, ' ↵ ');
  const runs = t.match(/`+/g) || [];
  const fence = '`'.repeat(Math.max(0, ...runs.map((r) => r.length)) + 1);
  return fence.length > 1 ? `${fence} ${t} ${fence}` : `\`${t}\``;
}

/** A member that can answer a single-agent thread: an agent with role solo that the autopilot starts with Claude Code. */
const isSoloAgent = (m) => Boolean(m && m.kind === 'agent' && m.role === 'solo' && m.launch === 'claude');
const oneLine = (s) => String(s ?? '').replace(/\s+/g, ' ').trim();
/** "checkout-v2" → "Checkout v2": the default title of a team created by `thread new`. */
const titleFromId = (id) => { const t = String(id).replace(/-+/g, ' ').trim(); return t.charAt(0).toUpperCase() + t.slice(1); };
/** The first n code points of s (never splits a surrogate pair). */
const truncate = (s, n) => {
  const cps = [...String(s ?? '')];
  return cps.length > n ? cps.slice(0, n).join('') : String(s ?? '');
};
const randomHex = () => crypto.randomBytes(2).toString('hex');
const isIso = (v) => typeof v === 'string' && ISO_RE.test(v) && Number.isFinite(Date.parse(v));
const isObject = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);
const fmtId = (prefix, n) => `${prefix}-${String(n).padStart(3, '0')}`;
const idNumber = (id) => Number(String(id).slice(2));
const plural = (n, word) => `${n} ${word}${n === 1 ? '' : 's'}`;
const byTsThenId = (a, b) => (a.ts < b.ts ? -1 : a.ts > b.ts ? 1 : a.id < b.id ? -1 : a.id > b.id ? 1 : 0);

/** '2026-11-01T15:30:12.345Z' → '20261101T153012Z' (message-id and report-file stamp). */
export function stampOf(ts) {
  return `${String(ts).slice(0, 19).replace(/[-:]/g, '')}Z`;
}

/**
 * Normalise a list argument: an array, a comma list ('a,b'), a single value, or nothing.
 * @returns {string[]}
 */
export function toList(v) {
  if (v == null || v === '') return [];
  if (Array.isArray(v)) return v.flatMap((x) => toList(x));
  return String(v).split(',').map((s) => s.trim()).filter(Boolean);
}

/**
 * Cadence → milliseconds: hourly | daily | weekly | <n>h | <n>d. Null when invalid.
 * @param {string} cadence
 * @returns {number|null}
 */
export function cadenceMs(cadence) {
  if (typeof cadence !== 'string' || !CADENCE_RE.test(cadence)) return null;
  const H = 3600 * 1000;
  if (cadence === 'hourly') return H;
  if (cadence === 'daily') return 24 * H;
  if (cadence === 'weekly') return 7 * 24 * H;
  const n = Number(cadence.slice(0, -1));
  return cadence.endsWith('h') ? n * H : n * 24 * H;
}

function stripMarkdown(line) {
  let s = line;
  s = s.replace(/^(?:>\s?)+/, '');
  s = s.replace(/^#{1,6}\s+/, '');
  s = s.replace(/^(?:[-*+]|\d+[.)])\s+/, '');
  s = s.replace(/^\[[ xX]\]\s+/, '');
  s = s.replace(/!?\[([^\]]*)\]\([^)]*\)/g, '$1');
  s = s.replace(/(\*\*|__)(.+?)\1/g, '$2');
  s = s.replace(/(^|[^\w*])\*(?!\s)(.+?)(?<!\s)\*(?!\w)/g, '$1$2');
  s = s.replace(/(^|[^\w])_(?!\s)(.+?)(?<!\s)_(?!\w)/g, '$1$2');
  s = s.replace(/~~(.+?)~~/g, '$1');
  s = s.replace(/`+/g, '');
  return s.replace(/\s+/g, ' ').trim();
}

function fallbackSummary(msg) {
  switch (msg.type) {
    case 'review': return `${msg.verdict} at ${msg.gate} (${plural(asArray(msg.points).length, 'point')})`;
    case 'review_response': return `response: ${plural(asArray(msg.stances).length, 'stance')}`;
    case 'result': return `${msg.task} ${msg.outcome}`;
    case 'dispatch': return `dispatch ${msg.task}`;
    case 'decision': return `decision ${msg.decision}`;
    case 'report': return `report ${msg.status}: ${msg.report}`;
    case 'alert': return `alert ${msg.metric} = ${msg.value}`;
    case 'event': return msg.event?.kind ? `event ${msg.event.kind}` : 'event';
    default: return '';
  }
}

/**
 * One-line summary of a message: its first non-empty body line, Markdown markers
 * stripped, at most 140 chars (a type-based fallback when the body is empty).
 * @param {object|string} msg a message entity, or a body string
 * @returns {string}
 */
export function summary(msg) {
  const body = typeof msg === 'string' ? msg : String(msg?.body ?? '');
  for (const raw of body.split('\n')) {
    const t = raw.trim();
    if (!t || /^(```|~~~)/.test(t)) continue;
    const s = stripMarkdown(t);
    if (!s) continue;
    return [...s].length > 140 ? `${truncate(s, 139)}…` : s;
  }
  return msg && typeof msg === 'object' ? fallbackSummary(msg) : '';
}

/** Problems with one estimate {minutes, by, at[, ended]} (`ended` only on a task). */
function etaErrors(e, isMember, task) {
  if (!isObject(e)) return ['must be {minutes, by, at}'];
  const out = [];
  if (!Number.isInteger(e.minutes) || e.minutes < 1 || e.minutes > ETA_MAX_MINUTES) out.push(`minutes must be a whole number from 1 to ${ETA_MAX_MINUTES}`);
  if (!isMember(e.by)) out.push(`by "${e.by}" is not on the roster`);
  if (!isIso(e.at)) out.push('at must be an ISO-8601 UTC timestamp');
  if (e.ended != null && (!task || !isIso(e.ended))) out.push(task ? 'ended must be an ISO-8601 UTC timestamp' : 'has no ended (only a task estimate does)');
  return out;
}

function ordered(obj, keys) {
  const out = {};
  for (const k of keys) out[k] = obj[k] === undefined ? null : obj[k];
  for (const k of Object.keys(obj)) {
    if (!(k in out) && !ENTITY_ONLY_KEYS.has(k) && obj[k] !== undefined) out[k] = obj[k];
  }
  return out;
}

function entityOf(data, body, team, rel) {
  return { ...data, body, team, path: rel };
}

/** The command line of a live process (`ps`), or null. */
export function processCommand(pid) {
  if (!pidAlive(pid)) return null;
  try {
    const out = execFileSync('ps', ['-o', 'command=', '-p', String(pid)], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'], timeout: 2000 }).trim();
    return out || null;
  } catch {
    return null;
  }
}

/** `ps` elapsed time ([[dd-]hh:]mm:ss) in seconds. */
export function etimeSeconds(etime) {
  const m = /^(?:(\d+)-)?(?:(\d+):)?(\d+):(\d+)$/.exec(String(etime).trim());
  return m ? ((Number(m[1] || 0) * 24 + Number(m[2] || 0)) * 60 + Number(m[3])) * 60 + Number(m[4]) : null;
}

/** The CLI's flags that take no value (factory/bin/factory.mjs parses argv with them). */
export const CLI_BOOL_FLAGS = Object.freeze(new Set(['json', 'help', 'internal', 'no-internal', 'pass', 'fail', 'exec', 'detach', 'open', 'stop', 'brief', 'once', 'dry-run', 'clear-allow', 'runs', 'at-login', 'no-at-login']));
/** Invocations that end within seconds (a detaching parent, a stop, one pass, a login item change): never left running. */
const ONE_SHOT_FLAGS = ['detach', 'stop', 'dry-run', 'once', 'at-login', 'no-at-login'];

/** The working directory of a live process of this user, or null (Linux /proc, else lsof). */
export function processCwd(pid) {
  try {
    return fs.readlinkSync(`/proc/${pid}/cwd`);
  } catch {
    // not Linux
  }
  try {
    const out = execFileSync('lsof', ['-a', '-p', String(pid), '-d', 'cwd', '-Fn'], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'], timeout: 3000 });
    const line = out.split('\n').find((l) => l.startsWith('n/'));
    return line ? line.slice(1) : null;
  } catch {
    return null;
  }
}

/** One environment variable of a live process of this user, or null (Linux /proc, else `ps -E`). */
export function processEnv(pid, name) {
  try {
    const kv = fs.readFileSync(`/proc/${pid}/environ`, 'utf8').split('\0').find((x) => x.startsWith(`${name}=`));
    return kv ? kv.slice(name.length + 1) : null;
  } catch {
    // not Linux
  }
  try {
    const out = execFileSync('ps', ['-E', '-o', 'command=', '-p', String(pid)], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'], timeout: 3000 });
    // ps prints the environment after the arguments, space-separated: the value runs to the next NAME=.
    const m = new RegExp(`\\s${name}=(.*?)(?=\\s[A-Za-z_][A-Za-z0-9_]*=|\\s*$)`).exec(out);
    return m ? m[1] : null;
  } catch {
    return null;
  }
}

const isDir = (p) => {
  try {
    return fs.statSync(p).isDirectory();
  } catch {
    return false;
  }
};

/**
 * Reads one `ps` command line as a factory process: {kind: 'autopilot'|'board',
 * root, root_from: 'flag'|'cli'|null, one_shot} when it is node running
 * factory.mjs with the ui or autopilot command, else null (a shell or anything
 * else that only mentions it). ps drops argv quoting, so a --root with spaces is
 * read as the longest run of words that names a folder. Without --root the CLI
 * serves $FACTORY_ROOT, else the repo that holds it. cwd() gives the process's
 * working directory (for relative paths) and env(name) its environment.
 */
export function parseFactoryCommand(cmd, cwd = () => null, env = () => null) {
  const m = /^(?:\S*\/)?node[\w.-]*\s+(?:-\S+\s+)*((?:[^\s-][^]*?\/)?factory\.mjs)(?=\s|$)(.*)$/.exec(String(cmd).trim());
  if (!m) return null;
  const [, script] = m;
  let rest = m[2];
  let base = null;
  const from = (p) => (path.isAbsolute(p) ? p : (base ??= cwd()) ? path.resolve(base, p) : null);
  let root = null;
  let rootFrom = null;
  const r = /(^|\s)--root(?:=|\s+)(\S.*)$/.exec(rest);
  if (r) {
    const words = r[2].split(/\s+/);
    let k = 1;
    for (let n = words.length; n > 1; n--) {
      const abs = from(words.slice(0, n).join(' '));
      if (abs && isDir(abs)) {
        k = n;
        break;
      }
    }
    root = from(words.slice(0, k).join(' '));
    rootFrom = root ? 'flag' : null;
    rest = `${rest.slice(0, r.index)} ${words.slice(k).join(' ')}`;
  }
  const flags = new Set();
  let command = null;
  const toks = rest.split(/\s+/).filter(Boolean);
  for (let i = 0; i < toks.length && command == null; i++) {
    const t = toks[i];
    if (t === '--') {
      command = toks[i + 1] ?? '';
    } else if (t.startsWith('--')) {
      const eq = t.indexOf('=');
      const name = t.slice(2, eq > 0 ? eq : undefined);
      flags.add(name);
      if (eq < 0 && !CLI_BOOL_FLAGS.has(name)) i++;
    } else if (t !== '-h') command = t;
  }
  const kind = command === 'autopilot' ? 'autopilot' : command === 'ui' ? 'board' : null;
  if (!kind) return null;
  // Flags after the command count too (`autopilot --detach`).
  for (const t of toks) if (t.startsWith('--')) flags.add(t.slice(2).split('=')[0]);
  if (!root) {
    const fromEnv = env('FACTORY_ROOT');
    if (fromEnv) {
      root = from(fromEnv);
      rootFrom = root ? 'env' : null;
    }
  }
  if (!root) {
    const cli = from(script);
    if (cli) {
      root = path.resolve(path.dirname(cli), '..', '..');
      rootFrom = 'cli';
    }
  }
  return { kind, root, root_from: rootFrom, one_shot: ONE_SHOT_FLAGS.some((f) => flags.has(f)) };
}

/**
 * The long-running factory processes this user runs on this machine, for any
 * root: every `factory autopilot` and board (`factory ui`), with the root it
 * serves. One-shot commands (--detach, --stop, --dry-run, --once) and anything
 * under 5 seconds old (a `ui --thread` printing a link) are left out.
 * null when ps could not be read.
 * @returns {{pid: number, kind: 'autopilot'|'board', root: string|null, root_from: string|null, elapsed_seconds: number|null}[]|null}
 */
export function factoryProcesses() {
  let out;
  try {
    out = execFileSync('ps', ['-axo', 'pid=,uid=,etime=,command='], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'], timeout: 5000, maxBuffer: 16 * 1024 * 1024 });
  } catch {
    return null;
  }
  const uid = typeof process.getuid === 'function' ? process.getuid() : null;
  const rows = [];
  for (const line of out.split('\n')) {
    const m = /^\s*(\d+)\s+(\d+)\s+(\S+)\s+(.*)$/.exec(line);
    if (!m || !m[4].includes('factory.mjs')) continue;
    if (uid != null && Number(m[2]) !== uid) continue;
    const pid = Number(m[1]);
    const elapsed = etimeSeconds(m[3]);
    if (elapsed != null && elapsed < 5) continue;
    const p = parseFactoryCommand(m[4], () => processCwd(pid), (name) => processEnv(pid, name));
    if (!p || p.one_shot) continue;
    rows.push({ pid, kind: p.kind, root: p.root, root_from: p.root_from, elapsed_seconds: elapsed });
  }
  return rows;
}

/**
 * Whether a recorded autopilot run ({pid, bin, mark}) is still that run: the
 * pid runs the agent's binary with the run's mark, not a stranger that reused it.
 */
export function isRunPid(run) {
  if (!run || !Number.isInteger(run.pid)) return false;
  const cmd = processCommand(run.pid);
  if (!cmd || !run.bin || !cmd.includes(path.basename(run.bin))) return false;
  return typeof run.mark === 'string' && run.mark ? cmd.includes(run.mark) : true;
}

/** Whether a pid is a live `factory autopilot` process, not a stranger that reused the pid. */
export function isAutopilotPid(pid) {
  const cmd = processCommand(pid);
  return Boolean(cmd && /factory\.mjs\b/.test(cmd) && /\sautopilot(\s|$)/.test(cmd));
}

/** Whether a process with this pid still runs on this machine (EPERM: it runs as someone else). */
export function pidAlive(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return err.code === 'EPERM';
  }
}

export function writeAtomic(abs, text) {
  fs.mkdirSync(path.dirname(abs), { recursive: true });
  const tmp = path.join(path.dirname(abs), `.tmp-${crypto.randomBytes(4).toString('hex')}-${path.basename(abs)}`);
  fs.writeFileSync(tmp, text);
  fs.renameSync(tmp, abs);
}

/**
 * Create abs exclusively and never torn: the text goes to a temp file first,
 * then a hard link publishes it (EEXIST when abs exists, like flag wx). A crash
 * leaves at most a `.tmp-*` file, never a half-written state file.
 * Falls back to an exclusive write where hard links are not supported.
 */
function createExclusive(abs, text) {
  const tmp = path.join(path.dirname(abs), `.tmp-${crypto.randomBytes(4).toString('hex')}-${path.basename(abs)}`);
  fs.writeFileSync(tmp, text, { flag: 'wx' });
  try {
    fs.linkSync(tmp, abs);
  } catch (e) {
    if (e.code !== 'EPERM' && e.code !== 'ENOTSUP' && e.code !== 'EXDEV') throw e;
    fs.writeFileSync(abs, text, { flag: 'wx' });
  } finally {
    fs.rmSync(tmp, { force: true });
  }
}

/** True when the process with this pid is gone (a lock it left behind is stale). */
function processGone(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return false;
  } catch (e) {
    return e.code === 'ESRCH';
  }
}

function appendLine(abs, line) {
  let prefix = '';
  try {
    const size = fs.statSync(abs).size;
    if (size > 0) {
      const fd = fs.openSync(abs, 'r');
      const buf = Buffer.alloc(1);
      fs.readSync(fd, buf, 0, 1, size - 1);
      fs.closeSync(fd);
      if (buf.toString() !== '\n') prefix = '\n';
    }
  } catch {
    // missing file: appendFileSync creates it
  }
  fs.appendFileSync(abs, `${prefix}${line}`);
}

function sleepSync(ms) {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

function appendHistory(body, line) {
  const b = String(body ?? '').replace(/\s+$/, '');
  if (/^## History\s*$/m.test(b)) return `${b}\n${line}\n`;
  return `${b}${b ? '\n\n' : ''}## History\n\n${line}\n`;
}

function ensureAcceptance(body, fallback) {
  const b = String(body ?? '').trim() || fallback;
  if (/^## Acceptance\s*$/m.test(b)) return `${b}\n`;
  return `${b}\n\n## Acceptance\n\n- [ ] _Say what done means: the behaviour, the test that proves it._\n`;
}

function shellQuote(s) {
  return /^[A-Za-z0-9_./:@%+=,-]+$/.test(s) ? s : `'${String(s).replace(/'/g, `'\\''`)}'`;
}

function normalizeSectionName(section) {
  const name = sectionKey(section, false);
  if (!name) fail('usage', 'name the section to edit with --section <name> (for example Brief, Design, Plan, Notes)');
  return name;
}

/**
 * A section name as both `thread show --section` and `thread edit` compare it:
 * leading #s, surrounding space and a closing `##` run stripped, spaces collapsed.
 * @param {string} name
 * @param {boolean} [lower] lower-case it (for comparisons)
 */
function sectionKey(name, lower = true) {
  const s = oneLine(name).replace(/^#+\s*/, '').replace(/\s+#+$/, '').trim();
  return lower ? s.toLowerCase() : s;
}

/** The level-2 headings (`## x`, outside code fences) of a text: [{line, name}]. */
function level2Headings(text) {
  const out = [];
  let fence = false;
  String(text ?? '').split('\n').forEach((line, i) => {
    if (/^\s*(```|~~~)/.test(line)) fence = !fence;
    if (fence) return;
    const m = /^## (?!#)(.*)$/.exec(line);
    if (m) out.push({ line: i, name: m[1] });
  });
  return out;
}

/**
 * The new content of section `name`, ready to insert: a leading `## <name>`
 * heading (the natural way to write a section file) is dropped; any other
 * level-2 heading is refused, because it would end the section early and
 * leave text no later edit can replace.
 */
function sectionContent(name, content) {
  let text = String(content ?? '').replace(/^﻿/, '');
  const heads = level2Headings(text);
  if (heads.length && heads[0].line === text.split('\n').findIndex((l) => l.trim() !== '') && sectionKey(heads[0].name) === sectionKey(name)) {
    const lines = text.split('\n');
    lines.splice(heads[0].line, 1);
    text = lines.join('\n');
    heads.shift();
  }
  if (heads.length) {
    fail('usage', `the new content of ## ${name} contains the level-2 heading "## ${heads[0].name.trim()}", which would end the section early; use "### ${heads[0].name.trim()}" inside it, or edit that section with its own --section`);
  }
  return text.replace(/^\s*\n/, '').replace(/\s+$/, '');
}

/** Replace the content of `## <name>` (up to the next level-2 heading), or append the section. */
function replaceSection(doc, name, content) {
  const lines = String(doc ?? '').split('\n');
  const want = sectionKey(name);
  const heads = level2Headings(doc);
  const at = heads.findIndex((h) => sectionKey(h.name) === want);
  const text = sectionContent(name, content);
  if (at < 0) {
    const head = String(doc ?? '').replace(/\s+$/, '');
    return `${head}${head ? '\n\n' : ''}## ${name}\n${text ? `\n${text}\n` : ''}`;
  }
  const start = heads[at].line;
  const end = at + 1 < heads.length ? heads[at + 1].line : lines.length;
  const block = text ? ['', ...text.split('\n'), ''] : [''];
  const out = [...lines.slice(0, start + 1), ...block, ...lines.slice(end)].join('\n');
  return out.endsWith('\n') ? out : `${out}\n`;
}

/** The content of `## <name>`, or null when the body has no such section. */
export function sectionText(doc, name) {
  const lines = String(doc ?? '').split('\n');
  const heads = level2Headings(doc);
  const at = heads.findIndex((h) => sectionKey(h.name) === sectionKey(name));
  if (at < 0) return null;
  const end = at + 1 < heads.length ? heads[at + 1].line : lines.length;
  return lines.slice(heads[at].line + 1, end).join('\n').trim();
}

function normalizePoints(points) {
  const list = asArray(points);
  const anyN = list.some((p) => p && p.n != null);
  const allN = list.every((p) => p && p.n != null);
  if (anyN && !allN) fail('usage', 'give every point an n, or none (they are numbered 1..k in order)');
  const out = list.map((p, i) => {
    if (!isObject(p)) fail('usage', `point ${i + 1} must be {severity, text}`);
    const severity = String(p.severity ?? '').trim().toLowerCase();
    if (!SEVERITIES.includes(severity)) fail('usage', `point ${i + 1} has severity "${p.severity}"; use one of ${SEVERITIES.join(', ')}`);
    const text = String(p.text ?? '').trim();
    if (!text) fail('usage', `point ${i + 1} has no text`);
    const n = allN && list.length ? Number(p.n) : i + 1;
    return { n, severity, text };
  });
  if (allN && list.length) {
    const ns = out.map((p) => p.n).sort((a, b) => a - b);
    if (!ns.every((n, i) => n === i + 1)) fail('usage', `point numbers must be 1..${out.length}, each once; got ${out.map((p) => p.n).join(', ')}`);
    out.sort((a, b) => a.n - b.n);
  }
  return out;
}

function normalizeStances(stances, review) {
  const points = asArray(review.points);
  const ns = points.map((p) => Number(p.n));
  if (!Array.isArray(stances)) fail('usage', `give one stance per point of review ${review.id} (points ${ns.join(', ') || 'none'})`);
  const seen = new Set();
  const out = [];
  for (const s of stances) {
    if (!isObject(s)) fail('usage', 'each stance must be {point, stance, reason?, action?}');
    const n = Number(s.point);
    if (!ns.includes(n)) fail('usage', `point ${s.point} is not in review ${review.id}; its points are ${ns.join(', ') || 'none'}`);
    if (seen.has(n)) fail('usage', `point ${n} has more than one stance; give exactly one per point`);
    seen.add(n);
    const stance = String(s.stance ?? '').trim();
    if (!STANCES.includes(stance)) fail('usage', `point ${n} has stance "${s.stance}"; use accepted, rejected or deferred`);
    const reason = s.reason == null ? '' : String(s.reason).trim();
    const action = s.action == null ? '' : oneLine(s.action);
    if (stance === 'rejected' && !reason) fail('usage', `point ${n} is rejected without a reason; say why (--stance "${n}=rejected: <reason>")`);
    if (action && stance !== 'accepted') fail('usage', `point ${n}: an action (task title) only applies to an accepted point`);
    const entry = { point: n, stance };
    if (reason) entry.reason = reason;
    if (action) entry.action = action;
    out.push(entry);
  }
  const missing = ns.filter((n) => !seen.has(n));
  if (missing.length) fail('usage', `the response must cover every point of review ${review.id}; missing: ${missing.join(', ')}`);
  return out.sort((a, b) => a.point - b.point);
}

function normalizeThresholds(input) {
  if (input == null) return null;
  if (!isObject(input)) fail('usage', 'thresholds must be a mapping like {error_rate: {max: 0.02}}');
  const out = {};
  for (const [metric, t] of Object.entries(input)) {
    if (!isObject(t)) fail('usage', `threshold for ${metric} must be {min?: number, max?: number}`);
    const th = {};
    for (const [k, v] of Object.entries(t)) {
      if (k !== 'min' && k !== 'max') fail('usage', `threshold for ${metric} has unknown key "${k}"; use min and/or max`);
      if (typeof v !== 'number' || !Number.isFinite(v)) fail('usage', `threshold ${metric}.${k} must be a number`);
    }
    if (t.min != null) th.min = t.min;
    if (t.max != null) th.max = t.max;
    if (th.min == null && th.max == null) fail('usage', `threshold for ${metric} needs min or max`);
    if (th.min != null && th.max != null && th.min > th.max) fail('usage', `threshold for ${metric} has min ${th.min} above max ${th.max}; every run would breach`);
    out[metric] = th;
  }
  return out;
}

/**
 * Validate measured metrics: a JSON object (or JSON text) of finite numbers,
 * optionally wrapped as {metrics: {...}}.
 * @returns {Record<string, number>}
 */
export function normalizeMetrics(input, code = 'usage') {
  let m = input;
  if (typeof m === 'string') {
    try {
      m = JSON.parse(m.replace(/^\uFEFF/, ''));
    } catch (e) {
      fail(code, `metrics are not valid JSON (${e.message}); pass an object like '{"error_rate": 0.01}'`);
    }
  }
  if (isObject(m) && isObject(m.metrics)) m = m.metrics;
  if (!isObject(m)) fail(code, 'metrics must be a JSON object like {"error_rate": 0.01}');
  const out = {};
  for (const [k, v] of Object.entries(m)) {
    if (typeof v !== 'number' || !Number.isFinite(v)) fail(code, `metric "${k}" is ${JSON.stringify(v)}; every metric value must be a finite number`);
    out[k] = v;
  }
  if (!Object.keys(out).length) fail(code, 'no metrics were measured; give at least one {"metric": number}');
  return out;
}

function formatThreshold(t) {
  if (!t) return '—';
  const parts = [];
  if (t.min != null) parts.push(`min ${t.min}`);
  if (t.max != null) parts.push(`max ${t.max}`);
  return parts.join(' · ');
}

function relativeExcess(delta, base) {
  return base === 0 ? Infinity : delta / Math.abs(base);
}

function evaluateThresholds(measured, thresholds) {
  const out = [];
  for (const [metric, t] of Object.entries(thresholds || {})) {
    const value = measured[metric];
    if (value === undefined) {
      out.push({ metric, value: null, threshold: t, status: 'missing', excess: 0 });
      continue;
    }
    let excess = 0;
    let breach = false;
    if (t.max != null && value > t.max) {
      breach = true;
      excess = relativeExcess(value - t.max, t.max);
    }
    if (t.min != null && value < t.min) {
      breach = true;
      excess = Math.max(excess, relativeExcess(t.min - value, t.min));
    }
    out.push({ metric, value, threshold: t, status: breach ? 'breach' : 'ok', excess });
  }
  for (const [metric, value] of Object.entries(measured)) {
    if (!(metric in (thresholds || {}))) out.push({ metric, value, threshold: null, status: 'none', excess: 0 });
  }
  return out;
}

function breachText(e) {
  const t = e.threshold || {};
  if (t.max != null && e.value > t.max) return `${e.metric} ${e.value} above max ${t.max}`;
  if (t.min != null && e.value < t.min) return `${e.metric} ${e.value} below min ${t.min}`;
  return `${e.metric} ${e.value}`;
}

const md = {
  who: (id) => `**${id}**`,
  /** `<member> <verb>` with agreement: "fable writes", "you write". */
  does: (id, verb) => `**${id}** ${id === 'you' ? verb : `${verb}s`}`,
  title: (t) => `*${String(t).replace(/\*/g, '')}*`,
  code: (s) => `\`${s}\``,
};

/**
 * Members that led a thread before a \`thread set\` moved its lead (a single-agent
 * thread converted to be led by its agent), per thread id. What they settled while
 * they led stays settled; new resolves need the current lead (\`_checkResolves\`).
 */
function formerLeads(msgs) {
  const out = new Map();
  for (const m of msgs) {
    const from = m.type === 'event' && m.event?.kind === 'thread_config' ? m.event.lead?.from : null;
    if (from) (out.get(m.thread) || out.set(m.thread, new Set()).get(m.thread)).add(from);
  }
  return out;
}

/** A message that came from another team's thread (tell, or a reply relayed back): its `link` points there. */
const fromOtherTeam = (m) => isObject(m?.link) && m.link.dir === 'from';
/** Message types whose replies to a linked message are relayed to the other team (§9, "Between teams"). */
const RELAY_TYPES = new Set(['question', 'answer', 'note']);

/** What `you` close by writing anything later in the same thread (§10, "Messages to you"). */
const OWNER_READS = new Set(['answer', 'question', 'escalation', 'note']);

/** Turn pairs (message, recipient) still open in a sorted message list. */
function openTurnPairs(msgs, threadMeta) {
  const repliedBy = new Map();
  const resolvedBy = new Map();
  // Dismissals close a turn for one member only (the one named in `dismissed_for`, else the dismisser).
  const dismissedFor = new Map();
  const former = formerLeads(msgs);
  // When the owner last wrote in each thread: an answer, question or escalation to `you` is handled by then (§10);
  // an asker whose question that message left open asks again.
  const ownerWrote = new Map();
  // When each member last wrote in each thread itself (a message relayed from another team does not count):
  // a note or answer from another team is read by then (§9, "Between teams").
  const wrote = new Map();
  const push = (map, k, v) => (map.has(k) ? map.get(k).push(v) : map.set(k, [v]));
  for (const r of msgs) {
    if (r.reply_to) push(repliedBy, r.reply_to, r.from);
    // A dismissal closes only the turns it names, for that one member: it is not a write in the thread.
    if (r.dismissal === true) {
      const who = typeof r.dismissed_for === 'string' && r.dismissed_for ? r.dismissed_for : r.from;
      for (const id of asArray(r.resolves)) push(dismissedFor, id, who);
      continue;
    }
    for (const id of asArray(r.resolves)) push(resolvedBy, id, r.from);
    if (r.from === 'you' && String(r.ts) > String(ownerWrote.get(r.thread) || '')) ownerWrote.set(r.thread, String(r.ts));
    const k = `${r.thread}\u0000${r.from}`;
    if (!fromOtherTeam(r) && String(r.ts) > String(wrote.get(k) || '')) wrote.set(k, String(r.ts));
  }
  const out = [];
  for (const m of msgs) {
    const to = uniq(asArray(m.to));
    if (!to.length) continue;
    const meta = threadMeta.get(m.thread) || {};
    const repliers = repliedBy.get(m.id) || [];
    const resolvers = resolvedBy.get(m.id) || [];
    const dismissed = dismissedFor.get(m.id) || [];
    for (const x of to) {
      if (repliers.includes(x)) continue;
      if (dismissed.includes(x)) continue;
      if (x === 'you' && OWNER_READS.has(m.type) && String(m.ts) < (ownerWrote.get(m.thread) || '')) continue;
      if (fromOtherTeam(m) && m.type !== 'question' && String(m.ts) < (wrote.get(`${m.thread}\u0000${x}`) || '')) continue;
      const allowed = new Set([x, m.from, meta.lead, meta.owner, 'you', 'factory', ...(former.get(m.thread) || [])]);
      if (resolvers.some((f) => allowed.has(f))) continue;
      out.push({ member: x, msg: m });
    }
  }
  return out;
}

/**
 * The current phase's pending gate when the owner dismissed its agent there (§10,
 * "Dismiss"): the board stops asking the owner to start that agent until the gate
 * moves or the thread re-enters the phase. `msgs` are the thread's messages.
 */
function dismissedGate(th, msgs) {
  const g = th.kind === 'project' && GATE_ENTRY_PHASES.has(th.phase) ? th.gates?.[th.phase] : null;
  if (!g || g.status !== 'pending' || !g.by) return null;
  const entered = msgs.filter((m) => m.type === 'event' && m.event?.kind === 'phase' && m.event?.to === th.phase).at(-1)?.ts;
  const since = [g.at, entered].map((x) => String(x || '')).sort().at(-1);
  return msgs.some((m) => m.dismissal === true && m.dismissed_gate === th.phase && m.dismissed_for === g.by && String(m.ts) >= since) ? th.phase : null;
}

function turnView(team, pair, nowMs) {
  const m = pair.msg;
  return {
    team,
    thread: m.thread,
    member: pair.member,
    message: { id: m.id, ts: m.ts, from: m.from, type: m.type, summary: summary(m), ...(m.type === 'event' ? { kind: m.event?.kind ?? null, ...(m.event?.kind === 'phase' ? { phase: m.event?.to ?? null } : {}) } : {}) },
    age_seconds: Math.max(0, Math.floor((nowMs - Date.parse(m.ts)) / 1000)),
  };
}

function countBy(list, key, values) {
  const out = Object.fromEntries(values.map((v) => [v, 0]));
  for (const x of list) if (x[key] in out) out[x[key]] += 1;
  out.total = list.length;
  return out;
}

function messageHead(m) {
  return m ? { id: m.id, ts: m.ts, from: m.from, type: m.type, summary: summary(m) } : null;
}

function parseDecisions(text) {
  const lines = String(text ?? '').split('\n');
  const out = [];
  let cur = null;
  const flush = () => {
    if (!cur) return;
    const rest = cur.lines;
    let i = 0;
    while (i < rest.length && rest[i].trim() === '') i += 1;
    while (i < rest.length) {
      const m = /^- (ts|by|thread|message|resolves|gate): ?(.*)$/.exec(rest[i]);
      if (!m) break;
      const [, key, value] = m;
      if (key === 'resolves') cur.entry.resolves = value.replace(/^\[|\]$/g, '').split(',').map((s) => s.trim()).filter(Boolean);
      else if (key === 'gate') {
        const [gate, verdict] = value.trim().split(/\s+/);
        cur.entry.gate = gate || null;
        cur.entry.verdict = verdict || null;
      } else cur.entry[key] = value.trim() || null;
      i += 1;
    }
    cur.entry.body = rest.slice(i).join('\n').trim();
    out.push(cur.entry);
  };
  for (const line of lines) {
    const h = DECISION_HEADING_RE.exec(line);
    if (h) {
      flush();
      cur = {
        entry: { id: `D-${h[1]}`, title: h[2].trim(), ts: null, by: null, thread: null, message: null, resolves: [], gate: null, verdict: null, body: '' },
        lines: [],
      };
    } else if (cur) {
      cur.lines.push(line);
    }
  }
  flush();
  return out;
}

// ---------------------------------------------------------------------------
// Store
// ---------------------------------------------------------------------------

/**
 * Open a store on a factory root.
 * Root: `root`, else $FACTORY_ROOT, else the repo that contains this file.
 * @param {{root?: string, now?: () => (Date|string|number)}} [options]
 *   now: the clock; returns a Date, an ISO string or epoch milliseconds.
 * @returns {Store}
 */
export function openStore({ root, now } = {}) {
  const explicit = root || process.env.FACTORY_ROOT;
  const dir = path.resolve(explicit || CODE_ROOT);
  const store = new Store(dir, typeof now === 'function' ? now : () => Date.now());
  if (!explicit) store._linkedWorktree = linkedWorktreeOf(CODE_ROOT);
  return store;
}

/**
 * When dir is a linked git worktree (its `.git` is a file pointing into another
 * repo's .git/worktrees/), the shared checkout that owns it; else null.
 * Reads files only; never runs git.
 */
function linkedWorktreeOf(dir) {
  let text;
  try {
    if (!fs.statSync(path.join(dir, '.git')).isFile()) return null;
    text = fs.readFileSync(path.join(dir, '.git'), 'utf8');
  } catch {
    return null;
  }
  const m = /^gitdir:\s*(.+?)\s*$/m.exec(text);
  if (!m) return null;
  const gitdir = path.resolve(dir, m[1]);
  // A linked worktree's gitdir holds a `commondir` file (a submodule's does not).
  let common = null;
  try {
    common = path.resolve(gitdir, fs.readFileSync(path.join(gitdir, 'commondir'), 'utf8').trim());
  } catch {
    const at = gitdir.lastIndexOf(`${path.sep}.git${path.sep}worktrees${path.sep}`);
    if (at >= 0) common = gitdir.slice(0, at + 5);
  }
  return common ? path.dirname(common) : null;
}

class Store {
  constructor(root, now) {
    /** Absolute path of the factory root (contains factory/ and teams/). */
    this.root = root;
    this._now = now;
    this._held = new Set();
    /** The shared checkout when this CLI copy lives in a linked worktree (writes are refused). */
    this._linkedWorktree = null;
    /** The write in progress (set by _op): actor, written ids, notice bookkeeping. */
    this._opCtx = null;
    for (const name of Object.getOwnPropertyNames(Store.prototype)) {
      if (name !== 'constructor' && typeof this[name] === 'function') this[name] = this[name].bind(this);
    }
  }

  // ---- paths, clock, files ------------------------------------------------

  _abs(...parts) {
    return path.join(this.root, ...parts);
  }

  _rel(abs) {
    return path.relative(this.root, abs).split(path.sep).join('/');
  }

  _teamDir(team) {
    return this._abs('teams', team);
  }

  _nowMs() {
    const v = this._now();
    const ms = v instanceof Date ? v.getTime() : typeof v === 'number' ? v : Date.parse(String(v));
    if (!Number.isFinite(ms)) fail('usage', `the clock returned an invalid time (${v}); FACTORY_NOW must be an ISO-8601 timestamp`);
    return ms;
  }

  _nowIso() {
    return new Date(this._nowMs()).toISOString();
  }
  /**
   * Record what an agent is doing, for the board's status badges. Best effort: it
   * never throws and never fails the command that called it. `you` and `factory`
   * have no presence. state: watching (a `wait` runs; pid is its process),
   * working (a factory command just ran), idle (it stopped waiting).
   */
  notePresence(member, { state = 'working', thread = null, activity = '', pid = null } = {}) {
    try {
      if (!member || member === 'you' || member === 'factory') return null;
      if (!this.members().some((m) => m.id === member)) return null;
      if (!fs.existsSync(this._abs('teams'))) return null;
      const st = PRESENCE_STATES.includes(state) ? state : 'working';
      const file = path.join(this._abs('teams'), PRESENCE_DIR, `${member}.json`);
      const rec = {
        member,
        state: st,
        thread: thread ? String(thread) : null,
        activity: oneLine(activity).slice(0, 160),
        at: this._nowIso(),
        pid: st === 'watching' && Number.isInteger(pid) ? pid : null,
      };
      // A `wait` still running in another process (the agent posted while it waits) stays on the record,
      // so the agent still counts as waiting once this command's activity is old.
      if (st !== 'watching') {
        try {
          const old = JSON.parse(fs.readFileSync(file, 'utf8'));
          const w = old?.state === 'watching' ? { pid: old.pid, thread: old.thread } : old?.wait;
          if (w && Number.isInteger(w.pid) && w.pid !== process.pid && pidAlive(w.pid)) rec.wait = { pid: w.pid, thread: typeof w.thread === 'string' ? w.thread : null };
        } catch {
          // no earlier record
        }
      }
      writeAtomic(file, `${JSON.stringify(rec)}\n`);
      return rec;
    } catch {
      return null;
    }
  }

  /**
   * Every agent with a presence record: {member: {member, state, thread, activity,
   * at, age_seconds, alive, waiting}}. alive says whether a watching `wait` still runs
   * (null for the other states); a dead one means the agent stopped at `at`.
   * waiting ({thread}) says a `wait` started before the latest command still runs.
   */
  presence() {
    const dir = path.join(this._abs('teams'), PRESENCE_DIR);
    let names;
    try {
      names = fs.readdirSync(dir);
    } catch {
      return {};
    }
    const ids = new Set(this.members().map((m) => m.id));
    const nowMs = this._nowMs();
    const out = {};
    for (const name of names.sort()) {
      if (!name.endsWith('.json')) continue;
      const id = name.slice(0, -5);
      if (!ids.has(id) || id === 'you' || id === 'factory') continue;
      let rec;
      try {
        rec = JSON.parse(fs.readFileSync(path.join(dir, name), 'utf8'));
      } catch {
        continue;
      }
      const atMs = rec && typeof rec === 'object' ? Date.parse(rec.at) : NaN;
      if (!Number.isFinite(atMs)) continue;
      const st = PRESENCE_STATES.includes(rec.state) ? rec.state : 'working';
      out[id] = {
        member: id,
        state: st,
        thread: typeof rec.thread === 'string' ? rec.thread : null,
        activity: typeof rec.activity === 'string' ? oneLine(rec.activity) : '',
        at: new Date(atMs).toISOString(),
        age_seconds: Math.max(0, Math.floor((nowMs - atMs) / 1000)),
        alive: st === 'watching' ? pidAlive(rec.pid) : null,
        // A `wait` that still runs after a later command: {thread}, else null.
        waiting: st !== 'watching' && rec.wait && Number.isInteger(rec.wait.pid) && pidAlive(rec.wait.pid) ? { thread: typeof rec.wait.thread === 'string' ? rec.wait.thread : null } : null,
      };
    }
    return out;
  }

  /**
   * What the autopilot reports in teams/.autopilot/state.json, with liveness:
   * {alive, pid, started_at, members: {id: {enabled, reason, running: {..., alive}|null, last, stuck, capped}}}.
   * {alive: false, members: {}} when it never ran.
   */
  autopilot() {
    // A member's runs, one per thread ({ref: run}); state from before per-thread runs has `running` alone.
    const runsIn = (m) => {
      const by = m.running_by_ref && typeof m.running_by_ref === 'object' && !Array.isArray(m.running_by_ref) ? { ...m.running_by_ref } : {};
      if (m.running && typeof m.running === 'object' && typeof m.running.ref === 'string' && !Object.values(by).some((r) => r && r.pid === m.running.pid)) by[m.running.ref] = m.running;
      return Object.values(by).filter((r) => r && typeof r === 'object' && typeof r.ref === 'string');
    };
    let rec;
    try {
      rec = JSON.parse(fs.readFileSync(path.join(this._abs('teams'), AUTOPILOT_DIR, 'state.json'), 'utf8'));
    } catch {
      return { alive: false, pid: null, started_at: null, members: {}, leftover_runs: [] };
    }
    if (!rec || typeof rec !== 'object') return { alive: false, pid: null, started_at: null, members: {}, leftover_runs: [] };
    const alive = isAutopilotPid(rec.pid);
    const members = {};
    for (const [id, m] of Object.entries(rec.members && typeof rec.members === 'object' ? rec.members : {})) {
      if (!m || typeof m !== 'object') continue;
      // Every run going, one per thread, newest first; `running` is the newest (readers of one run).
      const runs = runsIn(m).map((r) => ({ ...r, alive: alive && pidAlive(r.pid) })).filter((r) => r.alive)
        .sort((a, b) => String(b.started_at).localeCompare(String(a.started_at)));
      members[id] = {
        enabled: m.enabled === true,
        reason: typeof m.reason === 'string' ? m.reason : null,
        running: runs[0] || null,
        runs,
        last: m.last && typeof m.last === 'object' ? m.last : null,
        // Each thread's latest run: {thread ref: {ended_at, outcome, cost_usd}}.
        by_thread: m.by_thread && typeof m.by_thread === 'object' && !Array.isArray(m.by_thread) ? m.by_thread : {},
        stuck: Array.isArray(m.stuck) ? m.stuck.filter((x) => typeof x === 'string') : [],
        // Why each stuck or failed turn is held: {turn id: {outcome, ref, log, said}}.
        notes: m.notes && typeof m.notes === 'object' && !Array.isArray(m.notes) ? m.notes : {},
        capped: m.capped === true,
      };
    }
    // Runs going while no autopilot runs (it was stopped, restarted or died): the next autopilot takes them over; `autopilot --stop --runs` ends them.
    const leftover = alive
      ? []
      : Object.entries(rec.members && typeof rec.members === 'object' ? rec.members : {})
        .filter(([, m]) => m && typeof m === 'object')
        .flatMap(([member, m]) => runsIn(m).filter((r) => isRunPid(r)).map((r) => ({ member, pid: r.pid, ref: r.ref, started_at: typeof r.started_at === 'string' ? r.started_at : null })));
    return { alive, pid: Number.isInteger(rec.pid) ? rec.pid : null, started_at: typeof rec.started_at === 'string' ? rec.started_at : null, members, leftover_runs: leftover };
  }


  /** A timestamp strictly later than every one this process generated for this root. */
  _nextTs() {
    let ms = this._nowMs();
    const last = LAST_TS.get(this.root);
    if (last !== undefined && ms <= last) ms = last + 1;
    LAST_TS.set(this.root, ms);
    return new Date(ms).toISOString();
  }

  _readDoc(abs) {
    let text;
    try {
      text = fs.readFileSync(abs, 'utf8');
    } catch (e) {
      if (e.code === 'ENOENT') return null;
      throw e;
    }
    try {
      return parseFrontmatter(text);
    } catch (e) {
      return fail('invalid', `${this._rel(abs)}: ${e.message}`);
    }
  }

  _entityAt(abs, team) {
    const doc = this._readDoc(abs);
    return doc ? entityOf(doc.data, doc.body, team, this._rel(abs)) : null;
  }

  _listNames(dir, re) {
    let names;
    try {
      names = fs.readdirSync(dir);
    } catch {
      return [];
    }
    return names.filter((n) => n.endsWith('.md') && re.test(n.slice(0, -3))).sort();
  }

  /** Entities in teams/<team>/<sub>; unreadable files are skipped (validate reports them). */
  _loadAll(team, sub, re) {
    const dir = path.join(this._teamDir(team), sub);
    const out = [];
    for (const name of this._listNames(dir, re)) {
      try {
        const e = this._entityAt(path.join(dir, name), team);
        if (e) out.push(e);
      } catch {
        // skipped: `factory validate` names the broken file
      }
    }
    return out;
  }

  _teamIds() {
    let ents;
    try {
      ents = fs.readdirSync(this._abs('teams'), { withFileTypes: true });
    } catch {
      return [];
    }
    return ents
      .filter((d) => d.isDirectory() && ID_RE.test(d.name) && fs.existsSync(path.join(this._abs('teams'), d.name, 'team.md')))
      .map((d) => d.name)
      .sort();
  }

  _teamThreads(team) {
    return this._loadAll(team, 'threads', ID_RE).sort((a, b) => String(a.created).localeCompare(String(b.created)) || a.id.localeCompare(b.id));
  }

  _teamMessages(team) {
    return this._loadAll(team, 'comms', MESSAGE_ID_RE).sort(byTsThenId);
  }

  _teamTasks(team) {
    return this._loadAll(team, 'tasks', TASK_ID_RE).sort((a, b) => idNumber(a.id) - idNumber(b.id));
  }

  _teamIssues(team) {
    return this._loadAll(team, 'issues', ISSUE_ID_RE).sort((a, b) => idNumber(a.id) - idNumber(b.id));
  }

  _threadMeta(team) {
    return new Map(this._teamThreads(team).map((t) => [t.id, { lead: t.lead, owner: t.owner ?? null }]));
  }

  _metricRows(team) {
    let text;
    try {
      text = fs.readFileSync(path.join(this._teamDir(team), 'metrics.jsonl'), 'utf8');
    } catch {
      return [];
    }
    const rows = [];
    for (const line of text.split('\n')) {
      if (!line.trim()) continue;
      try {
        const row = JSON.parse(line);
        if (isObject(row)) rows.push(row);
      } catch {
        // skipped: `factory validate` reports the bad line
      }
    }
    return rows;
  }

  _nextNumber(team, sub, re) {
    let max = 0;
    for (const name of this._listNames(path.join(this._teamDir(team), sub), re)) max = Math.max(max, idNumber(name.slice(0, -3)));
    return max + 1;
  }

  _templateText(name) {
    for (const dir of [this._abs('factory', 'templates'), path.join(CODE_FACTORY_DIR, 'templates')]) {
      const file = path.join(dir, name);
      if (fs.existsSync(file)) return fs.readFileSync(file, 'utf8');
    }
    return fail('not_found', `template factory/templates/${name} is missing; run \`factory init --root ${this.root}\` to restore it`);
  }

  /** Render a template: parse it, then fill {{placeholders}} in string values and the body. */
  _render(name, vars) {
    const fill = (s) => s.replace(/\{\{\s*([a-z_]+)\s*\}\}/g, (m, k) => (k in vars ? String(vars[k] ?? '') : m));
    const deep = (v) => (typeof v === 'string' ? fill(v) : Array.isArray(v) ? v.map(deep) : isObject(v) ? Object.fromEntries(Object.entries(v).map(([k, x]) => [k, deep(x)])) : v);
    let doc;
    try {
      doc = parseFrontmatter(this._templateText(name));
    } catch (e) {
      if (e instanceof FactoryError) throw e;
      return fail('invalid', `factory/templates/${name}: ${e.message}`);
    }
    return { data: deep(doc.data), body: fill(doc.body) };
  }

  // ---- locking and write plumbing ------------------------------------------

  /** Run fn while holding teams/<team>/.lock (re-entrant within this store). */
  _withLock(team, fn) {
    if (this._held.has(team)) return fn();
    const dir = this._teamDir(team);
    fs.mkdirSync(dir, { recursive: true });
    const lock = path.join(dir, '.lock');
    const deadline = Date.now() + LOCK_TIMEOUT_MS;
    for (;;) {
      try {
        fs.writeFileSync(lock, `${process.pid} ${new Date().toISOString()}\n`, { flag: 'wx' });
        break;
      } catch (e) {
        if (e.code !== 'EEXIST') throw e;
        let age = 0;
        let content = '';
        try {
          age = Date.now() - fs.statSync(lock).mtimeMs;
          content = fs.readFileSync(lock, 'utf8');
        } catch {
          continue;
        }
        const holder = Number(content.split(/\s/)[0]);
        // A lock whose writer died (killed mid-command) is stale at once, not after 30 s.
        if (age > LOCK_STALE_MS || (holder !== process.pid && processGone(holder))) {
          // Remove it only if it is still the same stale lock (another process may have taken over).
          let now = null;
          try {
            now = fs.readFileSync(lock, 'utf8');
          } catch {
            now = null;
          }
          if (now === content) fs.rmSync(lock, { force: true });
          continue;
        }
        if (Date.now() > deadline) fail('conflict', `team ${team} is busy: another factory command holds teams/${team}/.lock; retry in a moment`);
        sleepSync(LOCK_RETRY_MS);
      }
    }
    this._held.add(team);
    try {
      return fn();
    } finally {
      this._held.delete(team);
      fs.rmSync(lock, { force: true });
    }
  }

  /** Refuse writes from a CLI copy inside a linked worktree (they would land on the feature branch). */
  _guardWritable() {
    if (!this._linkedWorktree) return;
    fail('permission', `this CLI copy lives in a linked git worktree (${CODE_ROOT}); its teams/ is on the feature branch, so writes here never reach the board. Run the CLI from the shared checkout instead: cd ${this._linkedWorktree} && node factory/bin/factory.mjs ... (or pass --root ${this._linkedWorktree})`);
  }

  /**
   * Run a write under the team lock; returns fn's result plus the events it posted.
   * `ownMessage`: the command writes a message from the actor, which then carries
   * the actor's notification turns in that thread; otherwise the first factory
   * event in the thread carries them (PROTOCOL §10).
   */
  _op(team, as, fn, { ownMessage = false, ownThread = null, closeNotices = true } = {}) {
    this._guardWritable();
    return this._withLock(team, () => {
      const ctx = { as, team, time: this._nowIso(), events: [], ownMessage, ownThread, closeNotices, written: new Set(), noticed: new Set() };
      const outer = this._opCtx;
      this._opCtx = ctx;
      try {
        const result = fn(ctx);
        return { ...result, events: ctx.events };
      } finally {
        this._opCtx = outer;
      }
    });
  }

  /**
   * The actor's open notification turns (event, alert, report) in a thread, as
   * they stood before the current write: ids, oldest first.
   */
  _noticeTurns(team, threadId, member, exclude = new Set()) {
    return openTurnPairs(this._teamMessages(team), this._threadMeta(team))
      .filter((p) => p.member === member && p.msg.thread === threadId && NOTICE_SET.has(p.msg.type) && !exclude.has(p.msg.id))
      .map((p) => p.msg.id);
  }

  /**
   * Extra resolves for the message m about to be written: the notification turns
   * its write closes. In the thread where the command writes the actor's own
   * message (ctx.ownThread), that message carries them; in any other thread the
   * command touches, its first factory event does.
   */
  _noticeResolves(team, m) {
    const ctx = this._opCtx;
    // A message from another team (tell, or a relayed reply) is not its sender's write in this thread.
    if (!ctx || ctx.team !== team || !ctx.as || ctx.closeNotices === false || ctx.noticed.has(m.thread)) return [];
    const ownHere = ctx.ownMessage && (ctx.ownThread == null || ctx.ownThread === m.thread);
    const carrier = m.from === ctx.as || (m.from === 'factory' && !ownHere);
    if (!carrier) return [];
    ctx.noticed.add(m.thread);
    return this._noticeTurns(team, m.thread, ctx.as, ctx.written).filter((id) => id !== m.reply_to);
  }

  /** Create a message file exclusively; returns the message entity. */
  _writeMessage(team, m) {
    const dir = path.join(this._teamDir(team), 'comms');
    fs.mkdirSync(dir, { recursive: true });
    const ts = this._nextTs();
    const otherTeams = this._teamIds().filter((t) => t !== team);
    const notices = this._noticeResolves(team, m);
    for (let attempt = 0; attempt < 500; attempt++) {
      const id = `${stampOf(ts)}-${m.from}-${randomHex()}`;
      if (otherTeams.some((t) => fs.existsSync(path.join(this._teamDir(t), 'comms', `${id}.md`)))) continue;
      const data = {
        id,
        ts,
        thread: m.thread,
        from: m.from,
        to: uniq(asArray(m.to).filter(Boolean)),
        cc: uniq(asArray(m.cc).filter(Boolean)),
        type: m.type,
        reply_to: m.reply_to ?? null,
        resolves: uniq([...asArray(m.resolves), ...notices].filter(Boolean)),
        refs: uniq(asArray(m.refs).filter(Boolean)),
        internal: Boolean(m.internal),
        ...(m.extra || {}),
      };
      const abs = path.join(dir, `${id}.md`);
      try {
        createExclusive(abs, stringifyFrontmatter(data, m.body ?? ''));
      } catch (e) {
        if (e.code === 'EEXIST') continue;
        throw e;
      }
      if (this._opCtx) this._opCtx.written.add(id);
      return this._entityAt(abs, team);
    }
    return fail('conflict', 'could not allocate a unique message id; retry');
  }

  /** Post the `event` message for one state change. */
  _event(ctx, thread, kind, data, text, { to = [], cc = [], refs = [], resolves = [] } = {}) {
    const msg = this._writeMessage(ctx.team, {
      thread: thread.id,
      from: 'factory',
      to,
      cc,
      type: 'event',
      reply_to: null,
      resolves,
      refs,
      internal: false,
      extra: { event: { kind, by: ctx.as, ...data } },
      body: text,
    });
    ctx.events.push(msg);
    return msg;
  }

  _saveThread(th) {
    // `roles` (who plays each role, on which model) is optional: written after
    // the members and gates when the owner picked them, and left out otherwise.
    const keys = KIND_KEYS[th.kind] || PROJECT_KEYS;
    const at = keys.indexOf('branch');
    const data = ordered(th, th.roles != null ? [...keys.slice(0, at), 'roles', ...keys.slice(at)] : keys);
    if (data.roles == null) delete data.roles;
    writeAtomic(path.join(this._teamDir(th.team), 'threads', `${th.id}.md`), stringifyFrontmatter(data, th.body));
  }

  _saveTask(task) {
    writeAtomic(path.join(this._teamDir(task.team), 'tasks', `${task.id}.md`), stringifyFrontmatter(ordered(task, TASK_KEYS), task.body));
  }

  _saveIssue(issue) {
    writeAtomic(path.join(this._teamDir(issue.team), 'issues', `${issue.id}.md`), stringifyFrontmatter(ordered(issue, ISSUE_KEYS), issue.body));
  }

  /** Create T-### / I-### exclusively, bumping the number if it is taken. */
  _createNumbered(team, sub, prefix, re, startAt, build) {
    const dir = path.join(this._teamDir(team), sub);
    fs.mkdirSync(dir, { recursive: true });
    for (let n = Math.max(startAt, this._nextNumber(team, sub, re)); ; n++) {
      const id = fmtId(prefix, n);
      const { data, body } = build(id);
      const abs = path.join(dir, `${id}.md`);
      try {
        createExclusive(abs, stringifyFrontmatter(data, body));
      } catch (e) {
        if (e.code === 'EEXIST') continue;
        throw e;
      }
      return this._entityAt(abs, team);
    }
  }

  // ---- reference resolution and permission checks --------------------------

  _actor(as) {
    if (!as) fail('permission', 'who is acting? pass --as <member> (or set FACTORY_AS); every write names its actor');
    if (as === 'factory') fail('permission', '`factory` is reserved for automatic events; act as yourself with --as <member>');
    const roster = this.members();
    const m = roster.find((x) => x.id === as);
    if (!m) fail('permission', `--as ${as} is not on the roster (factory/members.yaml); members: ${roster.map((x) => x.id).filter((x) => x !== 'factory').join(', ')}`);
    return m;
  }

  _requireMembers(ids, what) {
    const roster = new Set(this.members().map((m) => m.id));
    for (const id of ids) {
      if (!roster.has(id)) fail('usage', `${what}: "${id}" is not on the roster; members: ${[...roster].filter((x) => x !== 'factory').join(', ')}`);
      if (id === 'factory') fail('usage', `${what}: factory takes no turns; address a member instead`);
    }
    return ids;
  }

  _resolveThreadRef(ref) {
    if (ref == null || String(ref).trim() === '') fail('usage', 'name the thread as <team>/<thread>');
    const s = String(ref).trim();
    if (s.includes('/')) {
      const parts = s.split('/');
      if (parts.length !== 2 || !ID_RE.test(parts[0]) || !ID_RE.test(parts[1])) fail('usage', `"${s}" is not a thread ref; use <team>/<thread> with lowercase ids`);
      const [team, id] = parts;
      if (!fs.existsSync(path.join(this._teamDir(team), 'team.md'))) fail('not_found', `no team "${team}"; see \`factory team list\``);
      if (!fs.existsSync(path.join(this._teamDir(team), 'threads', `${id}.md`))) fail('not_found', `no thread ${team}/${id}; see \`factory thread list --team ${team}\``);
      return { team, id };
    }
    if (!ID_RE.test(s)) fail('usage', `"${s}" is not a thread id; use <team>/<thread>`);
    const teams = this._teamIds().filter((t) => fs.existsSync(path.join(this._teamDir(t), 'threads', `${s}.md`)));
    if (!teams.length) fail('not_found', `no thread "${s}" in any team; see \`factory thread list\``);
    if (teams.length > 1) fail('usage', `thread "${s}" exists in several teams (${teams.map((t) => `${t}/${s}`).join(', ')}); use <team>/<thread>`);
    return { team: teams[0], id: s };
  }

  _resolveItemRef(ref, kind) {
    const prefix = kind === 'task' ? 'T' : 'I';
    const re = kind === 'task' ? TASK_ID_RE : ISSUE_ID_RE;
    const sub = kind === 'task' ? 'tasks' : 'issues';
    if (ref == null || String(ref).trim() === '') fail('usage', `name the ${kind} as <team>/${prefix}-001 (or ${prefix}-001 when unique)`);
    const s = String(ref).trim();
    if (s.includes('/')) {
      const [team, id, extra] = s.split('/');
      if (extra !== undefined || !ID_RE.test(team) || !re.test(id)) fail('usage', `"${s}" is not a ${kind} ref; use <team>/${prefix}-001`);
      if (!fs.existsSync(path.join(this._teamDir(team), sub, `${id}.md`))) fail('not_found', `no ${kind} ${team}/${id}; see \`factory ${kind} list\``);
      return { team, id };
    }
    if (!re.test(s)) fail('usage', `"${s}" is not a ${kind} id; use ${prefix}-001 or <team>/${prefix}-001`);
    const teams = this._teamIds().filter((t) => fs.existsSync(path.join(this._teamDir(t), sub, `${s}.md`)));
    if (!teams.length) fail('not_found', `no ${kind} ${s} in any team; see \`factory ${kind} list\``);
    if (teams.length > 1) fail('usage', `${kind} ${s} exists in several teams (${teams.map((t) => `${t}/${s}`).join(', ')}); use <team>/${s}`);
    return { team: teams[0], id: s };
  }

  _loadThread(team, id) {
    const th = this._entityAt(path.join(this._teamDir(team), 'threads', `${id}.md`), team);
    if (!th) fail('not_found', `no thread ${team}/${id}; see \`factory thread list --team ${team}\``);
    return th;
  }

  _loadTask(team, id) {
    const t = this._entityAt(path.join(this._teamDir(team), 'tasks', `${id}.md`), team);
    if (!t) fail('not_found', `no task ${team}/${id}; see \`factory task list\``);
    return t;
  }

  _loadIssue(team, id) {
    const i = this._entityAt(path.join(this._teamDir(team), 'issues', `${id}.md`), team);
    if (!i) fail('not_found', `no issue ${team}/${id}; see \`factory issue list\``);
    return i;
  }

  _findMessage(id) {
    if (typeof id !== 'string' || !MESSAGE_ID_RE.test(id)) return null;
    for (const team of this._teamIds()) {
      const e = this._entityAt(path.join(this._teamDir(team), 'comms', `${id}.md`), team);
      if (e) return e;
    }
    return null;
  }

  _refThread(th) {
    return `${th.team}/${th.id}`;
  }

  _requireLeadOrYou(as, th, action) {
    if (as === 'you' || as === th.lead) return;
    // A single-agent thread is led by its agent; the team's lead, who sets such threads up, may still manage it.
    if (th.kind === 'solo' && as === this.team(th.team).lead) return;
    fail('permission', `${action} on ${this._refThread(th)} is for the thread lead (${th.lead}) or you; ${as} cannot do it`);
  }

  /** A single-agent thread's agent leads its work but never changes its own Instructions or settings. */
  _requireNotItsAgent(as, th, action) {
    if (th.kind !== 'solo' || as !== th.owner) return;
    fail('permission', `${as} cannot ${action} its own thread ${this._refThread(th)}; you or the team lead (${this.team(th.team).lead}) change its Instructions and settings`);
  }

  /**
   * Members, the lead, the owner and you take part in a thread; so does anyone a
   * task of the thread was dispatched to (a builder can ask its question and
   * raise what it finds even when the member list leaves it out).
   */
  _requireParticipant(as, th, action) {
    this._requireSoloScope(as, th);
    const allowed = new Set([...asArray(th.members), th.lead, th.owner, 'you'].filter(Boolean));
    if (allowed.has(as)) return;
    if (this._teamTasks(th.team).some((x) => x.thread === th.id && x.owner === as)) return;
    fail('permission', `${as} is not a member of ${this._refThread(th)} (members: ${[...allowed].join(', ')}) and owns none of its tasks; only members can ${action}`);
  }

  /**
   * On a single-agent thread only you, its lead and its agent are addressed (a turn
   * there must never start another agent); a solo agent is addressed only on its own.
   */
  _checkSoloRecipients(th, ids) {
    const roster = this.members();
    for (const id of ids) {
      if (th.kind === 'solo' && ![th.owner, th.lead, 'you'].includes(id)) {
        fail('usage', `${this._refThread(th)} is a single-agent thread: address ${uniq([th.owner, th.lead, 'you'].filter(Boolean)).join(', ')} only (${id} works on other threads)`);
      }
      if (roster.find((x) => x.id === id)?.role === 'solo' && !(th.kind === 'solo' && th.owner === id)) {
        fail('usage', `${id} answers only on the single-agent threads it owns; ${this._refThread(th)} is not one of them`);
      }
    }
  }

  /** A member with role solo works only on the single-agent threads it answers. */
  _requireSoloScope(as, th) {
    if (this.members().find((x) => x.id === as)?.role !== 'solo') return;
    if (th.kind === 'solo' && th.owner === as) return;
    fail('permission', `${as} works only on the single-agent threads it answers; ${this._refThread(th)} is not one of them`);
  }

  _requireProject(th, command) {
    if (th.kind === 'watch') fail('usage', `${this._refThread(th)} is a watch thread; \`${command}\` only applies to project threads (watch threads use \`factory watch run|pause|resume\`)`);
    if (th.kind !== 'project') fail('usage', `${this._refThread(th)} is a single-agent thread; \`${command}\` only applies to project threads (ask its agent with a question instead)`);
  }

  /** The actor's open turns in a thread, newest last. */
  _myOpenTurns(team, threadId, member) {
    const msgs = this._teamMessages(team);
    return openTurnPairs(msgs, this._threadMeta(team)).filter((p) => p.member === member && p.msg.thread === threadId).map((p) => p.msg);
  }

  /** A --reply-to target: it must exist in the posting thread's team (turns close per team). */
  _checkReplyTo(id, team) {
    if (id == null || id === '') return null;
    const m = this._findMessage(id);
    if (!m) fail('not_found', `--reply-to ${id}: no such message; see \`factory log <thread-ref>\``);
    if (team && m.team !== team) fail('usage', `--reply-to ${id}: that message is in team ${m.team} (${m.team}/${m.thread}); reply in that thread, not in team ${team}`);
    return id;
  }

  _checkResolves(ids, as, team) {
    for (const id of ids) {
      const m = this._findMessage(id);
      if (!m) fail('not_found', `--resolves ${id}: no such message`);
      if (team && m.team !== team) fail('usage', `--resolves ${id}: that message is in team ${m.team} (${m.team}/${m.thread}); resolve it with a message in that team`);
      const meta = this._threadMeta(m.team).get(m.thread) || {};
      const allowed = new Set([...asArray(m.to), m.from, meta.lead, meta.owner, 'you', 'factory'].filter(Boolean));
      if (!allowed.has(as)) fail('permission', `${as} cannot resolve ${id}: only its recipients (${asArray(m.to).join(', ') || 'none'}), its sender (${m.from}), the thread lead/owner or you can`);
    }
    return ids;
  }

  _checkRefs(team, ids) {
    for (const id of ids) {
      let ok;
      if (TASK_ID_RE.test(id)) ok = fs.existsSync(path.join(this._teamDir(team), 'tasks', `${id}.md`));
      else if (ISSUE_ID_RE.test(id)) ok = fs.existsSync(path.join(this._teamDir(team), 'issues', `${id}.md`));
      else if (DECISION_ID_RE.test(id)) ok = this.decisions(team).some((d) => d.id === id);
      else if (MESSAGE_ID_RE.test(id)) ok = Boolean(this._findMessage(id));
      else fail('usage', `--refs ${id}: refs are T-###, I-###, D-### (this team) or message ids`);
      if (!ok) fail('not_found', `--refs ${id}: no such ${id[0] === 'T' ? 'task' : id[0] === 'I' ? 'issue' : id[0] === 'D' ? 'decision' : 'message'} in team ${team}`);
    }
    return ids;
  }

  // ---- reads ---------------------------------------------------------------

  /** The roster (factory/members.yaml). @returns {object[]} */
  members() {
    const file = this._abs('factory', 'members.yaml');
    let text;
    try {
      text = fs.readFileSync(file, 'utf8');
    } catch {
      return fail('not_found', `no roster at ${file}; run \`factory init --root ${this.root}\``);
    }
    let data;
    try {
      data = parseYaml(text);
    } catch (e) {
      return fail('invalid', `factory/members.yaml: ${e.message}`);
    }
    if (!Array.isArray(data?.members)) fail('invalid', 'factory/members.yaml must have a `members:` list');
    return data.members.filter(isObject).map((m) => ({ ...m }));
  }

  /** One roster member. @param {string} id */
  member(id) {
    const all = this.members();
    const m = all.find((x) => x.id === id);
    if (!m) fail('not_found', `no member "${id}"; members: ${all.map((x) => x.id).join(', ')}`);
    return m;
  }

  /** Every team (team.md entities), sorted by id. Teams whose team.md cannot be read are in brokenTeams(). */
  teams() {
    const out = [];
    for (const id of this._teamIds()) {
      try {
        out.push(this.team(id));
      } catch {
        // listed by brokenTeams(); validate reports the file too
      }
    }
    return out;
  }

  /**
   * Teams whose folder holds a team.md that cannot be parsed: [{id, path, error}].
   * They still exist (their threads and turns are on disk); list and board show them as broken.
   */
  brokenTeams() {
    const out = [];
    for (const id of this._teamIds()) {
      try {
        this.team(id);
      } catch (e) {
        out.push({ id, path: `teams/${id}/team.md`, error: e.message });
      }
    }
    return out;
  }

  /** One team. @param {string} id */
  team(id) {
    if (!ID_RE.test(String(id ?? ''))) fail('usage', `"${id}" is not a team id`);
    const t = this._entityAt(path.join(this._teamDir(id), 'team.md'), id);
    if (!t) fail('not_found', `no team "${id}"; create it with \`factory team new ${id} --title <title> --as you\``);
    return t;
  }

  /** Commands every single-agent thread of a team may run (team.md `allow`), on top of each thread's own list. */
  teamAllow(id) {
    const t = this.team(id);
    return Array.isArray(t.allow) ? uniq(t.allow.filter((x) => typeof x === 'string' && x.trim())) : [];
  }

  /** Everything a single-agent thread's runs may use beyond the defaults: the team's rules, then the thread's own. */
  soloAllow(ref) {
    const th = this.thread(ref);
    if (th.kind !== 'solo') return [];
    return uniq([...this.teamAllow(th.team), ...asArray(th.allow)]);
  }

  /** Threads across teams, filtered. @param {{team?: string, kind?: string, phase?: string}} [filter] */
  threads({ team, kind, phase } = {}) {
    const teams = team ? [team] : this._teamIds();
    return teams.flatMap((t) => this._teamThreads(t)).filter((th) => (!kind || th.kind === kind) && (!phase || th.phase === phase));
  }

  /** One thread by `<team>/<thread>` (or a bare id unique across teams). */
  thread(ref) {
    const { team, id } = this._resolveThreadRef(ref);
    return this._loadThread(team, id);
  }

  /** A thread's messages ordered by ts then id. @param {string} ref @param {{internal?: boolean}} [options] */
  messages(ref, { internal = true } = {}) {
    const { team, id } = this._resolveThreadRef(ref);
    return this._teamMessages(team).filter((m) => m.thread === id && (internal || !m.internal));
  }

  /** One message by id (searched across teams). */
  message(id) {
    const m = this._findMessage(String(id ?? '').trim());
    if (!m) fail('not_found', `no message "${id}"; message ids look like 20261101T153012Z-fable-a3f9`);
    return m;
  }

  _itemScope(thread, team) {
    if (!thread) return { teams: team ? [team] : this._teamIds(), threadId: null };
    const r = this._resolveThreadRef(team && !String(thread).includes('/') ? `${team}/${thread}` : thread);
    return { teams: [r.team], threadId: r.id };
  }

  /** Tasks across teams, filtered. @param {{thread?: string, team?: string, status?: string, owner?: string}} [filter] */
  tasks({ thread, team, status, owner } = {}) {
    const { teams, threadId } = this._itemScope(thread, team);
    return teams.flatMap((t) => this._teamTasks(t)).filter((x) => (!threadId || x.thread === threadId) && (!status || x.status === status) && (!owner || x.owner === owner));
  }

  /** One task by `<team>/T-###` (or bare when unique). */
  task(ref) {
    const { team, id } = this._resolveItemRef(ref, 'task');
    return this._loadTask(team, id);
  }

  /** Issues across teams, filtered. @param {{thread?: string, team?: string, status?: string}} [filter] */
  issues({ thread, team, status } = {}) {
    const { teams, threadId } = this._itemScope(thread, team);
    return teams.flatMap((t) => this._teamIssues(t)).filter((x) => (!threadId || x.thread === threadId) && (!status || x.status === status));
  }

  /** One issue by `<team>/I-###` (or bare when unique). */
  issue(ref) {
    const { team, id } = this._resolveItemRef(ref, 'issue');
    return this._loadIssue(team, id);
  }

  /** decisions.md entries: [{id, title, ts, by, thread, message, resolves, gate, verdict, body}]. */
  decisions(teamId) {
    this.team(teamId);
    let text = '';
    try {
      text = fs.readFileSync(path.join(this._teamDir(teamId), 'decisions.md'), 'utf8');
    } catch {
      return [];
    }
    return parseDecisions(text);
  }

  /** metrics.jsonl rows for a watch thread, in file order. */
  metrics(ref) {
    const { team, id } = this._resolveThreadRef(ref);
    return this._metricRows(team).filter((r) => r.thread === id);
  }

  /** Watch reports for a thread: [{file, ts, status, title, path}], oldest first. */
  reports(ref) {
    const { team, id } = this._resolveThreadRef(ref);
    const dir = path.join(this._teamDir(team), 'reports');
    let names = [];
    try {
      names = fs.readdirSync(dir).filter((n) => n.endsWith('.md')).sort();
    } catch {
      return [];
    }
    const out = [];
    for (const name of names) {
      let doc;
      try {
        doc = this._readDoc(path.join(dir, name));
      } catch {
        continue;
      }
      if (!doc || doc.data.thread !== id) continue;
      const heading = /^# (.+)$/m.exec(doc.body);
      out.push({ file: `reports/${name}`, ts: doc.data.ts ?? null, status: doc.data.status ?? null, title: heading ? heading[1].trim() : name, path: `teams/${team}/reports/${name}` });
    }
    return out.sort((a, b) => String(a.ts).localeCompare(String(b.ts)));
  }

  /**
   * Open turns, oldest first: [{team, thread, member, message: {id, ts, from, type, summary}, age_seconds}].
   * @param {{member?: string, thread?: string, team?: string}} [filter]
   */
  openTurns({ member, thread, team } = {}) {
    const { teams, threadId } = this._itemScope(thread, team);
    const nowMs = this._nowMs();
    const out = [];
    for (const t of teams) {
      const pairs = openTurnPairs(this._teamMessages(t), this._threadMeta(t));
      for (const p of pairs) {
        if (member && p.member !== member) continue;
        if (threadId && p.msg.thread !== threadId) continue;
        out.push(turnView(t, p, nowMs));
      }
    }
    return out.sort((a, b) => byTsThenId(a.message, b.message));
  }

  /** Everything the board UI shows, across all teams. */
  board() {
    const nowMs = this._nowMs();
    const teams = [];
    for (const team of this.teams()) {
      const tid = team.id;
      const threads = this._teamThreads(tid);
      const msgs = this._teamMessages(tid);
      const tasks = this._teamTasks(tid);
      const issues = this._teamIssues(tid);
      const rows = this._metricRows(tid);
      const pairs = openTurnPairs(msgs, new Map(threads.map((t) => [t.id, { lead: t.lead, owner: t.owner ?? null }])));
      teams.push({
        id: tid,
        title: team.title,
        lead: team.lead,
        repo_paths: team.repo_paths ?? [],
        data_sources: team.data_sources ?? {},
        eval_cmd: team.eval_cmd ?? null,
        grader: team.grader ?? null,
        body: team.body,
        threads: threads.map((th) => {
          const own = msgs.filter((m) => m.thread === th.id);
          const runs = rows.filter((r) => r.thread === th.id);
          const last = runs[runs.length - 1];
          return {
            id: th.id,
            team: tid,
            title: th.title,
            kind: th.kind,
            phase: th.phase,
            lead: th.lead,
            owner: th.owner ?? null,
            // Who the owner picked for each role, and on which model: the board names the lead and builders by it.
            roles: th.roles ?? null,
            members: th.members ?? [],
            gates: th.gates ?? null,
            gate_dismissed: dismissedGate(th, own),
            branch: th.branch,
            cadence: th.cadence ?? null,
            thresholds: th.thresholds ?? null,
            last_run: th.last_run ?? null,
            updated: th.updated,
            eta: th.eta ?? null,
            // When the current phase began: its latest phase event, else the thread's creation.
            phase_since: own.filter((m) => m.type === 'event' && m.event?.kind === 'phase').at(-1)?.ts ?? th.created ?? null,
            tasks: countBy(tasks.filter((x) => x.thread === th.id), 'status', TASK_STATUSES),
            issues: countBy(issues.filter((x) => x.thread === th.id), 'status', ISSUE_STATUSES),
            openTurns: pairs.filter((p) => p.msg.thread === th.id).map((p) => turnView(tid, p, nowMs)),
            lastMessage: messageHead(own[own.length - 1]),
            messageCount: own.length,
            lastMetrics: last ? { ts: last.ts, metrics: last.metrics, breaches: last.breaches ?? [] } : null,
          };
        }),
        tasks: tasks.map((x) => ({ id: x.id, thread: x.thread, title: x.title, status: x.status, owner: x.owner ?? null, issue: x.issue ?? null, eta: x.eta ?? null, updated: x.updated })),
        issues: issues.map((x) => ({ id: x.id, thread: x.thread, title: x.title, severity: x.severity, status: x.status, gate: x.gate ?? null, task: x.task ?? null, metric: x.metric ?? null, updated: x.updated })),
      });
    }
    return { generated: new Date(nowMs).toISOString(), members: this.members(), teams, brokenTeams: this.brokenTeams(), archivedTeams: this.archivedTeams(), presence: this.presence(), autopilot: this.autopilot() };
  }

  /** One thread with its messages, tasks, issues, decisions, metrics, reports and open turns. */
  threadView(ref) {
    const { team, id } = this._resolveThreadRef(ref);
    const th = this._loadThread(team, id);
    const teamEntity = this.team(team);
    const { path: _path, team: _team, ...frontmatter } = th;
    const own = this._teamMessages(team).filter((m) => m.thread === id);
    const ruleView = (rule, scope) => ({ rule, scope, risk: allowRuleRisk(rule) });
    return {
      team,
      teamTitle: teamEntity.title,
      // What a single-agent thread's agent may run beyond the defaults: the team's rules, then the thread's own.
      allowRules: th.kind === 'solo'
        ? [...this.teamAllow(team).map((x) => ruleView(x, 'team')), ...asArray(th.allow).map((x) => ruleView(x, 'thread'))]
        : [],
      thread: { ...frontmatter, team, gate_dismissed: dismissedGate(th, own) },
      messages: own.map((m) => ({ ...m, summary: summary(m) })),
      tasks: this._teamTasks(team).filter((x) => x.thread === id),
      issues: this._teamIssues(team).filter((x) => x.thread === id),
      decisions: this.decisions(team).filter((d) => d.thread === id),
      metrics: this._metricRows(team).filter((r) => r.thread === id),
      reports: this.reports(`${team}/${id}`),
      openTurns: this.openTurns({ thread: `${team}/${id}` }),
      presence: this.presence(),
      autopilot: this.autopilot(),
    };
  }

  /** Active watch threads whose last_run + cadence is now or past (never run = due). */
  watchDue() {
    const nowMs = this._nowMs();
    const out = [];
    for (const th of this.threads({ kind: 'watch', phase: 'active' })) {
      const period = cadenceMs(th.cadence);
      if (!period) continue;
      const last = th.last_run ? Date.parse(th.last_run) : null;
      const dueAt = last === null ? null : last + period;
      if (dueAt !== null && dueAt > nowMs) continue;
      out.push({
        team: th.team,
        thread: th.id,
        ref: `${th.team}/${th.id}`,
        title: th.title,
        owner: th.owner ?? null,
        cadence: th.cadence,
        last_run: th.last_run ?? null,
        due_at: dueAt === null ? null : new Date(dueAt).toISOString(),
        overdue_seconds: dueAt === null ? null : Math.floor((nowMs - dueAt) / 1000),
      });
    }
    return out;
  }

  /**
   * The git commands that create the thread's worktree. Never runs git (a read-only
   * `git rev-parse --verify` checks whether the branch exists).
   * @returns {{branch: string, path: string, exists: boolean, commands: string[], note: string}}
   */
  worktreeCommands(ref) {
    const th = this.thread(ref);
    // Built from the validated ids, never taken from the file: the commands are run as printed.
    const branch = `factory/${th.team}/${th.id}`;
    if (th.branch != null && th.branch !== branch) {
      fail('invalid', `${this._refThread(th)} has branch "${th.branch}" in its thread file, but its branch must be ${branch}; run \`factory validate\` and report it to the owner`);
    }
    const wt = path.join(path.dirname(this.root), `${path.basename(this.root)}-factory`, `${th.team}--${th.id}`);
    const hasRef = (name) => {
      try {
        execFileSync('git', ['-C', this.root, 'rev-parse', '--verify', '--quiet', name], { stdio: 'ignore', timeout: 10_000 });
        return true;
      } catch {
        return false;
      }
    };
    const exists = hasRef(`refs/heads/${branch}`);
    // Pushed earlier, local branch since removed: rebuild it from origin, not from main.
    const remote = !exists && hasRef(`refs/remotes/origin/${branch}`);
    const root = shellQuote(this.root);
    const b = shellQuote(branch);
    const w = shellQuote(wt);
    let commands;
    if (exists) commands = [`git -C ${root} fetch origin main`, `git -C ${root} worktree add ${w} ${b}`];
    else if (remote) commands = [`git -C ${root} fetch origin main ${b}`, `git -C ${root} worktree add --track -b ${b} ${w} ${shellQuote(`origin/${branch}`)}`];
    else commands = [`git -C ${root} fetch origin main`, `git -C ${root} worktree add ${w} -b ${b} origin/main`];
    // The team's setup (team.md `setup`, one command line such as `npm ci`) runs once in the new worktree.
    const setup = this._teamSetup(th.team);
    if (setup) commands.push(`cd ${w} && ${setup}`);
    return { branch, path: wt, exists, remote, commands, setup, note: 'The shared checkout never leaves main: build in the worktree, never switch branches in the shared checkout.' };
  }

  /** A team's worktree setup command (team.md `setup`), or null. */
  _teamSetup(team) {
    const v = this.team(team).setup;
    return typeof v === 'string' && v.trim() && !/[\r\n]/.test(v) ? v.trim() : null;
  }

  // ---- writes: setup -------------------------------------------------------

  /**
   * Create teams/ (README.md, .gitignore) and copy factory/members.yaml and
   * factory/templates/ from the code's own factory dir when they are missing.
   * With `triage` (the `init` command), a root with no teams also gets the
   * Triage thread (TRIAGE_REF). Idempotent; needs no actor.
   * @returns {{root: string, created: string[], events: []}}
   */
  init({ triage = false } = {}) {
    this._guardWritable();
    const created = [];
    const copyIfMissing = (dest, source, fallback) => {
      if (fs.existsSync(dest)) return;
      fs.mkdirSync(path.dirname(dest), { recursive: true });
      if (source && fs.existsSync(source) && path.resolve(source) !== path.resolve(dest)) fs.copyFileSync(source, dest);
      else if (fallback !== undefined) fs.writeFileSync(dest, fallback);
      else return;
      created.push(this._rel(dest));
    };
    fs.mkdirSync(this._abs('teams'), { recursive: true });
    copyIfMissing(this._abs('teams', 'README.md'), path.join(CODE_ROOT, 'teams', 'README.md'), DEFAULT_TEAMS_README);
    copyIfMissing(this._abs('teams', '.gitignore'), path.join(CODE_ROOT, 'teams', '.gitignore'), DEFAULT_TEAMS_GITIGNORE);
    copyIfMissing(this._abs('factory', 'members.yaml'), path.join(CODE_FACTORY_DIR, 'members.yaml'));
    const tplDir = path.join(CODE_FACTORY_DIR, 'templates');
    let templates = [];
    try {
      templates = fs.readdirSync(tplDir).filter((n) => n.endsWith('.md'));
    } catch {
      templates = [];
    }
    for (const name of templates) copyIfMissing(this._abs('factory', 'templates', name), path.join(tplDir, name));
    if (triage) {
      const file = this._seedTriage();
      if (file) created.push(file);
    }
    return { root: this.root, created, events: [] };
  }

  /**
   * The Triage thread, a single-agent thread written as `you`: only on a root
   * with no teams and no archived Triage team (so an archived one stays gone),
   * and only when the roster has a single agent. Its creation opens no turn,
   * so no agent starts until the owner posts there.
   * @returns {string|null} the thread file it created
   */
  _seedTriage() {
    if (this._teamIds().length) return null;
    const [team, id] = TRIAGE_REF.split('/');
    let archived = [];
    try {
      archived = fs.readdirSync(this._abs('teams', ARCHIVE_DIR)).filter((n) => n.startsWith(`${team}-`));
    } catch {
      archived = [];
    }
    if (archived.length || !this.members().some(isSoloAgent)) return null;
    this.createThread({ as: 'you', ref: TRIAGE_REF, title: 'Triage', teamTitle: 'Triage', kind: 'solo' });
    this.editSection({ as: 'you', ref: TRIAGE_REF, section: 'Instructions', body: TRIAGE_INSTRUCTIONS });
    return this._rel(path.join(this._teamDir(team), 'threads', `${id}.md`));
  }

  /**
   * Archive a team: its whole folder moves to teams/.archive/<team>-<stamp>, so
   * it leaves the board, the inbox and the autopilot, nothing is deleted, and
   * the id is free for a new team. You only. Refused while an agent run works
   * on one of its threads. The autopilot's saved sessions for its threads are
   * dropped, so a new team with the same id starts fresh.
   */
  archiveTeam({ as, id } = {}) {
    this._actor(as);
    if (as !== 'you') fail('permission', 'only you archive a team');
    const team = this.team(id);
    const ap = this.autopilot();
    const busy = ap.alive
      ? Object.entries(ap.members || {}).flatMap(([k, m]) => (Array.isArray(m?.runs) ? m.runs : m?.running ? [m.running] : []).filter((r) => String(r.ref || '').startsWith(`${team.id}/`)).map((r) => `${k} (${r.ref})`))
      : [];
    if (busy.length) fail('conflict', `${busy.join(', ')} is working in ${team.id} right now; wait for the run to end or stop it, then archive`);
    const stamp = new Date(this._nowMs()).toISOString().replace(/[-:]/g, '').replace(/\.\d+Z$/, 'Z');
    const archiveRoot = path.join(this._abs('teams'), ARCHIVE_DIR);
    let dest = path.join(archiveRoot, `${team.id}-${stamp}`);
    for (let n = 2; fs.existsSync(dest); n++) dest = path.join(archiveRoot, `${team.id}-${stamp}-${n}`);
    const threads = this.threads({ team: team.id }).length;
    fs.mkdirSync(archiveRoot, { recursive: true });
    // Under the team's lock, so no write lands mid-move; the lock file moves with the folder and is removed there.
    this._withLock(team.id, () => fs.renameSync(this._teamDir(team.id), dest));
    fs.rmSync(path.join(dest, '.lock'), { force: true });
    const sessionsFile = path.join(this._abs('teams'), AUTOPILOT_DIR, 'sessions.json');
    let dropped = 0;
    try {
      const all = JSON.parse(fs.readFileSync(sessionsFile, 'utf8'));
      for (const refs of Object.values(all)) {
        if (!refs || typeof refs !== 'object') continue;
        for (const ref of Object.keys(refs)) if (ref.startsWith(`${team.id}/`)) { delete refs[ref]; dropped++; }
      }
      if (dropped) writeAtomic(sessionsFile, `${JSON.stringify(all, null, 2)}\n`);
    } catch {
      // no saved sessions
    }
    return { team: { id: team.id, title: team.title }, threads, path: path.relative(this.root, dest), sessions_dropped: dropped };
  }

  /**
   * Teams that `archiveTeam` moved to teams/.archive, newest first:
   * [{name, id, title, threads, archived_at, path}]. `name` is the folder name,
   * which `restoreTeam` takes.
   */
  archivedTeams() {
    const root = path.join(this._abs('teams'), ARCHIVE_DIR);
    let ents;
    try {
      ents = fs.readdirSync(root, { withFileTypes: true });
    } catch {
      return [];
    }
    const out = [];
    for (const d of ents) {
      const m = d.isDirectory() && ARCHIVED_RE.exec(d.name);
      if (!m) continue;
      const dir = path.join(root, d.name);
      let title = m[1];
      try {
        title = this._entityAt(path.join(dir, 'team.md'), m[1])?.title || title;
      } catch {
        // a team.md that does not parse still restores; its id stands in for the title
      }
      const [, id, y, mo, da, h, mi, se] = m;
      out.push({
        name: d.name,
        id,
        title,
        threads: this._listNames(path.join(dir, 'threads'), ID_RE).length,
        archived_at: `${y}-${mo}-${da}T${h}:${mi}:${se}Z`,
        path: path.relative(this.root, dir),
      });
    }
    return out.sort((a, b) => b.archived_at.localeCompare(a.archived_at) || b.name.localeCompare(a.name));
  }

  /**
   * Bring an archived team back to teams/<id>, as it was. You only. Refused
   * while a team with that id is on the board: archive that one first.
   */
  restoreTeam({ as, name } = {}) {
    this._actor(as);
    if (as !== 'you') fail('permission', 'only you restore a team');
    const entry = this.archivedTeams().find((x) => x.name === String(name ?? ''));
    if (!entry) fail('not_found', `no archived team "${name}"; see \`factory team archived\``);
    const dest = this._teamDir(entry.id);
    if (fs.existsSync(dest)) fail('conflict', `a team "${entry.id}" is already on the board; archive it first, then restore ${entry.name}`);
    fs.renameSync(path.join(this.root, entry.path), dest);
    return { team: { id: entry.id, title: entry.title }, threads: entry.threads, from: entry.path };
  }

  /**
   * Create a team: team.md from the template, decisions.md, and the state folders.
   * Allowed for you or the new team's lead (default: the roster's lead).
   */
  createTeam({ as, id, title, lead } = {}) {
    const actor = this._actor(as);
    if (as !== 'you' && actor.role !== 'lead') {
      fail('permission', `only you or a lead (${this.members().filter((m) => m.role === 'lead').map((m) => m.id).join(', ')}) can create teams; ${as} is a ${actor.role}`);
    }
    if (!ID_RE.test(String(id ?? ''))) fail('usage', `team id "${id}" must be lowercase letters, digits and dashes (1-41 chars, starting with a letter or digit)`);
    const name = oneLine(title);
    if (!name) fail('usage', `team ${id} needs a title: --title "<Title>"`);
    const roster = this.members();
    const theLead = lead || roster.find((m) => m.role === 'lead')?.id || as;
    this._requireMembers([theLead], '--lead');
    this._requireLeadRole(theLead);
    if (fs.existsSync(path.join(this._teamDir(id), 'team.md'))) fail('conflict', `team ${id} already exists; see \`factory team list\``);
    return this._op(id, as, (ctx) => {
      const dir = this._teamDir(id);
      if (fs.existsSync(path.join(dir, 'team.md'))) fail('conflict', `team ${id} already exists`);
      writeAtomic(path.join(dir, 'team.md'), this._renderTeam({ id, title: name, lead: theLead, created: ctx.time }));
      if (!fs.existsSync(path.join(dir, 'decisions.md'))) {
        fs.writeFileSync(path.join(dir, 'decisions.md'), `# Decisions — ${name}\n\nAppend-only: \`factory decide\` adds entries; never edit or remove one.\n`);
      }
      for (const sub of ['threads', 'comms', 'tasks', 'issues', 'reports']) fs.mkdirSync(path.join(dir, sub), { recursive: true });
      return { team: this.team(id) };
    });
  }

  /**
   * A team or thread lead must be a member whose role is lead, or you: a lead
   * answers reviews and moves phases, so a reviewer, gatekeeper or builder
   * leading a thread would review and answer its own work.
   */
  /** A single-agent thread's owner is an agent from the roster (it is started for each request). */
  _requireSoloAgent(id) {
    const roster = this.members();
    const m = roster.find((x) => x.id === id);
    if (isSoloAgent(m)) return;
    const ok = roster.filter(isSoloAgent).map((x) => x.id);
    fail('usage', `--owner ${id} is ${m ? `a ${m.kind} with role ${m.role}` : 'not on the roster'}; a single-agent thread is answered by an agent with role solo and launch: claude (${ok.join(', ') || 'none in factory/members.yaml'}), so its runs keep to the thread's allowed commands`);
  }

  _requireLeadRole(id) {
    if (id === 'you') return;
    const m = this.members().find((x) => x.id === id);
    if (m && m.role === 'lead') return;
    const leads = this.members().filter((x) => x.role === 'lead').map((x) => x.id);
    fail('usage', `--lead ${id}: ${id} is a ${m?.role ?? 'non-member'}; a lead is a member with role lead (${leads.join(', ') || 'none'}) or you`);
  }

  /** team.md text: the template with its comments kept when placeholders render cleanly. */
  _renderTeam(vars) {
    const raw = this._templateText('team.md');
    const close = raw.indexOf('\n---', 3);
    if (raw.startsWith('---\n') && close > 0) {
      const head = raw.slice(0, close).replace(/\{\{\s*([a-z_]+)\s*\}\}/g, (m, k) => (k in vars ? JSON.stringify(String(vars[k])).slice(1, -1) : m));
      const tail = raw.slice(close).replace(/\{\{\s*([a-z_]+)\s*\}\}/g, (m, k) => (k in vars ? String(vars[k]) : m));
      try {
        const doc = parseFrontmatter(head + tail);
        if (doc.data.id === vars.id && doc.data.title === vars.title && doc.data.lead === vars.lead && doc.data.created === vars.created) return head + tail;
      } catch {
        // fall through to a canonical rewrite
      }
    }
    const { data, body } = this._render('team.md', vars);
    const merged = {
      eval_cmd: null, grader: null, data_sources: { usage: null, traces: null, latency: null, feedback: null }, repo_paths: [],
      ...data, id: vars.id, title: vars.title, lead: vars.lead, created: vars.created,
    };
    return stringifyFrontmatter(ordered(merged, TEAM_KEYS), body);
  }

  /**
   * Create a project, watch or single-agent thread from its template.
   * Allowed for the team lead or you. Project threads start in `brief` and post
   * `thread_created` to the lead; watch and single-agent threads start `active`.
   * A single-agent (`solo`) thread has one agent, its `owner`, that works only
   * when someone asks it there; `allow` lists the extra commands its autopilot
   * runs may use (Claude Code permission rules).
   * `roles` (project and single-agent threads) picks who plays each role and
   * on which model; on a project it also sets the builders, the pair engineer
   * and the review gate owners (lib/roles.mjs).
   */
  createThread({ as, ref, title, kind = 'project', lead, owner, members, cadence, thresholds, teamTitle, allow, roles } = {}) {
    const actor = this._actor(as);
    const s = String(ref ?? '').trim();
    const parts = s.split('/');
    if (parts.length !== 2) fail('usage', `name the new thread as <team>/<thread>, e.g. checkout/checkout-v2 (got "${s}")`);
    const [teamId, id] = parts;
    if (!ID_RE.test(teamId) || !ID_RE.test(id)) fail('usage', `"${s}": team and thread ids are lowercase letters, digits and dashes (1-41 chars)`);
    const theKind = kind || 'project';
    if (!THREAD_KINDS.includes(theKind)) fail('usage', `--kind must be project, watch or solo (got "${kind}")`);
    const name = oneLine(title);
    if (!name) fail('usage', `thread ${s} needs a title: --title "<Title>"`);
    // Checked before a missing team is created, so a bad pick leaves nothing behind.
    let theRoles = null;
    if (roles != null) {
      if (theKind === 'watch') fail('usage', 'roles apply to project and single-agent threads');
      if (theKind === 'project' && members != null) fail('usage', '--members: the roles pick a project\'s members; leave --members out');
      try {
        theRoles = normalizeRoles(theKind, roles);
      } catch (e) {
        fail('usage', e.message);
      }
    }
    // A thread in a team that does not exist yet creates the team (and its
    // folder) first, so "start work on X" is one command. Only someone who may
    // create teams (you, or a lead) gets this; everyone else sees not_found.
    let teamCreated = false;
    if (!fs.existsSync(path.join(this._teamDir(teamId), 'team.md'))) {
      if (as !== 'you' && actor.role !== 'lead') this.team(teamId);
      if (!fs.existsSync(path.join(this.root, 'teams'))) this.init();
      this.createTeam({ as, id: teamId, title: oneLine(teamTitle) || titleFromId(teamId), lead });
      teamCreated = true;
    }
    const team = this.team(teamId);
    if (as !== 'you' && as !== team.lead) fail('permission', `only the team lead (${team.lead}) or you can start threads in ${teamId}`);
    const roster = this.members();
    // A single-agent thread is led by its own agent (set below); every other thread by a lead or you.
    let theLead = theKind === 'solo' ? null : lead || team.lead;
    if (theLead) {
      this._requireMembers([theLead], '--lead');
      this._requireLeadRole(theLead);
    }
    let theOwner = null;
    let theCadence = null;
    let theThresholds = null;
    const theAllow = normalizeAllow(allow);
    if (theKind !== 'solo' && theAllow.length) fail('usage', '--allow only applies to single-agent threads (--kind solo)');
    if (theKind === 'watch') {
      theOwner = owner || roster.find((m) => m.role === 'monitor')?.id || theLead;
      this._requireMembers([theOwner], '--owner');
    } else if (theKind === 'solo') {
      if (cadence) fail('usage', '--cadence only applies to watch threads; a single-agent thread works when someone asks it');
      if (thresholds && Object.keys(thresholds).length) fail('usage', '--threshold only applies to watch threads');
      theOwner = owner || roster.find(isSoloAgent)?.id;
      if (!theOwner) fail('usage', 'factory/members.yaml has no agent with role solo and launch: claude to answer a single-agent thread');
      this._requireMembers([theOwner], '--owner');
      this._requireSoloAgent(theOwner);
      if (lead && lead !== theOwner) fail('usage', `--lead: a single-agent thread is led by its own agent (${theOwner}); leave --lead out`);
      if (members != null) fail('usage', '--members: a single-agent thread has two members, you and its agent; leave --members out');
      theLead = theOwner;
    } else {
      if (owner) fail('usage', '--owner only applies to watch threads; a project thread is run by its lead');
      if (cadence) fail('usage', '--cadence only applies to watch threads');
      if (thresholds && Object.keys(thresholds).length) fail('usage', '--threshold only applies to watch threads');
    }
    if (fs.existsSync(path.join(this._teamDir(teamId), 'threads', `${id}.md`))) fail('conflict', `thread ${s} already exists; see \`factory thread show ${s}\``);
    const staffing = theRoles && theKind === 'project' ? rolesStaffing(theRoles, theLead, this.members().filter((m) => m.role === 'builder').map((m) => m.id)) : null;
    return this._op(teamId, as, (ctx) => {
      if (fs.existsSync(path.join(this._teamDir(teamId), 'threads', `${id}.md`))) fail('conflict', `thread ${s} already exists`);
      const vars = { id, title: name, team: teamId, lead: theLead, owner: theOwner ?? '', created: ctx.time };
      const { data: tpl, body } = this._render(`thread-${theKind}.md`, vars);
      let list = staffing ? staffing.members : members != null ? toList(members) : toList(tpl.members);
      if (!list.length) list = theKind === 'project' ? ['you', theLead, 'opus-1', 'opus-2', 'openai', 'grok'] : ['you', theLead, theOwner];
      let gates = null;
      if (theKind === 'project') {
        gates = {};
        for (const g of GATES) {
          const by = g === 'build' ? theLead : staffing?.gates[g] || tpl.gates?.[g]?.by || DEFAULT_GATE_OWNERS[g];
          // An optional gate (security_review) exists only when the roles picked someone for it.
          if (!by && OPTIONAL_GATES.includes(g)) continue;
          gates[g] = { by, status: 'pending', at: null, ref: null };
        }
        list = [...list, 'you', theLead, ...Object.values(gates).map((x) => x.by)];
      } else if (theKind === 'solo') {
        list = [...list, 'you', theLead, theOwner];
      } else {
        list = [...list, 'you', theLead, theOwner];
        theCadence = cadence || tpl.cadence || 'daily';
        if (!CADENCE_RE.test(theCadence)) fail('usage', `--cadence "${theCadence}" is not valid; use hourly, daily, weekly, <n>h or <n>d`);
        theThresholds = normalizeThresholds(thresholds ?? tpl.thresholds ?? {}) || {};
      }
      list = uniq(list.filter(Boolean));
      this._requireMembers(list, '--members');
      const th = {
        ...tpl,
        id,
        title: name,
        kind: theKind,
        team: teamId,
        phase: theKind === 'project' ? 'brief' : 'active',
        lead: theLead,
        ...(theKind === 'project' ? {} : { owner: theOwner }),
        members: list,
        gates,
        branch: `factory/${teamId}/${id}`,
        cadence: theCadence,
        thresholds: theThresholds,
        ...(theKind === 'watch' ? { last_run: null } : {}),
        ...(theKind === 'solo' ? { allow: theAllow } : {}),
        ...(theRoles ? { roles: theRoles } : {}),
        created: ctx.time,
        updated: ctx.time,
        body,
      };
      if (theKind === 'project') delete th.owner;
      if (theKind !== 'watch') delete th.last_run;
      if (theKind === 'solo') {
        delete th.cadence;
        delete th.thresholds;
      } else {
        delete th.allow;
      }
      this._saveThread(th);
      const saved = this._loadThread(teamId, id);
      if (theKind === 'project') {
        this._event(ctx, saved, 'thread_created', { thread_kind: 'project' }, `${md.who(as)} created ${md.title(name)} — ${md.does(theLead, 'write')} the brief.`, { to: [theLead] });
      } else if (theKind === 'solo') {
        this._event(ctx, saved, 'thread_created', { thread_kind: 'solo' }, `${md.who(as)} created the single-agent thread ${md.title(name)}: ${md.who(theOwner)} leads it and works when someone asks it.`);
      } else {
        this._event(ctx, saved, 'thread_created', { thread_kind: 'watch' }, `${md.who(as)} created the watch ${md.title(name)} (${theCadence}, run by ${md.who(theOwner)}).`);
      }
      return { thread: saved, team_created: teamCreated };
    });
  }

  /** Replace the content of one `## <section>` of a thread body (adds it when missing). Lead or you. */
  editSection({ as, ref, section, body } = {}) {
    this._actor(as);
    const { team, id } = this._resolveThreadRef(ref);
    const name = normalizeSectionName(section);
    return this._op(team, as, (ctx) => {
      const th = this._loadThread(team, id);
      this._requireLeadOrYou(as, th, 'thread edit');
      this._requireNotItsAgent(as, th, 'thread edit');
      th.body = replaceSection(th.body, name, body ?? '');
      th.updated = ctx.time;
      this._saveThread(th);
      this._event(ctx, th, 'section_updated', { section: name }, `${md.who(as)} updated ${md.title(name)} in ${md.title(th.title)}.`);
      return { thread: this._loadThread(team, id) };
    });
  }

  /**
   * The autopilot's record that a single-agent run was refused commands (Claude
   * Code's `permission_denials`, which a run in dontAsk mode never asks about):
   * one `permission_denied` event to you with what was refused and the rules that
   * would allow it, which the board shows as a permission card. It also carries
   * the rules of older open cards in the thread, and closes them, so one card
   * holds everything still to decide. Nothing is posted (event: null) when the
   * member is not the thread's agent, or every refusal is read-only or already
   * allowed. `denials`: [{tool, command?, input?}]; `turns`: the run's turn ids.
   */
  notePermissionDenied({ ref, member, denials = [], turns = [] } = {}) {
    const { team, id } = this._resolveThreadRef(ref);
    this._requireMembers([member], 'member');
    return this._op(team, null, (ctx) => {
      const th = this._loadThread(team, id);
      if (th.kind !== 'solo' || th.owner !== member) return { event: null };
      const allowed = new Set([...this.teamAllow(team), ...asArray(th.allow)]);
      const msgs = this._teamMessages(team);
      const older = openTurnPairs(msgs, this._threadMeta(team))
        .filter((p) => p.member === 'you' && p.msg.thread === id && p.msg.type === 'event' && p.msg.event?.kind === 'permission_denied')
        .map((p) => p.msg);
      const commands = [];
      const rules = [];
      const addCommand = (tool, text) => {
        const c = { tool, command: truncate(String(text ?? '').trim(), 500) };
        if (c.command && !commands.some((x) => x.tool === c.tool && x.command === c.command)) commands.push(c);
      };
      const addRule = (r) => {
        if (typeof r === 'string' && !allowed.has(r) && !allowRuleProblem(r) && !rules.includes(r)) rules.push(r);
      };
      for (const m of older) {
        for (const c of asArray(m.event.commands)) if (c && typeof c.tool === 'string') addCommand(c.tool, c.command);
        for (const r of asArray(m.event.rules)) addRule(typeof r === 'string' ? r : r?.rule);
      }
      let fresh = 0;
      for (const d of asArray(denials)) {
        const tool = String(d?.tool ?? '').trim();
        if (!tool) continue;
        const text = tool === 'Bash' ? (d.command ?? d.input?.command) : (d.command ?? JSON.stringify(d.input ?? {}));
        if (typeof text !== 'string' || !text.trim()) continue;
        const before = rules.length;
        if (tool === 'Bash') for (const r of suggestAllowRules(text)) addRule(r);
        if (rules.length > before) {
          addCommand(tool, text);
          fresh += 1;
        }
      }
      // Nothing new to decide: every refusal was read-only or is allowed by now (older cards stay as they are).
      if (!fresh) return { event: null };
      const shown = commands.slice(-10);
      const refs = uniq(asArray(turns).filter((x) => msgs.some((m) => m.id === x)));
      const ruleList = rules.map((rule) => ({ rule, risk: allowRuleRisk(rule) }));
      const text = [
        `${md.who(member)} was refused ${shown.length === 1 ? 'a command' : `${shown.length} commands`}: ${shown.slice(0, 3).map((c) => codeSpan(truncate(c.command, 160))).join('; ')}${shown.length > 3 ? '; …' : ''}.`,
        `Allow ${ruleList.length === 1 ? 'it' : 'them'} on the board (the permission card in this thread), or: ${ruleList.map((r) => codeSpan(`node factory/bin/factory.mjs thread set ${team}/${id} --add-allow "${r.rule}" --as you`)).join('; ')}`,
      ].join('\n\n');
      const ev = this._event(ctx, th, 'permission_denied', { by: member, member, commands: shown, rules: ruleList, turns: refs }, text, {
        to: ['you'],
        refs,
        resolves: older.map((m) => m.id),
      });
      return { event: ev };
    });
  }

  /**
   * Change a thread's configuration (lead or you): a watch thread's cadence,
   * thresholds and owner, and any thread's members. `thresholds` replaces the
   * bounds of each metric it names; `clearThresholds` removes metrics. Posts one
   * `thread_config` event listing what changed.
   */
  setThreadConfig({ as, ref, cadence, thresholds, clearThresholds, owner, members, allow, clearAllow, allowAdd, allowRemove } = {}) {
    this._actor(as);
    const { team, id } = this._resolveThreadRef(ref);
    const clear = uniq(toList(clearThresholds));
    const addList = normalizeAllow(allowAdd, '--add-allow');
    const removeList = uniq(toArrayLoose(allowRemove));
    const replaceGiven = allow != null && toArrayLoose(allow).length > 0;
    if (replaceGiven && (addList.length || removeList.length)) fail('usage', '--allow replaces the whole list; use it alone, or change the list with --add-allow / --remove-allow');
    if (clearAllow && (addList.length || removeList.length)) fail('usage', '--clear-allow empties the list; use it alone, or change the list with --add-allow / --remove-allow');
    const allowGiven = replaceGiven || addList.length > 0 || removeList.length > 0;
    const given = cadence != null || (thresholds && Object.keys(thresholds).length) || clear.length || owner != null || members != null || allowGiven || clearAllow;
    if (!given) fail('usage', 'say what to change: --cadence, --threshold "metric<=v", --clear-threshold <metric>, --owner <member>, --members a,b, or (single-agent threads) --allow <rule> / --add-allow <rule> / --remove-allow <rule> / --clear-allow');
    if (replaceGiven && clearAllow) fail('usage', '--allow replaces the list and --clear-allow empties it; use one');
    return this._op(team, as, (ctx) => {
      const th = this._loadThread(team, id);
      const tref = this._refThread(th);
      this._requireLeadOrYou(as, th, 'thread set');
      this._requireNotItsAgent(as, th, 'thread set');
      const changes = [];
      const data = {};
      const watchOnly = cadence != null || clear.length || (thresholds && Object.keys(thresholds).length);
      if (th.kind === 'project' && (watchOnly || owner != null || allowGiven || clearAllow)) {
        fail('usage', `${tref} is a project thread; only --members applies to it (cadence, thresholds and owner belong to watch threads)`);
      }
      if (th.kind === 'solo' && watchOnly) fail('usage', `${tref} is a single-agent thread; cadence and thresholds belong to watch threads (it works when someone asks it)`);
      if (th.kind === 'solo' && members != null) fail('usage', `${tref} is a single-agent thread: its members are you and its agent; change the agent with --owner`);
      if (th.kind !== 'solo' && (allowGiven || clearAllow)) fail('usage', `${tref} is a ${KIND_NAME[th.kind]} thread; allowed commands only apply to single-agent threads`);
      if (allowGiven || clearAllow) {
        const before = asArray(th.allow);
        const missing = removeList.filter((x) => !before.includes(x));
        if (missing.length) fail('not_found', `${tref} does not allow ${missing.map((x) => JSON.stringify(x)).join(', ')}; it allows ${before.length ? before.map((x) => JSON.stringify(x)).join(', ') : 'nothing beyond the defaults'}`);
        const next = clearAllow ? [] : replaceGiven ? normalizeAllow(allow) : uniq([...before.filter((x) => !removeList.includes(x)), ...addList]);
        if (JSON.stringify(next) !== JSON.stringify(before)) {
          data.allow = { from: before, to: next };
          const added = next.filter((x) => !before.includes(x));
          const removed = before.filter((x) => !next.includes(x));
          if (replaceGiven || clearAllow) changes.push(next.length ? `allowed commands → ${next.map((x) => codeSpan(x)).join('; ')}` : 'allowed commands → none beyond the defaults');
          else changes.push([added.length ? `allowed ${added.map((x) => codeSpan(x)).join('; ')}` : '', removed.length ? `stopped allowing ${removed.map((x) => codeSpan(x)).join('; ')}` : ''].filter(Boolean).join('; '));
          th.allow = next;
        }
      }
      if (cadence != null) {
        if (!CADENCE_RE.test(String(cadence))) fail('usage', `--cadence "${cadence}" is not valid; use hourly, daily, weekly, <n>h or <n>d`);
        if (cadence !== th.cadence) {
          data.cadence = { from: th.cadence, to: cadence };
          changes.push(`cadence ${th.cadence} → ${cadence}`);
          th.cadence = cadence;
        }
      }
      if (clear.length || (thresholds && Object.keys(thresholds).length)) {
        const next = { ...(th.thresholds || {}) };
        for (const metric of clear) {
          if (!(metric in next)) fail('usage', `--clear-threshold ${metric}: ${tref} has no threshold on ${metric} (it has ${Object.keys(next).join(', ') || 'none'})`);
          delete next[metric];
        }
        Object.assign(next, normalizeThresholds(thresholds || {}));
        const before = JSON.stringify(th.thresholds || {});
        if (JSON.stringify(next) !== before) {
          data.thresholds = { from: th.thresholds || {}, to: next };
          const shown = Object.entries(next).map(([k, t]) => `${k} ${formatThreshold(t)}`).join('; ') || 'none';
          changes.push(`thresholds → ${shown}`);
          th.thresholds = next;
        }
      }
      if (owner != null) {
        this._requireMembers([owner], '--owner');
        if (th.kind === 'solo') this._requireSoloAgent(owner);
        if (owner !== th.owner) {
          if (th.kind === 'solo') {
            // Its requests stay with the agent they were sent to; moving them would drop them silently.
            const held = openTurnPairs(this._teamMessages(team), this._threadMeta(team))
              .filter((p) => p.member === th.owner && p.msg.thread === th.id && !NOTICE_SET.has(p.msg.type))
              .map((p) => p.msg.id);
            if (held.length) {
              fail('conflict', `${th.owner} has ${held.length} open request${held.length === 1 ? '' : 's'} on ${tref} (${held.join(', ')}); let it answer first, or close ${held.length === 1 ? 'it' : 'them'} with \`factory post ${tref} --type note --resolves <id> --body "<why>" --as you\`, then change the agent`);
            }
          }
          data.owner = { from: th.owner, to: owner };
          changes.push(`owner ${th.owner} → ${owner}`);
          th.owner = owner;
        }
        if (th.kind === 'solo' && th.lead !== owner) {
          // Its agent leads it (this also converts a thread made when the team lead led single-agent threads).
          data.lead = { from: th.lead, to: owner };
          changes.push(`lead ${th.lead} → ${owner}`);
          th.lead = owner;
        }
      }
      if (members != null || data.owner || data.lead) {
        const gone = new Set(th.kind === 'solo' ? [data.owner?.from, data.lead?.from].filter((m) => m && m !== 'you' && m !== th.owner) : []);
        const base = members != null ? uniq(toList(members)) : asArray(th.members).filter((m) => !gone.has(m));
        const keep = th.kind === 'project' ? ['you', th.lead, ...Object.values(th.gates || {}).map((x) => x.by)] : ['you', th.lead, th.owner];
        const list = uniq([...base, ...keep].filter(Boolean));
        this._requireMembers(list, '--members');
        if (JSON.stringify(list) !== JSON.stringify(asArray(th.members))) {
          data.members = { from: asArray(th.members), to: list };
          changes.push(`members → ${list.join(', ')}`);
          th.members = list;
        }
      }
      if (!changes.length) fail('conflict', `${tref} already has that configuration; nothing changed`);
      // Members that leave a single-agent thread can no longer write there: close the turns they hold on it.
      const left = th.kind === 'solo' && data.members ? new Set(data.members.from.filter((m) => !data.members.to.includes(m))) : new Set();
      const closed = left.size
        ? openTurnPairs(this._teamMessages(team), this._threadMeta(team)).filter((p) => left.has(p.member) && p.msg.thread === th.id).map((p) => p.msg.id)
        : [];
      if (closed.length) changes.push(`closed ${closed.length} turn${closed.length === 1 ? '' : 's'} held by ${[...left].join(', ')}`);
      th.updated = ctx.time;
      this._saveThread(th);
      this._event(ctx, th, 'thread_config', data, `${md.who(as)} changed ${md.title(th.title)}: ${changes.join('; ')}.`, { resolves: uniq(closed) });
      return { thread: this._loadThread(team, id), changes };
    });
  }

  /**
   * Change team.md configuration (you or the team lead): eval_cmd, grader,
   * data_sources entries, repo_paths and `allow` (commands every single-agent
   * thread of the team may run, on top of each thread's own). A team has no
   * thread, so this posts no event (like `team new`); the change is in team.md.
   * `dataSources` maps usage|traces|latency|feedback to text (or null to clear).
   */
  editTeam({ as, id, eval_cmd: evalCmd, grader, setup, dataSources, repoPaths, allow, allowAdd, allowRemove, clearAllow } = {}) {
    this._actor(as);
    const t = this.team(id);
    if (as !== 'you' && as !== t.lead) fail('permission', `only you or the team lead (${t.lead}) can change team ${id}; ${as} cannot`);
    const ds = dataSources || {};
    for (const k of Object.keys(ds)) {
      if (!DATA_SOURCE_KEYS.includes(k)) fail('usage', `--data-source ${k}: data_sources has exactly ${DATA_SOURCE_KEYS.join(', ')}`);
    }
    const replaceAllow = allow != null && toArrayLoose(allow).length > 0;
    const addList = normalizeAllow(allowAdd, '--add-allow');
    const removeList = uniq(toArrayLoose(allowRemove));
    if ([replaceAllow, Boolean(clearAllow), addList.length > 0 || removeList.length > 0].filter(Boolean).length > 1) {
      fail('usage', 'change the team\'s allowed commands one way: --allow (replaces the list), --add-allow / --remove-allow, or --clear-allow');
    }
    const allowGiven = replaceAllow || clearAllow || addList.length > 0 || removeList.length > 0;
    if (setup != null && /[\r\n]/.test(String(setup))) fail('usage', '--setup is one command line; chain steps with &&');
    if (evalCmd === undefined && grader === undefined && setup === undefined && !Object.keys(ds).length && repoPaths === undefined && !allowGiven) {
      fail('usage', 'say what to change: --eval-cmd, --grader, --setup <usage|traces|latency|feedback>=<text>, --repo-paths a,b, or the commands its single-agent threads may run (--allow / --add-allow / --remove-allow / --clear-allow)');
    }
    return this._op(id, as, () => {
      const cur = this.team(id);
      const { body, path: _p, team: _t, ...data } = cur;
      const blank = (v) => (v == null || String(v).trim() === '' || v === 'null' ? null : String(v));
      const changed = [];
      if (evalCmd !== undefined) { data.eval_cmd = blank(evalCmd); changed.push('eval_cmd'); }
      if (grader !== undefined) { data.grader = blank(grader); changed.push('grader'); }
      if (setup !== undefined) { data.setup = blank(setup)?.trim() || null; changed.push('setup'); }
      if (Object.keys(ds).length) {
        const prev = isObject(data.data_sources) ? data.data_sources : {};
        data.data_sources = Object.fromEntries(DATA_SOURCE_KEYS.map((k) => [k, k in ds ? blank(ds[k]) : prev[k] ?? null]));
        changed.push(...Object.keys(ds).map((k) => `data_sources.${k}`));
      }
      if (repoPaths !== undefined) { data.repo_paths = uniq(toList(repoPaths)); changed.push('repo_paths'); }
      if (allowGiven) {
        const before = asArray(data.allow);
        const missing = removeList.filter((x) => !before.includes(x));
        if (missing.length) fail('not_found', `team ${id} does not allow ${missing.map((x) => JSON.stringify(x)).join(', ')}; it allows ${before.length ? before.map((x) => JSON.stringify(x)).join(', ') : 'nothing'}`);
        const next = clearAllow ? [] : replaceAllow ? normalizeAllow(allow) : uniq([...before.filter((x) => !removeList.includes(x)), ...addList]);
        if (JSON.stringify(next) === JSON.stringify(before) && !changed.length) fail('conflict', `team ${id} already allows exactly that; nothing changed`);
        if (JSON.stringify(next) !== JSON.stringify(before)) { data.allow = next; changed.push('allow'); }
      }
      writeAtomic(path.join(this._teamDir(id), 'team.md'), stringifyFrontmatter(ordered(data, TEAM_KEYS), body));
      return { team: this.team(id), changed };
    });
  }

  /**
   * Edit a task (lead or you): its title, and/or one `## <section>` of its body
   * (for example the Acceptance list of a task created by respond or issue accept).
   */
  editTask({ as, task, title, section, body } = {}) {
    this._actor(as);
    const { team, id } = this._resolveItemRef(task, 'task');
    const name = title == null ? null : oneLine(title);
    if (title != null && !name) fail('usage', 'the task title cannot be empty');
    if (section == null && name == null) fail('usage', 'say what to change: --title <t>, and/or --section <name> with the new content (--body, --body-file or stdin)');
    const sec = section == null ? null : normalizeSectionName(section);
    if (sec && (body == null || !String(body).trim())) fail('usage', `give the new content of ## ${sec}: --body <text>, --body-file <path>, or piped stdin`);
    return this._op(team, as, (ctx) => {
      const tk = this._loadTask(team, id);
      const th = this._loadThread(team, tk.thread);
      this._requireLeadOrYou(as, th, 'task edit');
      const changed = [];
      if (name != null && name !== tk.title) { tk.title = name; changed.push('title'); }
      if (sec) { tk.body = replaceSection(tk.body, sec, body); changed.push(`## ${sec}`); }
      if (!changed.length) fail('conflict', `${team}/${id} already has that title; nothing changed`);
      tk.updated = ctx.time;
      this._saveTask(tk);
      this._event(ctx, th, 'task_updated', { task: tk.id, changed }, `${md.who(as)} edited ${tk.id} ${md.title(tk.title)} (${changed.join(', ')}).`, { refs: [tk.id] });
      return { task: this._loadTask(team, id), changed };
    });
  }

  // ---- writes: messages ----------------------------------------------------

  /**
   * Post a free-form message (kickoff, proposal, question, answer, escalation, note;
   * `decision` is recorded through decide()). The actor must be a thread member,
   * its lead or owner, or you.
   */
  post({ as, ref, type, to, cc, reply_to, resolves, refs, internal, body } = {}) {
    this._actor(as);
    if (!type) fail('usage', `choose a message type with --type (${MESSAGE_TYPES.filter((x) => !(x in DEDICATED_COMMANDS) && x !== 'event').join(', ')})`);
    if (!MESSAGE_TYPES.includes(type)) fail('usage', `unknown message type "${type}"; types: ${MESSAGE_TYPES.join(', ')}`);
    if (type === 'event') fail('permission', 'event messages are posted by the factory itself for state changes; use --type note');
    if (type === 'decision') {
      // A decision addresses nobody and is never internal: refuse what decide would drop.
      const dropped = [toList(to).length && '--to', toList(cc).length && '--cc', internal && '--internal'].filter(Boolean);
      if (dropped.length) {
        fail('usage', `a decision takes no ${dropped.join(', ')}: it is recorded for everyone and opens no turns; post a note or question to address someone, and name turns the decision settles with --resolves (or --reply-to)`);
      }
      return this.decide({ as, ref, title: summary(String(body ?? '')) || 'Decision', body, resolves, refs, reply_to });
    }
    if (DEDICATED_COMMANDS[type]) fail('usage', `a ${type} records state; post it with \`${DEDICATED_COMMANDS[type]}\``);
    const { team, id } = this._resolveThreadRef(ref);
    const text = String(body ?? '');
    if (!text.trim()) fail('usage', 'the message needs a body: --body <text>, --body-file <path> (- reads stdin to the end), or piped stdin');
    const out = this._op(team, as, () => {
      const th = this._loadThread(team, id);
      this._requireParticipant(as, th, 'post here');
      const toList_ = this._requireMembers(uniq(toList(to)), '--to');
      const ccList = this._requireMembers(uniq(toList(cc)), '--cc');
      this._checkSoloRecipients(th, [...toList_, ...ccList]);
      let replyTo = reply_to ?? null;
      if (replyTo == null && type === 'answer') {
        // An answer answers the newest question-like turn; notification turns close on their own (§10).
        const mine = this._myOpenTurns(team, id, as);
        replyTo = (mine.filter((m) => !NOTICE_SET.has(m.type)).at(-1) ?? mine.at(-1))?.id ?? null;
      }
      this._checkReplyTo(replyTo, team);
      const res = this._checkResolves(uniq(toList(resolves)), as, team);
      const rf = this._checkRefs(team, uniq(toList(refs)));
      const message = this._writeMessage(team, { thread: id, from: as, to: toList_, cc: ccList, type, reply_to: replyTo, resolves: res, refs: rf, internal: Boolean(internal), body: text });
      return { message };
    }, { ownMessage: true, ownThread: id });
    // A reply to a message from (or to) another team goes back to that team's thread too.
    const relayed = this._relay(out.message);
    return relayed ? { ...out, relayed } : out;
  }

  /**
   * Talk to another team (§9, "Between teams"): post into its thread, addressed to
   * that thread's lead (a single-agent thread's agent), and keep a copy in the
   * sender's thread. Both carry a `link` to the other side, and a reply on either
   * side is relayed to the other. A team name picks its one open thread.
   */
  tell({ as, from, target, type, body } = {}) {
    this._actor(as);
    const kind = type == null || type === '' ? 'question' : String(type);
    if (!['question', 'note'].includes(kind)) fail('usage', `--type is question (you want an answer; the default) or note (for their information, still a turn for their lead), not "${kind}"`);
    if (from == null || String(from).trim() === '') fail('usage', 'say which thread you speak from: --from <team>/<thread>');
    const origin = this._resolveThreadRef(from);
    const oth = this._loadThread(origin.team, origin.id);
    const originRef = `${origin.team}/${origin.id}`;
    if (as !== 'you' && oth.lead !== as && oth.owner !== as) fail('permission', `only the lead or owner of ${originRef}, or you, speaks for it to another team; ${as} is neither`);
    const dest = this._tellTarget(target, originRef);
    const dth = this._loadThread(dest.team, dest.id);
    const destRef = `${dest.team}/${dest.id}`;
    const to = dth.kind === 'solo' ? dth.owner : dth.lead;
    if (!to) fail('conflict', `${destRef} has no lead or owner to address`);
    const text = String(body ?? '');
    if (!text.trim()) fail('usage', 'the message needs a body: --body <text>, --body-file <path> (- reads stdin to the end), or piped stdin');
    // The copy first: the other side links to it, so a reply there finds its way back.
    const copy = this._op(origin.team, as, () => ({
      message: this._writeMessage(origin.team, { thread: origin.id, from: as, to: [], cc: [], type: kind, reply_to: null, resolves: [], refs: [], internal: false, extra: { link: { dir: 'to', thread: destRef, msg: null } }, body: text }),
    }), { ownMessage: true, ownThread: origin.id }).message;
    const message = this._op(dest.team, as, () => ({
      message: this._writeMessage(dest.team, { thread: dest.id, from: as, to: [to], cc: [], type: kind, reply_to: null, resolves: [], refs: [], internal: false, extra: { link: { dir: 'from', thread: originRef, msg: copy.id } }, body: text }),
    }), { closeNotices: false }).message;
    return { message, copy, thread: destRef, from: originRef };
  }

  /**
   * Save an image for a message in a thread (§9, "Images"): teams/<team>/attachments/,
   * named like a message id. Returns {path, markdown}; the message body carries the
   * markdown, and agents open the path with their Read tool.
   */
  attach({ as, ref, type, data, name } = {}) {
    this._actor(as);
    const ext = ATTACHMENT_TYPES[String(type ?? '').toLowerCase()];
    if (!ext) fail('usage', `attach a PNG, JPEG, GIF or WebP image, not ${type ? `"${type}"` : 'an untyped file'}`);
    const bytes = Buffer.isBuffer(data) ? data : Buffer.from(String(data ?? ''), 'base64');
    if (!bytes.length) fail('usage', 'the image is empty');
    if (bytes.length > MAX_ATTACHMENT_BYTES) fail('usage', `the image is ${Math.ceil(bytes.length / 1048576)} MB; the limit is ${MAX_ATTACHMENT_BYTES / 1048576} MB`);
    if (!IMAGE_MAGIC[ext](bytes)) fail('usage', `the file is not a ${ext.toUpperCase()} image`);
    const { team, id } = this._resolveThreadRef(ref);
    const th = this._loadThread(team, id);
    this._requireParticipant(as, th, 'attach an image here');
    this._guardWritable();
    const dir = path.join(this._teamDir(team), 'attachments');
    fs.mkdirSync(dir, { recursive: true });
    const stamp = stampOf(this._nextTs());
    for (let attempt = 0; attempt < 50; attempt++) {
      const file = `${stamp}-${as}-${randomHex()}.${ext}`;
      try {
        fs.writeFileSync(path.join(dir, file), bytes, { flag: 'wx' });
      } catch (e) {
        if (e.code === 'EEXIST') continue;
        throw e;
      }
      const rel = `teams/${team}/attachments/${file}`;
      const alt = String(name ?? '').replace(/\.[a-z0-9]+$/i, '').replace(/[[\]()\n\r]/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 80) || 'image';
      return { path: rel, bytes: bytes.length, markdown: `![${alt}](${rel})` };
    }
    return fail('conflict', 'could not name the image; retry');
  }

  /**
   * Close turns without answering them (§10, "Dismiss"): a hidden note
   * (internal, `dismissal: true`) that resolves exactly those turns. It is not a
   * write in the thread, so it closes nothing else and starts no agent. `member`
   * is whose turns they are: yours by default; only `you` may dismiss another
   * member's (an agent the owner chose not to start). Dismissing an agent that
   * owns the current phase's pending gate also stops the wait on that gate
   * (`dismissed_gate`); the gate stays pending, and approves nothing.
   */
  dismiss({ as, ref, ids, member } = {}) {
    this._actor(as);
    const { team, id } = this._resolveThreadRef(ref);
    const want = uniq(toList(ids));
    const holder = member == null || member === '' ? as : String(member);
    if (holder !== as && as !== 'you') fail('permission', `only you can dismiss another member's turns; ${as} can dismiss its own`);
    return this._op(team, as, () => {
      const th = this._loadThread(team, id);
      const g = th.kind === 'project' && GATE_ENTRY_PHASES.has(th.phase) ? th.gates?.[th.phase] : null;
      const gate = holder !== as && g?.status === 'pending' && g.by === holder ? th.phase : null;
      if (!want.length && !gate) fail('usage', 'name the message whose turn to dismiss');
      const open = new Map(this._myOpenTurns(team, id, holder).map((m) => [m.id, m]));
      for (const x of want) if (!open.has(x)) fail('not_found', `${x} is not waiting on ${holder} in ${team}/${id} (already closed?)`);
      const what = [...want.map((x) => `${open.get(x).type} from ${open.get(x).from} (${x})`), ...(gate ? [`the wait on the ${gate} gate`] : [])].join(', ');
      const message = this._writeMessage(team, {
        thread: id, from: as, to: [], cc: [], type: 'note', reply_to: null, resolves: want, refs: [], internal: true,
        extra: { dismissal: true, dismissed_for: holder, ...(gate ? { dismissed_gate: gate } : {}) },
        body: `Dismissed ${what}${holder === as ? '' : ` for ${holder}`}.`,
      });
      return { message, dismissed: want, member: holder, gate };
    }, { closeNotices: false });
  }

  /** The thread `tell` posts into: <team>/<thread>, or a team name when that team has one open thread. */
  _tellTarget(target, originRef) {
    const s = String(target ?? '').trim();
    if (!s) fail('usage', 'name the team (or <team>/<thread>) to talk to');
    let r;
    if (s.includes('/')) r = this._resolveThreadRef(s);
    else {
      if (!ID_RE.test(s) || !this._teamIds().includes(s)) fail('not_found', `no team "${s}"; teams: ${this._teamIds().join(', ')}`);
      const all = this._teamThreads(s).filter((th) => `${s}/${th.id}` !== originRef);
      const open = all.filter((th) => th.phase !== 'done' && th.state !== 'paused');
      const pick = open.length ? open : all;
      if (!pick.length) fail('not_found', `team ${s} has no thread to talk to`);
      if (pick.length > 1) fail('usage', `team ${s} has ${pick.length} open threads; name one: ${pick.map((th) => `${s}/${th.id} (${th.title})`).join(', ')}`);
      r = { team: s, id: pick[0].id };
    }
    if (`${r.team}/${r.id}` === originRef) fail('usage', `${originRef} is the thread you speak from; name another team's thread`);
    return r;
  }

  /**
   * Relay a reply to a linked message (one from or to another team) into the other
   * team's thread, addressed to whoever wrote the other side. Returns the relayed
   * message, or null when there is nothing to relay.
   */
  _relay(r) {
    if (!r?.reply_to || !RELAY_TYPES.has(r.type) || r.internal) return null;
    const p = this._teamMessages(r.team).find((m) => m.id === r.reply_to);
    if (!p || !isObject(p.link) || typeof p.link.thread !== 'string') return null;
    let other;
    try {
      other = this._resolveThreadRef(p.link.thread);
    } catch {
      return null; // the other thread is gone (archived or deleted)
    }
    const theirs = this._teamMessages(other.team);
    const c = p.link.msg ? theirs.find((m) => m.id === p.link.msg) : theirs.find((m) => isObject(m.link) && m.link.msg === p.id);
    if (!c || c.thread !== other.id) return null;
    return this._op(other.team, r.from, () => ({
      message: this._writeMessage(other.team, {
        thread: other.id, from: r.from, to: c.from === 'factory' ? [] : [c.from], cc: [], type: r.type, reply_to: c.id, resolves: [], refs: [], internal: false,
        extra: { link: { dir: 'from', thread: `${r.team}/${r.thread}`, msg: r.id } }, body: r.body,
      }),
    }), { closeNotices: false }).message;
  }

  // ---- writes: gates -------------------------------------------------------

  /**
   * The gate owner's review of the current gate. Sets the gate status, opens one
   * issue per point, addresses the lead when there are points or the verdict is
   * not approve, and on approve verifies the gate's fixed issues and moves on.
   */
  review({ as, ref, verdict, points, reply_to, body } = {}) {
    this._actor(as);
    const { team, id } = this._resolveThreadRef(ref);
    return this._op(team, as, (ctx) => {
      const th = this._loadThread(team, id);
      this._requireProject(th, 'review');
      const g = th.phase;
      const tref = this._refThread(th);
      if (!REVIEW_GATES.includes(g)) {
        const mine = REVIEW_GATES.filter((x) => th.gates?.[x]?.by === as);
        let hint = mine.length ? ` (${as} owns ${mine.join(', ')})` : '';
        if (g === 'build') hint = '; the build gate approves itself when every task is done';
        if (g === 'done') hint = '; the thread is done, so there is nothing left to review';
        fail('permission', `thread ${tref} is in ${g}; reviews are only accepted in a gate phase (${REVIEW_GATES.join(', ')})${hint}`);
      }
      const owner = th.gates?.[g]?.by;
      if (as !== owner) fail('permission', `${tref} is in ${g}; only ${owner} (the ${g} gate owner) can review it now, not ${as}`);
      if (!VERDICTS.includes(verdict)) fail('usage', `--verdict must be approve, changes_requested or blocked (got "${verdict ?? ''}")`);
      const pts = normalizePoints(points);
      const serious = pts.filter((p) => p.severity === 'high' || p.severity === 'medium');
      if (verdict === 'approve' && serious.length) fail('usage', `approve only carries low or nit points; point ${serious.map((p) => p.n).join(', ')} is ${serious[0].severity}: use --verdict changes_requested`);
      if (verdict === 'approve') this._checkApprovable(th, g, { override: false });
      const mineOpen = this._myOpenTurns(team, id, as);
      const replyTo = reply_to != null ? this._checkReplyTo(reply_to, team) : mineOpen.at(-1)?.id ?? null;
      const resolves = mineOpen.map((m) => m.id).filter((x) => x !== replyTo);
      const to = pts.length || verdict !== 'approve' ? [th.lead] : [];
      const counts = SEVERITIES.map((sv) => [sv, pts.filter((p) => p.severity === sv).length]).filter(([, n]) => n).map(([sv, n]) => `${n} ${sv}`);
      const text = String(body ?? '').trim() || `${md.code(verdict)} at ${md.code(g)}${pts.length ? `: ${plural(pts.length, 'point')} (${counts.join(', ')})` : ''}.`;
      const msg = this._writeMessage(team, { thread: id, from: as, to, cc: [], type: 'review', reply_to: replyTo, resolves, refs: [], internal: false, extra: { gate: g, verdict, points: pts }, body: text });
      this._setGate(ctx, th, g, GATE_STATUS_OF[verdict], msg);
      const issues = pts.map((p) => this._createIssueFile(ctx, th, {
        title: truncate(oneLine(p.text), 80),
        gate: g,
        source: msg.id,
        point: p.n,
        severity: p.severity,
        body: p.text,
        note: `raised at ${g} in review ${msg.id}`,
        refs: [msg.id],
      }));
      if (verdict === 'approve') this._approveGateEffects(ctx, th, g, as);
      return { message: msg, thread: this._loadThread(team, id), issues };
    }, { ownMessage: true, ownThread: id });
  }

  /**
   * Refuse an approval that would let unfinished work through: at code_review,
   * final_review and signoff every task of the thread must be done (a review
   * only; you can still override with decide --gate), and signoff needs every
   * issue triaged (none still `open`).
   */
  _checkApprovable(th, g, { override }) {
    const tref = this._refThread(th);
    if (!override && ['code_review', 'security_review', 'final_review', 'signoff'].includes(g)) {
      const open = this._teamTasks(th.team).filter((x) => x.thread === th.id && x.status !== 'done');
      if (open.length) {
        fail('conflict', `${tref} has unfinished tasks (${open.map((x) => `${x.id} ${x.status}`).join(', ')}); the work they describe has not been built and reviewed. Ask ${th.lead} to finish them (the thread belongs in build), or you can override with \`factory decide ${tref} --gate ${g} --verdict approve --title <t> --as you\``);
      }
    }
    if (g === 'signoff') {
      const untriaged = this._teamIssues(th.team).filter((x) => x.thread === th.id && x.status === 'open');
      if (untriaged.length) {
        fail('conflict', `${tref} cannot be signed off while issues are untriaged: ${untriaged.map((x) => `${x.id} (${x.severity}${x.gate ? `, ${x.gate}` : ''}) ${x.title}`).join('; ')}. ${th.lead} answers each one first: \`factory respond\` for review points, \`factory issue accept|reject|defer <issue-ref>\` for the rest`);
      }
    }
  }

  _setGate(ctx, th, g, status, msg) {
    const prev = th.gates[g].status;
    th.gates[g] = { ...th.gates[g], status, at: msg.ts, ref: msg.id };
    th.updated = ctx.time;
    this._saveThread(th);
    const verb = { approved: `approved the ${md.code(g)} gate of`, changes_requested: `requested changes at ${md.code(g)} on`, blocked: `blocked ${md.code(g)} on` }[status];
    const tail = status === 'blocked' ? ` — ${md.does('you', 'decide')} how to proceed.` : status === 'changes_requested' ? ` — ${md.does(th.lead, 'respond')}.` : '.';
    this._event(ctx, th, 'gate', { gate: g, from: prev, to: status }, `${md.who(ctx.as)} ${verb} ${md.title(th.title)}${tail}`, {
      cc: status === 'blocked' ? ['you'] : [],
      refs: [msg.id],
    });
  }

  /**
   * Approve effects shared by review and decide: verify fixed issues, then move on.
   * An approval verifies the thread's `fixed` issues that the approver raised at
   * any gate (or by hand), and those raised at this gate; the signoff approval
   * verifies every `fixed` issue left in the thread. Watch-thread issues are
   * verified only by watch runs and `factory verify`.
   */
  _approveGateEffects(ctx, th, g, approver) {
    for (const issue of this._teamIssues(th.team)) {
      if (issue.thread !== th.id || issue.status !== 'fixed') continue;
      const mine = issue.raised_by === approver;
      if (g !== 'signoff' && !mine && issue.gate !== g) continue;
      const why = mine ? `${approver} approved ${g} after the fix` : g === 'signoff' ? 'signed off with the fix in place' : `the ${g} gate approved again`;
      this._setIssueStatus(ctx, th, issue, 'verified', `verified: ${why}`);
    }
    const order = threadPhases(th);
    this._movePhase(ctx, th, order[order.indexOf(g) + 1]);
  }

  /**
   * Move a project thread to `to`, posting the phase event. Gate entries address
   * the gate owner; done cc's every member; back moves address the lead and
   * reset gates from the target onward; a forward move into a lead phase made by
   * someone else (you approving the brief, the reviewer approving design_review)
   * addresses the lead, whose turn on it the autopilot starts.
   */
  _movePhase(ctx, th, to, { back = false, why = '', note = '' } = {}) {
    const from = th.phase;
    const reset = back ? this._gatesFrom(th, to) : [];
    th.phase = to;
    th.updated = ctx.time;
    let recipients = [];
    let cc = [];
    let tail = '.';
    if (back) {
      recipients = [th.lead];
      tail = why ? ` — ${why}.` : '.';
    } else if (GATE_ENTRY_PHASES.has(to)) {
      recipients = [th.gates[to].by];
      tail = ` — waiting on ${md.who(th.gates[to].by)}.`;
    } else if (to === 'done') {
      // The sign-off is the owner's go to merge: the lead merges the PR (`factory merge`).
      recipients = th.kind === 'project' ? [th.lead] : [];
      cc = asArray(th.members).filter((m) => !recipients.includes(m));
      tail = th.kind === 'project' ? ` — the thread is done; over to ${md.who(th.lead)} to merge its PR.` : ' — the thread is done.';
    } else if (LEAD_PHASES.includes(to) && ctx.as !== th.lead) {
      recipients = [th.lead];
      tail = ` — over to ${md.who(th.lead)}.`;
    }
    const text = `${md.who(ctx.as)} moved ${md.title(th.title)} from ${md.code(from)} to ${md.code(to)}${tail}${note ? `\n\n${note}` : ''}`;
    const ev = this._event(ctx, th, 'phase', { from, to, ...(reset.length ? { reset } : {}) }, text, { to: recipients, cc });
    for (const g of reset) th.gates[g] = { ...th.gates[g], status: 'pending', at: ev.ts, ref: ev.id };
    this._saveThread(th);
    if (to === 'done') this._fixLinkedWatchIssues(ctx, th);
    return ev;
  }

  /**
   * A watch issue fixed through a project thread becomes `fixed` when that thread
   * is signed off (its code reviewed at code_review, final_review and signoff),
   * not when its task is accepted. The next watch run verifies or reopens it.
   */
  _fixLinkedWatchIssues(ctx, th) {
    const tasks = this._teamTasks(th.team).filter((x) => x.thread === th.id && x.issue && x.status === 'done');
    for (const tk of tasks) {
      let issue = null;
      try {
        issue = this._loadIssue(th.team, tk.issue);
      } catch {
        issue = null;
      }
      if (!issue || issue.thread === th.id || issue.task !== tk.id) continue;
      if (!['open', 'accepted', 'deferred'].includes(issue.status)) continue;
      this._setIssueStatus(ctx, th, issue, 'fixed', `fixed by ${tk.id}: ${th.id} was signed off`, { refs: [tk.id] });
    }
  }

  /**
   * New work on a project thread after its build (code_review, final_review,
   * signoff or done) is code nobody has reviewed: the thread returns to build and
   * its build, code_review, final_review and signoff gates reset to pending.
   */
  _lateWorkSendBack(ctx, th, why) {
    if (th.kind !== 'project' || !LATE_PHASES.has(th.phase)) return;
    this._movePhase(ctx, th, 'build', { back: true, why });
  }

  /** Gates at or after phase `target` that are not pending (reset candidates). */
  _gatesFrom(th, target) {
    const ti = PROJECT_PHASES.indexOf(target);
    return GATES.filter((g) => isObject(th.gates?.[g]) && PROJECT_PHASES.indexOf(g) >= ti && th.gates[g].status !== 'pending');
  }

  /**
   * After accepted findings on review rv (PROTOCOL §7 rows 11-12):
   * - rv is still its gate's current review (the gate's ref), the thread is
   *   still in that gate and the verdict is not approve: back(g), as row 11.
   * - otherwise (an approve review, or one that a later review, a gate decision
   *   or a reset superseded): the tasks are new work; after the build that sends
   *   the thread back to build (row 12), earlier it changes no phase. A stale
   *   review never rewinds a thread to brief or design.
   */
  _sendBack(ctx, th, rv, why) {
    const g = rv.gate;
    const current = th.gates?.[g]?.ref === rv.id;
    if (!(current && th.phase === g && rv.verdict !== 'approve')) {
      this._lateWorkSendBack(ctx, th, why);
      return;
    }
    const target = BACK_TARGET[g];
    if (th.phase !== target) {
      this._movePhase(ctx, th, target, { back: true, why });
      return;
    }
    // Already in the target phase (back(brief) = brief): reset the gates so the owner reviews again.
    for (const gate of this._gatesFrom(th, target)) {
      const prev = th.gates[gate].status;
      const ev = this._event(ctx, th, 'gate', { gate, from: prev, to: 'pending' }, `${md.who(ctx.as)} reset the ${md.code(gate)} gate of ${md.title(th.title)} to pending — ${why}.`, { to: [th.lead] });
      th.gates[gate] = { ...th.gates[gate], status: 'pending', at: ev.ts, ref: ev.id };
    }
    th.updated = ctx.time;
    this._saveThread(th);
  }

  /**
   * The lead's answer to a review: one stance per point. Accepted points become
   * tasks; rejected and deferred points close their issues with a reason.
   */
  respond({ as, ref, review, stances, body } = {}) {
    this._actor(as);
    const { team, id } = this._resolveThreadRef(ref);
    return this._op(team, as, (ctx) => {
      const th = this._loadThread(team, id);
      this._requireProject(th, 'respond');
      const tref = this._refThread(th);
      if (as !== th.lead) fail('permission', `only the thread lead (${th.lead}) responds to reviews on ${tref}`);
      const msgs = this._teamMessages(team);
      const answered = new Set(msgs.filter((m) => m.type === 'review_response' && m.reply_to).map((m) => m.reply_to));
      let rv;
      if (review) {
        rv = msgs.find((m) => m.id === review);
        if (!rv) fail('not_found', `--review ${review}: no such message in team ${team}`);
        if (rv.type !== 'review') fail('usage', `${review} is a ${rv.type}, not a review`);
        if (rv.thread !== id) fail('usage', `review ${review} belongs to thread ${team}/${rv.thread}, not ${tref}`);
      } else {
        rv = msgs.filter((m) => m.thread === id && m.type === 'review' && !answered.has(m.id) && (asArray(m.points).length || m.verdict !== 'approve')).at(-1);
        if (!rv) fail('usage', `no review on ${tref} is waiting for a response; pass --review <msg-id>`);
      }
      if (answered.has(rv.id)) fail('conflict', `review ${rv.id} already has a response; each review gets one`);
      const st = normalizeStances(stances, rv);
      const issues = this._teamIssues(team).filter((i) => i.source === rv.id);
      const byPoint = new Map(issues.map((i) => [Number(i.point), i]));
      for (const s of st) if (!byPoint.has(s.point)) fail('invalid', `review ${rv.id} point ${s.point} has no issue file; run \`factory validate\``);
      const accepted = st.filter((s) => s.stance === 'accepted');
      const firstTask = this._nextNumber(team, 'tasks', TASK_ID_RE);
      const taskIds = accepted.map((_, i) => fmtId('T', firstTask + i));
      const v = rv.verdict;
      const reviewer = rv.from;
      const to = accepted.length === 0 && v !== 'approve' ? [reviewer] : [];
      const cc = to.length ? [] : [reviewer];
      const tally = STANCES.map((x) => [x, st.filter((s) => s.stance === x).length]).filter(([, n]) => n).map(([x, n]) => `${n} ${x}`);
      const text = String(body ?? '').trim() || `Response to ${reviewer} at ${rv.gate}: ${tally.join(', ') || 'no points'}.`;
      const msg = this._writeMessage(team, {
        thread: id, from: as, to, cc, type: 'review_response', reply_to: rv.id, resolves: [], refs: [...st.map((s) => byPoint.get(s.point).id), ...taskIds], internal: false,
        extra: { stances: st }, body: text,
      });
      const tasks = [];
      const changed = [];
      for (const s of st) {
        const issue = byPoint.get(s.point);
        if (s.stance === 'accepted') {
          const task = this._createTaskFile(ctx, th, {
            title: s.action || `Fix: ${issue.title}`,
            issue: issue.id,
            refs: [rv.id],
            body: `From ${issue.id} — point ${s.point} of the review by ${reviewer} at ${rv.gate} (${rv.id}):\n\n> ${String(issue.body).split('\n## History')[0].trim().split('\n').join('\n> ')}`,
          });
          tasks.push(task);
          changed.push(this._setIssueStatus(ctx, th, issue, 'accepted', `accepted in ${msg.id}; task ${task.id}`, { task: task.id, refs: [task.id, msg.id] }));
        } else {
          changed.push(this._setIssueStatus(ctx, th, issue, s.stance, `${s.stance} in ${msg.id}${s.reason ? `: ${s.reason}` : ''}`, { reason: s.reason ?? null, refs: [msg.id] }));
        }
      }
      if (accepted.length) this._sendBack(ctx, th, rv, `${md.who(as)} accepted ${plural(accepted.length, 'point')} from ${md.who(reviewer)} at ${rv.gate}`);
      return { message: msg, thread: this._loadThread(team, id), tasks, issues: changed };
    }, { ownMessage: true, ownThread: id });
  }

  /**
   * The lead's (or your) forward move where no gate owner decides:
   * design → design_review, plan → build, build → code_review.
   */
  advance({ as, ref, body } = {}) {
    this._actor(as);
    const { team, id } = this._resolveThreadRef(ref);
    return this._op(team, as, (ctx) => {
      const th = this._loadThread(team, id);
      if (th.kind === 'watch') fail('usage', `${team}/${id} is a watch thread; it moves with \`factory watch pause|resume\`, not advance`);
      if (th.kind !== 'project') fail('usage', `${team}/${id} is a single-agent thread; it has no phases to advance (ask its agent with a question)`);
      this._requireLeadOrYou(as, th, 'advance');
      const tref = this._refThread(th);
      const tasks = this._teamTasks(team).filter((x) => x.thread === id);
      const open = tasks.filter((x) => x.status !== 'done');
      const list = (xs) => xs.map((x) => `${x.id} (${x.status})`).join(', ');
      const note = String(body ?? '').trim();
      switch (th.phase) {
        case 'design':
          if (open.length) fail('conflict', `every task of ${tref} must be done before design review; open: ${list(open)}`);
          this._movePhase(ctx, th, 'design_review', { note });
          break;
        case 'plan':
          if (!open.length) fail('conflict', `plan → build needs at least one open task; add them with \`factory task new ${tref} --title <t>\``);
          this._movePhase(ctx, th, 'build', { note });
          break;
        case 'build':
          if (!tasks.length) fail('conflict', `${tref} has no tasks; build → code_review needs at least one task, all done`);
          if (open.length) fail('conflict', `build → code_review needs every task done; open: ${list(open)}`);
          this._approveBuildGate(ctx, th, note);
          break;
        default:
          fail('usage', this._howToMove(th));
      }
      return { thread: this._loadThread(team, id) };
    });
  }

  _howToMove(th) {
    const tref = this._refThread(th);
    const g = th.phase;
    if (REVIEW_GATES.includes(g)) {
      const owner = th.gates[g].by;
      return `${tref} is in ${g}; the ${g} gate moves by review: ${owner} runs \`factory review ${tref} --as ${owner} --verdict approve|changes_requested\` (you can override with \`factory decide ${tref} --gate ${g} --verdict approve --title <t> --as you\`)`;
    }
    if (g === 'done') return `${tref} is done; nothing to advance (record follow-up work with \`factory issue new ${tref}\` then \`factory issue accept\`, or \`factory decide ${tref}\`)`;
    return `${tref} is in ${g}; advance moves design → design_review, plan → build and build → code_review only`;
  }

  /** Approve the build gate (all tasks done) and enter code_review. */
  _approveBuildGate(ctx, th, note = '') {
    const prev = th.gates.build.status;
    const ev = this._event(ctx, th, 'gate', { gate: 'build', from: prev, to: 'approved' }, `Every task of ${md.title(th.title)} is done — the ${md.code('build')} gate is approved.`);
    th.gates.build = { ...th.gates.build, status: 'approved', at: ev.ts, ref: ev.id };
    this._movePhase(ctx, th, 'code_review', { note });
  }

  // ---- writes: tasks -------------------------------------------------------

  _createTaskFile(ctx, th, { title, issue = null, owner = null, refs = [], body }) {
    const task = this._createNumbered(th.team, 'tasks', 'T', TASK_ID_RE, 1, (tid) => ({
      data: { id: tid, title: oneLine(title), thread: th.id, status: 'todo', owner, issue, refs: uniq(refs), created: ctx.time, updated: ctx.time },
      body: ensureAcceptance(body, '_Describe the change._'),
    }));
    this._event(ctx, th, 'task_created', { task: task.id, ...(issue ? { issue } : {}) }, `${md.who(ctx.as)} created ${task.id} ${md.title(task.title)}${issue ? ` for ${issue}` : ''}.`, { refs: [task.id, ...(issue ? [issue] : [])] });
    return task;
  }

  _setTaskStatus(ctx, th, task, status, { owner, resolves = [], refs = [], note = '', reason } = {}) {
    const from = task.status;
    task.status = status;
    if (owner !== undefined) task.owner = owner;
    task.updated = ctx.time;
    this._saveTask(task);
    const text = `${md.who(ctx.as)} moved ${task.id} ${md.title(task.title)} from ${md.code(from)} to ${md.code(status)}${task.owner ? ` (owner ${md.who(task.owner)})` : ''}.${note ? `\n\n${note}` : ''}`;
    this._event(ctx, th, 'task_status', { task: task.id, from, to: status, owner: task.owner ?? null, ...(reason ? { reason } : {}) }, text, { resolves, refs: [task.id, ...refs] });
    return task;
  }

  /**
   * Done-task effects: its issue becomes fixed (a watch issue fixed through a
   * project thread waits for that thread's signoff instead); in build, the last
   * done task approves the build gate.
   */
  _afterTaskDone(ctx, th, task) {
    if (task.issue) {
      let issue = null;
      try {
        issue = this._loadIssue(th.team, task.issue);
      } catch {
        issue = null;
      }
      if (issue && issue.thread === th.id && ['open', 'accepted', 'deferred'].includes(issue.status)) {
        this._setIssueStatus(ctx, th, issue, 'fixed', `fixed by ${task.id}`, { refs: [task.id] });
      }
    }
    if (th.kind === 'project' && th.phase === 'build') {
      const tasks = this._teamTasks(th.team).filter((x) => x.thread === th.id);
      if (tasks.length && tasks.every((x) => x.status === 'done')) this._approveBuildGate(ctx, th);
    }
  }

  /**
   * Create a task on a project thread (lead or you); `issue` links and accepts a
   * manual or watch issue (the same path as issue accept). A task created after
   * the build sends the thread back to build (PROTOCOL §7 row 13).
   */
  createTask({ as, ref, title, body, owner, issue } = {}) {
    this._actor(as);
    const { team, id } = this._resolveThreadRef(ref);
    const name = oneLine(title);
    if (!name) fail('usage', 'the task needs a title: --title "<what to do>"');
    return this._op(team, as, (ctx) => {
      const th = this._loadThread(team, id);
      this._requireLeadOrYou(as, th, 'task new');
      if (owner) this._requireMembers([owner], '--owner');
      let linked = null;
      if (issue) {
        const ir = this._resolveItemRef(String(issue).includes('/') ? issue : `${team}/${issue}`, 'issue');
        if (ir.team !== team) fail('usage', `issue ${issue} is in team ${ir.team}; a task links an issue of its own team`);
        linked = this._loadIssue(ir.team, ir.id);
        this._checkIssueAcceptable(linked, this._loadThread(team, linked.thread));
        this._checkFixThread(linked, th);
      } else if (th.kind !== 'project') {
        fail('usage', `${this._refThread(th)} is a ${KIND_NAME[th.kind]} thread; ${KIND_NAME[th.kind]} threads hold no tasks. Put the work on a project thread (\`factory task new ${team}/<project-thread> --title <t>\`)`);
      }
      const task = this._createTaskFile(ctx, th, { title: name, issue: linked?.id ?? null, owner: owner || null, body: String(body ?? '').trim() || (linked ? `From ${linked.id}: ${linked.title}` : '') });
      if (linked) this._setIssueStatus(ctx, th, linked, 'accepted', `accepted; task ${task.id}${linked.thread !== id ? ` on ${id}` : ''}`, { task: task.id, refs: [task.id] });
      this._lateWorkSendBack(ctx, th, `${md.who(as)} added ${task.id}; the new work needs review`);
      return { task: this._loadTask(team, task.id), thread: this._loadThread(team, id) };
    });
  }

  _taskContext(as, taskRef) {
    this._actor(as);
    return this._resolveItemRef(taskRef, 'task');
  }

  _latestResult(team, taskId) {
    return this._teamMessages(team).filter((m) => m.type === 'result' && m.task === taskId).at(-1) ?? null;
  }

  /**
   * Assign a task to a builder (or the lead itself): owner set, status doing, dispatch message.
   * `eta` is the lead's estimate; without it, an estimate the task already has restarts now.
   */
  dispatch({ as, task, to, body, eta } = {}) {
    const { team, id } = this._taskContext(as, task);
    const minutes = eta == null || eta === '' ? null : etaMinutes(eta);
    return this._op(team, as, (ctx) => {
      const tk = this._loadTask(team, id);
      const th = this._loadThread(team, tk.thread);
      ctx.ownThread = th.id;
      this._requireLeadOrYou(as, th, 'dispatch');
      if (!to) fail('usage', `dispatch ${id} to whom? --to <builder> (${this.members().filter((m) => m.role === 'builder').map((m) => m.id).join(', ')})`);
      const target = this.members().find((m) => m.id === to);
      if (!target) fail('usage', `--to ${to} is not on the roster`);
      if (target.role !== 'builder' && to !== th.lead) fail('permission', `${id} can go to a builder (${this.members().filter((m) => m.role === 'builder').map((m) => m.id).join(', ')}) or the lead ${th.lead}; ${to} is a ${target.role}`);
      if (tk.status === 'done') fail('conflict', `${team}/${id} is done; create a follow-up task instead`);
      const text = String(body ?? '').trim() || `Please take **${tk.id}: ${tk.title}**.\n\n${String(tk.body ?? '').trim()}`;
      // Re-dispatching a task answers its latest result while someone still
      // holds a turn on it (blocked, failed, or done but never accepted): reply
      // to that result, which closes the lead's turn on it, and name it in
      // resolves when someone else (you) holds that turn open.
      const prev = this._latestResult(team, tk.id);
      const holders = prev ? openTurnPairs(this._teamMessages(team), this._threadMeta(team)).filter((p) => p.msg.id === prev.id).map((p) => p.member) : [];
      const answers = holders.length ? prev : null;
      const msg = this._writeMessage(team, {
        thread: th.id, from: as, to: [to], cc: [], type: 'dispatch', reply_to: answers?.id ?? null, resolves: answers && holders.some((m) => m !== as) ? [answers.id] : [],
        refs: [tk.id], internal: true, extra: { task: tk.id }, body: text,
      });
      this._restartTaskEta(ctx, tk, minutes);
      this._setTaskStatus(ctx, th, tk, 'doing', { owner: to, refs: [msg.id] });
      if (minutes != null) this._taskEtaEvent(ctx, th, tk);
      return { task: this._loadTask(team, id), message: msg };
    }, { ownMessage: true });
  }

  /**
   * The task owner's (or lead's) outcome. done → `review` until the lead runs
   * `task accept` (also when the lead reports its own task: PROTOCOL makes
   * `task accept` the only way to `done`); blocked/failed → `blocked`.
   * A lead's own result is addressed to nobody, so it opens no self-turn.
   */
  result({ as, task, outcome, body } = {}) {
    const { team, id } = this._taskContext(as, task);
    return this._op(team, as, (ctx) => {
      const tk = this._loadTask(team, id);
      const th = this._loadThread(team, tk.thread);
      ctx.ownThread = th.id;
      if (as !== tk.owner && as !== th.lead) fail('permission', `only the owner of ${id} (${tk.owner ?? 'nobody yet'}) or the lead (${th.lead}) reports its result`);
      if (!OUTCOMES.includes(outcome)) fail('usage', `--outcome must be done, blocked or failed (got "${outcome ?? ''}")`);
      if (tk.status === 'done') fail('conflict', `${team}/${id} is already done`);
      const mine = this._myOpenTurns(team, th.id, as);
      const replyTo = (mine.filter((m) => m.type === 'dispatch' && m.task === id).at(-1) ?? mine.at(-1))?.id ?? null;
      const byLead = as === th.lead;
      const text = String(body ?? '').trim() || `${tk.id} ${outcome}.`;
      const msg = this._writeMessage(team, { thread: th.id, from: as, to: byLead ? [] : [th.lead], cc: [], type: 'result', reply_to: replyTo, resolves: [], refs: [tk.id], internal: true, extra: { task: tk.id, outcome }, body: text });
      const status = outcome === 'done' ? 'review' : 'blocked';
      if (tk.eta) tk.eta = { ...tk.eta, ended: ctx.time };
      this._setTaskStatus(ctx, th, tk, status, { refs: [msg.id] });
      return { task: this._loadTask(team, id), message: msg, thread: this._loadThread(team, th.id) };
    }, { ownMessage: true });
  }

  /** Accept a task (lead or you): done; resolves the result message; may approve the build gate. */
  acceptTask({ as, task, body } = {}) {
    const { team, id } = this._taskContext(as, task);
    return this._op(team, as, (ctx) => {
      const tk = this._loadTask(team, id);
      const th = this._loadThread(team, tk.thread);
      this._requireLeadOrYou(as, th, 'task accept');
      if (tk.status === 'done') fail('conflict', `${team}/${id} is already done`);
      const res = this._latestResult(team, id);
      this._setTaskStatus(ctx, th, tk, 'done', { resolves: res ? [res.id] : [], refs: res ? [res.id] : [], note: String(body ?? '').trim() });
      this._afterTaskDone(ctx, th, tk);
      return { task: this._loadTask(team, id), thread: this._loadThread(team, th.id) };
    });
  }

  /** Send a task back to its owner (lead or you): doing again, with a dispatch carrying the reason. */
  rejectTask({ as, task, reason } = {}) {
    const { team, id } = this._taskContext(as, task);
    const why = String(reason ?? '').trim();
    if (!why) fail('usage', `say what is missing: factory task reject ${team}/${id} --reason "<text>"`);
    return this._op(team, as, (ctx) => {
      const tk = this._loadTask(team, id);
      const th = this._loadThread(team, tk.thread);
      ctx.ownThread = th.id;
      this._requireLeadOrYou(as, th, 'task reject');
      if (tk.status === 'done') fail('conflict', `${team}/${id} is done; create a follow-up task instead`);
      if (!tk.owner) fail('conflict', `${team}/${id} has no owner yet; dispatch it with \`factory dispatch ${team}/${id} --to <builder>\``);
      const res = this._latestResult(team, id);
      const msg = this._writeMessage(team, {
        thread: th.id, from: as, to: [tk.owner], cc: [], type: 'dispatch', reply_to: res?.id ?? null, resolves: [], refs: [tk.id], internal: true,
        extra: { task: tk.id }, body: `**${tk.id} needs more work:** ${why}`,
      });
      this._restartTaskEta(ctx, tk, null);
      this._setTaskStatus(ctx, th, tk, 'doing', { resolves: res ? [res.id] : [], refs: [msg.id, ...(res ? [res.id] : [])], reason: why });
      return { task: this._loadTask(team, id), message: msg };
    }, { ownMessage: true });
  }

  /** A new assignment (dispatch, rework) starts the estimate's clock now; `minutes` replaces it. */
  _restartTaskEta(ctx, tk, minutes) {
    if (minutes != null) tk.eta = { minutes, by: ctx.as, at: ctx.time };
    else if (tk.eta) tk.eta = { minutes: tk.eta.minutes, by: tk.eta.by, at: ctx.time };
  }

  _taskEtaEvent(ctx, th, tk) {
    const span = fmtDuration(tk.eta.minutes);
    const when = tk.status === 'doing' ? `${span} from now` : `${span} once it starts`;
    return this._event(ctx, th, 'eta', { task: tk.id, minutes: tk.eta.minutes }, `${md.who(ctx.as)} estimates ${tk.id} ${md.title(tk.title)}: ${when}.`, { refs: [tk.id] });
  }

  /** The time left on a task (todo: its length once started), by its owner, the lead or you (PROTOCOL §8, "Estimates"). */
  setTaskEta({ as, task, eta } = {}) {
    const { team, id } = this._taskContext(as, task);
    const minutes = etaMinutes(eta);
    return this._op(team, as, (ctx) => {
      const tk = this._loadTask(team, id);
      const th = this._loadThread(team, tk.thread);
      ctx.ownThread = th.id;
      if (as !== 'you' && as !== th.lead && as !== tk.owner) fail('permission', `the estimate for ${id} is for its owner (${tk.owner ?? 'nobody yet'}), the lead (${th.lead}) or you; ${as} cannot set it`);
      if (tk.status !== 'todo' && tk.status !== 'doing') fail('conflict', `${team}/${id} is ${tk.status}; only a task to do or in progress takes an estimate`);
      tk.eta = { minutes, by: as, at: ctx.time };
      tk.updated = ctx.time;
      this._saveTask(tk);
      const event = this._taskEtaEvent(ctx, th, tk);
      return { task: this._loadTask(team, id), event };
    });
  }

  /**
   * Estimates for a project thread's phases (PROTOCOL §7, "Estimates"): `eta` is
   * `phase=time[,phase=time]`. The current phase's value is the time left; a later
   * phase's is its length. The lead or you set any phase; a gate's owner its own gate.
   */
  setThreadEta({ as, ref, eta } = {}) {
    this._actor(as);
    const { team, id } = this._resolveThreadRef(ref);
    const items = String(eta ?? '').split(',').map((x) => x.trim()).filter(Boolean);
    if (!items.length) fail('usage', 'give each phase its estimate: --eta design=45m,plan=20m,build=3h');
    const est = {};
    for (const item of items) {
      const m = item.match(/^([a-z_]+)\s*=\s*(.+)$/);
      if (!m) fail('usage', `"${item}" is not <phase>=<time>, such as build=3h`);
      if (!ETA_PHASES.includes(m[1])) fail('usage', `"${m[1]}" is not a phase to estimate; the phases are ${ETA_PHASES.join(', ')}`);
      est[m[1]] = etaMinutes(m[2]);
    }
    return this._op(team, as, (ctx) => {
      const th = this._loadThread(team, id);
      ctx.ownThread = th.id;
      if (th.kind !== 'project') fail('usage', `${team}/${id} is a ${th.kind === 'solo' ? 'single-agent' : th.kind} thread; only project threads have phases to estimate`);
      const here = PROJECT_PHASES.indexOf(th.phase);
      for (const p of Object.keys(est)) {
        if (PROJECT_PHASES.indexOf(p) < here) fail('conflict', `${p} is behind ${team}/${id}, which is in ${th.phase}; estimate the current phase or a later one`);
        if (OPTIONAL_GATES.includes(p) && !isObject(th.gates?.[p])) fail('usage', `${team}/${id} has no ${p} gate: nobody was picked for it`);
        if (as !== 'you' && as !== th.lead && th.gates?.[p]?.by !== as) {
          fail('permission', `the estimate for ${p} is for the lead (${th.lead}), you${th.gates?.[p] ? ` or the gate's owner (${th.gates[p].by})` : ''}; ${as} cannot set it`);
        }
      }
      const next = { ...(th.eta || {}) };
      for (const [p, minutes] of Object.entries(est)) next[p] = { minutes, by: as, at: ctx.time };
      th.eta = Object.fromEntries(ETA_PHASES.filter((p) => next[p]).map((p) => [p, next[p]]));
      th.updated = ctx.time;
      this._saveThread(th);
      const list = ETA_PHASES.filter((p) => p in est).map((p) => `${p} ${fmtDuration(est[p])}${p === th.phase ? ' left' : ''}`).join(' · ');
      const event = this._event(ctx, th, 'eta', { estimates: est }, `${md.who(as)} estimated ${md.title(th.title)}: ${list}.`);
      return { thread: this._loadThread(team, id), event };
    });
  }

  /**
   * Whether `as` may merge the thread's PR now (`factory merge`, PROTOCOL §15):
   * the lead or `you`, on a project thread `you` signed off. Returns the branch
   * and when it was signed off; the CLI checks the PR itself with gh.
   */
  mergeCheck({ as, ref } = {}) {
    this._actor(as);
    const { team, id } = this._resolveThreadRef(ref);
    const th = this._loadThread(team, id);
    if (th.kind !== 'project') fail('usage', `${team}/${id} is a ${th.kind === 'solo' ? 'single-agent' : th.kind} thread; only a project thread has a branch to merge`);
    if (as !== 'you' && as !== th.lead) fail('permission', `merging ${team}/${id} is for its lead (${th.lead}) or you; ${as} cannot`);
    const so = th.gates?.signoff;
    if (th.phase !== 'done' || so?.status !== 'approved' || !so.at) fail('conflict', `${team}/${id} is in ${th.phase}; its PR merges only after you sign it off`);
    return { team, id, branch: th.branch, lead: th.lead, signedOffAt: so.at };
  }

  /** Record a merged PR (`factory merge`): a `merged` event, copied to `you`. */
  recordMerge({ as, ref, pr, url, commit = null, outside = false } = {}) {
    this._actor(as);
    const { team, id } = this._resolveThreadRef(ref);
    if (!Number.isInteger(pr) || !/^https:\/\/\S+$/.test(String(url || ''))) fail('usage', 'a merge needs the PR number and URL');
    return this._op(team, as, (ctx) => {
      const th = this._loadThread(team, id);
      ctx.ownThread = th.id;
      const sha = commit ? ` as ${md.code(String(commit).slice(0, 9))}` : '';
      const lead = outside
        ? `[PR #${pr}](${url}) for ${md.title(th.title)} was merged outside the factory; ${md.who(as)} recorded it. It is in ${md.code('main')}${sha}`
        : `${md.who(as)} merged ${md.title(th.title)}: [PR #${pr}](${url}) is in ${md.code('main')}${sha}`;
      const event = this._event(ctx, th, 'merged', { pr, url, commit, ...(outside ? { outside: true } : {}) }, `${lead} and ships with the next release.`, { cc: ['you'] });
      return { thread: th, event };
    });
  }

  // ---- writes: issues ------------------------------------------------------

  _createIssueFile(ctx, th, { title, gate = null, source = null, point = null, severity, metric = null, body, note, refs = [] }) {
    const issue = this._createNumbered(th.team, 'issues', 'I', ISSUE_ID_RE, 1, (iid) => ({
      data: {
        id: iid, title: oneLine(title), thread: th.id, gate, source, point, severity, status: 'open', raised_by: ctx.as,
        task: null, metric, reason: null, created: ctx.time, updated: ctx.time,
      },
      body: appendHistory(String(body ?? '').trim() || oneLine(title), `- ${ctx.time} open by ${ctx.as}: ${note}`),
    }));
    this._event(ctx, th, 'issue_created', { issue: issue.id, severity, ...(gate ? { gate } : {}), ...(metric ? { metric } : {}) },
      `${md.who(ctx.as)} raised ${issue.id} (${severity}) on ${md.title(th.title)}: ${issue.title}`, { refs: [issue.id, ...refs] });
    return issue;
  }

  /** Change an issue's status; the issue_status event goes to the issue's own thread (th, or the watch thread it lives in). */
  _setIssueStatus(ctx, th, issue, status, note, { task, reason, refs = [] } = {}) {
    if (issue.thread !== th.id) th = this._loadThread(th.team, issue.thread);
    const from = issue.status;
    issue.status = status;
    if (task !== undefined) issue.task = task;
    if (reason !== undefined) issue.reason = reason;
    issue.updated = ctx.time;
    issue.body = appendHistory(issue.body, `- ${ctx.time} ${status === 'open' && from !== 'open' ? 'reopened' : status} by ${ctx.as}: ${note}`);
    this._saveIssue(issue);
    const label = status === 'open' ? 'reopened' : status;
    let taskText = '';
    if (issue.task && status === 'accepted') {
      // A watch issue's task lives on a project thread: say which one.
      let taskThread = null;
      try { taskThread = this._loadTask(th.team, issue.task).thread; } catch { taskThread = null; }
      taskText = ` → ${issue.task}${taskThread && taskThread !== th.id ? ` on ${taskThread}` : ''}`;
    }
    // Nothing verifies a single-agent thread's fixed issue on its own: the owner asks its agent once the fix ships.
    const askVerify = th.kind === 'solo' && status === 'fixed';
    this._event(ctx, th, 'issue_status', { issue: issue.id, from, to: status, ...(issue.task ? { task: issue.task } : {}) },
      `${md.who(ctx.as)} marked ${issue.id} ${md.code(label)}${taskText}: ${issue.title}${askVerify ? `. Once it ships, ask ${th.owner} here to check it (it runs \`verify\`).` : ''}`,
      { refs: [issue.id, ...refs], ...(askVerify ? { to: ['you'] } : {}) });
    return issue;
  }

  /**
   * The review an issue is waiting on: a review point (point set, source a review)
   * whose review has no response yet. Such issues are answered with `respond`;
   * every other issue (manual, watch, a review point already answered and later
   * reopened) is triaged with issue accept, reject or defer.
   */
  _pendingReviewOf(issue) {
    if (issue.point == null || !MESSAGE_ID_RE.test(String(issue.source ?? ''))) return null;
    const src = this._findMessage(issue.source);
    if (!src || src.type !== 'review' || src.team !== issue.team) return null;
    const answered = this._teamMessages(issue.team).some((m) => m.type === 'review_response' && m.reply_to === src.id);
    return answered ? null : src;
  }

  _checkIssueAcceptable(issue, th) {
    const iref = `${issue.team}/${issue.id}`;
    const rv = issue.status === 'open' ? this._pendingReviewOf(issue) : null;
    if (rv) {
      fail('usage', `${iref} is point ${issue.point} of review ${rv.id} at ${rv.gate}, which has no response yet; answer it with \`factory respond ${this._refThread(th)} --review ${rv.id} --stance "${issue.point}=accepted"\``);
    }
    if (!['open', 'deferred', 'rejected'].includes(issue.status)) fail('conflict', `${iref} is ${issue.status}${issue.task ? ` (task ${issue.task})` : ''}; only open, deferred or rejected issues can be accepted`);
  }

  /**
   * Where the task for issue `issue` may live: its own project thread, or — for a
   * watch issue — a project thread of the same team that is past its design, so
   * the fix is built on a branch and reviewed at code_review, final_review and
   * signoff before a watch run can verify it.
   */
  _checkFixThread(issue, target) {
    const iref = `${issue.team}/${issue.id}`;
    const tref = this._refThread(target);
    if (target.kind !== 'project') {
      fail('usage', `${tref} is a ${KIND_NAME[target.kind]} thread; ${KIND_NAME[target.kind]} threads hold no tasks. Fix ${iref} on a project thread, so its code is reviewed before a run verifies it: \`factory issue accept ${iref} --thread ${issue.team}/<project-thread>\` (or \`factory task new ${issue.team}/<project-thread> --issue ${issue.id}\`; start one with \`factory thread new\`)`);
    }
    if (issue.thread === target.id) return;
    const own = this._loadThread(issue.team, issue.thread);
    if (own.kind === 'project') {
      fail('usage', `${iref} belongs to ${this._refThread(own)}; its task goes on that thread, not on ${tref}`);
    }
    if (!FIX_PHASES.has(target.phase)) {
      fail('conflict', `${tref} is in ${target.phase}; a fix for ${iref} needs a project thread in plan or later (its brief approved and design settled), or start a new one with \`factory thread new\``);
    }
  }

  _issueContext(as, issueRef) {
    this._actor(as);
    return this._resolveItemRef(issueRef, 'issue');
  }

  /** Raise a manual issue (any thread member). */
  createIssue({ as, ref, severity, title, body, source, metric } = {}) {
    this._actor(as);
    const { team, id } = this._resolveThreadRef(ref);
    if (!SEVERITIES.includes(severity)) fail('usage', `--severity must be one of ${SEVERITIES.join(', ')} (got "${severity ?? ''}")`);
    const name = oneLine(title);
    if (!name) fail('usage', 'the issue needs a title: --title "<what is wrong>"');
    return this._op(team, as, (ctx) => {
      const th = this._loadThread(team, id);
      this._requireParticipant(as, th, 'raise issues');
      const issue = this._createIssueFile(ctx, th, {
        title: name, source: source ? String(source) : null, severity, metric: metric ? String(metric) : null,
        body: String(body ?? '').trim() || name, note: source ? `raised from ${source}` : 'raised manually',
      });
      return { issue };
    });
  }

  /**
   * Accept a manual or watch issue (lead or you): creates its task; on a project
   * thread in code_review/final_review/signoff the thread returns to build.
   */
  acceptIssue({ as, issue, action, thread } = {}) {
    const { team, id } = this._issueContext(as, issue);
    return this._op(team, as, (ctx) => {
      const is = this._loadIssue(team, id);
      const own = this._loadThread(team, is.thread);
      let th = own;
      if (thread != null && String(thread).trim() !== '') {
        const r = this._resolveThreadRef(String(thread).includes('/') ? thread : `${team}/${thread}`);
        if (r.team !== team) fail('usage', `--thread ${thread} is in team ${r.team}; ${team}/${id} is fixed on a thread of team ${team}`);
        th = this._loadThread(team, r.id);
      }
      this._requireLeadOrYou(as, own, 'issue accept');
      if (th.id !== own.id) this._requireLeadOrYou(as, th, 'issue accept');
      this._checkIssueAcceptable(is, own);
      this._checkFixThread(is, th);
      const task = this._createTaskFile(ctx, th, {
        title: oneLine(action) || `Fix: ${is.title}`, issue: is.id, refs: is.source && MESSAGE_ID_RE.test(is.source) ? [is.source] : [],
        body: `From ${is.id} (${is.severity}${is.metric ? `, metric ${is.metric}` : ''}${th.id !== own.id ? `, ${own.kind === 'watch' ? 'watch' : 'single-agent thread'} ${own.id}` : ''}):\n\n> ${String(is.body).split('\n## History')[0].trim().split('\n').join('\n> ')}`,
      });
      this._setIssueStatus(ctx, th, is, 'accepted', `accepted; task ${task.id}${th.id !== own.id ? ` on ${th.id}` : ''}`, { task: task.id, refs: [task.id] });
      this._lateWorkSendBack(ctx, th, `${md.who(as)} accepted ${is.id}; the fix needs review`);
      return { issue: this._loadIssue(team, id), task: this._loadTask(team, task.id), thread: this._loadThread(team, th.id) };
    });
  }

  _closeIssue(as, issueRef, status, reason) {
    const { team, id } = this._issueContext(as, issueRef);
    return this._op(team, as, (ctx) => {
      const is = this._loadIssue(team, id);
      const th = this._loadThread(team, is.thread);
      this._requireLeadOrYou(as, th, `issue ${status === 'rejected' ? 'reject' : 'defer'}`);
      const rv = is.status === 'open' ? this._pendingReviewOf(is) : null;
      if (rv) {
        fail('usage', `${team}/${id} is point ${is.point} of review ${rv.id} at ${rv.gate}, which has no response yet; answer it with \`factory respond ${this._refThread(th)} --review ${rv.id} --stance "${is.point}=${status}: <reason>"\``);
      }
      if (!['open', 'accepted', 'deferred'].includes(is.status) || is.status === status) {
        fail('conflict', `${team}/${id} is ${is.status}; only open, accepted or deferred issues can be ${status}`);
      }
      const why = String(reason ?? '').trim() || null;
      this._setIssueStatus(ctx, th, is, status, why || status, { reason: why });
      return { issue: this._loadIssue(team, id) };
    });
  }

  /** Reject an issue with a reason (lead or you). */
  rejectIssue({ as, issue, reason } = {}) {
    if (!String(reason ?? '').trim()) fail('usage', 'say why: --reason "<text>"');
    return this._closeIssue(as, issue, 'rejected', reason);
  }

  /** Defer an issue, optionally with a reason (lead or you). */
  deferIssue({ as, issue, reason } = {}) {
    return this._closeIssue(as, issue, 'deferred', reason);
  }

  /** Manual production check of a fixed issue: pass → verified, fail → open. Watch owner, lead or you. */
  verifyIssue({ as, issue, pass, note } = {}) {
    const { team, id } = this._issueContext(as, issue);
    if (typeof pass !== 'boolean') fail('usage', 'say whether it held in production: --pass or --fail');
    return this._op(team, as, (ctx) => {
      const is = this._loadIssue(team, id);
      const th = this._loadThread(team, is.thread);
      if (as !== 'you' && as !== th.lead && !(th.kind !== 'project' && as === th.owner)) {
        fail('permission', `verify on ${this._refThread(th)} is for ${[th.kind !== 'project' ? th.owner : null, th.lead, 'you'].filter(Boolean).join(', ')}; ${as} cannot do it`);
      }
      if (is.status !== 'fixed') fail('conflict', `${team}/${id} is ${is.status}; only fixed issues can be verified`);
      const text = String(note ?? '').trim();
      this._setIssueStatus(ctx, th, is, pass ? 'verified' : 'open', `${pass ? 'verified in production' : 'failed production verification'}${text ? `: ${text}` : ''}`);
      return { issue: this._loadIssue(team, id) };
    });
  }

  // ---- writes: decisions ---------------------------------------------------

  /**
   * Record a decision (you or the lead): decision message + decisions.md entry.
   * With `gate`/`verdict` (you only, while the thread is in that gate) it applies
   * the same effects as a review with that verdict and no points.
   */
  decide({ as, ref, title, body, resolves, refs, gate, verdict, reply_to } = {}) {
    this._actor(as);
    const { team, id } = this._resolveThreadRef(ref);
    const name = oneLine(title);
    if (!name) fail('usage', 'the decision needs a title: --title "<what was decided>"');
    return this._op(team, as, (ctx) => {
      const th = this._loadThread(team, id);
      const tref = this._refThread(th);
      if (gate) {
        if (as !== 'you') fail('permission', `only you can decide a gate (--gate ${gate}); ${as} can post an escalation to you instead`);
        this._requireProject(th, 'decide --gate');
        if (!REVIEW_GATES.includes(gate)) fail('usage', `--gate must be one of ${REVIEW_GATES.join(', ')}`);
        if (verdict !== 'approve' && verdict !== 'changes_requested') fail('usage', '--gate needs --verdict approve or changes_requested');
        if (th.phase !== gate) fail('permission', `${tref} is in ${th.phase}, not ${gate}; a gate decision applies only while the thread is in that gate`);
        if (verdict === 'approve') this._checkApprovable(th, gate, { override: true });
      } else {
        if (verdict) fail('usage', '--verdict needs --gate <gate>');
        if (th.kind === 'solo' && as !== 'you') fail('permission', `only you record decisions on the single-agent thread ${tref}; ${as} can post a note or a question to you there instead`);
        this._requireLeadOrYou(as, th, 'decide');
      }
      const replyTo = this._checkReplyTo(reply_to ?? null, team);
      let wanted = uniq(toList(resolves));
      // Replying to a turn someone else holds (an escalation to you, answered by the lead) also closes it.
      if (replyTo) {
        const target = this._findMessage(replyTo);
        if (target && asArray(target.to).some((x) => x !== as)) wanted = uniq([...wanted, replyTo]);
      }
      // A gate decision settles the escalations you hold in this thread, the
      // notification that put the thread in that gate, and the requests for the
      // gate owner's review (proposals, review responses): the gate owner's turn
      // to review is moot once you have decided the gate.
      if (gate) {
        const reviewer = th.gates?.[gate]?.by;
        const settled = openTurnPairs(this._teamMessages(team), this._threadMeta(team))
          .filter((p) => p.msg.thread === id && p.msg.id !== replyTo)
          .filter((p) => (p.member === as && p.msg.type === 'escalation') || (p.msg.type === 'event' && p.msg.event?.kind === 'phase' && p.msg.event?.to === gate)
            || (reviewer && reviewer !== as && p.member === reviewer && ['proposal', 'review_response'].includes(p.msg.type)))
          .map((p) => p.msg.id);
        wanted = uniq([...wanted, ...settled]);
      }
      const res = this._checkResolves(wanted, as, team);
      const rf = this._checkRefs(team, uniq(toList(refs)));
      const existing = this.decisions(team);
      const did = fmtId('D', existing.length ? Math.max(...existing.map((d) => idNumber(d.id))) + 1 : 1);
      const text = String(body ?? '').trim() || name;
      const msg = this._writeMessage(team, {
        thread: id, from: as, to: gate && verdict === 'changes_requested' ? [th.lead] : [], cc: [], type: 'decision', reply_to: replyTo, resolves: res, refs: rf, internal: false,
        extra: { decision: did, ...(gate ? { gate, verdict } : {}) }, body: text,
      });
      // Escape every body line that starts like a decision heading, so the
      // append-only file never holds a line validate rejects.
      const entryBody = text.split('\n').map((l) => (/^## D-/.test(l) ? `\\${l}` : l)).join('\n');
      const entry = [
        '', `## ${did}: ${name}`, '', `- ts: ${msg.ts}`, `- by: ${as}`, `- thread: ${id}`, `- message: ${msg.id}`, `- resolves: [${res.join(', ')}]`,
        ...(gate ? [`- gate: ${gate} ${verdict}`] : []), '', entryBody, '',
      ].join('\n');
      appendLine(path.join(this._teamDir(team), 'decisions.md'), entry);
      this._event(ctx, th, 'decision', { decision: did, ...(gate ? { gate, verdict } : {}) }, `${md.who(as)} recorded ${did} ${md.title(name)}${gate ? ` (${md.code(gate)} ${verdict})` : ''}.`, { refs: [did, msg.id] });
      if (gate) {
        this._setGate(ctx, th, gate, GATE_STATUS_OF[verdict], msg);
        if (verdict === 'approve') this._approveGateEffects(ctx, th, gate, as);
      }
      const decision = this.decisions(team).find((d) => d.id === did);
      return { decision, message: msg, thread: this._loadThread(team, id) };
    }, { ownMessage: true, ownThread: id });
  }

  // ---- writes: watch threads -----------------------------------------------

  _runEval(team) {
    const t = this.team(team);
    if (!t.eval_cmd) fail('usage', `team ${team} has no eval_cmd in teams/${team}/team.md; set it, or pass --metrics '<json>'`);
    let out;
    try {
      out = execSync(t.eval_cmd, { cwd: this.root, encoding: 'utf8', timeout: EVAL_TIMEOUT_MS, stdio: ['ignore', 'pipe', 'pipe'], maxBuffer: 64 * 1024 * 1024 });
    } catch (e) {
      const why = e.signal ? `killed by ${e.signal}${e.signal === 'SIGTERM' ? ' (10 min timeout?)' : ''}` : `exit ${e.status}`;
      const tail = (s, n) => String(s || '').trim().split('\n').slice(-n).join(' | ');
      const detail = [tail(e.stderr, 5) && `stderr: ${tail(e.stderr, 5)}`, tail(e.stdout, 3) && `stdout: ${tail(e.stdout, 3)}`].filter(Boolean).join('; ') || 'it printed nothing';
      return fail('invalid', `eval_cmd \`${t.eval_cmd}\` failed (${why}); ${detail}`);
    }
    // The last stdout line that starts with "{" is the result. It must parse: an
    // earlier JSON line is never used instead (that would turn a NaN breach into an ok run).
    const line = out.split('\n').map((x) => x.trim().replace(/^\uFEFF/, '')).filter((x) => x.startsWith('{')).at(-1);
    if (line === undefined) return fail('invalid', `eval_cmd \`${t.eval_cmd}\` printed no line starting with "{"; its last such line must be {"metric": number} or {"metrics": {...}}`);
    let v;
    try {
      v = JSON.parse(line);
    } catch (e) {
      const nonJson = /\b(NaN|-?Infinity)\b/.test(line) ? '; NaN and Infinity are not JSON numbers, so print null or leave the metric out' : '';
      return fail('invalid', `eval_cmd's last JSON line is not valid JSON (${e.message})${nonJson}: ${truncate(line, 200)}`);
    }
    if (!isObject(v)) return fail('invalid', `eval_cmd's last JSON line is not an object: ${truncate(line, 200)}`);
    return normalizeMetrics(v, 'invalid');
  }

  _freeReportPath(team, threadId, ts) {
    const base = `reports/${threadId}-${stampOf(ts)}`;
    const dir = this._teamDir(team);
    if (!fs.existsSync(path.join(dir, `${base}.md`))) return `${base}.md`;
    for (let n = 2; ; n++) if (!fs.existsSync(path.join(dir, `${base}-${n}.md`))) return `${base}-${n}.md`;
  }

  /**
   * One watch run (watch owner or lead): measure, append metrics.jsonl, write the
   * report, open issues on breaches, verify or reopen fixed issues, post the report.
   */
  watchRun({ as, ref, metrics, from, to, note, exec } = {}) {
    this._actor(as);
    const { team, id } = this._resolveThreadRef(ref);
    const pre = this._loadThread(team, id);
    const tref = this._refThread(pre);
    if (pre.kind !== 'watch') fail('usage', `${tref} is a ${KIND_NAME[pre.kind]} thread; \`watch run\` only applies to watch threads`);
    if (as !== pre.owner && as !== pre.lead) fail('permission', `watch runs on ${tref} are for its owner (${pre.owner}) or lead (${pre.lead}); ${as} cannot run it`);
    if (pre.phase === 'paused') fail('conflict', `${tref} is paused; resume it with \`factory watch resume ${tref}\` first`);
    if (exec && metrics != null) fail('usage', 'give --metrics or --exec, not both');
    if (!exec && metrics == null) fail('usage', "measure something: --metrics '<json>', --metrics-file <f> or --exec (runs the team's eval_cmd)");
    if (from != null && !isIso(from)) fail('usage', `--from must be an ISO-8601 UTC timestamp (got "${from}")`);
    if (to != null && !isIso(to)) fail('usage', `--to must be an ISO-8601 UTC timestamp (got "${to}")`);
    const measured = exec ? this._runEval(team) : normalizeMetrics(metrics);
    return this._op(team, as, (ctx) => {
      const th = this._loadThread(team, id);
      if (th.phase === 'paused') fail('conflict', `${tref} was paused while measuring; resume it and run again`);
      const runTs = this._nextTs();
      const prev = this._metricRows(team).filter((r) => r.thread === id).at(-1);
      const window = { from: from ?? prev?.window?.to ?? th.created, to: to ?? runTs };
      const evals = evaluateThresholds(measured, th.thresholds || {});
      const breaches = evals.filter((e) => e.status === 'breach');
      const status = breaches.length ? 'breach' : 'ok';
      const reportRel = this._freeReportPath(team, id, runTs);
      const metricIssues = this._teamIssues(team).filter((i) => i.thread === id && i.metric);

      const plan = { opened: [], reopened: [], verified: [], tracked: [], recovered: [] };
      let nextI = this._nextNumber(team, 'issues', ISSUE_ID_RE);
      for (const e of breaches) {
        const fixed = metricIssues.filter((i) => i.metric === e.metric && i.status === 'fixed');
        const live = metricIssues.find((i) => i.metric === e.metric && (i.status === 'open' || i.status === 'accepted'));
        for (const i of fixed) plan.reopened.push({ issue: i, e });
        if (live) plan.tracked.push({ issue: live, e });
        if (!live && !fixed.length) plan.opened.push({ id: fmtId('I', nextI++), e });
      }
      for (const i of metricIssues.filter((x) => x.status === 'fixed')) {
        const e = evals.find((x) => x.metric === i.metric);
        if (e && e.status === 'ok') plan.verified.push({ issue: i, e });
      }
      // Open or accepted issues whose metric is back within threshold: nothing verified a
      // fix, so they stay as they are and the report asks the lead to triage them.
      for (const i of metricIssues.filter((x) => x.status === 'open' || x.status === 'accepted')) {
        const e = evals.find((x) => x.metric === i.metric);
        if (e && e.status === 'ok') plan.recovered.push({ issue: i, e });
      }

      appendLine(path.join(this._teamDir(team), 'metrics.jsonl'), JSON.stringify({
        ts: runTs, thread: id, window, metrics: measured, breaches: breaches.map((e) => e.metric), report: reportRel, by: as,
      }));
      writeAtomic(path.join(this._teamDir(team), reportRel), stringifyFrontmatter({
        thread: id, ts: runTs, by: as, window, status, metrics: measured, breaches: breaches.map((e) => e.metric),
        opened: plan.opened.map((o) => o.id), verified: plan.verified.map((v) => v.issue.id), reopened: plan.reopened.map((r) => r.issue.id),
        recovered: plan.recovered.map((r) => r.issue.id),
      }, this._reportBody(th, { runTs, by: as, window, status, evals, plan, note })));

      const alert = (issue, e) => this._writeMessage(team, {
        thread: id, from: as, to: [th.lead], cc: [], type: 'alert', reply_to: null, resolves: [], refs: [issue.id], internal: false,
        extra: { metric: e.metric, value: e.value, threshold: e.threshold, issue: issue.id },
        body: `**${breachText(e)}** in ${md.title(th.title)} — ${issue.id} is ${issue.status === 'open' && plan.reopened.some((r) => r.issue.id === issue.id) ? 'reopened' : 'open'}. Report: ${reportRel}`,
      });
      const alerts = [];
      const opened = [];
      for (const o of plan.opened) {
        const issue = this._createIssueFile(ctx, th, {
          title: truncate(breachText(o.e), 80), source: reportRel, severity: o.e.excess > 0.5 ? 'high' : 'medium', metric: o.e.metric,
          body: `${md.code(o.e.metric)} measured **${o.e.value}** (${formatThreshold(o.e.threshold)}) in the window ${window.from} → ${window.to}. Report: ${reportRel}`,
          note: `breach in ${reportRel}`,
        });
        opened.push(issue);
        alerts.push(alert(issue, o.e));
      }
      const reopened = [];
      for (const r of plan.reopened) {
        const fixNote = r.issue.task ? `; ${r.issue.task} fixed it on paper — if that fix is not deployed yet, defer the issue instead of accepting it again` : '';
        const issue = this._setIssueStatus(ctx, th, r.issue, 'open', `still ${breachText(r.e)} in ${reportRel}${fixNote}`, { refs: [] });
        reopened.push(issue);
        alerts.push(alert(issue, r.e));
      }
      const verified = plan.verified.map((v) => this._setIssueStatus(ctx, th, v.issue, 'verified', `${v.e.metric} ${v.e.value} within threshold (${formatThreshold(v.e.threshold)}) in ${reportRel}`));

      const breachList = breaches.map(breachText).join('; ');
      const changes = [
        opened.length ? `opened ${opened.map((x) => x.id).join(', ')}` : '',
        reopened.length ? `reopened ${reopened.map((x) => x.id).join(', ')}` : '',
        verified.length ? `verified ${verified.map((x) => x.id).join(', ')}` : '',
        plan.tracked.length ? `already tracked: ${plan.tracked.map((x) => x.issue.id).join(', ')}` : '',
        plan.recovered.length ? `recovered without a verified fix — triage: ${plan.recovered.map((x) => x.issue.id).join(', ')}` : '',
      ].filter(Boolean).join('; ');
      const reportText = `${md.title(th.title)}: **${status}**${breachList ? ` — ${breachList}` : ''}${changes ? ` (${changes})` : ''}. Report: ${reportRel}${note ? `\n\n${String(note).trim()}` : ''}`;
      const reportMsg = this._writeMessage(team, {
        thread: id, from: as, to: status === 'breach' ? [th.lead] : [], cc: ['you'], type: 'report', reply_to: null, resolves: [],
        refs: uniq([...opened, ...reopened, ...verified].map((x) => x.id)), internal: false, extra: { report: reportRel, status }, body: reportText,
      });
      th.last_run = runTs;
      th.updated = ctx.time;
      this._saveThread(th);
      this._event(ctx, th, 'watch_run', { status, breaches: breaches.map((e) => e.metric), report: reportRel },
        `${md.who(as)} ran ${md.title(th.title)}: ${md.code(status)}${breaches.length ? ` on ${breaches.map((e) => e.metric).join(', ')}` : ''}.`, { refs: [reportMsg.id] });
      const row = this._metricRows(team).filter((r) => r.thread === id).at(-1);
      return {
        run: row,
        report: { file: reportRel, path: `teams/${team}/${reportRel}`, status, ts: runTs },
        message: reportMsg,
        alerts,
        issues: { opened, reopened, verified, tracked: plan.tracked.map((x) => x.issue), recovered: plan.recovered.map((x) => x.issue) },
        thread: this._loadThread(team, id),
      };
    }, { ownMessage: true, ownThread: id });
  }

  _reportBody(th, { runTs, by, window, status, evals, plan, note }) {
    const when = `${runTs.slice(0, 10)} ${runTs.slice(11, 19)} UTC`;
    const rows = evals.map((e) => `| ${e.metric} | ${e.value ?? '—'} | ${formatThreshold(e.threshold)} | ${e.status === 'none' ? '—' : e.status} |`);
    const list = (items, fmt) => (items.length ? items.map(fmt).join('\n') : '_None._');
    return [
      `# ${th.title} — ${when}`,
      '',
      `**Status: ${status}** · window ${window.from} → ${window.to} · run by **${by}**`,
      '',
      '| metric | value | threshold | status |',
      '|---|---|---|---|',
      ...rows,
      '',
      '## Opened issues',
      '',
      list(plan.opened, (o) => `- ${o.id} (${o.e.excess > 0.5 ? 'high' : 'medium'}) ${breachText(o.e)}`),
      '',
      '## Verified issues',
      '',
      list(plan.verified, (v) => `- ${v.issue.id} ${v.issue.title} — ${v.e.metric} ${v.e.value} is within ${formatThreshold(v.e.threshold)}`),
      '',
      '## Reopened issues',
      '',
      list(plan.reopened, (r) => `- ${r.issue.id} ${r.issue.title} — ${breachText(r.e)}`),
      ...(plan.tracked.length ? ['', '## Already tracked', '', list(plan.tracked, (x) => `- ${x.issue.id} (${x.issue.status}) ${x.issue.title}`)] : []),
      '',
      '## Recovered without a verified fix — triage',
      '',
      list(plan.recovered, (r) => `- ${r.issue.id} (${r.issue.status}) ${r.issue.title} — ${r.e.metric} ${r.e.value} is within ${formatThreshold(r.e.threshold)}: recovered without a verified fix — triage`),
      '',
      '## Note',
      '',
      String(note ?? '').trim() || '_None._',
      '',
    ].join('\n');
  }

  /** Pause or resume a watch thread (lead or you). @param {{state: 'active'|'paused'}} args */
  setWatchState({ as, ref, state } = {}) {
    this._actor(as);
    if (!WATCH_PHASES.includes(state)) fail('usage', `state must be active or paused (got "${state ?? ''}")`);
    const { team, id } = this._resolveThreadRef(ref);
    return this._op(team, as, (ctx) => {
      const th = this._loadThread(team, id);
      const tref = this._refThread(th);
      if (th.kind !== 'watch') fail('usage', `${tref} is a ${KIND_NAME[th.kind]} thread; only watch threads pause and resume`);
      this._requireLeadOrYou(as, th, state === 'paused' ? 'watch pause' : 'watch resume');
      if (th.phase === state) fail('conflict', `${tref} is already ${state}`);
      const from = th.phase;
      th.phase = state;
      th.updated = ctx.time;
      this._saveThread(th);
      this._event(ctx, th, 'watch_state', { from, to: state }, `${md.who(as)} ${state === 'paused' ? 'paused' : 'resumed'} the watch ${md.title(th.title)}.`);
      return { thread: this._loadThread(team, id) };
    });
  }

  // ---- validate ------------------------------------------------------------

  /**
   * Check every file under the root against the contract.
   * @returns {{ok: boolean, errors: {file: string, message: string}[], warnings: {file: string, message: string}[]}}
   */
  validate() {
    const errors = [];
    const warnings = [];
    const E = (file, message) => errors.push({ file, message });
    const W = (file, message) => warnings.push({ file, message });
    const roster = this._validateRoster(E);
    const memberIds = new Set(roster.map((m) => m.id));
    const teamsDir = this._abs('teams');
    let ents = [];
    try {
      ents = fs.readdirSync(teamsDir, { withFileTypes: true });
    } catch {
      W('teams', 'no teams/ directory; run `factory init`');
      return { ok: errors.length === 0, errors, warnings };
    }
    const teams = [];
    for (const ent of ents.sort((a, b) => a.name.localeCompare(b.name))) {
      const rel = `teams/${ent.name}`;
      if ((ent.name === PRESENCE_DIR || ent.name === AUTOPILOT_DIR || ent.name === ARCHIVE_DIR) && ent.isDirectory()) continue; // status badges, the autopilot's state and archived teams, written by the CLI
      if (!ent.isDirectory()) {
        if (!['README.md', '.gitignore'].includes(ent.name)) W(rel, 'unknown file in teams/ (only team folders, README.md and .gitignore belong here)');
        continue;
      }
      if (!ID_RE.test(ent.name)) {
        W(rel, 'folder name is not a valid team id; the factory ignores it');
        continue;
      }
      teams.push(this._loadTeamForValidation(ent.name, E, W));
    }
    const allMessages = new Map();
    for (const t of teams) {
      for (const m of t.messages) {
        const prev = allMessages.get(m.id);
        if (prev) E(m.file, `message id ${m.id} is also used by ${prev.file}; message ids are unique across teams`);
        else allMessages.set(m.id, m);
      }
    }
    const roles = new Map(roster.filter((m) => typeof m.id === 'string').map((m) => [m.id, m.role]));
    const kinds = new Map(roster.filter((m) => typeof m.id === 'string').map((m) => [m.id, m.kind]));
    const soloAgents = new Set(roster.filter(isSoloAgent).map((m) => m.id));
    for (const t of teams) this._validateTeam(t, { E, W, memberIds, allMessages, roles, kinds, soloAgents });
    this._gitImmutabilityWarnings(W);
    return { ok: errors.length === 0, errors, warnings };
  }

  _validateRoster(E) {
    const file = 'factory/members.yaml';
    let data;
    try {
      data = parseYaml(fs.readFileSync(this._abs(file), 'utf8'));
    } catch (e) {
      E(file, e.code === 'ENOENT' ? 'missing; run `factory init`' : e.message);
      return [];
    }
    if (!Array.isArray(data?.members)) {
      E(file, 'must have a `members:` list');
      return [];
    }
    const seen = new Set();
    for (const [i, m] of data.members.entries()) {
      const where = `member #${i + 1}${m?.id ? ` (${m.id})` : ''}`;
      if (!isObject(m)) {
        E(file, `${where} is not a mapping`);
        continue;
      }
      for (const k of MEMBER_KEYS) if (!(k in m)) E(file, `${where} is missing ${k}`);
      if (typeof m.id !== 'string' || !MEMBER_ID_RE.test(m.id)) E(file, `${where}: id must be lowercase letters, digits and dashes`);
      else if (seen.has(m.id)) E(file, `${where}: duplicate id ${m.id}`);
      seen.add(m.id);
      if (!MEMBER_KINDS.includes(m.kind)) E(file, `${where}: kind must be ${MEMBER_KINDS.join(' | ')}`);
      if (!MEMBER_ROLES.includes(m.role)) E(file, `${where}: role must be ${MEMBER_ROLES.join(' | ')}`);
      if (typeof m.short !== 'string' || [...m.short].length !== 2) E(file, `${where}: short must be exactly 2 characters`);
      if (typeof m.name !== 'string' || !m.name.trim()) E(file, `${where}: name must be a non-empty string`);
      if (m.model !== null && typeof m.model !== 'string') E(file, `${where}: model must be a string or null`);
      if ('effort' in m && m.effort !== null && typeof m.effort !== 'string') E(file, `${where}: effort must be a string or null`);
      if ('launch' in m && m.launch !== null && !LAUNCH_KINDS.includes(m.launch)) E(file, `${where}: launch must be ${LAUNCH_KINDS.join(' | ')} or null`);
      if ('launch' in m && m.launch != null && m.kind !== 'agent') E(file, `${where}: only an agent can have a launch`);
      if (typeof m.color !== 'string') E(file, `${where}: color must be a string like "#111827"`);
    }
    for (const id of ['you', 'factory']) if (!seen.has(id)) E(file, `the roster needs the reserved member "${id}"`);
    return data.members.filter(isObject);
  }

  _loadTeamForValidation(teamId, E, W) {
    const dir = this._teamDir(teamId);
    const rel = `teams/${teamId}`;
    const t = { id: teamId, rel, team: null, threads: new Map(), messages: [], tasks: new Map(), issues: new Map(), decisionIds: new Set(), reports: new Set(), files: {} };
    const parse = (abs) => {
      try {
        return parseFrontmatter(fs.readFileSync(abs, 'utf8'));
      } catch (e) {
        E(this._rel(abs), `cannot parse: ${e.message}`);
        return null;
      }
    };
    for (const ent of fs.readdirSync(dir, { withFileTypes: true })) {
      if (!TEAM_DIR_ENTRIES.has(ent.name)) W(`${rel}/${ent.name}`, ent.name.startsWith('.tmp-') ? 'leftover from an interrupted write; report it to the owner (never delete files under teams/ yourself)' : 'unknown file in a team folder');
    }
    let images = [];
    try {
      images = fs.readdirSync(path.join(dir, 'attachments'));
    } catch {
      // no images yet
    }
    for (const name of images) if (!ATTACHMENT_PATH_RE.test(`teams/${teamId}/attachments/${name}`)) W(`${rel}/attachments/${name}`, 'not an image the board saved (<yyyymmddThhmmssZ>-<from>-<4 hex>.png|jpg|gif|webp)');
    if (fs.existsSync(path.join(dir, 'team.md'))) {
      const doc = parse(path.join(dir, 'team.md'));
      if (doc) t.team = doc.data;
    } else {
      E(`${rel}/team.md`, 'missing; every team folder needs a team.md (factory team new)');
    }
    const what = { threads: 'thread', comms: 'message (<yyyymmddThhmmssZ>-<from>-<4 hex>)', tasks: 'task (T-###)', issues: 'issue (I-###)', reports: 'report' };
    const scan = (sub, re, onDoc) => {
      const sdir = path.join(dir, sub);
      let names = [];
      try {
        names = fs.readdirSync(sdir, { withFileTypes: true });
      } catch {
        return;
      }
      for (const ent of names.sort((a, b) => a.name.localeCompare(b.name))) {
        const frel = `${rel}/${sub}/${ent.name}`;
        if (ent.name.startsWith('.tmp-')) {
          W(frel, 'leftover from an interrupted write; report it to the owner (never delete files under teams/ yourself)');
          continue;
        }
        if (ent.isDirectory() || !ent.name.endsWith('.md')) {
          W(frel, `unknown file in ${sub}/ (only .md state files belong here)`);
          continue;
        }
        const stem = ent.name.slice(0, -3);
        if (!re.test(stem)) E(frel, `file name "${stem}" is not a valid ${what[sub]} id`);
        const doc = parse(path.join(sdir, ent.name));
        if (doc) onDoc(stem, doc, frel);
      }
    };
    scan('threads', ID_RE, (stem, doc, file) => t.threads.set(stem, { ...doc.data, body: doc.body, file, stem }));
    scan('comms', MESSAGE_ID_RE, (stem, doc, file) => t.messages.push({ ...doc.data, body: doc.body, file, stem, team: teamId }));
    scan('tasks', TASK_ID_RE, (stem, doc, file) => t.tasks.set(stem, { ...doc.data, file, stem }));
    scan('issues', ISSUE_ID_RE, (stem, doc, file) => t.issues.set(stem, { ...doc.data, body: doc.body, file, stem }));
    scan('reports', /^[^.]/, (stem, doc, file) => {
      t.reports.add(`reports/${stem}.md`);
      t.files[file] = doc.data;
    });
    const dfile = path.join(dir, 'decisions.md');
    if (fs.existsSync(dfile)) {
      const lines = fs.readFileSync(dfile, 'utf8').split('\n');
      const nums = [];
      lines.forEach((line, i) => {
        if (!line.startsWith('## D-')) return;
        const m = DECISION_HEADING_RE.exec(line);
        if (!m) {
          E(`${rel}/decisions.md`, `line ${i + 1}: decision headings look like "## D-001: <title>"`);
          return;
        }
        nums.push(Number(m[1]));
        t.decisionIds.add(`D-${m[1]}`);
      });
      const seen = new Set();
      nums.forEach((n, i) => {
        if (seen.has(n)) E(`${rel}/decisions.md`, `D-${String(n).padStart(3, '0')} appears twice`);
        else if (n !== i + 1) E(`${rel}/decisions.md`, `decision numbers must run 1, 2, 3, … without gaps; entry ${i + 1} is D-${String(n).padStart(3, '0')}`);
        seen.add(n);
      });
    } else if (t.team) {
      W(`${rel}/decisions.md`, 'missing; `factory decide` creates entries here');
    }
    const mfile = path.join(dir, 'metrics.jsonl');
    t.metricLines = [];
    if (fs.existsSync(mfile)) {
      fs.readFileSync(mfile, 'utf8').split('\n').forEach((line, i) => {
        if (line.trim()) t.metricLines.push({ line, n: i + 1 });
      });
    }
    return t;
  }

  _validateTeam(t, { E, W, memberIds, allMessages, roles = new Map(), kinds = new Map(), soloAgents = new Set() }) {
    const isMember = (id) => typeof id === 'string' && memberIds.has(id);
    const isAgent = (id) => kinds.get(id) === 'agent';
    const isMemberList = (v) => Array.isArray(v) && v.every(isMember);
    const msgIds = new Set(t.messages.map((m) => m.id));
    // team.md
    if (t.team) {
      const f = `${t.rel}/team.md`;
      for (const k of TEAM_KEYS) if (!(k in t.team)) E(f, `missing key ${k}`);
      if (t.team.id !== t.id) E(f, `id is "${t.team.id}" but the folder is ${t.id}`);
      if (typeof t.team.title !== 'string' || !t.team.title.trim()) E(f, 'title must be a non-empty string');
      if (!isMember(t.team.lead)) E(f, `lead "${t.team.lead}" is not on the roster`);
      if (t.team.eval_cmd != null && typeof t.team.eval_cmd !== 'string') E(f, 'eval_cmd must be a shell command string or null');
      if (t.team.grader != null && typeof t.team.grader !== 'string') E(f, 'grader must be a string or null');
      if (t.team.setup != null && (typeof t.team.setup !== 'string' || /[\r\n]/.test(t.team.setup))) E(f, 'setup must be one command line (chain steps with &&) or null');
      if ('data_sources' in t.team && !isObject(t.team.data_sources)) E(f, 'data_sources must be a mapping {usage, traces, latency, feedback}');
      else if (isObject(t.team.data_sources)) {
        const ds = t.team.data_sources;
        const missing = DATA_SOURCE_KEYS.filter((k) => !(k in ds));
        if (missing.length) E(f, `data_sources is missing ${missing.join(', ')}; it has exactly ${DATA_SOURCE_KEYS.join(', ')} (null when unknown)`);
        for (const k of Object.keys(ds)) if (!DATA_SOURCE_KEYS.includes(k)) W(f, `data_sources has an unknown key "${k}"; the keys are ${DATA_SOURCE_KEYS.join(', ')}`);
        for (const k of DATA_SOURCE_KEYS) if (k in ds && ds[k] != null && typeof ds[k] !== 'string') E(f, `data_sources.${k} must be a string or null`);
      }
      if (isMember(t.team.lead) && t.team.lead !== 'you' && roles.get(t.team.lead) !== 'lead') W(f, `lead ${t.team.lead} is a ${roles.get(t.team.lead)}; a team lead is a member with role lead, or you`);
      if ('repo_paths' in t.team && !Array.isArray(t.team.repo_paths)) E(f, 'repo_paths must be a list');
      if ('allow' in t.team && t.team.allow != null) {
        if (!Array.isArray(t.team.allow)) E(f, 'allow must be a list of Claude Code permission rules, e.g. "Bash(gcloud logging read:*)"');
        else for (const x of t.team.allow) { const why = allowRuleProblem(x); if (why) E(f, `allow ${JSON.stringify(x)}: ${why}`); }
      }
      if ('created' in t.team && !isIso(t.team.created)) E(f, 'created must be an ISO-8601 UTC timestamp');
    }
    // threads
    for (const [stem, th] of t.threads) this._validateThread(t, stem, th, { E, W, isMember, isAgent, isSoloAgent: (id) => soloAgents.has(id), isMemberList, msgIds });
    // messages
    const former = formerLeads(t.messages);
    for (const m of t.messages) this._validateMessage(t, m, { E, isMember, allMessages, former });
    this._validateEffects(t, { E });
    // tasks and issues
    for (const [stem, x] of t.tasks) {
      const f = x.file;
      for (const k of TASK_KEYS) if (!(k in x)) E(f, `missing key ${k}`);
      if (x.id !== stem) E(f, `id "${x.id}" does not match the file name`);
      if (!t.threads.has(x.thread)) E(f, `thread "${x.thread}" does not exist in team ${t.id}`);
      if (!TASK_STATUSES.includes(x.status)) E(f, `status must be ${TASK_STATUSES.join(' | ')}`);
      if (x.owner != null && !isMember(x.owner)) E(f, `owner "${x.owner}" is not on the roster`);
      if (x.issue != null && !t.issues.has(x.issue)) E(f, `issue ${x.issue} does not exist`);
      else if (x.issue != null) {
        const is = t.issues.get(x.issue);
        const own = t.threads.get(is.thread);
        if (is.thread !== x.thread && !(own && own.kind !== 'project')) E(f, `task of ${x.thread} links ${x.issue}, which belongs to ${is.thread}; only a watch or single-agent issue is fixed from another thread`);
      }
      if ('refs' in x && !Array.isArray(x.refs)) E(f, 'refs must be a list');
      for (const k of ['created', 'updated']) if (k in x && !isIso(x[k])) E(f, `${k} must be an ISO-8601 UTC timestamp`);
      if (x.eta != null) for (const msg of etaErrors(x.eta, isMember, true)) E(f, `eta ${msg}`);
    }
    for (const [stem, x] of t.issues) {
      const f = x.file;
      for (const k of ISSUE_KEYS) if (!(k in x)) E(f, `missing key ${k}`);
      if (x.id !== stem) E(f, `id "${x.id}" does not match the file name`);
      if (!t.threads.has(x.thread)) E(f, `thread "${x.thread}" does not exist in team ${t.id}`);
      if (x.gate != null && !GATES.includes(x.gate)) E(f, `gate must be null or one of ${GATES.join(', ')}`);
      if (!SEVERITIES.includes(x.severity)) E(f, `severity must be ${SEVERITIES.join(' | ')}`);
      if (!ISSUE_STATUSES.includes(x.status)) E(f, `status must be ${ISSUE_STATUSES.join(' | ')}`);
      if ('raised_by' in x && !isMember(x.raised_by)) E(f, `raised_by "${x.raised_by}" is not on the roster`);
      if (x.task != null && !t.tasks.has(x.task)) E(f, `task ${x.task} does not exist`);
      else if (x.task != null && t.tasks.get(x.task).issue !== x.id) E(f, `task ${x.task} does not link back to ${x.id} (its issue is ${t.tasks.get(x.task).issue ?? 'null'}); an interrupted write?`);
      if (x.point != null && !Number.isInteger(x.point)) E(f, 'point must be an integer or null');
      if (x.status === 'accepted' && x.task == null) W(f, 'accepted issue has no task');
      for (const k of ['created', 'updated']) if (k in x && !isIso(x[k])) E(f, `${k} must be an ISO-8601 UTC timestamp`);
    }
    // metrics.jsonl
    for (const { line, n } of t.metricLines) {
      const f = `${t.rel}/metrics.jsonl`;
      let row;
      try {
        row = JSON.parse(line);
      } catch (e) {
        E(f, `line ${n} is not JSON (${e.message})`);
        continue;
      }
      if (!isObject(row)) E(f, `line ${n} must be a JSON object`);
      else {
        if (!isIso(row.ts)) E(f, `line ${n}: ts must be an ISO-8601 timestamp`);
        if (!t.threads.has(row.thread)) E(f, `line ${n}: thread "${row.thread}" does not exist`);
        if (!isObject(row.metrics)) E(f, `line ${n}: metrics must be an object`);
        if (row.report && !t.reports.has(row.report)) W(f, `line ${n}: report ${row.report} is missing`);
      }
    }
    // reports
    for (const [file, data] of Object.entries(t.files)) {
      const name = file.split('/').pop();
      if (!REPORT_NAME_RE.test(name)) W(file, 'report files are named <thread>-<yyyymmddThhmmssZ>.md');
      if (!t.threads.has(data.thread)) E(file, `thread "${data.thread}" does not exist`);
      if (!['ok', 'breach'].includes(data.status)) E(file, 'status must be ok or breach');
    }
  }

  /**
   * Cross-file checks that catch a write interrupted half-way: every review point
   * has its issue, every stance reached its issue (and accepted ones their task),
   * and each project thread's phase matches its last phase event.
   */
  _validateEffects(t, { E }) {
    const issues = [...t.issues.values()];
    const tasks = [...t.tasks.values()];
    for (const m of t.messages) {
      if (m.type === 'review' && Array.isArray(m.points)) {
        for (const p of m.points) {
          if (!isObject(p) || !Number.isInteger(p.n)) continue;
          if (!issues.some((i) => i.source === m.id && i.point === p.n)) E(m.file, `point ${p.n} has no issue (an issue with source ${m.id}, point ${p.n}); an interrupted write?`);
        }
      }
      if (m.type === 'review_response' && Array.isArray(m.stances)) {
        for (const st of m.stances) {
          if (!isObject(st)) continue;
          const is = issues.find((i) => i.source === m.reply_to && i.point === st.point);
          if (!is) continue;
          if (!String(is.body ?? '').includes(m.id)) E(m.file, `the ${st.stance} stance on point ${st.point} never reached ${is.id} (its history does not mention ${m.id}); an interrupted write?`);
          if (st.stance === 'accepted' && !tasks.some((x) => x.issue === is.id && asArray(x.refs).includes(m.reply_to))) {
            E(m.file, `the accepted stance on point ${st.point} has no task (a task with issue ${is.id} and refs ${m.reply_to}); an interrupted write?`);
          }
        }
      }
    }
    for (const [stem, th] of t.threads) {
      if (th.kind !== 'project') continue;
      const last = t.messages.filter((m) => m.thread === stem && m.type === 'event' && isObject(m.event) && m.event.kind === 'phase').sort(byTsThenId).at(-1);
      if (last && last.event.to !== th.phase) E(th.file, `phase is ${th.phase}, but the last phase event (${last.id}) moved it to ${last.event.to}; an interrupted write?`);
    }
  }

  _validateThread(t, stem, th, { E, W, isMember, isAgent = () => true, isSoloAgent = () => true, isMemberList, msgIds }) {
    const f = th.file;
    const kind = th.kind;
    if (!THREAD_KINDS.includes(kind)) {
      E(f, `kind must be project, watch or solo (got "${kind}")`);
      return;
    }
    for (const k of KIND_KEYS[kind]) if (!(k in th)) E(f, `missing key ${k}`);
    if (th.roles != null) {
      try {
        normalizeRoles(kind, th.roles);
      } catch (e) {
        E(f, `roles: ${e.message}`);
      }
    }
    if (th.id !== stem) E(f, `id "${th.id}" does not match the file name`);
    if (th.team !== t.id) E(f, `team is "${th.team}" but the file lives in teams/${t.id}`);
    if (typeof th.title !== 'string' || !th.title.trim()) E(f, 'title must be a non-empty string');
    const phases = KIND_PHASES[kind];
    if (!phases.includes(th.phase)) E(f, `phase "${th.phase}" is not a ${kind} phase (${phases.join(', ')})`);
    if (!isMember(th.lead)) E(f, `lead "${th.lead}" is not on the roster`);
    if (!isMemberList(th.members)) E(f, 'members must be a list of roster ids');
    if (th.branch !== `factory/${t.id}/${stem}`) E(f, `branch must be factory/${t.id}/${stem}`);
    for (const k of ['created', 'updated']) if (k in th && !isIso(th[k])) E(f, `${k} must be an ISO-8601 UTC timestamp`);
    if (kind === 'project') {
      if (!isObject(th.gates)) {
        E(f, `gates must map ${GATES.join(', ')} to {by, status, at, ref}`);
      } else {
        for (const g of GATES) {
          const gate = th.gates[g];
          if (!isObject(gate)) {
            if (!OPTIONAL_GATES.includes(g)) E(f, `gates.${g} is missing`);
            continue;
          }
          if (!isMember(gate.by)) E(f, `gates.${g}.by "${gate.by}" is not on the roster`);
          if (!GATE_STATUSES.includes(gate.status)) E(f, `gates.${g}.status must be ${GATE_STATUSES.join(' | ')}`);
          if (gate.at != null && !isIso(gate.at)) E(f, `gates.${g}.at must be an ISO timestamp or null`);
          if (gate.ref != null && !msgIds.has(gate.ref)) E(f, `gates.${g}.ref ${gate.ref} is not a message in team ${t.id}`);
        }
        for (const g of Object.keys(th.gates)) if (!GATES.includes(g)) E(f, `unknown gate "${g}"`);
        if (OPTIONAL_GATES.includes(th.phase) && !isObject(th.gates[th.phase])) E(f, `phase ${th.phase}: the thread has no ${th.phase} gate`);
        if (th.eta != null) {
          if (!isObject(th.eta)) E(f, 'eta must map phases to {minutes, by, at}');
          else {
            for (const [p, e] of Object.entries(th.eta)) {
              if (!ETA_PHASES.includes(p)) E(f, `eta.${p}: not a phase to estimate (${ETA_PHASES.join(', ')})`);
              for (const msg of etaErrors(e, isMember, false)) E(f, `eta.${p} ${msg}`);
            }
          }
        }
        if (th.gates.build && th.gates.build.by !== th.lead) W(f, `gates.build.by (${th.gates.build.by}) differs from the lead (${th.lead})`);
        const own = th.lead === 'you' ? [] : REVIEW_GATES.filter((g) => isObject(th.gates[g]) && th.gates[g].by === th.lead);
        if (own.length) W(f, `the lead ${th.lead} also owns the ${own.join(', ')} gate${own.length === 1 ? '' : 's'}: it would review and answer its own work`);
      }
      if (th.cadence != null || th.thresholds != null) W(f, 'project threads ignore cadence and thresholds');
    } else if (kind === 'solo') {
      if (!isMember(th.owner)) E(f, `owner "${th.owner}" is not on the roster`);
      else if (!isAgent(th.owner)) E(f, `owner "${th.owner}" is not an agent; a single-agent thread is answered by an agent`);
      else if (!isSoloAgent(th.owner)) E(f, `owner "${th.owner}" needs role solo and launch: claude in factory/members.yaml, so its runs keep to the thread's allowed commands`);
      // Made before single-agent threads were led by their agent: it still works the old way.
      const extra = asArray(th.members).filter((m) => m !== 'you' && m !== th.owner && m !== th.lead);
      if (extra.length) W(f, `members ${extra.join(', ')}: a single-agent thread's members are you and its agent; they cannot be addressed there`);
      if (th.lead !== th.owner) W(f, `lead "${th.lead}" is not its agent "${th.owner}": a single-agent thread is led by its own agent; convert it with \`factory thread set ${t.id}/${stem} --owner ${th.owner}\``);
      if (!Array.isArray(th.allow)) E(f, 'allow must be a list of Claude Code permission rules, e.g. "Bash(npm run test:*)"');
      else for (const x of th.allow) { const why = allowRuleProblem(x); if (why) E(f, `allow ${JSON.stringify(x)}: ${why}`); }
    } else {
      if (!isMember(th.owner)) E(f, `owner "${th.owner}" is not on the roster`);
      if (typeof th.cadence !== 'string' || !CADENCE_RE.test(th.cadence)) E(f, `cadence "${th.cadence}" must be hourly, daily, weekly, <n>h or <n>d`);
      if (!isObject(th.thresholds)) E(f, 'watch threads need thresholds: {metric: {min?, max?}}');
      else {
        for (const [metric, v] of Object.entries(th.thresholds)) {
          if (!isObject(v) || (v.min == null && v.max == null)) E(f, `thresholds.${metric} needs min and/or max`);
          else for (const [k, x] of Object.entries(v)) if (!['min', 'max'].includes(k) || typeof x !== 'number') E(f, `thresholds.${metric}.${k} must be min or max with a number`);
        }
        if (!Object.keys(th.thresholds).length) W(f, 'no thresholds yet: watch runs will never breach');
      }
      if (th.last_run != null && !isIso(th.last_run)) E(f, 'last_run must be an ISO timestamp or null');
      if (th.gates != null) W(f, 'watch threads have no gates; set gates: null');
    }
  }

  _validateMessage(t, m, { E, isMember, allMessages, former = new Map() }) {
    const f = m.file;
    for (const k of MESSAGE_KEYS) if (!(k in m)) E(f, `missing key ${k}`);
    if (m.id !== m.stem) E(f, `id "${m.id}" does not match the file name`);
    if (!MESSAGE_ID_RE.test(String(m.id))) E(f, 'id must look like <yyyymmddThhmmssZ>-<from>-<4 hex>');
    if (!isIso(m.ts)) E(f, 'ts must be an ISO-8601 UTC timestamp');
    else if (!String(m.id).startsWith(`${stampOf(m.ts)}-${m.from}-`) || !/^[0-9a-f]{4}$/.test(String(m.id).slice(`${stampOf(m.ts)}-${m.from}-`.length))) {
      E(f, `id must be ${stampOf(m.ts)}-${m.from}-<4 hex> (from ts and from)`);
    }
    if (!t.threads.has(m.thread)) E(f, `thread "${m.thread}" does not exist in team ${t.id}`);
    if (!isMember(m.from)) E(f, `from "${m.from}" is not on the roster`);
    for (const k of ['to', 'cc']) {
      if (!Array.isArray(m[k])) E(f, `${k} must be a list`);
      else for (const x of m[k]) if (!isMember(x)) E(f, `${k} "${x}" is not on the roster`);
    }
    if (!MESSAGE_TYPES.includes(m.type)) E(f, `type "${m.type}" is not one of ${MESSAGE_TYPES.join(', ')}`);
    if (typeof m.internal !== 'boolean') E(f, 'internal must be true or false');
    if (m.type === 'event' && m.from !== 'factory') E(f, 'only factory posts event messages');
    if (m.from === 'factory' && m.type !== 'event') E(f, 'factory posts only event messages');
    if (m.reply_to != null && !allMessages.has(m.reply_to)) E(f, `reply_to ${m.reply_to} is not an existing message`);
    if (!Array.isArray(m.resolves)) E(f, 'resolves must be a list');
    else {
      for (const id of m.resolves) {
        const target = allMessages.get(id);
        if (!target) {
          E(f, `resolves ${id} is not an existing message`);
          continue;
        }
        const meta = t.threads.get(target.thread) || {};
        const allowed = new Set([...asArray(target.to), target.from, meta.lead, meta.owner, 'you', 'factory', ...(former.get(target.thread) || [])].filter(Boolean));
        if (!allowed.has(m.from)) E(f, `${m.from} may not resolve ${id} (only its recipients, its sender, the thread lead/owner, you or factory)`);
      }
    }
    if ('dismissed_for' in m && (m.dismissal !== true || !isMember(m.dismissed_for))) E(f, 'dismissed_for goes only on a dismissal and names a roster member');
    if ('dismissed_gate' in m && (m.dismissal !== true || !GATES.includes(m.dismissed_gate))) E(f, `dismissed_gate goes only on a dismissal and is one of ${GATES.join(', ')}`);
    if ('link' in m) {
      const l = m.link;
      if (!isObject(l) || !['to', 'from'].includes(l.dir) || typeof l.thread !== 'string' || !/^[^/\s]+\/[^/\s]+$/.test(l.thread)) E(f, 'link must be {dir: to|from, thread: <team>/<thread>, msg: <message id> or null}');
      else if (l.msg != null && !MESSAGE_ID_RE.test(String(l.msg))) E(f, `link.msg ${l.msg} is not a message id`);
      else if (l.thread === `${t.id}/${m.thread}`) E(f, 'link points at its own thread');
    }
    if (!Array.isArray(m.refs)) E(f, 'refs must be a list');
    else {
      for (const r of m.refs) {
        const ok = TASK_ID_RE.test(r) ? t.tasks.has(r) : ISSUE_ID_RE.test(r) ? t.issues.has(r) : DECISION_ID_RE.test(r) ? t.decisionIds.has(r) : allMessages.has(r);
        if (!ok) E(f, `refs ${r} does not resolve (T-/I-/D- of team ${t.id}, or a message id)`);
      }
    }
    switch (m.type) {
      case 'review': {
        if (!REVIEW_GATES.includes(m.gate)) E(f, `review gate must be one of ${REVIEW_GATES.join(', ')}`);
        if (!VERDICTS.includes(m.verdict)) E(f, `verdict must be ${VERDICTS.join(' | ')}`);
        if (!Array.isArray(m.points)) {
          E(f, 'points must be a list (may be [])');
          break;
        }
        const ns = new Set();
        for (const p of m.points) {
          if (!isObject(p) || !Number.isInteger(p.n) || p.n < 1) E(f, 'each point needs an integer n ≥ 1');
          else if (ns.has(p.n)) E(f, `point n=${p.n} appears twice`);
          else ns.add(p.n);
          if (!isObject(p) || !SEVERITIES.includes(p.severity)) E(f, `point severity must be ${SEVERITIES.join(' | ')}`);
          if (!isObject(p) || typeof p.text !== 'string' || !p.text.trim()) E(f, 'each point needs text');
        }
        if (m.verdict === 'approve' && m.points.some((p) => p && (p.severity === 'high' || p.severity === 'medium'))) E(f, 'an approve review carries only low or nit points');
        break;
      }
      case 'review_response': {
        const rv = allMessages.get(m.reply_to);
        if (!rv || rv.type !== 'review') E(f, 'reply_to must be the review this responds to');
        if (!Array.isArray(m.stances)) {
          E(f, 'stances must be a list');
          break;
        }
        const seen = new Set();
        for (const s of m.stances) {
          if (!isObject(s) || !STANCES.includes(s.stance)) E(f, `stance must be ${STANCES.join(' | ')}`);
          else if (s.stance === 'rejected' && !(typeof s.reason === 'string' && s.reason.trim())) E(f, `point ${s.point} is rejected without a reason`);
          if (isObject(s)) {
            if (seen.has(s.point)) E(f, `point ${s.point} has two stances`);
            seen.add(s.point);
          }
        }
        if (rv && rv.type === 'review' && Array.isArray(rv.points)) {
          const want = rv.points.map((p) => p.n);
          const missing = want.filter((n) => !seen.has(n));
          const extra = [...seen].filter((n) => !want.includes(n));
          if (missing.length) E(f, `stances miss point ${missing.join(', ')} of ${rv.id}`);
          if (extra.length) E(f, `stances name point ${extra.join(', ')} that ${rv.id} does not have`);
        }
        break;
      }
      case 'result':
        if (!t.tasks.has(m.task)) E(f, `task ${m.task} does not exist`);
        if (!OUTCOMES.includes(m.outcome)) E(f, `outcome must be ${OUTCOMES.join(' | ')}`);
        break;
      case 'dispatch':
        if (!t.tasks.has(m.task)) E(f, `task ${m.task} does not exist`);
        break;
      case 'decision':
        if (!t.decisionIds.has(m.decision)) E(f, `decision ${m.decision} is not in decisions.md`);
        if (m.gate != null && !REVIEW_GATES.includes(m.gate)) E(f, `gate must be one of ${REVIEW_GATES.join(', ')}`);
        if (m.verdict != null && !['approve', 'changes_requested'].includes(m.verdict)) E(f, 'verdict must be approve or changes_requested');
        break;
      case 'report':
        if (typeof m.report !== 'string' || !t.reports.has(m.report)) E(f, `report ${m.report} does not exist`);
        if (!['ok', 'breach'].includes(m.status)) E(f, 'status must be ok or breach');
        break;
      case 'alert':
        if (typeof m.metric !== 'string') E(f, 'alert needs a metric name');
        if (typeof m.value !== 'number') E(f, 'alert value must be a number');
        if (!isObject(m.threshold)) E(f, 'alert threshold must be {min?, max?}');
        if (!t.issues.has(m.issue)) E(f, `issue ${m.issue} does not exist`);
        break;
      case 'event':
        if (!isObject(m.event) || !EVENT_KINDS.includes(m.event.kind)) E(f, `event.kind must be one of ${EVENT_KINDS.join(', ')}`);
        else if (!isMember(m.event.by)) E(f, `event.by "${m.event.by}" is not on the roster`);
        break;
      default:
        break;
    }
  }

  _gitImmutabilityWarnings(W) {
    let out;
    try {
      out = execFileSync('git', ['--no-optional-locks', '-C', this.root, 'status', '--porcelain', '--', 'teams'], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'], timeout: 15_000 });
    } catch {
      return;
    }
    for (const line of out.split('\n')) {
      if (line.length < 4) continue;
      const code = line.slice(0, 2);
      const file = line.slice(3).split(' -> ')[0].replace(/^"|"$/g, '');
      if (!/(^|\/)comms\/[^/]+\.md$/.test(file)) continue;
      if (code.includes('?') || code[0] === 'A') continue;
      if (/[MDR]/.test(code)) W(file, `message files are immutable, but git reports this committed one as ${code.includes('D') ? 'deleted' : 'modified'}; report it to the owner (never restore or edit it yourself)`);
    }
  }
}
