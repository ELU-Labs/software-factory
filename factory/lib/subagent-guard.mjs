#!/usr/bin/env node
/**
 * PreToolUse hook for headless autopilot runs (factory/lib/autopilot.mjs
 * passes it with --settings). It lets the Agent tool start only the built-in
 * read-and-search subagent types, in the run's own checkout and permission
 * mode: no worktree or remote isolation (a worktree is a branch inside the
 * shared checkout), no other working directory, no permission mode, and none of
 * the project's own agent definitions (which may carry their own permission
 * mode, hooks or MCP servers). Every other tool call passes through untouched.
 *
 * With the argument `lead` (the lead's runs) it also allows the factory's
 * `builder` and `monitor` types, and checks Bash commands: the owner's Git and
 * release steps are refused (see leadShellRefusal). That is a seatbelt against
 * mistakes, not a sandbox: a determined shell can still get round a pattern.
 *
 * Exit 0 allows the call; exit 2 refuses it and Claude Code shows stderr to the
 * agent. Anything it cannot read is refused.
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const SUBAGENT_TYPES = Object.freeze(['Explore', 'general-purpose', 'Plan']);
export const LEAD_SUBAGENT_TYPES = Object.freeze([...SUBAGENT_TYPES, 'builder', 'monitor']);
const SUBAGENT_TOOLS = new Set(['Agent', 'Task']);
/** Agent inputs that change where or how a subagent runs. */
const REFUSED_INPUTS = Object.freeze(['isolation', 'cwd', 'mode', 'team_name']);
/** Git commands that move the shared checkout off main or rewrite its history. */
const CHECKOUT_MOVES = new Set(['checkout', 'switch', 'stash', 'reset', 'rebase', 'merge', 'pull', 'commit', 'cherry-pick', 'revert', 'am', 'restore', 'clean']);

/** @returns {string|null} why the call is refused, or null when it may run. */
export function refusal(call, { lead = false, root = process.cwd() } = {}) {
  if (!call || typeof call !== 'object') return 'the tool call could not be read';
  if (lead && call.tool_name === 'Bash') return leadShellRefusal(call.tool_input?.command, root);
  if (!SUBAGENT_TOOLS.has(call.tool_name)) return null;
  const input = call.tool_input && typeof call.tool_input === 'object' ? call.tool_input : {};
  const type = input.subagent_type ?? 'general-purpose';
  const types = lead ? LEAD_SUBAGENT_TYPES : SUBAGENT_TYPES;
  if (!types.includes(type)) return `subagent type "${type}" is not available ${lead ? 'to the lead' : 'on a single-agent thread'}; use ${types.join(', ')}`;
  const set = REFUSED_INPUTS.filter((k) => input[k] != null && input[k] !== '');
  if (set.length) return `a subagent here runs in this checkout with your permissions; leave out ${set.join(', ')}`;
  return null;
}

/**
 * The owner's steps (PROTOCOL §15) that a lead run may never take: merge, tag,
 * push to main, force or tag pushes, releases, workflow runs, deploys, and Git
 * commands that move the shared checkout. A worktree (`git -C <worktree> ...`) is the lead's and its builders'.
 * @returns {string|null}
 */
export function leadShellRefusal(command, root) {
  if (typeof command !== 'string') return 'the command could not be read';
  const owner = (what) => `${what} is the owner's step; ask \`you\` in the thread instead`;
  for (const seg of commandText(command).split(/&&|\|\||[;|\n]/)) {
    const words = seg.trim().split(/\s+/).filter(Boolean);
    const at = (name) => words.findIndex((w) => w === name || w.endsWith(`/${name}`));
    const g = at('git');
    if (g >= 0) {
      let dir = null;
      let i = g + 1;
      for (; i < words.length && words[i].startsWith('-'); i++) {
        if (words[i] === '-C') dir = words[++i];
        else if (words[i] === '-c') i++;
      }
      const sub = words[i];
      const rest = words.slice(i + 1);
      if (sub === 'push') {
        const bad = rest.find((w) => /^(--force.*|-f|--tags|--follow-tags|--mirror|--all|--delete|-d)$/.test(w) || /(^|[:/])(main|master)$/.test(w) || w.startsWith('refs/tags/') || /^v\d/.test(w));
        if (bad) return owner(`\`git push ${bad}\``);
      }
      if (sub === 'tag') {
        const listing = rest.some((w) => /^(-l|--list|--contains|--no-contains|--merged|--no-merged|--points-at|--sort.*|-n\d*|--format.*)$/.test(w));
        const writing = rest.some((w) => /^-(a|s|f|d|m|F|u)$|^--(annotate|sign|force|delete|message.*|file.*)$/.test(w));
        if (writing || (!listing && rest.some((w) => !w.startsWith('-')))) return owner('creating or deleting a tag');
      }
      const home = !dir || path.resolve(root, dir) === path.resolve(root);
      if (home && CHECKOUT_MOVES.has(sub)) return `\`git ${sub}\` in the shared checkout: it never leaves main. Run it in the thread worktree (git -C <worktree> ${sub} ...)`;
    }
    const gh = at('gh');
    if (gh >= 0) {
      const [a, b] = words.slice(gh + 1);
      if (a === 'pr' && b === 'merge') return 'merge a thread\'s PR with `node factory/bin/factory.mjs merge <thread-ref>` once `you` signed it off; it checks the sign-off first';
      if (a === 'release' || (a === 'workflow' && b === 'run')) return owner(`\`gh ${[a, b].filter(Boolean).join(' ')}\``);
    }
    if (words.some((w) => /(^|\/)deploy\.sh$/.test(w))) return owner('deploying');
    const npm = at('npm');
    if (npm >= 0 && words.slice(npm + 1).some((w, k, r) => w === 'run' && /^deploy/.test(r[k + 1] || ''))) return owner('deploying');
    if (at('firebase') >= 0 && words.includes('deploy')) return owner('deploying');
    if (at('gcloud') >= 0 && words.includes('deploy')) return owner('deploying');
  }
  return null;
}

/**
 * The parts of a shell command that run, for leadShellRefusal: heredoc bodies
 * and quoted strings go (a message body that mentions `git push` is text, not a
 * command), each replaced by one placeholder word.
 */
function commandText(command) {
  const out = [];
  let end = null;
  for (const line of command.split('\n')) {
    if (end !== null) {
      if (line.trim() === end) end = null;
      continue;
    }
    const doc = /<<-?\s*(['"]?)(\w+)\1/.exec(line);
    if (doc) end = doc[2];
    out.push(line);
  }
  return out.join('\n').replace(/'[^']*'|"(?:[^"\\]|\\.)*"/g, 'Q');
}

if (process.argv[1] && fs.realpathSync(process.argv[1]) === fs.realpathSync(fileURLToPath(import.meta.url))) {
  let call = null;
  try {
    call = JSON.parse(fs.readFileSync(0, 'utf8'));
  } catch {
    call = null;
  }
  const why = refusal(call, { lead: process.argv[2] === 'lead', root: call?.cwd || process.cwd() });
  if (why) {
    process.stderr.write(`Refused by the factory: ${why}.\n`);
    process.exit(2);
  }
  process.exit(0);
}
