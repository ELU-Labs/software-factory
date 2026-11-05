#!/usr/bin/env node
// Install the software factory into the git repo you run it from:
//
//   npx github:ELU-Labs/software-factory             copy it in, set up teams/, open the board
//   npx github:ELU-Labs/software-factory --no-open   the same, without starting the board
//   npx github:ELU-Labs/software-factory --update    take this version's files (factory/members.yaml is kept)
//
// Files you already have are left alone unless --update is given.
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync, spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const SRC = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
/** What goes into your repo: the CLI and its rules, the board, and the Claude Code skill and subagents. */
export const PARTS = ['factory', 'tools/factory-ui', '.claude/skills/factory', '.claude/agents/builder.md', '.claude/agents/monitor.md'];
/** The factory's own tests and demo data stay here. */
const SKIP = ['factory/test', 'tools/factory-ui/seed-demo.mjs'];
/** Your roster: never replaced, even by --update. */
const KEEP = 'factory/members.yaml';
const USAGE = 'Usage: npx github:ELU-Labs/software-factory [--no-open] [--update]\nRun it inside the git repository you want the factory in.';

const skipped = (rel) => SKIP.some((s) => rel === s || rel.startsWith(`${s}/`)) || path.basename(rel) === '.DS_Store';

/** Every file under `rel` in this package (or `rel` itself), as repo-relative paths. */
function filesOf(rel) {
  const abs = path.join(SRC, rel);
  if (!fs.existsSync(abs) || skipped(rel)) return [];
  if (!fs.statSync(abs).isDirectory()) return [rel];
  return fs.readdirSync(abs).sort().flatMap((name) => filesOf(path.posix.join(rel, name)));
}

const sameFile = (a, b) => fs.readFileSync(a).equals(fs.readFileSync(b));

/** Copy the factory into `root`. @returns {{added: string[], updated: string[], kept: string[], same: number}} */
export function copyFactory(root, { update = false } = {}) {
  const out = { added: [], updated: [], kept: [], same: 0 };
  for (const rel of PARTS.flatMap(filesOf)) {
    const from = path.join(SRC, rel);
    const to = path.join(root, rel);
    if (fs.existsSync(to)) {
      if (sameFile(from, to)) {
        out.same += 1;
        continue;
      }
      if (!update || rel === KEEP) {
        out.kept.push(rel);
        continue;
      }
      out.updated.push(rel);
    } else out.added.push(rel);
    fs.mkdirSync(path.dirname(to), { recursive: true });
    fs.copyFileSync(from, to);
    fs.chmodSync(to, fs.statSync(from).mode & 0o777);
  }
  return out;
}

function main(argv) {
  const flags = argv.filter((a) => a !== 'init');
  if (flags.includes('--help') || flags.includes('-h')) {
    console.log(USAGE);
    return 0;
  }
  const unknown = flags.filter((f) => !['--no-open', '--update'].includes(f));
  if (unknown.length) {
    console.error(`software-factory: unknown option ${unknown[0]}\n${USAGE}`);
    return 2;
  }
  if (Number(process.versions.node.split('.')[0]) < 22) {
    console.error(`software-factory: needs Node.js 22 or newer (this is ${process.versions.node})`);
    return 1;
  }
  let root;
  try {
    root = execFileSync('git', ['rev-parse', '--show-toplevel'], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim();
  } catch {
    console.error('software-factory: run this inside the git repository you want the factory in (no repository here)');
    return 1;
  }
  if (fs.realpathSync(root) === fs.realpathSync(SRC)) {
    console.error('software-factory: this is the factory\'s own repository; run it inside the repository you want the factory in');
    return 1;
  }
  const r = copyFactory(root, { update: flags.includes('--update') });
  console.log(`Software factory in ${root}`);
  if (r.added.length) console.log(`  added ${r.added.length} files`);
  if (r.updated.length) console.log(`  updated ${r.updated.length} files`);
  if (!r.added.length && !r.updated.length) console.log('  already up to date');
  if (r.kept.length) {
    console.log(`  kept ${r.kept.length} of your files that differ from this version${r.kept.some((x) => x !== KEEP) ? ' (--update replaces them)' : ''}:`);
    for (const k of r.kept) console.log(`    ${k}`);
  }
  const cli = (...args) => spawnSync(process.execPath, [path.join('factory', 'bin', 'factory.mjs'), ...args], { cwd: root, stdio: 'inherit' }).status;
  if (cli('init') !== 0) return 1;
  if (!flags.includes('--no-open') && cli('ui', '--detach', '--open') !== 0) return 1;
  console.log([
    '',
    flags.includes('--no-open') ? 'Open the board: node factory/bin/factory.mjs ui --open' : 'Start a thread on the board, or ask Claude Code: /factory start a thread to <what you want>',
    'Commit factory/, tools/factory-ui/ and .claude/ when you want them in the repo; teams/ stays on your machine.',
  ].join('\n'));
  return 0;
}

if (process.argv[1] && fs.realpathSync(process.argv[1]) === fileURLToPath(import.meta.url)) process.exitCode = main(process.argv.slice(2));
