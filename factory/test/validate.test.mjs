// store.validate(): a clean lifecycle validates; each single corruption is reported against its file.
import test, { before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { parseYaml, stringifyYaml, parseFrontmatter } from '../lib/yaml.mjs';
import {
  openStore, makeRoot, makeTempDir, setupTeam, setupProject, setupWatch, since, single, driveTo,
  threadTasks, editFrontmatterFile, runCli, assertExit,
} from './helpers.mjs';

let fx; // the shared clean fixture (read-only; every corruption works on a copy)

async function buildFixture() {
  const ctx = await makeRoot({ prefix: 'factory-validate-fixture-' });
  const { store, clock } = ctx;
  await setupTeam(ctx);
  const ref = await setupProject(ctx);
  await store.editSection({ as: 'fable', ref, section: 'Brief', body: 'Problem: checkout drops carts.\n' });
  const post = async (args) => {
    clock.seconds(30);
    const { added } = await since(ctx, args.ref || ref, () => store.post({ ref, ...args }));
    return single(added, (m) => m.type === args.type && m.from === args.as, `${args.type} from ${args.as}`);
  };
  const question = await post({ as: 'fable', type: 'question', to: ['openai'], body: 'Hosted or embedded checkout?' });
  const answer = await post({ as: 'openai', type: 'answer', reply_to: question.id, body: 'Hosted.' });
  await driveTo(ctx, ref, 'code_review');
  clock.minutes(10);
  await store.review({
    as: 'openai', ref, verdict: 'changes_requested', body: 'Two findings.',
    points: [{ severity: 'high', text: 'Retry loop has no backoff' }, { severity: 'low', text: 'Rename the helper' }],
  });
  const msgs = await store.messages(ref);
  const review = msgs.filter((m) => m.type === 'review').at(-1);
  clock.minutes(10);
  await store.respond({
    as: 'fable', ref, review: review.id, body: 'One accepted.',
    stances: [{ point: 1, stance: 'accepted' }, { point: 2, stance: 'rejected', reason: 'Name matches the module' }],
  });
  const response = (await store.messages(ref)).filter((m) => m.type === 'review_response').at(-1);
  await driveTo(ctx, ref, 'done');
  clock.minutes(10);
  await store.decide({ as: 'fable', ref, title: 'Use hosted checkout', body: 'Simpler PCI scope.' });
  const watch = await setupWatch(ctx);
  clock.hours(1);
  await store.watchRun({ as: 'opus-monitor', ref: watch, metrics: { error_rate: 0.031, success_rate: 0.99 }, note: 'Spike' });
  const grokNote = await post({ as: 'grok', type: 'note', body: 'Final review notes are in the PR.' });
  const finalNote = await post({ as: 'fable', type: 'note', body: 'Wrap-up: shipped.' });
  const result = (await store.messages(ref)).filter((m) => m.type === 'result').at(-1);
  const tasks = await threadTasks(store, ref);
  return { ...ctx, ref, watch, ids: { question: question.id, answer: answer.id, review: review.id, response: response.id, grokNote: grokNote.id, finalNote: finalNote.id, result: result.id }, tasks };
}

before(async () => {
  fx = await buildFixture();
});

after(() => {
  if (fx) fx.cleanup();
});

const comms = (root, id) => path.join(root, 'teams', 'checkout', 'comms', `${id}.md`);

function errorText(res) {
  return JSON.stringify({ errors: res.errors, warnings: res.warnings }, null, 2);
}

/** Copy the clean fixture, apply one corruption, validate, and expect an error that mentions one of `needles`. */
async function expectCorruption(t, mutate) {
  const copy = makeTempDir('factory-validate-copy-');
  t.after(() => fs.rmSync(copy, { recursive: true, force: true }));
  fs.cpSync(fx.root, copy, { recursive: true });
  const needles = [].concat(await mutate(copy));
  const res = await openStore({ root: copy, now: fx.clock.now }).validate();
  assert.equal(res.ok, false, `validate() must fail\n${errorText(res)}`);
  assert.ok(res.errors.length > 0);
  const hit = res.errors.some((e) => needles.some((n) => `${e.file ?? ''} ${e.message ?? ''}`.includes(n)));
  assert.ok(hit, `no error mentions ${needles.join(' or ')}\n${errorText(res)}`);
  for (const e of res.errors) {
    assert.equal(typeof e.message, 'string');
    assert.ok('file' in e, 'every error names a file');
  }
  return res;
}

test('a clean lifecycle (project to done, review loop, decision, watch run) validates ok', async () => {
  const res = await fx.store.validate();
  assert.deepEqual(res.errors, [], errorText(res));
  assert.equal(res.ok, true);
  assert.ok(Array.isArray(res.warnings));
  const view = await fx.store.thread(fx.ref);
  assert.equal(view.phase, 'done');
});

test('CLI validate: exit 0 on the clean fixture, 1 on a corrupt copy', async (t) => {
  let r = runCli(['validate'], { root: fx.root });
  assertExit(r, 0);
  const copy = makeTempDir('factory-validate-cli-');
  t.after(() => fs.rmSync(copy, { recursive: true, force: true }));
  fs.cpSync(fx.root, copy, { recursive: true });
  fs.appendFileSync(path.join(copy, 'teams', 'checkout', 'metrics.jsonl'), 'not json\n');
  r = runCli(['validate'], { root: copy });
  assertExit(r, 1);
  assert.match(`${r.stdout}\n${r.stderr}`, /metrics\.jsonl/);
  r = runCli(['validate', '--json'], { root: copy });
  const doc = r.json();
  assert.equal(doc.ok, false);
});

test('an unknown file in a team dir is a warning, not an error', async (t) => {
  const copy = makeTempDir('factory-validate-warn-');
  t.after(() => fs.rmSync(copy, { recursive: true, force: true }));
  fs.cpSync(fx.root, copy, { recursive: true });
  fs.writeFileSync(path.join(copy, 'teams', 'checkout', 'stray.txt'), 'hello');
  const res = await openStore({ root: copy, now: fx.clock.now }).validate();
  assert.deepEqual(res.errors, [], errorText(res));
  assert.equal(res.ok, true);
  assert.ok(res.warnings.some((w) => `${w.file ?? ''} ${w.message ?? ''}`.includes('stray.txt')), errorText(res));
});

// --- messages ---------------------------------------------------------------

test('message filename that does not match its id', async (t) => {
  await expectCorruption(t, (root) => {
    const id = fx.ids.finalNote;
    const renamed = `${id.slice(0, -4)}${id.endsWith('ffff') ? 'eeee' : 'ffff'}`;
    fs.renameSync(comms(root, id), comms(root, renamed));
    return [renamed, id];
  });
});

test('message id in the wrong format', async (t) => {
  await expectCorruption(t, (root) => {
    const id = fx.ids.finalNote;
    editFrontmatterFile(comms(root, id), (d) => { d.id = 'bogus-id'; });
    fs.renameSync(comms(root, id), comms(root, 'bogus-id'));
    return ['bogus-id'];
  });
});

test('message id inconsistent with its ts', async (t) => {
  await expectCorruption(t, (root) => {
    const id = fx.ids.finalNote;
    editFrontmatterFile(comms(root, id), (d) => { d.ts = new Date(Date.parse(d.ts) + 86400000).toISOString(); });
    return [id];
  });
});

test('message with an unknown type', async (t) => {
  await expectCorruption(t, (root) => {
    editFrontmatterFile(comms(root, fx.ids.finalNote), (d) => { d.type = 'gossip'; });
    return [fx.ids.finalNote];
  });
});

test('message from someone who is not a member', async (t) => {
  await expectCorruption(t, (root) => {
    editFrontmatterFile(comms(root, fx.ids.finalNote), (d) => { d.from = 'mallory'; });
    return [fx.ids.finalNote];
  });
});

test('message to someone who is not a member', async (t) => {
  await expectCorruption(t, (root) => {
    editFrontmatterFile(comms(root, fx.ids.finalNote), (d) => { d.to = ['mallory']; });
    return [fx.ids.finalNote];
  });
});

test('message on a thread that does not exist', async (t) => {
  await expectCorruption(t, (root) => {
    editFrontmatterFile(comms(root, fx.ids.finalNote), (d) => { d.thread = 'no-such-thread'; });
    return [fx.ids.finalNote];
  });
});

test('event posted by a member other than factory', async (t) => {
  await expectCorruption(t, (root) => {
    editFrontmatterFile(comms(root, fx.ids.finalNote), (d) => { d.type = 'event'; d.event = { kind: 'phase', by: 'fable' }; });
    return [fx.ids.finalNote];
  });
});

test('review_response that does not cover every point', async (t) => {
  await expectCorruption(t, (root) => {
    editFrontmatterFile(comms(root, fx.ids.response), (d) => { d.stances = d.stances.filter((s) => s.point !== 2); });
    return [fx.ids.response];
  });
});

test('review_response rejecting a point without a reason', async (t) => {
  await expectCorruption(t, (root) => {
    editFrontmatterFile(comms(root, fx.ids.response), (d) => {
      d.stances = d.stances.map((s) => {
        if (s.stance !== 'rejected') return s;
        const { reason, ...rest } = s;
        return rest;
      });
    });
    return [fx.ids.response];
  });
});

test('review_response whose reply_to is not a review', async (t) => {
  await expectCorruption(t, (root) => {
    editFrontmatterFile(comms(root, fx.ids.response), (d) => { d.reply_to = fx.ids.question; });
    return [fx.ids.response];
  });
});

test('review with duplicate point numbers', async (t) => {
  await expectCorruption(t, (root) => {
    editFrontmatterFile(comms(root, fx.ids.review), (d) => { d.points = d.points.map((p) => ({ ...p, n: 1 })); });
    return [fx.ids.review];
  });
});

test('review point with an unknown severity', async (t) => {
  await expectCorruption(t, (root) => {
    editFrontmatterFile(comms(root, fx.ids.review), (d) => { d.points[0].severity = 'critical'; });
    return [fx.ids.review];
  });
});

test('result with an unknown outcome', async (t) => {
  await expectCorruption(t, (root) => {
    editFrontmatterFile(comms(root, fx.ids.result), (d) => { d.outcome = 'meh'; });
    return [fx.ids.result];
  });
});

test('dangling reply_to', async (t) => {
  await expectCorruption(t, (root) => {
    editFrontmatterFile(comms(root, fx.ids.finalNote), (d) => { d.reply_to = '20200101T000000Z-fable-0000'; });
    return [fx.ids.finalNote];
  });
});

test('dangling refs and resolves', async (t) => {
  await expectCorruption(t, (root) => {
    editFrontmatterFile(comms(root, fx.ids.finalNote), (d) => { d.refs = ['T-999']; });
    return [fx.ids.finalNote];
  });
  await expectCorruption(t, (root) => {
    editFrontmatterFile(comms(root, fx.ids.finalNote), (d) => { d.resolves = ['20200101T000000Z-openai-0000']; });
    return [fx.ids.finalNote];
  });
});

test('resolves from a member without authority over that turn', async (t) => {
  await expectCorruption(t, (root) => {
    editFrontmatterFile(comms(root, fx.ids.grokNote), (d) => { d.resolves = [fx.ids.question]; });
    return [fx.ids.grokNote];
  });
});

// --- tasks, issues, threads, team, roster ------------------------------------

test('task with an unknown status', async (t) => {
  await expectCorruption(t, (root) => {
    editFrontmatterFile(path.join(root, 'teams', 'checkout', 'tasks', 'T-001.md'), (d) => { d.status = 'wip'; });
    return ['T-001'];
  });
});

test('task linking an issue that does not exist', async (t) => {
  await expectCorruption(t, (root) => {
    editFrontmatterFile(path.join(root, 'teams', 'checkout', 'tasks', 'T-001.md'), (d) => { d.issue = 'I-099'; });
    return ['T-001'];
  });
});

test('task filename that does not match its id', async (t) => {
  await expectCorruption(t, (root) => {
    const dir = path.join(root, 'teams', 'checkout', 'tasks');
    fs.renameSync(path.join(dir, 'T-001.md'), path.join(dir, 'T-050.md'));
    return ['T-050', 'T-001'];
  });
});

test('issue with an unknown status', async (t) => {
  await expectCorruption(t, (root) => {
    editFrontmatterFile(path.join(root, 'teams', 'checkout', 'issues', 'I-001.md'), (d) => { d.status = 'closed'; });
    return ['I-001'];
  });
});

test('thread with a wrong branch, a phase invalid for its kind, or an unknown member', async (t) => {
  const file = (root) => path.join(root, 'teams', 'checkout', 'threads', 'checkout-v2.md');
  await expectCorruption(t, (root) => {
    editFrontmatterFile(file(root), (d) => { d.branch = 'feature/checkout'; });
    return ['checkout-v2.md'];
  });
  await expectCorruption(t, (root) => {
    editFrontmatterFile(file(root), (d) => { d.phase = 'active'; });
    return ['checkout-v2.md'];
  });
  await expectCorruption(t, (root) => {
    editFrontmatterFile(file(root), (d) => { d.members = [...d.members, 'mallory']; });
    return ['checkout-v2.md'];
  });
  await expectCorruption(t, (root) => {
    editFrontmatterFile(file(root), (d) => { d.gates.code_review.status = 'maybe'; });
    return ['checkout-v2.md'];
  });
});

test('watch thread with an invalid cadence', async (t) => {
  await expectCorruption(t, (root) => {
    editFrontmatterFile(path.join(root, 'teams', 'checkout', 'threads', 'checkout-health.md'), (d) => { d.cadence = 'sometimes'; });
    return ['checkout-health.md'];
  });
});

test('team.md whose lead is not a member', async (t) => {
  await expectCorruption(t, (root) => {
    editFrontmatterFile(path.join(root, 'teams', 'checkout', 'team.md'), (d) => { d.lead = 'mallory'; });
    return ['team.md'];
  });
});

test('roster with a short code that is not 2 characters, or a duplicate id', async (t) => {
  const edit = (root, fn) => {
    const file = path.join(root, 'factory', 'members.yaml');
    const doc = parseYaml(fs.readFileSync(file, 'utf8'));
    fn(doc.members);
    fs.writeFileSync(file, stringifyYaml(doc));
  };
  await expectCorruption(t, (root) => {
    edit(root, (members) => { members.find((m) => m.id === 'grok').short = 'GRK'; });
    return ['members.yaml'];
  });
  await expectCorruption(t, (root) => {
    edit(root, (members) => { members.push({ ...members.find((m) => m.id === 'grok') }); });
    return ['members.yaml'];
  });
});

// --- append-only files ---------------------------------------------------------

test('gap in D-numbers', async (t) => {
  await expectCorruption(t, (root) => {
    fs.appendFileSync(
      path.join(root, 'teams', 'checkout', 'decisions.md'),
      '\n## D-003: Skipped a number\n\n- ts: 2026-11-01T15:30:12.345Z\n- by: you\n- thread: checkout-v2\n- message: none\n- resolves: []\n\nGap.\n',
    );
    return ['decisions.md'];
  });
});

test('duplicate D-number', async (t) => {
  await expectCorruption(t, (root) => {
    fs.appendFileSync(
      path.join(root, 'teams', 'checkout', 'decisions.md'),
      '\n## D-001: Same number again\n\n- ts: 2026-11-01T15:30:12.345Z\n- by: you\n- thread: checkout-v2\n- message: none\n- resolves: []\n\nDup.\n',
    );
    return ['decisions.md'];
  });
});

test('bad metrics.jsonl lines', async (t) => {
  await expectCorruption(t, (root) => {
    fs.appendFileSync(path.join(root, 'teams', 'checkout', 'metrics.jsonl'), 'not json\n');
    return ['metrics.jsonl'];
  });
  await expectCorruption(t, (root) => {
    fs.appendFileSync(path.join(root, 'teams', 'checkout', 'metrics.jsonl'), `${JSON.stringify({ ts: '2026-11-01T15:30:12.345Z', metrics: { error_rate: 0.01 } })}\n`);
    return ['metrics.jsonl'];
  });
});

test('validate reads the files, not a cache: fixing the corruption makes it ok again', async (t) => {
  const copy = makeTempDir('factory-validate-heal-');
  t.after(() => fs.rmSync(copy, { recursive: true, force: true }));
  fs.cpSync(fx.root, copy, { recursive: true });
  const store = openStore({ root: copy, now: fx.clock.now });
  const file = path.join(copy, 'teams', 'checkout', 'tasks', 'T-001.md');
  const original = fs.readFileSync(file);
  editFrontmatterFile(file, (d) => { d.status = 'wip'; });
  assert.equal((await store.validate()).ok, false);
  fs.writeFileSync(file, original);
  const res = await store.validate();
  assert.equal(res.ok, true, errorText(res));
  // sanity: the fixture really exercised the build loop
  assert.ok(fx.tasks.length >= 2);
  assert.ok(fx.tasks.every((x) => x.status === 'done'));
});

// --- consistency checks added for interrupted writes and config ---------------

async function validateCopy(t, mutate) {
  const copy = makeTempDir('factory-validate-extra-');
  t.after(() => fs.rmSync(copy, { recursive: true, force: true }));
  fs.cpSync(fx.root, copy, { recursive: true });
  await mutate(copy);
  return openStore({ root: copy, now: fx.clock.now }).validate();
}

test('team.md data_sources: exactly usage, traces, latency, feedback (strings or null)', async (t) => {
  const teamMd = (root) => path.join(root, 'teams', 'checkout', 'team.md');
  await expectCorruption(t, (root) => {
    editFrontmatterFile(teamMd(root), (d) => { delete d.data_sources.traces; });
    return ['data_sources is missing traces'];
  });
  await expectCorruption(t, (root) => {
    editFrontmatterFile(teamMd(root), (d) => { d.data_sources.usage = 42; });
    return ['data_sources.usage must be a string or null'];
  });
  const res = await validateCopy(t, (root) => editFrontmatterFile(teamMd(root), (d) => { d.data_sources.sessions = 'x'; }));
  assert.deepEqual(res.errors, [], errorText(res));
  assert.ok(res.warnings.some((w) => /unknown key "sessions"/.test(w.message)), errorText(res));
});

test('a message id used in two teams is an error', async (t) => {
  await expectCorruption(t, async (root) => {
    const store = openStore({ root, now: fx.clock.now });
    await store.createTeam({ as: 'you', id: 'payments', title: 'Payments', lead: 'fable' });
    fs.mkdirSync(path.join(root, 'teams', 'payments', 'comms'), { recursive: true });
    fs.copyFileSync(comms(root, fx.ids.finalNote), path.join(root, 'teams', 'payments', 'comms', `${fx.ids.finalNote}.md`));
    return [`message id ${fx.ids.finalNote} is also used by`];
  });
});

test('a write interrupted half-way is reported: a review point without its issue, a stance that never reached its issue, a phase without its event', async (t) => {
  await expectCorruption(t, (root) => {
    const dir = path.join(root, 'teams', 'checkout', 'issues');
    for (const name of fs.readdirSync(dir)) {
      const { data } = readIssue(path.join(dir, name));
      if (data.source === fx.ids.review && data.point === 2) fs.rmSync(path.join(dir, name));
    }
    return ['point 2 has no issue'];
  });
  await expectCorruption(t, (root) => {
    const dir = path.join(root, 'teams', 'checkout', 'issues');
    for (const name of fs.readdirSync(dir)) {
      const file = path.join(dir, name);
      const { data } = readIssue(file);
      if (data.source === fx.ids.review && data.point === 2) editFrontmatterFile(file, () => ({ body: 'History lost.\n' }));
    }
    return ['never reached'];
  });
  await expectCorruption(t, (root) => {
    editFrontmatterFile(path.join(root, 'teams', 'checkout', 'threads', 'checkout-v2.md'), (d) => { d.phase = 'signoff'; });
    return ['the last phase event'];
  });
});

test('warnings never tell a member to fix teams/ by hand; a non-lead lead is a warning', async (t) => {
  const res = await validateCopy(t, (root) => {
    fs.writeFileSync(path.join(root, 'teams', 'checkout', 'threads', '.tmp-ab12-checkout-v2.md'), 'partial');
    editFrontmatterFile(path.join(root, 'teams', 'checkout', 'team.md'), (d) => { d.lead = 'opus-1'; });
  });
  const tmp = res.warnings.find((w) => w.file.includes('.tmp-'));
  assert.ok(tmp, errorText(res));
  assert.match(tmp.message, /report it to the owner/);
  assert.ok(!/delete it/.test(tmp.message));
  assert.ok(res.warnings.some((w) => /lead opus-1 is a builder/.test(w.message)), errorText(res));
});

function readIssue(file) {
  return parseFrontmatter(fs.readFileSync(file, 'utf8'));
}
