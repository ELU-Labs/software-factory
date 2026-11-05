// The Changes tab: what a thread's branch changes against main, with line notes the owner sends to
// the lead together (a question), or as a Request changes review when the owner holds the gate.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { openStore, DIFF_MAX_CHARS } from '../lib/store.mjs';
import { startServer } from '../../tools/factory-ui/server.mjs';
import { runCli, assertExit, makeTempDir, editFrontmatterFile } from './helpers.mjs';

const UI_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../tools/factory-ui');
const REF = 'web/retry';

/** A git repo with the factory in it, a thread, and its branch: app.js changed, new.js added, old.txt removed; main moves on after. */
function repo(t, { branch = true } = {}) {
  const root = makeTempDir('factory-diff-');
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const git = (...a) => execFileSync('git', ['-C', root, '-c', 'user.name=T', '-c', 'user.email=t@example.com', '-c', 'commit.gpgsign=false', ...a], { stdio: 'pipe', encoding: 'utf8' });
  git('init', '-q', '-b', 'main');
  assertExit(runCli(['init'], { root }), 0);
  fs.writeFileSync(path.join(root, 'app.js'), 'const a = 1;\nconst b = 2;\nconst c = 3;\n');
  fs.writeFileSync(path.join(root, 'old.txt'), 'bye\n');
  git('add', '-A');
  git('commit', '-q', '-m', 'base');
  const store = openStore({ root });
  store.createThread({ as: 'you', ref: REF, title: 'Retry payments', kind: 'project' });
  if (branch) {
    git('checkout', '-q', '-b', 'factory/web/retry');
    fs.writeFileSync(path.join(root, 'app.js'), 'const a = 1;\nconst b = 20;\nconst c = 3;\n');
    fs.writeFileSync(path.join(root, 'new.js'), 'export const x = 1;\n');
    fs.rmSync(path.join(root, 'old.txt'));
    git('add', 'app.js', 'new.js', 'old.txt');
    git('commit', '-q', '-m', 'retry');
    git('checkout', '-q', 'main');
    fs.writeFileSync(path.join(root, 'main-only.txt'), 'later on main\n');
    git('add', 'main-only.txt');
    git('commit', '-q', '-m', 'main moves on');
  }
  return { root, git, store };
}

function loadPage() {
  const noop = () => {};
  const hooks = {};
  const sandbox = {
    __factoryUiTest: hooks,
    document: { addEventListener: noop, querySelector: () => null, querySelectorAll: () => [], documentElement: { dataset: {} } },
    window: { addEventListener: noop },
    location: { hash: '' },
    navigator: { platform: 'test', userAgent: 'test' },
    localStorage: { getItem: () => null, setItem: noop },
    setInterval: noop,
    clearInterval: noop,
    setTimeout,
    clearTimeout,
  };
  vm.createContext(sandbox);
  vm.runInContext(fs.readFileSync(path.join(UI_DIR, 'app.js'), 'utf8'), sandbox, { filename: 'app.js' });
  return hooks;
}

const NOTE = { id: 'n1', path: 'app.js', line: 2, side: 'new', code: 'const b = 20;', text: 'Keep the retry count at 2.' };

test('threadDiff: the branch against where it left main, committed work only; no branch yet is not an error', (t) => {
  const { store } = repo(t);
  const d = store.threadDiff(REF);
  assert.equal(d.exists, true);
  assert.equal(d.branch, 'factory/web/retry');
  assert.equal(d.base, 'main', 'origin/main when fetched, else main');
  assert.equal(d.truncated, false);
  assert.match(d.diff, /^diff --git a\/app\.js b\/app\.js$/m);
  assert.match(d.diff, /^-const b = 2;$/m);
  assert.match(d.diff, /^\+const b = 20;$/m);
  assert.match(d.diff, /^diff --git a\/new\.js b\/new\.js$/m);
  assert.match(d.diff, /^deleted file mode/m);
  assert.doesNotMatch(d.diff, /main-only/, 'what main gained since the branch left it is not the branch\'s change');

  const { store: bare } = repo(t, { branch: false });
  assert.deepEqual({ ...bare.threadDiff(REF) }, { branch: 'factory/web/retry', base: null, exists: false, diff: '', truncated: false });
});

test('threadDiff: a diff longer than the board shows is cut at a line and marked truncated', (t) => {
  const { root, git, store } = repo(t);
  git('checkout', '-q', 'factory/web/retry');
  fs.writeFileSync(path.join(root, 'big.txt'), 'a line of text that repeats\n'.repeat(Math.ceil((DIFF_MAX_CHARS * 1.2) / 28)));
  git('add', 'big.txt');
  git('commit', '-q', '-m', 'big');
  git('checkout', '-q', 'main');
  const d = store.threadDiff(REF);
  assert.equal(d.truncated, true);
  assert.ok(d.diff.length <= DIFF_MAX_CHARS && d.diff.length > DIFF_MAX_CHARS * 0.9, String(d.diff.length));
  assert.ok(d.diff.endsWith('\n'));
});

test('GET /api/diff serves the thread\'s diff; no ref is a 400', async (t) => {
  const { root, store } = repo(t);
  const srv = await startServer({ root, port: 0 });
  t.after(() => srv.close());
  let res = await fetch(`${srv.url}/api/diff?ref=${encodeURIComponent(REF)}`);
  assert.equal(res.status, 200);
  assert.deepEqual(await res.json(), store.threadDiff(REF));
  res = await fetch(`${srv.url}/api/diff`);
  assert.equal(res.status, 400);
});

test('parseDiff: files with status, counts, and each line\'s numbers on both sides', (t) => {
  const { store } = repo(t);
  const hooks = loadPage();
  const files = JSON.parse(JSON.stringify(hooks.parseDiff(store.threadDiff(REF).diff)));
  assert.deepEqual(files.map((f) => [f.path, f.status, f.add, f.del]), [['app.js', 'modified', 1, 1], ['new.js', 'added', 1, 0], ['old.txt', 'deleted', 0, 1]]);
  assert.deepEqual(files[0].hunks[0].lines, [
    { kind: ' ', text: 'const a = 1;', old: 1, new: 1 },
    { kind: '-', text: 'const b = 2;', old: 2, new: null },
    { kind: '+', text: 'const b = 20;', old: null, new: 2 },
    { kind: ' ', text: 'const c = 3;', old: 3, new: 3 },
  ]);
  const renamed = JSON.parse(JSON.stringify(hooks.parseDiff('diff --git a/x.js b/y.js\nsimilarity index 90%\nrename from x.js\nrename to y.js\n@@ -4,2 +4,2 @@ fn\n a\n-b\n+c\ndiff --git a/logo.png b/logo.png\nBinary files a/logo.png and b/logo.png differ\n')));
  assert.deepEqual(renamed.map((f) => [f.oldPath, f.path, f.status, f.binary]), [['x.js', 'y.js', 'renamed', false], ['logo.png', 'logo.png', 'modified', true]]);
  assert.deepEqual(renamed[0].hunks[0].lines.map((l) => [l.old, l.new]), [[4, 4], [5, null], [null, 5]]);
});

test('the Changes tab: a note button on every line, notes under their line, and the send bar naming who gets them', (t) => {
  const { store } = repo(t);
  const hooks = loadPage();
  hooks.state.board = store.board();
  hooks.state.route = { name: 'thread', ref: REF, tab: 'diff' };
  hooks.state.diff = { ref: REF, loading: false, data: store.threadDiff(REF), error: null };
  hooks.state.diffNotes = { [REF]: [NOTE] };
  const v = store.threadView(REF);
  const out = String(hooks.diffView(v));
  assert.match(out, /factory\/web\/retry/);
  assert.match(out, /3 files changed/);
  assert.match(out, /data-act="diff-note" data-path="app.js" data-side="new" data-line="2"/);
  assert.match(out, /data-act="diff-note" data-path="app.js" data-side="old" data-line="2"/, 'a removed line takes a note on its old number');
  assert.match(out, /<tr class="dl add">[\s\S]*?const b = 20;[\s\S]*?<\/tr><tr class="dnote">[\s\S]*?<textarea[^>]*id="dn-n1"[^>]*>Keep the retry count at 2.<\/textarea>/, 'the note sits under its line');
  assert.match(out, /1 note on these changes/);
  assert.match(out, /Request changes at brief/, 'you own the brief gate: the notes go as a review');
  assert.match(String(hooks.threadHead(v)), /href="#\/t\/web\/retry\?tab=diff"[^>]*>[\s\S]*?Changes<span class="count[^"]*">1<\/span>/);

  hooks.state.diff = { ref: REF, loading: false, data: { branch: 'factory/web/retry', base: null, exists: false, diff: '', truncated: false }, error: null };
  assert.match(String(hooks.diffView(v)), /No branch yet/);
});

test('notes go to the lead as one question with each line and its code; on a gate you own they are a Request changes review', async (t) => {
  const { root, store } = repo(t);
  const srv = await startServer({ root, port: 0 });
  t.after(() => srv.close());
  const hooks = loadPage();
  hooks.state.board = store.board();
  const notes = [NOTE, { id: 'n2', path: 'old.txt', line: 1, side: 'old', code: 'bye', text: 'Why remove this?\nIt is still read.' }];
  const send = async (req) => {
    const res = await fetch(`${srv.url}${req.path}`, { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Factory-UI': '1' }, body: JSON.stringify(req.body) });
    assert.equal(res.status, 200, await res.clone().text());
  };

  // In the build phase the gate is not yours: a question to the lead.
  editFrontmatterFile(path.join(root, 'teams', 'web', 'threads', 'retry.md'), (d) => { d.phase = 'build'; });
  let v = store.threadView(REF);
  const lead = v.thread.lead;
  let req = JSON.parse(JSON.stringify(hooks.notesRequest(v, notes)));
  assert.equal(req.path, '/api/post');
  assert.deepEqual(req.body.to, [lead]);
  await send(req);
  const q = store.threadView(REF).messages.filter((m) => m.type === 'question' && m.from === 'you').pop();
  assert.deepEqual(q.to, [lead]);
  assert.equal(q.body.trim(), [
    'Notes on the changes in factory/web/retry:',
    '',
    '- `app.js:2`: `const b = 20;`',
    '  Keep the retry count at 2.',
    '- `old.txt (removed line 1)`: `bye`',
    '  Why remove this? It is still read.',
  ].join('\n'));

  // Back at the brief, a gate you own: the notes are the points of a Request changes review.
  editFrontmatterFile(path.join(root, 'teams', 'web', 'threads', 'retry.md'), (d) => { d.phase = 'brief'; });
  v = store.threadView(REF);
  req = JSON.parse(JSON.stringify(hooks.notesRequest(v, notes)));
  assert.equal(req.path, '/api/review');
  await send(req);
  const after = store.threadView(REF);
  assert.equal(after.thread.gates.brief.status, 'changes_requested');
  const review = after.messages.filter((m) => m.type === 'review').pop();
  assert.deepEqual(review.points.map((p) => [p.severity, p.text]), [['medium', '`app.js:2`: Keep the retry count at 2.'], ['medium', '`old.txt (removed line 1)`: Why remove this?\nIt is still read.']]);
});
