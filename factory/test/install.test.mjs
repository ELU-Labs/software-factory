// The installer (bin/install.mjs, what `npx github:ELU-Labs/software-factory` runs): it copies the
// factory into the git repo it runs in, sets up teams/, and never overwrites your files unasked.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync, execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { openStore, TRIAGE_REF } from '../lib/store.mjs';
import { runCli, assertExit, makeTempDir } from './helpers.mjs';

const PKG = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const INSTALL = path.join(PKG, 'bin', 'install.mjs');

const install = (cwd, ...args) => spawnSync(process.execPath, [INSTALL, ...args], { cwd, encoding: 'utf8', timeout: 60000 });

function repo(t) {
  const dir = makeTempDir('factory-install-');
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  execFileSync('git', ['init', '-q', dir]);
  fs.mkdirSync(path.join(dir, 'src'));
  return fs.realpathSync(dir);
}

test('install copies the factory to the repo root from any folder in it, sets up teams/ with Triage, and leaves the tests behind', (t) => {
  const dir = repo(t);
  const r = install(path.join(dir, 'src'), '--no-open');
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, new RegExp(`Software factory in ${dir}\\n  added \\d+ files`));
  assert.match(r.stdout, /Open the board: node factory\/bin\/factory\.mjs ui --open/);
  for (const f of ['factory/bin/factory.mjs', 'factory/lib/store.mjs', 'factory/PROTOCOL.md', 'factory/members.yaml', 'tools/factory-ui/app.js',
    '.claude/skills/factory/SKILL.md', '.claude/agents/builder.md', '.claude/agents/monitor.md', 'teams/.gitignore']) {
    assert.ok(fs.existsSync(path.join(dir, f)), `${f} is there`);
  }
  for (const f of ['factory/test', 'tools/factory-ui/seed-demo.mjs', 'bin', 'package.json', 'src/factory']) {
    assert.equal(fs.existsSync(path.join(dir, f)), false, `${f} is not copied`);
  }
  assert.equal(fs.statSync(path.join(dir, 'factory/bin/factory.mjs')).mode & 0o777, fs.statSync(path.join(PKG, 'factory/bin/factory.mjs')).mode & 0o777);
  assert.equal(openStore({ root: dir }).thread(TRIAGE_REF).kind, 'solo');
  assertExit(runCli(['validate'], { root: dir }), 0);
});

test('install again: your changed files are kept and listed; --update takes this version but always keeps factory/members.yaml', (t) => {
  const dir = repo(t);
  assert.equal(install(dir, '--no-open').status, 0);
  let r = install(dir, '--no-open');
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, /already up to date/);
  fs.appendFileSync(path.join(dir, 'factory/PROTOCOL.md'), '\nmine\n');
  fs.appendFileSync(path.join(dir, 'factory/members.yaml'), '\n# mine\n');
  r = install(dir, '--no-open');
  assert.match(r.stdout, /kept 2 of your files that differ from this version \(--update replaces them\):\n    factory\/PROTOCOL\.md\n    factory\/members\.yaml/);
  assert.match(fs.readFileSync(path.join(dir, 'factory/PROTOCOL.md'), 'utf8'), /mine\n$/);
  r = install(dir, '--no-open', '--update');
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, /updated 1 files/);
  assert.match(r.stdout, /kept 1 of your files that differ from this version:\n    factory\/members\.yaml/);
  assert.equal(fs.readFileSync(path.join(dir, 'factory/PROTOCOL.md'), 'utf8'), fs.readFileSync(path.join(PKG, 'factory/PROTOCOL.md'), 'utf8'));
  assert.match(fs.readFileSync(path.join(dir, 'factory/members.yaml'), 'utf8'), /# mine\n$/);
});

test('install refuses outside a git repo, in the factory\'s own repo, and on an unknown option', (t) => {
  const plain = makeTempDir('factory-install-plain-');
  t.after(() => fs.rmSync(plain, { recursive: true, force: true }));
  let r = install(plain, '--no-open');
  assert.equal(r.status, 1);
  assert.match(r.stderr, /run this inside the git repository you want the factory in/);
  assert.deepEqual(fs.readdirSync(plain), [], 'nothing was written');
  if (fs.existsSync(path.join(PKG, '.git'))) {
    r = install(PKG, '--no-open');
    assert.equal(r.status, 1);
    assert.match(r.stderr, /the factory's own repository/);
  }
  r = install(plain, '--force');
  assert.equal(r.status, 2);
  assert.match(r.stderr, /unknown option --force/);
});

test('package.json runs the installer as its bin, and ships what it copies', () => {
  const pkg = JSON.parse(fs.readFileSync(path.join(PKG, 'package.json'), 'utf8'));
  assert.deepEqual(pkg.bin, { 'software-factory': 'bin/install.mjs' });
  for (const f of ['bin', 'factory', 'tools', '.claude']) assert.ok(pkg.files.includes(f), `files has ${f}`);
  assert.match(fs.readFileSync(INSTALL, 'utf8'), /^#!\/usr\/bin\/env node\n/);
  assert.ok(fs.statSync(INSTALL).mode & 0o111, 'the installer is executable');
});
