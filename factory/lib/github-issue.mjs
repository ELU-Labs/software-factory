// A GitHub issue, read with the GitHub CLI (`gh`), as the request a thread starts from.
import { execFileSync } from 'node:child_process';
import { FactoryError } from './store.mjs';

/** The longest issue text a request carries; the rest stays on GitHub. */
export const ISSUE_TEXT_MAX = 20000;

const NUMBER_RE = /^#?(\d{1,9})$/;
const URL_RE = /^https?:\/\/[\w.-]+(?::\d+)?\/[\w.-]+\/[\w.-]+\/issues\/\d{1,9}\/?$/;

/** "123", "#123" or an issue URL, as `gh issue view` takes it; null for anything else. */
export function issueArg(v) {
  const s = String(v ?? '').trim();
  const n = NUMBER_RE.exec(s);
  if (n) return n[1];
  return URL_RE.test(s) ? s : null;
}

/**
 * The issue's number, title, text and link, read in the repo at `root`.
 * @returns {{number: number, title: string, body: string, url: string}}
 */
export function fetchIssue(root, ref) {
  const arg = issueArg(ref);
  if (!arg) throw new FactoryError('usage', `"${ref}" is not an issue: give its number (123) or its link`);
  let out;
  try {
    out = execFileSync('gh', ['issue', 'view', arg, '--json', 'number,title,body,url'], {
      cwd: root, encoding: 'utf8', timeout: 30000, stdio: ['ignore', 'pipe', 'pipe'], maxBuffer: 8 * 1024 * 1024,
    });
  } catch (e) {
    if (e.code === 'ENOENT') throw new FactoryError('invalid', 'reading an issue needs the GitHub CLI (gh), signed in: https://cli.github.com');
    const why = String(e.stderr || e.message || '').trim().split('\n')[0];
    throw new FactoryError('invalid', `could not read issue ${arg}: ${why || 'gh failed'}`);
  }
  let j;
  try {
    j = JSON.parse(out);
  } catch {
    throw new FactoryError('invalid', `gh printed something other than the issue for ${arg}`);
  }
  if (!j || !Number.isInteger(j.number) || typeof j.title !== 'string' || typeof j.url !== 'string') {
    throw new FactoryError('invalid', `gh printed something other than the issue for ${arg}`);
  }
  return { number: j.number, title: j.title.trim(), body: typeof j.body === 'string' ? j.body : '', url: j.url };
}

/** The request a thread starts from: a link to the issue, then its text. */
export function issueRequest(issue) {
  const text = String(issue.body || '').trim();
  const cut = text.length > ISSUE_TEXT_MAX ? `${text.slice(0, ISSUE_TEXT_MAX)}\n\n_(cut here; the rest is on GitHub)_` : text;
  const label = `#${issue.number}: ${String(issue.title).replace(/[[\]]/g, '')}`;
  return `From GitHub issue [${label}](${issue.url}):\n\n${cut || '_The issue has no description._'}`;
}
