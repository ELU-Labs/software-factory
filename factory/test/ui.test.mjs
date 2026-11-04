// The board server: every GET route's shape, owner-only writes, the write
// guard (Host and Origin on every bind), gate ownership on reviews, and the
// live SSE feed; plus the page's pure helpers (Markdown, times, who is up),
// loaded from app.js in a VM. Runs against a seeded root in os.tmpdir();
// never touches the repo's teams/.

import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import vm from 'node:vm';
import { fileURLToPath } from 'node:url';
import { spawn } from 'node:child_process';

import { startServer, boardAccess } from '../../tools/factory-ui/server.mjs';
import { seedDemo } from '../../tools/factory-ui/seed-demo.mjs';
import { openStore, NOTICE_TYPES, REVIEW_GATES, parseFactoryCommand, pidAlive } from '../lib/store.mjs';

const UI_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../tools/factory-ui');

/** app.js's pure helpers: the page runs in a VM with stub DOM globals and returns before it starts. */
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
  hooks.setNow = (ms) => vm.runInContext(`Date.now = () => ${Number(ms)}`, sandbox);
  return hooks;
}

let root;
let srv;
let port;

before(async () => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'factory-ui-'));
  seedDemo(root);
  srv = await startServer({ root, port: 0 });
  port = Number(new URL(srv.url).port);
});

after(async () => {
  await srv?.close();
  if (root) fs.rmSync(root, { recursive: true, force: true });
});

/** One HTTP request with full control over headers (Host, Origin included). */
function request(method, pathname, { headers = {}, body, to = port } = {}) {
  return new Promise((resolve, reject) => {
    const payload = body === undefined ? null : typeof body === 'string' ? body : JSON.stringify(body);
    const req = http.request(
      {
        host: '127.0.0.1',
        port: to,
        method,
        path: pathname,
        headers: {
          ...(payload != null ? { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(payload) } : {}),
          ...headers,
        },
      },
      (res) => {
        const chunks = [];
        res.on('data', (c) => chunks.push(c));
        res.on('end', () => {
          const text = Buffer.concat(chunks).toString('utf8');
          let json = null;
          if (String(res.headers['content-type'] || '').includes('application/json')) {
            try {
              json = JSON.parse(text);
            } catch {
              json = null;
            }
          }
          resolve({ status: res.statusCode, headers: res.headers, text, json });
        });
      },
    );
    req.on('error', reject);
    if (payload != null) req.write(payload);
    req.end();
  });
}

const get = (p) => request('GET', p);
const write = (p, body, headers = { 'X-Factory-UI': '1' }) => request('POST', p, { body, headers });
const threadView = async (ref) => (await get(`/api/thread?ref=${encodeURIComponent(ref)}`)).json;

test('serves the page, script and stylesheet with their types', async () => {
  const page = await get('/');
  assert.equal(page.status, 200);
  assert.match(page.headers['content-type'], /^text\/html/);
  assert.match(page.text, /<script src="\/app\.js"/);
  assert.match(page.headers['content-security-policy'], /default-src 'self'/);
  const js = await get('/app.js');
  assert.equal(js.status, 200);
  assert.match(js.headers['content-type'], /javascript/);
  const css = await get('/style.css');
  assert.equal(css.status, 200);
  assert.match(css.headers['content-type'], /^text\/css/);
  assert.equal((await get('/nope')).status, 404);
  assert.equal((await request('POST', '/api/board', { headers: { 'X-Factory-UI': '1' }, body: {} })).status, 405);
});

test('GET /api/board lists every team, thread and member with counts and open turns', async () => {
  const { status, json: b } = await get('/api/board');
  assert.equal(status, 200);
  assert.ok(b.generated);
  assert.ok(b.members.some((m) => m.id === 'you' && m.kind === 'human'));
  assert.deepEqual(b.teams.map((t) => t.id).sort(), ['checkout', 'search']);
  const threads = b.teams.flatMap((t) => t.threads);
  for (const th of threads) {
    for (const k of ['id', 'team', 'title', 'kind', 'phase', 'lead', 'gates', 'tasks', 'issues', 'openTurns', 'messageCount']) {
      assert.ok(k in th, `${th.team}/${th.id} has ${k}`);
    }
    assert.equal(typeof th.tasks.total, 'number');
    assert.equal(typeof th.issues.total, 'number');
    assert.ok(Array.isArray(th.openTurns));
  }
  const phases = new Set(threads.filter((t) => t.kind === 'project').map((t) => t.phase));
  for (const p of ['brief', 'design_review', 'build', 'final_review', 'done']) assert.ok(phases.has(p), `a project in ${p}`);
  const typo = threads.find((t) => t.id === 'typo-tolerance');
  assert.ok(typo.openTurns.some((o) => o.member === 'you' && o.message.type === 'proposal'));
  const health = threads.find((t) => t.id === 'checkout-health');
  assert.equal(health.kind, 'watch');
  assert.equal(health.phase, 'active');
  assert.ok(health.lastMetrics && typeof health.lastMetrics.metrics.p95_ms === 'number');
  assert.ok(threads.some((t) => t.kind === 'watch' && t.phase === 'paused'));
  const checkout = b.teams.find((t) => t.id === 'checkout');
  assert.ok(checkout.tasks.length > 0 && checkout.issues.length > 0);
});

test('GET /api/thread returns the full view of a build thread, including internal traffic', async () => {
  const v = await threadView('checkout/checkout-v2');
  for (const k of ['team', 'teamTitle', 'thread', 'messages', 'tasks', 'issues', 'decisions', 'metrics', 'reports', 'openTurns']) assert.ok(k in v, k);
  assert.equal(v.thread.phase, 'build');
  assert.ok(v.messages.some((m) => m.internal && m.type === 'dispatch'));
  assert.ok(v.messages.some((m) => m.internal && m.type === 'result'));
  assert.ok(v.messages.every((m) => typeof m.summary === 'string'));
  const statuses = new Set(v.tasks.map((t) => t.status));
  for (const s of ['todo', 'doing', 'review', 'blocked', 'done']) assert.ok(statuses.has(s), `a task in ${s}`);
  assert.ok(v.decisions.length >= 1);
});

test('GET /api/thread carries the review round trip and the watch history', async () => {
  const cards = await threadView('checkout/saved-cards');
  assert.equal(cards.thread.phase, 'design_review');
  const review = cards.messages.filter((m) => m.type === 'review' && m.verdict === 'changes_requested').at(-1);
  assert.ok(review && review.points.length >= 1);
  const response = cards.messages.find((m) => m.type === 'review_response' && m.reply_to === review.id);
  assert.ok(response && response.stances.length >= 1);

  const health = await threadView('checkout/checkout-health');
  assert.equal(health.thread.kind, 'watch');
  assert.ok(health.metrics.length >= 6, 'at least six runs');
  assert.ok(health.reports.length >= 6, 'a report per run');
  assert.ok(health.metrics.some((r) => r.breaches.length > 0), 'a breach in the history');
  assert.ok(health.issues.some((i) => i.status === 'verified'), 'breach fixed and verified');
});

test('GET /api/thread, /api/inbox and /api/validate answer bad input with codes', async () => {
  const missing = await get('/api/thread');
  assert.equal(missing.status, 400);
  assert.equal(missing.json.code, 'usage');
  const unknown = await get('/api/thread?ref=checkout/nope');
  assert.equal(unknown.status, 404);
  assert.equal(unknown.json.code, 'not_found');

  const inbox = await get('/api/inbox?member=you');
  assert.equal(inbox.status, 200);
  assert.equal(inbox.json.member, 'you');
  assert.ok(inbox.json.turns.some((o) => o.thread === 'typo-tolerance'));
  assert.ok(inbox.json.turns.every((o) => o.member === 'you'));
  const nobody = await get('/api/inbox?member=nobody');
  assert.equal(nobody.status, 404);

  const v = await get('/api/validate');
  assert.equal(v.status, 200);
  assert.deepEqual(v.json.errors, []);
  assert.ok(Array.isArray(v.json.warnings));
});

test('POST /api/post writes a message from you, whatever the body claims', async () => {
  const r = await write('/api/post', { ref: 'checkout/checkout-v2', type: 'note', body: 'Looks good from here.', as: 'fable', to: ['fable'] });
  assert.equal(r.status, 200, r.text);
  const m = r.json.message;
  assert.equal(m.from, 'you');
  assert.equal(m.internal, false);
  assert.deepEqual(m.to, ['fable']);
  assert.ok(fs.existsSync(path.resolve(root, m.path)), `the message is a file on disk (${m.path})`);
  const v = await threadView('checkout/checkout-v2');
  assert.equal(v.messages.at(-1).id, m.id);
  assert.ok(v.openTurns.some((o) => o.member === 'fable' && o.message.id === m.id));
});

test('POST /api/thread/new starts a thread from the board: your request goes to its lead or agent, and a new team comes with it', async () => {
  // A project in an existing team, with one builder: the lead and both gate owners are always in.
  const p = await write('/api/thread/new', { team: 'checkout', title: 'Cut chat latency now!', kind: 'project', builders: ['opus-2', 'openai'], prompt: 'Halve the median turn time.' });
  assert.equal(p.status, 200, p.text);
  assert.equal(p.json.ref, 'checkout/cut-chat-latency-now');
  assert.deepEqual([...p.json.thread.members].sort(), ['fable', 'grok', 'openai', 'opus-2', 'you'], 'opus-1 was left out');
  assert.equal(p.json.message.type, 'kickoff');
  assert.equal(p.json.message.from, 'you');
  assert.deepEqual(p.json.message.to, ['fable']);
  const v = await threadView(p.json.ref);
  assert.ok(v.openTurns.some((o) => o.member === 'fable' && o.message.id === p.json.message.id), 'the kickoff is a turn fable holds, so the autopilot starts it');
  // The same title again gets a free id.
  const again = await write('/api/thread/new', { team: 'checkout', title: 'Cut chat latency now', prompt: 'Again.' });
  assert.equal(again.json.ref, 'checkout/cut-chat-latency-now-2');
  // A single agent in a new team.
  const s = await write('/api/thread/new', { new_team: 'Growth Ops', title: 'Weekly signups', kind: 'solo', prompt: 'How many signups last week?' });
  assert.equal(s.status, 200, s.text);
  assert.equal(s.json.ref, 'growth-ops/weekly-signups');
  assert.equal(s.json.thread.kind, 'solo');
  assert.equal(s.json.message.type, 'question');
  assert.deepEqual(s.json.message.to, [s.json.thread.owner]);
  assert.equal((await get('/api/board')).json.teams.find((t) => t.id === 'growth-ops')?.title, 'Growth Ops');
  // A request is required, and the team must exist.
  assert.equal((await write('/api/thread/new', { team: 'checkout', title: 'No ask' })).status, 400);
  assert.equal((await write('/api/thread/new', { team: 'nope', title: 'X', prompt: 'y' })).status, 404);
});

test('POST /api/thread/new with roles: the agents and models picked set the members and gate owners; GET /api/thread/options lists the choices', async () => {
  const o = await get('/api/thread/options');
  assert.equal(o.status, 200, o.text);
  assert.deepEqual(o.json.models.map((m) => m.id), ['claude-fable-5-1', 'claude-opus-5-5', 'claude-sonnet-5-5', 'claude-haiku-5-5']);
  assert.deepEqual(o.json.builders.map((m) => m.id), ['opus-1', 'opus-2']);
  assert.ok(!('skills' in o.json), 'a role has no skill of its own');
  const roles = {
    lead: { model: 'claude-opus-5-5' },
    subagents: null,
    pair: null,
    code_review: { agent: 'you' },
    final_check: { agent: 'grok' },
  };
  const p = await write('/api/thread/new', { team: 'checkout', title: 'Roles picked', kind: 'project', prompt: 'Do it.', roles });
  assert.equal(p.status, 200, p.text);
  assert.deepEqual(p.json.thread.members, ['you', 'fable', 'grok'], 'no subagents, no pair engineer and you review the code: no builders and no openai');
  assert.equal(p.json.thread.gates.code_review.by, 'you');
  assert.equal(p.json.thread.roles.subagents, null);
  const sub = await write('/api/thread/new', { team: 'checkout', title: 'With subagents', kind: 'project', prompt: 'Do it.', roles: { ...roles, subagents: { model: 'claude-sonnet-5-5' }, code_review: { agent: 'grok' }, final_check: { agent: 'openai' } } });
  assert.equal(sub.status, 200, sub.text);
  assert.deepEqual(sub.json.thread.members, ['you', 'fable', 'opus-1', 'opus-2', 'grok', 'openai']);
  assert.deepEqual([sub.json.thread.gates.code_review.by, sub.json.thread.gates.final_review.by], ['grok', 'openai']);
  assert.deepEqual(sub.json.thread.roles.subagents, { model: 'claude-sonnet-5-5' });
  assert.deepEqual(p.json.thread.roles.final_check, { agent: 'grok' });
  const s = await write('/api/thread/new', { team: 'checkout', title: 'Solo pick', kind: 'solo', prompt: 'Count it.', roles: { agent: { model: 'claude-haiku-5-5' } } });
  assert.equal(s.status, 200, s.text);
  assert.deepEqual(s.json.thread.roles, { agent: { model: 'claude-haiku-5-5' } });
  const bad = await write('/api/thread/new', { team: 'checkout', title: 'Bad', prompt: 'x', roles: { ...roles, lead: { model: 'gpt-9' } } });
  assert.equal(bad.status, 400);
  assert.match(bad.json.error, /lead: "gpt-9"/);
});

test('POST /api/team/archive moves a team off the board as you; a missing or unnamed team is refused', async () => {
  const made = await write('/api/thread/new', { new_team: 'Archive Me', title: 'Old work', kind: 'solo', prompt: 'Count it.' });
  assert.equal(made.status, 200, made.text);
  const id = made.json.thread.team;
  assert.ok((await get('/api/board')).json.teams.some((x) => x.id === id));
  const r = await write('/api/team/archive', { team: id });
  assert.equal(r.status, 200, r.text);
  assert.equal(r.json.team.id, id);
  assert.match(r.json.path, new RegExp(`^teams/\\.archive/${id}-`));
  assert.ok(!(await get('/api/board')).json.teams.some((x) => x.id === id), 'gone from the board');
  assert.equal((await write('/api/team/archive', { team: id })).status, 404);
  assert.equal((await write('/api/team/archive', {})).status, 400);
  assert.equal((await write('/api/team/archive', { team: 'checkout' }, {})).status, 403, 'a write without the header is refused');
  // The board lists it under Archived; Restore brings it back.
  const listed = (await get('/api/board')).json.archivedTeams.find((x) => x.id === id);
  assert.equal(listed.title, 'Archive Me');
  assert.equal(listed.threads, 1);
  assert.equal((await write('/api/team/restore', {})).status, 400);
  assert.equal((await write('/api/team/restore', { name: 'nope-20260101T000000Z' })).status, 404);
  const back = await write('/api/team/restore', { name: listed.name });
  assert.equal(back.status, 200, back.text);
  assert.equal(back.json.team.id, id);
  const board = (await get('/api/board')).json;
  assert.ok(board.teams.some((x) => x.id === id), 'back on the board');
  assert.ok(!board.archivedTeams.some((x) => x.name === listed.name), 'gone from Archived');
});

test('writes are refused without the header, from a foreign origin, or cross-site', async () => {
  const body = { ref: 'checkout/checkout-v2', type: 'note', body: 'should not land' };
  const before_ = (await threadView('checkout/checkout-v2')).messages.length;

  const noHeader = await write('/api/post', body, {});
  assert.equal(noHeader.status, 403);
  assert.equal(noHeader.json.code, 'permission');

  const foreign = await write('/api/post', body, { 'X-Factory-UI': '1', Origin: 'http://evil.example' });
  assert.equal(foreign.status, 403);

  const crossSite = await write('/api/post', body, { 'X-Factory-UI': '1', 'Sec-Fetch-Site': 'cross-site' });
  assert.equal(crossSite.status, 403);

  const badHost = await request('GET', '/api/board', { headers: { Host: 'rebind.example:80' } });
  assert.equal(badHost.status, 403);

  assert.equal((await threadView('checkout/checkout-v2')).messages.length, before_, 'nothing was written');

  const own = await write('/api/post', { ...body, body: 'same origin is fine' }, { 'X-Factory-UI': '1', Origin: `http://127.0.0.1:${port}` });
  assert.equal(own.status, 200, own.text);
});

test('POST /api/post accepts only the conversational types and valid JSON', async () => {
  for (const type of ['review', 'dispatch', 'result', 'event', 'report']) {
    const r = await write('/api/post', { ref: 'checkout/checkout-v2', type, body: 'x' });
    assert.equal(r.status, 400, type);
    assert.equal(r.json.code, 'usage');
  }
  const bad = await request('POST', '/api/post', { headers: { 'X-Factory-UI': '1' }, body: '{not json' });
  assert.equal(bad.status, 400);
  assert.equal(bad.json.code, 'usage');
  const empty = await write('/api/post', { ref: 'checkout/checkout-v2', type: 'note', body: '   ' });
  assert.equal(empty.status, 400);
  const unknown = await write('/api/post', { ref: 'nowhere/none', type: 'note', body: 'x' });
  assert.equal(unknown.status, 404);
});

test('POST /api/review works only on a gate you own', async () => {
  const notMine = await write('/api/review', { ref: 'checkout/saved-cards', verdict: 'approve' });
  assert.equal(notMine.status, 403);
  assert.equal(notMine.json.code, 'permission');
  const watch = await write('/api/review', { ref: 'checkout/checkout-health', verdict: 'approve' });
  assert.equal(watch.status, 403);
  assert.equal((await threadView('checkout/saved-cards')).thread.gates.design_review.status, 'changes_requested');

  const ok = await write('/api/review', { ref: 'search/typo-tolerance', verdict: 'approve', body: 'Clear. Fuzzy-match words only; model numbers stay exact.', points: [{ severity: 'nit', text: 'Say "zero-result rate" the same way in both sections.' }, { severity: 'low', text: '  ' }] });
  assert.equal(ok.status, 200, ok.text);
  const v = await threadView('search/typo-tolerance');
  assert.equal(v.thread.gates.brief.status, 'approved');
  assert.equal(v.thread.phase, 'design');
  const review = v.messages.filter((m) => m.type === 'review').at(-1);
  assert.equal(review.from, 'you');
  assert.equal(review.points.length, 1, 'blank points are dropped');
  assert.ok(!v.openTurns.some((o) => o.member === 'you'), 'the proposal turn is closed');

  const again = await write('/api/review', { ref: 'search/typo-tolerance', verdict: 'approve' });
  assert.equal(again.status, 403, 'the thread has left your gate');
});

test('POST /api/decide records a decision as you', async () => {
  const r = await write('/api/decide', { ref: 'search/ranking-v3', title: 'Keep the 50-impression fallback', body: 'Revisit after two weeks of holdout data.', as: 'grok' });
  assert.equal(r.status, 200, r.text);
  assert.equal(r.json.decision.by, 'you');
  const v = await threadView('search/ranking-v3');
  assert.ok(v.decisions.some((d) => d.id === r.json.decision.id && d.title === 'Keep the 50-impression fallback'));
  const msg = v.messages.find((m) => m.id === r.json.message.id);
  assert.equal(msg.type, 'decision');
  assert.equal(msg.from, 'you');
  const missing = await write('/api/decide', { ref: 'search/ranking-v3', body: 'no title' });
  assert.equal(missing.status, 400);
});

test('GET /api/events says hello, then sends a change after a write', async () => {
  const events = [];
  let buf = '';
  let res;
  const req = http.get({ host: '127.0.0.1', port, path: '/api/events' });
  const waitFor = (name, ms) =>
    new Promise((resolve, reject) => {
      const deadline = setTimeout(() => reject(new Error(`no ${name} event within ${ms} ms; got ${events.map((e) => e.event).join(', ') || 'nothing'}`)), ms);
      const check = () => {
        const hit = events.find((e) => e.event === name);
        if (hit) {
          clearTimeout(deadline);
          clearInterval(tick);
          resolve(hit);
        }
      };
      const tick = setInterval(check, 25);
      check();
    });
  try {
    await new Promise((resolve, reject) => {
      req.on('response', (r) => {
        res = r;
        assert.equal(r.statusCode, 200);
        assert.match(r.headers['content-type'], /^text\/event-stream/);
        r.setEncoding('utf8');
        r.on('data', (chunk) => {
          buf += chunk;
          let i;
          while ((i = buf.indexOf('\n\n')) >= 0) {
            const block = buf.slice(0, i);
            buf = buf.slice(i + 2);
            const ev = { event: 'message', data: '' };
            for (const line of block.split('\n')) {
              if (line.startsWith('event: ')) ev.event = line.slice(7);
              else if (line.startsWith('data: ')) ev.data += line.slice(6);
            }
            if (block.split('\n').some((l) => l && !l.startsWith(':'))) events.push(ev);
          }
        });
        resolve();
      });
      req.on('error', reject);
    });
    const hello = await waitFor('hello', 3000);
    const helloData = JSON.parse(hello.data);
    assert.equal(fs.realpathSync(helloData.root), fs.realpathSync(root));
    assert.ok(helloData.sig);

    const w = await write('/api/post', { ref: 'search/instant-results', type: 'note', body: 'Shipped numbers look right.' });
    assert.equal(w.status, 200, w.text);
    const change = await waitFor('change', 6000);
    const changeData = JSON.parse(change.data);
    assert.notEqual(changeData.sig, helloData.sig);
  } finally {
    req.destroy();
    res?.destroy();
  }
});

// ---------------------------------------------------------------------------
// Access on a network bind
// ---------------------------------------------------------------------------

test('boardAccess: every bind checks Host; a network bind adds only this machine\'s names', () => {
  const lo = boardAccess({ host: '127.0.0.1', port: 4477 });
  assert.equal(lo.loopback, true);
  assert.deepEqual([...lo.hosts].sort(), ['127.0.0.1:4477', '[::1]:4477', 'localhost:4477']);
  assert.ok(lo.origins.has('http://localhost:4477'));

  const wild = boardAccess({ host: '0.0.0.0', port: 4477, names: ['192.168.1.5', 'fe80::1%en0', 'Mac.local'] });
  assert.equal(wild.loopback, false);
  assert.equal(wild.bind, '0.0.0.0');
  assert.equal(wild.url, 'http://127.0.0.1:4477');
  for (const h of ['127.0.0.1:4477', '192.168.1.5:4477', '[fe80::1]:4477', 'mac.local:4477']) assert.ok(wild.hosts.has(h), h);
  assert.ok(!wild.hosts.has('attacker.example:4477'));
  assert.ok(!wild.origins.has('http://attacker.example:4477'));

  const lan = boardAccess({ host: '192.168.1.5', port: 4477, names: [], allowHosts: ['Board.Example.com'] });
  assert.deepEqual([...lan.hosts].sort(), ['192.168.1.5:4477', 'board.example.com:4477']);
  assert.throws(() => boardAccess({ host: '127.0.0.1', port: 1, allowHosts: ['evil.example:80'] }), /not a host name/);
});

test('a network bind warns, refuses rebinding Hosts and foreign or missing Origins, and serves its own names', async () => {
  const warnings = [];
  const wild = await startServer({ root, port: 0, host: '0.0.0.0', warn: (w) => warnings.push(w) });
  try {
    const p = wild.server.address().port;
    assert.equal(warnings.length, 1);
    assert.equal(wild.warning, warnings[0]);
    assert.equal(wild.bind, `0.0.0.0:${p}`);
    assert.match(warnings[0], new RegExp(`0\\.0\\.0\\.0:${p}`));
    assert.match(warnings[0], /no sign-in/);
    assert.match(warnings[0], /acts as you/);

    const body = { ref: 'search/instant-results', type: 'note', body: 'should not land' };
    const before_ = (await threadView('search/instant-results')).messages.length;
    const evil = `attacker.example:${p}`;
    const own = `127.0.0.1:${p}`;
    assert.equal((await request('GET', '/api/board', { to: p, headers: { Host: evil } })).status, 403, 'rebinding read');
    assert.equal((await request('POST', '/api/post', { to: p, body, headers: { Host: evil, Origin: `http://${evil}`, 'X-Factory-UI': '1' } })).status, 403, 'rebinding write');
    assert.equal((await request('POST', '/api/post', { to: p, body, headers: { Host: own, Origin: `http://${evil}`, 'X-Factory-UI': '1' } })).status, 403, 'foreign Origin');
    assert.equal((await request('POST', '/api/post', { to: p, body, headers: { Host: own, 'X-Factory-UI': '1' } })).status, 403, 'no Origin on a network bind');
    assert.equal((await threadView('search/instant-results')).messages.length, before_, 'nothing was written');

    assert.equal((await request('GET', '/api/board', { to: p, headers: { Host: own } })).status, 200);
    const ok = await request('POST', '/api/post', { to: p, body: { ...body, body: 'from the board page' }, headers: { Host: own, Origin: `http://${own}`, 'X-Factory-UI': '1' } });
    assert.equal(ok.status, 200, ok.text);
  } finally {
    await wild.close();
  }
  assert.equal(srv.warning, null, 'the loopback default prints no warning');
});

// ---------------------------------------------------------------------------
// Notification turns and gates, as the board sees them
// ---------------------------------------------------------------------------

/** A fresh search project thread driven through the store to `gate` (design_review … signoff); returns its ref. */
function driveTo(gate, id) {
  const s = openStore({ root });
  const ref = `search/${id}`;
  s.createThread({ as: 'fable', ref, title: `Probe ${id}` });
  s.editSection({ as: 'fable', ref, section: 'Brief', body: '**Problem.** p\n\n**Users.** u\n\n**Success criteria.** s\n\n**Out of scope.** o' });
  s.post({ as: 'fable', ref, type: 'proposal', to: ['you'], body: 'Brief is ready.' });
  s.review({ as: 'you', ref, verdict: 'approve' });
  s.editSection({ as: 'fable', ref, section: 'Design', body: 'One endpoint.' });
  s.advance({ as: 'fable', ref });
  if (gate === 'design_review') return ref;
  s.review({ as: 'openai', ref, verdict: 'approve' });
  const task = s.createTask({ as: 'fable', ref, title: 'Build it' }).task;
  s.advance({ as: 'fable', ref });
  s.dispatch({ as: 'fable', task: `search/${task.id}`, to: 'opus-1' });
  s.result({ as: 'opus-1', task: `search/${task.id}`, outcome: 'done', body: 'Built.' });
  s.acceptTask({ as: 'fable', task: `search/${task.id}` });
  if (gate === 'code_review') return ref;
  s.review({ as: 'openai', ref, verdict: 'approve' });
  if (gate === 'final_review') return ref;
  s.review({ as: 'grok', ref, verdict: 'approve' });
  return ref;
}

test('the page and the store agree on notification types and gate-entry phases', () => {
  const page = loadPage();
  assert.deepEqual([...page.NOTIFY_TYPES].sort(), [...NOTICE_TYPES].sort());
  assert.deepEqual([...page.GATE_ENTRY].sort(), REVIEW_GATES.filter((g) => g !== 'brief').sort());
});

test('Dismiss closes an event turn you hold, without a visible message; the pending gate still shows you as up', async () => {
  const page = loadPage();
  const ref = driveTo('signoff', 'handled-probe');
  let v = await threadView(ref);
  assert.equal(v.thread.phase, 'signoff');
  const entry = v.openTurns.find((o) => o.member === 'you' && o.message.type === 'event');
  assert.ok(entry, 'entering signoff opens a notification turn for you');
  assert.equal(page.gateWait(v.thread, v.openTurns), null, 'the open turn already says you are up');

  const r = await write('/api/dismiss', { ref, id: entry.message.id });
  assert.equal(r.status, 200, r.text);
  assert.deepEqual(r.json.dismissed, [entry.message.id]);
  assert.equal(r.json.message.internal, true);
  assert.equal(page.shownInChat(r.json.message), false, 'the chat leaves the dismissal out');
  v = await threadView(ref);
  assert.ok(!v.openTurns.some((o) => o.member === 'you'), 'the dismissal closed it');
  const again = await write('/api/dismiss', { ref, id: entry.message.id });
  assert.equal(again.status, 404);
  assert.match(again.json.error, /is not waiting on you .*already closed/);
  assert.deepEqual({ ...page.gateWait(v.thread, v.openTurns) }, { member: 'you', gate: 'signoff' }, 'the gate still waits on you');

  const board = (await get('/api/board')).json;
  const th = board.teams.find((t) => t.id === 'search').threads.find((t) => t.id === 'handled-probe');
  page.state.board = board;
  assert.deepEqual([...page.waitingMembers(th)], ['you'], 'the board card and rail still count it as waiting on you');

  const signed = await write('/api/review', { ref, verdict: 'approve', body: 'Signed off.' });
  assert.equal(signed.status, 200, signed.text);
  v = await threadView(ref);
  assert.equal(v.thread.phase, 'done');
  assert.equal(page.gateWait(v.thread, v.openTurns), null);
});

test('a board decision on another member\'s gate closes that gate\'s entry turn; a sign-off by decision leaves nothing waiting on you', async () => {
  const page = loadPage();
  const ref = driveTo('final_review', 'override-probe');
  let v = await threadView(ref);
  const resolves = [...page.gateEntryTurns(v, 'final_review')];
  assert.equal(resolves.length, 1);
  assert.ok(v.openTurns.some((o) => o.member === 'grok' && o.message.id === resolves[0]), "grok holds the final-review entry turn");

  const r = await write('/api/decide', { ref, title: 'Ship without the final review', gate: 'final_review', verdict: 'approve', resolves });
  assert.equal(r.status, 200, r.text);
  v = await threadView(ref);
  assert.equal(v.thread.phase, 'signoff');
  assert.ok(!v.openTurns.some((o) => o.member === 'grok'), "grok's turn is closed");
  assert.ok(v.openTurns.some((o) => o.member === 'you' && o.message.type === 'event'), 'the signoff entry waits on you');

  const so = await write('/api/decide', { ref, title: 'Signed off', gate: 'signoff', verdict: 'approve', resolves: [...page.gateEntryTurns(v, 'signoff')] });
  assert.equal(so.status, 200, so.text);
  v = await threadView(ref);
  assert.equal(v.thread.phase, 'done');
  assert.deepEqual(v.openTurns.map((o) => `${o.member}:${o.message.type}`), [`${v.thread.lead}:event`], 'a done thread waits only on its lead, who merges the PR');
});

test('POST /api/decide forwards reply_to, which closes the turn it answers', async () => {
  const s = openStore({ root });
  const q = s.post({ as: 'fable', ref: 'search/ranking-v3', type: 'question', to: ['you'], body: 'Keep the fallback at 50 impressions?' }).message;
  const r = await write('/api/decide', { ref: 'search/ranking-v3', title: 'Keep the fallback at 50', reply_to: q.id });
  assert.equal(r.status, 200, r.text);
  assert.equal(r.json.message.reply_to, q.id);
  assert.ok(!(await threadView('search/ranking-v3')).openTurns.some((o) => o.message.id === q.id));
});

// ---------------------------------------------------------------------------
// The page's pure helpers
// ---------------------------------------------------------------------------

test('page Markdown: link labels keep code and emphasis, and no placeholder ever leaks', () => {
  const { mdInline } = loadPage();
  assert.equal(
    mdInline('Changed [`store.mjs`](https://example.com/a) and [the **PR**](https://example.com/pr).'),
    'Changed <a href="https://example.com/a" target="_blank" rel="noopener noreferrer"><code>store.mjs</code></a> and <a href="https://example.com/pr" target="_blank" rel="noopener noreferrer">the <strong>PR</strong></a>.',
  );
  for (const text of ['https://a.com/[x](https://b.com)', '[`c`](https://c.com/`d`)', 'forged \u00000\u0000 placeholder `x`', '**bold `code`** [a `b` c](#/t/x/y) T-001']) {
    const out = mdInline(text);
    assert.ok(!out.includes('\u0000'), `${JSON.stringify(text)} → ${out}`);
  }
  assert.match(mdInline('https://a.com/[x](https://b.com)'), /<a href="https:\/\/b\.com"[^>]*>x<\/a>/);
  assert.equal(mdInline('[a](javascript:alert(1))'), '[a](javascript:alert(1))');
});

test('page Markdown: an attachment renders as an image served by the board; any other image source stays text', () => {
  const { mdInline } = loadPage();
  const out = mdInline('See ![login page](teams/chat/attachments/20261104T060000Z-you-ab12.png) now');
  assert.match(out, /<img class="md-img" src="\/api\/attachment\?path=teams%2Fchat%2Fattachments%2F20261104T060000Z-you-ab12\.png" alt="login page" loading="lazy">/);
  assert.match(out, /^See <a class="md-img-link" href="\/api\/attachment\?path=[^"]+" target="_blank"/);
  assert.ok(!mdInline('![x](https://evil.example/a.png)').includes('<img'), 'no remote images');
  assert.ok(!mdInline('![x](teams/chat/attachments/../../../etc/passwd)').includes('<img'), 'no path escapes');
  assert.ok(!mdInline('![x" onerror="alert(1)](teams/chat/attachments/a.png)').includes('onerror="'), 'alt is escaped');
});

test('images: POST /api/attach saves one beside the team\'s messages; GET /api/attachment serves it and nothing else', async () => {
  // A real PNG header, then padding: over the 1 MB JSON limit of other routes once base64-encoded.
  const png = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.alloc(1200 * 1024, 7)]);
  const r = await write('/api/attach', { ref: 'checkout/checkout-v2', type: 'image/png', name: 'Login [step 2].png', data: png.toString('base64') });
  assert.equal(r.status, 200, r.text);
  assert.match(r.json.path, /^teams\/checkout\/attachments\/\d{8}T\d{6}Z-you-[0-9a-f]{4}\.png$/);
  assert.equal(r.json.markdown, `![Login step 2](${r.json.path})`, 'the name, without its extension or brackets');
  assert.deepEqual(fs.readFileSync(path.join(root, r.json.path)), png);

  const img = await get(`/api/attachment?path=${encodeURIComponent(r.json.path)}`);
  assert.equal(img.status, 200);
  assert.equal(img.headers['content-type'], 'image/png');
  assert.equal(Number(img.headers['content-length']), png.length);
  assert.match(img.headers['content-security-policy'], /sandbox/);
  for (const bad of ['../../etc/passwd', 'teams/checkout/comms/x.md', 'teams/checkout/attachments/../threads/checkout-v2.md', 'teams/checkout/attachments/x.svg']) {
    assert.equal((await get(`/api/attachment?path=${encodeURIComponent(bad)}`)).status, 400, bad);
  }
  assert.equal((await get('/api/attachment?path=teams%2Fcheckout%2Fattachments%2F20261104T060000Z-you-ffff.png')).status, 404);

  // Only real images, of the four types, from the board page.
  const fake = await write('/api/attach', { ref: 'checkout/checkout-v2', type: 'image/png', name: 'x.png', data: Buffer.from('not a png').toString('base64') });
  assert.equal(fake.status, 400);
  assert.match(fake.json.error, /not a PNG image/);
  const svg = await write('/api/attach', { ref: 'checkout/checkout-v2', type: 'image/svg+xml', name: 'x.svg', data: Buffer.from('<svg/>').toString('base64') });
  assert.equal(svg.status, 400);
  assert.equal((await write('/api/attach', { ref: 'checkout/checkout-v2', type: 'image/png', data: png.toString('base64') }, {})).status, 403);

  // A message carries it; validate knows the folder.
  const post = await write('/api/post', { ref: 'checkout/checkout-v2', type: 'note', body: `Screenshot:\n${r.json.markdown}` });
  assert.equal(post.status, 200, post.text);
  const v = await get('/api/validate');
  assert.ok(!JSON.stringify(v.json).includes('attachments'), 'no validate finding about the attachments folder');
});

test('page times: units truncate and days count calendar days, matching the day separators', () => {
  const page = loadPage();
  const now = new Date(2026, 9, 31, 18, 35).getTime();
  page.setNow(now);
  const yesterdayEarly = new Date(2026, 9, 30, 4, 35).toISOString();
  assert.equal(page.dayLabel(yesterdayEarly), 'Yesterday');
  assert.equal(page.rel(yesterdayEarly), '1d ago', '38 h ago, but yesterday');
  assert.equal(page.rel(new Date(2026, 9, 29, 23, 0).toISOString()), '2d ago');
  assert.equal(page.rel(new Date(now - 23.6 * 3600e3).toISOString()), '23h ago');
  assert.equal(page.rel(new Date(now - 59.5 * 60e3).toISOString()), '59m ago');
});

test('page review blocks name the gate once', async () => {
  const page = loadPage();
  const v = await threadView('checkout/saved-cards');
  const ctx = page.threadCtx(v);
  const blocks = v.messages.filter((m) => m.type === 'review_response').map((m) => String(page.typeBlock(m, ctx)));
  assert.ok(blocks.length >= 2);
  for (const b of blocks) {
    assert.doesNotMatch(b, /review review/i);
    assert.match(b, /<span>at<\/span><span class="mono">Design review<\/span>/);
  }
});

test('page composer: review points with text go out only with a verdict, and only on your gate', () => {
  const { pendingPoints } = loadPage();
  const d = { points: [{ severity: 'nit', text: 'nit wording' }, { severity: 'low', text: '  ' }] };
  const mine = { kind: 'project', phase: 'brief', gates: { brief: { by: 'you', status: 'pending' } } };
  assert.equal(pendingPoints(mine, d).length, 1);
  assert.equal(pendingPoints({ ...mine, phase: 'design' }, d).length, 0);
  assert.equal(pendingPoints({ ...mine, gates: { brief: { by: 'openai', status: 'pending' } } }, d).length, 0);
});

test('the hidden attribute wins over component display rules', () => {
  const css = fs.readFileSync(path.join(UI_DIR, 'style.css'), 'utf8');
  assert.match(css, /\[hidden\]\s*\{\s*display:\s*none\s*!important;?\s*\}/);
  assert.match(css, /\.composer\s*\{[^}]*display:\s*grid/, 'the rule above is what keeps a hidden composer hidden');
});

test('etimeSeconds reads ps elapsed times', async () => {
  const { etimeSeconds } = await import('../lib/store.mjs');
  assert.equal(etimeSeconds('05:35'), 335);
  assert.equal(etimeSeconds('10:51:09'), 39069);
  assert.equal(etimeSeconds('01-20:51:57'), 161517);
  assert.equal(etimeSeconds('nonsense'), null);
});

test('parseFactoryCommand: only node running factory.mjs ui or autopilot counts; roots with spaces, relative roots and no root are read', () => {
  const P = parseFactoryCommand;
  const spaced = fs.mkdtempSync(path.join(os.tmpdir(), 'factory ui spaced-'));
  try {
    assert.deepEqual(P(`node /r/factory/bin/factory.mjs autopilot --root ${spaced}`), { kind: 'autopilot', root: spaced, root_from: 'flag', one_shot: false });
    assert.equal(P(`node /r/factory/bin/factory.mjs ui --root ${spaced} --port 4477`).root, spaced);
  } finally {
    fs.rmSync(spaced, { recursive: true, force: true });
  }
  assert.deepEqual(P('/usr/local/bin/node --max-old-space-size=8192 /r/factory/bin/factory.mjs --root /tmp autopilot'), { kind: 'autopilot', root: '/tmp', root_from: 'flag', one_shot: false });
  assert.equal(P('node factory/bin/factory.mjs --port 4800 ui').kind, 'board', 'a value flag before the command');
  // No --root: the repo that holds the CLI, a relative path read from the process's working directory.
  assert.deepEqual(P('node factory/bin/factory.mjs autopilot', () => '/repo'), { kind: 'autopilot', root: '/repo', root_from: 'cli', one_shot: false });
  assert.equal(P('node factory/bin/factory.mjs ui --root sub', () => '/work').root, '/work/sub');
  assert.equal(P('node factory/bin/factory.mjs ui').root, null, 'no working directory, no guess');
  // $FACTORY_ROOT wins over the CLI's repo, as it does in the CLI.
  assert.deepEqual(P('node factory/bin/factory.mjs autopilot', () => '/repo', (n) => (n === 'FACTORY_ROOT' ? '/elsewhere' : null)), { kind: 'autopilot', root: '/elsewhere', root_from: 'env', one_shot: false });
  // One-shot invocations.
  for (const f of ['--detach', '--stop', '--dry-run', '--once']) assert.equal(P(`node /r/factory/bin/factory.mjs autopilot ${f}`).one_shot, true, f);
  // Not factory processes: shells that mention it, other commands, values that read like a command.
  for (const cmd of [
    "/bin/zsh -c source /x && eval 'node factory/bin/factory.mjs ui --root /tmp' < /dev/null",
    'sh -c node factory/bin/factory.mjs autopilot',
    'node factory/bin/factory.mjs post a/b --body autopilot --as you',
    'node factory/bin/factory.mjs wait a/b --as fable',
    'node /r/myfactory.mjs ui',
    'tail -f teams/.autopilot/autopilot.log factory.mjs autopilot',
  ]) assert.equal(P(cmd), null, cmd);
});

test('autopilot(): a dead autopilot\'s runs that still run are listed as leftover', async (t) => {
  const s = openStore({ root });
  const dir = path.join(root, 'teams', '.autopilot');
  const file = path.join(dir, 'state.json');
  const before = fs.existsSync(file) ? fs.readFileSync(file, 'utf8') : null;
  const sleeper = spawn('sleep', ['30'], { stdio: 'ignore' });
  t.after(() => {
    sleeper.kill();
    if (before == null) fs.rmSync(file, { force: true });
    else fs.writeFileSync(file, before);
  });
  const dead = spawn(process.execPath, ['-e', '0']);
  await new Promise((r) => dead.on('close', r));
  fs.mkdirSync(dir, { recursive: true });
  const run = { pid: sleeper.pid, bin: '/bin/sleep', ref: 'chat/x', started_at: '2026-11-02T10:00:00.000Z' };
  fs.writeFileSync(file, JSON.stringify({ pid: dead.pid, members: { openai: { enabled: true, running: run }, grok: { enabled: false, running: { ...run, pid: dead.pid } } } }));
  const ap = s.autopilot();
  assert.equal(ap.alive, false);
  assert.equal(ap.members.openai.running, null, 'a dead autopilot has no runs of its own');
  assert.deepEqual(ap.leftover_runs, [{ member: 'openai', pid: sleeper.pid, ref: 'chat/x', started_at: '2026-11-02T10:00:00.000Z' }], 'only the run that still runs');
});

test('Running panel: /api/processes lists factory processes; /api/process stops this root\'s autopilot or another root\'s, starts it again, and touches nothing else', async (t) => {
  const { runCli } = await import('./helpers.mjs');
  const other = fs.mkdtempSync(path.join(os.tmpdir(), 'factory-ui-other-'));
  seedDemo(other);
  // No agent CLI: the autopilots start nothing. The board's own start inherits this environment.
  const env = { FACTORY_CODEX_BIN: path.join(other, 'no-codex'), FACTORY_CLAUDE_BIN: path.join(other, 'no-claude') };
  const saved = { codex: process.env.FACTORY_CODEX_BIN, claude: process.env.FACTORY_CLAUDE_BIN };
  Object.assign(process.env, env);
  // Registered before anything can fail, so a failing run leaves no autopilot behind.
  t.after(() => {
    runCli(['autopilot', '--stop'], { root });
    runCli(['autopilot', '--stop'], { root: other });
    fs.rmSync(other, { recursive: true, force: true });
    if (saved.codex === undefined) delete process.env.FACTORY_CODEX_BIN; else process.env.FACTORY_CODEX_BIN = saved.codex;
    if (saved.claude === undefined) delete process.env.FACTORY_CLAUDE_BIN; else process.env.FACTORY_CLAUDE_BIN = saved.claude;
  });
  const mine = runCli(['autopilot', '--detach', '--json'], { root, env }).json().pid;
  const theirs = runCli(['autopilot', '--detach', '--json'], { root: other, env }).json().pid;
  const until = async (fn, ms = 15000) => {
    for (const end = Date.now() + ms; Date.now() < end; await new Promise((r) => setTimeout(r, 200))) if (await fn()) return true;
    return false;
  };
  const list = async () => (await get('/api/processes')).json.list;
  // ps lists a process a moment after it starts; the scan skips anything under 5 seconds old.
  assert.ok(await until(async () => (await list()).some((p) => p.pid === theirs), 20000), 'the other root\'s autopilot is listed');
  const rows = await list();
  const a = rows.find((p) => p.pid === mine);
  const b = rows.find((p) => p.pid === theirs);
  assert.deepEqual({ kind: a.kind, here: a.here, main: a.main }, { kind: 'autopilot', here: true, main: true });
  assert.deepEqual({ kind: b.kind, here: b.here, main: b.main }, { kind: 'autopilot', here: false, main: false });
  for (const p of rows) assert.match(p.kind, /^(autopilot|board)$/);

  // Only a listed factory process is stopped: never another pid.
  const stranger = await write('/api/process', { action: 'stop', pid: process.pid });
  assert.equal(stranger.status, 404);
  assert.match(stranger.json.error, /is not a factory autopilot or board/);
  assert.equal((await write('/api/process', { action: 'restart' })).status, 400);
  // Writes come from the board page only.
  assert.equal((await request('POST', '/api/process', { body: { action: 'stop', pid: theirs }, headers: { Origin: 'http://evil.example' } })).status, 403);
  assert.ok(pidAlive(theirs));

  // Another root's autopilot: stopped by its pid.
  assert.equal((await write('/api/process', { action: 'stop', pid: theirs })).status, 200);
  assert.ok(await until(() => !pidAlive(theirs)), 'the other root\'s autopilot exits');
  assert.ok(pidAlive(mine), 'this root\'s autopilot is untouched');
  // This root's: through `autopilot --stop`, then started again from the board.
  const stopped = await write('/api/process', { action: 'stop', pid: mine });
  assert.equal(stopped.status, 200);
  assert.equal(stopped.json.stopped, true);
  assert.equal(pidAlive(mine), false);
  const started = await write('/api/process', { action: 'start' });
  assert.equal(started.status, 200, started.text);
  const again = started.json.pid;
  assert.ok(pidAlive(again));
  assert.equal(openStore({ root }).autopilot().pid, again);
  // Stopped right after it started (younger than the scan's 5 seconds): found by its state, not the scan.
  const quick = await write('/api/process', { action: 'stop', pid: again });
  assert.equal(quick.status, 200, quick.text);
  assert.equal(pidAlive(again), false);
  // stop-autopilot works with no pid, and with nothing running says so.
  const third = (await write('/api/process', { action: 'start' })).json.pid;
  assert.equal((await write('/api/process', { action: 'stop-autopilot' })).status, 200);
  assert.equal(pidAlive(third), false);
  assert.equal((await write('/api/process', { action: 'stop-autopilot' })).json.running, false);
});

test('Running panel: a shell that only mentions a factory command is never listed or stopped', async (t) => {
  const sh = spawn('/bin/sh', ['-c', `sleep 30; echo node factory/bin/factory.mjs ui --root ${root}`], { stdio: 'ignore' });
  t.after(() => sh.kill());
  await new Promise((r) => setTimeout(r, 5500));
  const { list } = (await get('/api/processes')).json;
  assert.equal(list.some((p) => p.pid === sh.pid), false);
  assert.equal((await write('/api/process', { action: 'stop', pid: sh.pid })).status, 404);
  assert.ok(pidAlive(sh.pid));
});
