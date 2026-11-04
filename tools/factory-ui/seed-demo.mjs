#!/usr/bin/env node
// Seeds a demo factory root for the board UI, through the store API only (it
// never writes a state file itself). The board's tests seed with it too.
//
//   node tools/factory-ui/seed-demo.mjs <root>
//
// Two teams, six project threads (brief, design_review, build, final_review and
// two done), two watch threads (one with eight daily runs: a breach → issue →
// a fix on its own project thread, reviewed and signed off → verified by the
// next run, then a new breach), dispatch/result traffic, reviews with
// responses, and decisions. The clock runs from about eight days ago up to now,
// so relative times in the UI read naturally. Event, alert and report turns are
// notifications: the store closes them on the holder's next write in the
// thread, so the seed never resolves them by hand.
//
// It lives here, not in factory/test/, because `node --test` run inside
// factory/ treats every file under test/ as a test file.
//
// Refuses to seed the repo's own root, or a root that already has teams.

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { openStore } from '../../factory/lib/store.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(HERE, '../..');
const HOUR = 3600 * 1000;

function real(p) {
  try {
    return fs.realpathSync(p);
  } catch {
    return path.resolve(p);
  }
}

/**
 * Seed `root` with the demo. Returns {root, teams, threads, openTurns, last}.
 * @param {string} root an empty or new directory (never the repo root)
 * @param {{end?: number}} [options] end: epoch ms the timeline finishes just before (default now)
 */
export function seedDemo(root, { end = Date.now() } = {}) {
  if (!root) throw new Error('usage: node tools/factory-ui/seed-demo.mjs <root>');
  const abs = path.resolve(root);
  if (real(abs) === real(REPO_ROOT)) {
    throw new Error(`refusing to seed ${abs}: that is the repo root, whose teams/ is real factory state; pass a scratch directory`);
  }
  const teamsDir = path.join(abs, 'teams');
  if (fs.existsSync(teamsDir) && fs.readdirSync(teamsDir).some((n) => fs.existsSync(path.join(teamsDir, n, 'team.md')))) {
    throw new Error(`refusing to seed ${abs}: teams/ already has teams; pass an empty directory`);
  }
  fs.mkdirSync(abs, { recursive: true });

  const SPAN_HOURS = 198;
  const t0 = Math.floor((end - SPAN_HOURS * HOUR) / 60000) * 60000;
  let t = t0;
  const store = openStore({ root: abs, now: () => t });
  store.init();

  // ---- timeline plumbing ---------------------------------------------------
  const plan = [];
  const at = (h, fn) => plan.push({ h, i: plan.length, fn });

  const post = (as, ref, type, body, opts = {}) => store.post({
    as, ref, type, body, to: opts.to || [], cc: opts.cc || [], reply_to: opts.reply_to ?? null, refs: opts.refs || [], internal: Boolean(opts.internal), resolves: opts.resolves || [],
  }).message;
  const brief = (ref, { problem, users, success, out }) => store.editSection({
    as: 'fable', ref, section: 'Brief',
    body: `**Problem.** ${problem}\n\n**Users.** ${users}\n\n**Success criteria.** ${success}\n\n**Out of scope.** ${out}`,
  });
  /** The lead finishing its own task: a done result, then an accept when the store leaves it in review. */
  const leadDone = (taskRef, body) => {
    const r = store.result({ as: 'fable', task: taskRef, outcome: 'done', body });
    if (r.task.status !== 'done') store.acceptTask({ as: 'fable', task: taskRef });
    return r;
  };
  const ctx = {};

  // ---- teams ---------------------------------------------------------------
  at(0, () => {
    store.createTeam({ as: 'you', id: 'checkout', title: 'Checkout', lead: 'fable' });
    store.createTeam({ as: 'you', id: 'search', title: 'Search', lead: 'fable' });
  });

  // ======================================================================
  // checkout/checkout-health — watch, daily, 8 runs
  // ======================================================================
  const HEALTH = 'checkout/checkout-health';
  at(0.2, () => {
    store.createThread({
      as: 'fable', ref: HEALTH, title: 'Checkout health', kind: 'watch', owner: 'opus-monitor', cadence: 'daily',
      thresholds: { error_rate: { max: 0.02 }, success_rate: { min: 0.98 }, p95_ms: { max: 1200 } },
    });
    store.editSection({ as: 'fable', ref: HEALTH, section: 'What we watch', body: 'The pay step of checkout, from **Place order** to the confirmation page.\n\n- `error_rate`: failed payment calls / payment calls (traces)\n- `success_rate`: confirmations / checkouts started (analytics)\n- `p95_ms`: 95th percentile pay-step latency (traces)' });
    store.editSection({ as: 'fable', ref: HEALTH, section: 'Thresholds', body: '- `error_rate` ≤ 2%: above that, support tickets double within a day.\n- `success_rate` ≥ 98%: the quarter target.\n- `p95_ms` ≤ 1200: past this, abandonment on mobile climbs fast.' });
    store.editSection({ as: 'fable', ref: HEALTH, section: 'Runbook', body: '1. Check the provider status page and the last deploy.\n2. Open or update the metric issue; attach the report.\n3. Two breaches in a row on the same metric: escalate to **you**.' });
  });
  const run = (h, metrics, note) => at(h, () => {
    const r = store.watchRun({ as: 'opus-monitor', ref: HEALTH, metrics, note });
    ctx.lastRun = r;
    return r;
  });
  run(8, { error_rate: 0.011, success_rate: 0.992, p95_ms: 840 });
  run(32, { error_rate: 0.013, success_rate: 0.99, p95_ms: 905 });
  run(56, { error_rate: 0.034, success_rate: 0.981, p95_ms: 960 }, 'Error spike starts 14:10 UTC, right after the pay button change; retries are double-submitting on slow connections.');
  // The breach is fixed on its own project thread (watch threads hold no tasks),
  // so the fix is reviewed and signed off before the next run verifies it.
  const PAY = 'checkout/pay-double-submit';
  at(56.5, () => {
    store.createThread({ as: 'fable', ref: PAY, title: 'Stop double charges from the pay button' });
    brief(PAY, {
      problem: 'Since the pay button change, a slow payment call leaves the button enabled; a second tap sends a second charge. Error rate on the pay step hit 3.4% (checkout health, last run).',
      users: 'Every buyer on a slow connection, mostly mobile.',
      success: 'error_rate back under 2% on the next daily run, and no double charges in the payment provider report for a week.',
      out: 'The rest of checkout v2.',
    });
    post('fable', PAY, 'proposal', 'Hotfix brief for the double-charge breach in checkout health. Small scope; approve so we can fix it today.', { to: ['you'] });
  });
  at(57, () => store.review({ as: 'you', ref: PAY, verdict: 'approve', body: 'Yes, fix it now.' }));
  at(57.5, () => {
    store.editSection({ as: 'fable', ref: PAY, section: 'Design', body: 'Disable the pay button from submit until the payment call settles, and send an idempotency key with every payment call so a retry can never charge twice.' });
    store.advance({ as: 'fable', ref: PAY });
  });
  at(58, () => store.review({ as: 'openai', ref: PAY, verdict: 'approve', body: 'Both halves are needed: the disabled button stops taps, the key stops retries. Approved.' }));
  at(58.5, () => {
    const r = ctx.lastRun;
    const issue = r.issues.opened[0];
    const acc = store.acceptIssue({ as: 'fable', issue: `checkout/${issue.id}`, thread: PAY, action: 'Stop double-submitting the pay button on slow connections' });
    ctx.healthTask = acc.task;
    store.advance({ as: 'fable', ref: PAY });
    post('fable', HEALTH, 'note', `Accepted ${issue.id} as ${acc.task.id} on the hotfix thread; opus-2 takes it today. Looks like the pay button stays enabled while the first request is in flight.`, { refs: [issue.id, acc.task.id] });
    store.dispatch({ as: 'fable', task: `checkout/${acc.task.id}`, to: 'opus-2', body: `Please take **${acc.task.id}**: disable the pay button until the payment call settles, and add an idempotency key so a retry can never charge twice.` });
  });
  at(65, () => store.result({ as: 'opus-2', task: `checkout/${ctx.healthTask.id}`, outcome: 'done', body: 'Pay button now disables on submit and the request carries an idempotency key. Added a test that fires two submits 50 ms apart; one charge.' }));
  at(66, () => store.acceptTask({ as: 'fable', task: `checkout/${ctx.healthTask.id}`, body: 'Verified on the preview.' }));
  at(68, () => store.review({ as: 'openai', ref: PAY, verdict: 'approve', body: 'The key is generated once per checkout attempt and reused on retry. Approved.' }));
  at(72, () => store.review({ as: 'grok', ref: PAY, verdict: 'approve', body: 'Ran the **Pay on 3G** end-to-end suite against the preview: 12 of 12 journeys pass, one charge each.' }));
  at(74, () => store.review({ as: 'you', ref: PAY, verdict: 'approve', body: 'Signed off. Merge it.' }));
  run(80, { error_rate: 0.017, success_rate: 0.988, p95_ms: 1010 });
  run(104, { error_rate: 0.012, success_rate: 0.991, p95_ms: 1090 });
  run(128, { error_rate: 0.014, success_rate: 0.989, p95_ms: 1150 });
  run(152, { error_rate: 0.013, success_rate: 0.99, p95_ms: 1262 }, 'Latency has crept up for four days; the new address autocomplete adds a call before pay.');
  at(154, () => {
    const r = ctx.lastRun;
    post('fable', HEALTH, 'note', `Seen. ${r.issues.opened.map((i) => i.id).join(', ')} stays open while we confirm it is the autocomplete call; one more run before we act.`, { refs: r.issues.opened.map((i) => i.id) });
  });
  run(176, { error_rate: 0.012, success_rate: 0.991, p95_ms: 1318 }, 'Second breach in a row on p95_ms.');

  // ======================================================================
  // search/search-quality — watch, three runs, then paused
  // ======================================================================
  const QUALITY = 'search/search-quality';
  at(90, () => {
    store.createThread({
      as: 'fable', ref: QUALITY, title: 'Search quality', kind: 'watch', owner: 'opus-monitor', cadence: 'daily',
      thresholds: { zero_result_rate: { max: 0.08 }, click_through: { min: 0.35 } },
    });
    store.editSection({ as: 'fable', ref: QUALITY, section: 'What we watch', body: 'Search result quality on the main search box: share of queries with no results, and click-through on the first page.' });
  });
  at(100, () => store.watchRun({ as: 'opus-monitor', ref: QUALITY, metrics: { zero_result_rate: 0.061, click_through: 0.41 } }));
  at(124, () => store.watchRun({ as: 'opus-monitor', ref: QUALITY, metrics: { zero_result_rate: 0.058, click_through: 0.43 } }));
  at(148, () => store.watchRun({ as: 'opus-monitor', ref: QUALITY, metrics: { zero_result_rate: 0.064, click_through: 0.39 } }));
  at(160, () => {
    store.setWatchState({ as: 'fable', ref: QUALITY, state: 'paused' });
    post('fable', QUALITY, 'note', 'Paused while ranking v3 shadow traffic skews click-through. Resume after the final review.', { cc: ['you'] });
  });

  // ======================================================================
  // search/instant-results — project, done
  // ======================================================================
  const INSTANT = 'search/instant-results';
  at(0.5, () => store.createThread({ as: 'fable', ref: INSTANT, title: 'Instant results dropdown' }));
  at(1, () => {
    brief(INSTANT, {
      problem: 'Shoppers type a query, press Enter, wait for a full results page, then refine. 38% of searches are refined at least once.',
      users: 'Everyone who uses the search box; about 41k searches a day.',
      success: 'Median time to first product click drops by 30%; refinement rate drops below 30%.',
      out: 'Ranking changes (ranking v3 owns those) and the mobile app.',
    });
    post('fable', INSTANT, 'proposal', 'Brief is ready: results appear as you type, in a dropdown under the search box. Approve when it reads right.', { to: ['you'] });
  });
  at(3, () => store.review({ as: 'you', ref: INSTANT, verdict: 'approve', body: 'Clear and measurable. Go.' }));
  at(5, () => {
    store.editSection({ as: 'fable', ref: INSTANT, section: 'Design', body: 'A debounced query endpoint (`/api/search/suggest`, 150 ms) returns the top 6 products. The dropdown is a listbox with full keyboard support. We reuse the existing product card at a compact size.\n\n**Rejected:** client-side index (too large for the catalogue).' });
    store.advance({ as: 'fable', ref: INSTANT, body: 'Design is written; over to review.' });
  });
  at(9, () => store.review({ as: 'openai', ref: INSTANT, verdict: 'approve', points: [{ severity: 'nit', text: 'Call the endpoint `/api/search/suggestions` to match the other plural routes.' }], body: 'Approach is sound. One naming nit.' }));
  at(10, () => {
    store.respond({ as: 'fable', ref: INSTANT, stances: [{ point: 1, stance: 'deferred', reason: 'We rename all suggest routes together next sprint.' }], body: 'Deferring the rename so every route changes at once.' });
    store.editSection({ as: 'fable', ref: INSTANT, section: 'Plan', body: '1. Debounced query endpoint\n2. Dropdown with keyboard navigation\n3. Analytics events for the dropdown' });
    ctx.i1 = store.createTask({ as: 'fable', ref: INSTANT, title: 'Debounced query endpoint', body: 'Return the top 6 products for a prefix in under 80 ms p95.\n\n## Acceptance\n\n- [ ] p95 under 80 ms on the staging catalogue\n- [ ] contract test for the response shape' }).task;
    ctx.i2 = store.createTask({ as: 'fable', ref: INSTANT, title: 'Dropdown with keyboard navigation' }).task;
    ctx.i3 = store.createTask({ as: 'fable', ref: INSTANT, title: 'Analytics events for the dropdown' }).task;
    store.advance({ as: 'fable', ref: INSTANT });
  });
  at(11, () => {
    store.dispatch({ as: 'fable', task: `search/${ctx.i1.id}`, to: 'opus-1' });
    store.dispatch({ as: 'fable', task: `search/${ctx.i2.id}`, to: 'opus-2' });
  });
  at(20, () => {
    store.result({ as: 'opus-1', task: `search/${ctx.i1.id}`, outcome: 'done', body: 'Endpoint is live behind the flag; p95 is 54 ms on staging.' });
    store.acceptTask({ as: 'fable', task: `search/${ctx.i1.id}` });
    store.dispatch({ as: 'fable', task: `search/${ctx.i3.id}`, to: 'opus-1' });
  });
  at(26, () => {
    store.result({ as: 'opus-2', task: `search/${ctx.i2.id}`, outcome: 'done', body: 'Dropdown done, arrows and Enter work.' });
    store.rejectTask({ as: 'fable', task: `search/${ctx.i2.id}`, reason: 'ArrowDown from the input skips the first suggestion. Add a test for it.' });
  });
  at(30, () => {
    store.result({ as: 'opus-2', task: `search/${ctx.i2.id}`, outcome: 'done', body: 'Fixed the off-by-one and added the keyboard test.' });
    store.acceptTask({ as: 'fable', task: `search/${ctx.i2.id}` });
  });
  at(34, () => {
    store.result({ as: 'opus-1', task: `search/${ctx.i3.id}`, outcome: 'done', body: 'Added `search_suggestion_shown` and `search_suggestion_clicked`.' });
    store.acceptTask({ as: 'fable', task: `search/${ctx.i3.id}` });
  });
  at(38, () => store.review({
    as: 'openai', ref: INSTANT, verdict: 'changes_requested',
    points: [
      { severity: 'medium', text: 'The debounce runs after the fetch, so every keystroke still sends a request. Debounce before fetching.' },
      { severity: 'low', text: 'The listbox is missing aria-activedescendant, so screen readers do not announce the highlighted item.' },
    ],
    body: 'Two fixes before this can ship.',
  }));
  at(40, () => store.respond({ as: 'fable', ref: INSTANT, stances: [{ point: 1, stance: 'accepted', action: 'Debounce before fetch, not after' }, { point: 2, stance: 'accepted' }], body: 'Both accepted; back to build.' }));
  at(41, () => {
    const tasks = store.tasks({ thread: INSTANT, status: 'todo' });
    ctx.i4 = tasks[0];
    ctx.i5 = tasks[1];
    post('fable', INSTANT, 'note', `Picking these up now: ${ctx.i4.id} to opus-1, ${ctx.i5.id} to opus-2.`, { refs: [ctx.i4.id, ctx.i5.id] });
    store.dispatch({ as: 'fable', task: `search/${ctx.i4.id}`, to: 'opus-1' });
    store.dispatch({ as: 'fable', task: `search/${ctx.i5.id}`, to: 'opus-2' });
  });
  at(45, () => {
    store.result({ as: 'opus-1', task: `search/${ctx.i4.id}`, outcome: 'done', body: 'Debounce moved in front of the fetch; one request per pause in typing.' });
    store.acceptTask({ as: 'fable', task: `search/${ctx.i4.id}` });
  });
  at(46, () => {
    store.result({ as: 'opus-2', task: `search/${ctx.i5.id}`, outcome: 'done', body: 'aria-activedescendant now tracks the highlighted option.' });
    store.acceptTask({ as: 'fable', task: `search/${ctx.i5.id}` });
  });
  at(50, () => store.review({ as: 'openai', ref: INSTANT, verdict: 'approve', body: 'Both fixes verified. Approved.' }));
  at(56, () => store.review({ as: 'grok', ref: INSTANT, verdict: 'approve', body: 'Ran the **Search dropdown** end-to-end suite against the preview: 24 of 24 journeys pass. Feedback from 6 beta users is positive; no confusion around the dropdown.' }));
  at(60, () => store.review({ as: 'you', ref: INSTANT, verdict: 'approve', body: 'Signed off. Nice work, all.' }));
  at(61, () => store.decide({ as: 'you', ref: INSTANT, title: 'Roll out instant results to all traffic', body: 'Roll out to 100% after one day at 10% with no error-rate change. The flag stays for two weeks as a kill switch.' }));

  // ======================================================================
  // search/ranking-v3 — project, final_review (waiting on grok)
  // ======================================================================
  const RANKING = 'search/ranking-v3';
  at(20, () => store.createThread({ as: 'fable', ref: RANKING, title: 'Search ranking v3: learn from clicks' }));
  at(21, () => {
    brief(RANKING, {
      problem: 'Ranking is pure text match. Popular products sit on page 2 for common queries; first-page click-through is 39%.',
      users: 'Everyone who searches; most visible on short queries.',
      success: 'First-page click-through above 45% in a two-week holdout, with no drop in conversion.',
      out: 'The dropdown (instant results) and merchandising rules.',
    });
    post('fable', RANKING, 'proposal', 'Brief for ranking v3 is ready for your review.', { to: ['you'] });
  });
  at(24, () => store.review({ as: 'you', ref: RANKING, verdict: 'approve' }));
  at(30, () => {
    store.editSection({ as: 'fable', ref: RANKING, section: 'Design', body: 'Blend a click-through prior into the text score, weighted by inverse propensity so top positions do not win just for being on top. Offline eval on 30 days of queries first, then shadow traffic.' });
    store.advance({ as: 'fable', ref: RANKING });
  });
  at(36, () => store.review({ as: 'openai', ref: RANKING, verdict: 'approve', body: 'Design approved.' }));
  at(38, () => {
    ctx.r1 = store.createTask({ as: 'fable', ref: RANKING, title: 'Blend click-through prior into the text score' }).task;
    ctx.r2 = store.createTask({ as: 'fable', ref: RANKING, title: 'Offline eval harness on 30 days of queries' }).task;
    ctx.r3 = store.createTask({ as: 'fable', ref: RANKING, title: 'Shadow-traffic comparison dashboard' }).task;
    store.advance({ as: 'fable', ref: RANKING });
    store.dispatch({ as: 'fable', task: `search/${ctx.r1.id}`, to: 'opus-1' });
    store.dispatch({ as: 'fable', task: `search/${ctx.r2.id}`, to: 'opus-2' });
  });
  at(62, () => {
    store.result({ as: 'opus-2', task: `search/${ctx.r2.id}`, outcome: 'done', body: 'Harness replays 30 days of queries; NDCG@10 goes from 0.412 to 0.468 with the blend.' });
    store.acceptTask({ as: 'fable', task: `search/${ctx.r2.id}` });
    store.dispatch({ as: 'fable', task: `search/${ctx.r3.id}`, to: 'opus-2' });
  });
  at(70, () => {
    store.result({ as: 'opus-1', task: `search/${ctx.r1.id}`, outcome: 'done', body: 'Blend is in, with IPS weights from the position-randomised slice.' });
    store.acceptTask({ as: 'fable', task: `search/${ctx.r1.id}` });
  });
  at(78, () => {
    store.result({ as: 'opus-2', task: `search/${ctx.r3.id}`, outcome: 'done', body: 'Dashboard compares v2 and v3 on shadow traffic per query bucket.' });
    store.acceptTask({ as: 'fable', task: `search/${ctx.r3.id}` });
  });
  at(84, () => store.review({
    as: 'openai', ref: RANKING, verdict: 'changes_requested',
    points: [{ severity: 'high', text: 'The click prior still leaks position bias: the IPS weights come from a 2% randomised slice that undersamples long-tail queries.' }],
  }));
  at(88, () => store.respond({ as: 'fable', ref: RANKING, stances: [{ point: 1, stance: 'rejected', reason: 'Long-tail queries fall back to text score (prior weight is 0 below 50 impressions), so the slice size does not matter there.' }], body: 'Respectfully disagree; details in the stance.' }));
  at(92, () => {
    ctx.blocked = store.review({ as: 'openai', ref: RANKING, verdict: 'blocked', body: 'Fable and I disagree on point 1 and I cannot approve without an owner decision. The risk is real but bounded.' }).message;
  });
  at(93, () => {
    ctx.escalation = post('fable', RANKING, 'escalation', 'We are stuck on the position-bias point. My view: the fallback below 50 impressions makes it safe, and the holdout will show it. Your call.', { to: ['you'], reply_to: ctx.blocked.id });
  });
  at(100, () => store.decide({
    as: 'you', ref: RANKING, gate: 'code_review', verdict: 'approve', title: 'Ship ranking v3 with the impression fallback',
    resolves: [ctx.escalation.id],
    body: 'Approve code review. The fallback bounds the risk; openai, please add a long-tail bucket to the holdout so we see it if you are right.',
  }));
  at(125, () => {
    ctx.grokQ = post('grok', RANKING, 'question', 'Analytics shows 18% of searches are four words or longer. Which test journeys should cover those, or should I write new ones from recent queries?', { to: ['fable'] });
  });
  at(127, () => post('fable', RANKING, 'answer', 'Build two new ones from recent long queries; the existing journeys are all one or two words.', { cc: ['grok'], reply_to: ctx.grokQ.id }));

  // ======================================================================
  // search/typo-tolerance — project, brief (waiting on you)
  // ======================================================================
  const TYPO = 'search/typo-tolerance';
  at(183, () => store.createThread({ as: 'fable', ref: TYPO, title: 'Typo-tolerant search for long product names with model numbers and sizes' }));
  at(185, () => {
    brief(TYPO, {
      problem: '6.1% of searches return no results, and two thirds of those are one edit away from a product name (analytics: zero-result searches, last 30 days).',
      users: 'Everyone who searches; worst on mobile, where typos are twice as common.',
      success: 'Zero-result rate below 3% with no drop in first-page click-through.',
      out: 'Synonyms and spelling suggestions ("did you mean").',
    });
    store.editSection({ as: 'fable', ref: TYPO, section: 'Notes', body: '- Ranking v3 ships first (D-002); this builds on its scoring.\n- Open question: do we fuzz model numbers like `X-200`, or only words?' });
    post('fable', TYPO, 'proposal', 'Brief is ready for your review. One open question in Notes: whether model numbers get fuzzy matching too.', { to: ['you'], cc: ['openai'] });
  });

  // ======================================================================
  // checkout/checkout-v2 — project, build (tasks in every status)
  // ======================================================================
  const V2 = 'checkout/checkout-v2';
  at(2, () => store.createThread({ as: 'fable', ref: V2, title: 'Checkout v2: one-page flow' }));
  at(3, () => {
    brief(V2, {
      problem: 'Checkout takes four pages. 31% of shoppers who reach shipping leave before payment (analytics: checkout funnel, last 30 days).',
      users: 'Every buyer; mobile is 64% of checkouts.',
      success: 'Fewer drop-offs between shipping and payment.',
      out: 'Payment providers, saved cards (separate thread), and the order confirmation email.',
    });
    post('fable', V2, 'proposal', 'Brief for the one-page checkout is ready.', { to: ['you'] });
  });
  at(6, () => store.review({ as: 'you', ref: V2, verdict: 'changes_requested', points: [{ severity: 'medium', text: 'Success criteria needs a number: what drop-off do we expect, and over what window?' }], body: 'Close. One thing to tighten.' }));
  at(8, () => {
    const r = store.respond({ as: 'fable', ref: V2, stances: [{ point: 1, stance: 'accepted', action: 'Add a measurable drop-off target to the brief' }], body: 'Fair. Adding a target.' });
    ctx.v2t1 = r.tasks[0];
  });
  at(9, () => {
    store.editSection({ as: 'fable', ref: V2, section: 'Brief', body: '**Problem.** Checkout takes four pages. 31% of shoppers who reach shipping leave before payment (analytics: checkout funnel, last 30 days).\n\n**Users.** Every buyer; mobile is 64% of checkouts.\n\n**Success criteria.** Shipping → payment drop-off falls from 31% to 24% or lower over a two-week 50/50 test, with conversion up at least 2 points.\n\n**Out of scope.** Payment providers, saved cards (separate thread), and the order confirmation email.' });
    leadDone(`checkout/${ctx.v2t1.id}`, 'Target added: drop-off from 31% to 24% or lower in a two-week 50/50 test.');
    post('fable', V2, 'proposal', 'Updated the success criteria with a target and a test window.', { to: ['you'] });
  });
  at(14, () => store.review({ as: 'you', ref: V2, verdict: 'approve', body: 'That works. Approved.' }));
  at(20, () => {
    store.editSection({ as: 'fable', ref: V2, section: 'Design', body: 'One page with three collapsible sections (address, shipping, payment). Each section validates inline and collapses to a summary line when complete. The order summary is sticky on desktop and a bottom sheet on mobile.\n\n**Risk:** the legacy coupon modal assumes a page change; we remove it and move coupons inline.' });
    store.advance({ as: 'fable', ref: V2 });
  });
  at(28, () => store.review({ as: 'openai', ref: V2, verdict: 'approve', body: 'Clean design. Approved.' }));
  at(30, () => {
    store.editSection({ as: 'fable', ref: V2, section: 'Plan', body: '1. Collapse address and shipping into one step\n2. Inline card validation\n3. Retry the payment call with an idempotency key\n4. Sticky order summary on mobile\n5. Remove the legacy coupon modal' });
    ctx.v2t2 = store.createTask({ as: 'fable', ref: V2, title: 'Collapse address and shipping into one step' }).task;
    ctx.v2t3 = store.createTask({ as: 'fable', ref: V2, title: 'Inline card validation' }).task;
    ctx.v2t4 = store.createTask({ as: 'fable', ref: V2, title: 'Retry the payment call with an idempotency key' }).task;
    ctx.v2t5 = store.createTask({ as: 'fable', ref: V2, title: 'Sticky order summary on mobile' }).task;
    ctx.v2t6 = store.createTask({ as: 'fable', ref: V2, title: 'Remove the legacy coupon modal and move coupons inline' }).task;
    store.advance({ as: 'fable', ref: V2, body: 'Five tasks; builders start with the first three.' });
  });
  at(31, () => {
    store.dispatch({ as: 'fable', task: `checkout/${ctx.v2t2.id}`, to: 'opus-1' });
    store.dispatch({ as: 'fable', task: `checkout/${ctx.v2t3.id}`, to: 'opus-2' });
  });
  at(33, () => store.dispatch({ as: 'fable', task: `checkout/${ctx.v2t4.id}`, to: 'opus-1', body: `Please take **${ctx.v2t4.id}** after ${ctx.v2t2.id}. Use the same idempotency-key helper as the checkout-health fix so retries never double charge.` }));
  at(45, () => store.decide({ as: 'fable', ref: V2, title: 'Keep the legacy checkout behind a flag until v2 ships', refs: [ctx.v2t6.id], body: 'The legacy four-page flow stays reachable behind `checkout_legacy` until v2 passes final review, so support can switch a buyer back.' }));
  at(60, () => {
    store.result({ as: 'opus-1', task: `checkout/${ctx.v2t2.id}`, outcome: 'done', body: 'Address and shipping are one step; the shipping options load as soon as the postcode is valid.' });
    store.acceptTask({ as: 'fable', task: `checkout/${ctx.v2t2.id}`, body: 'Looks right on mobile and desktop.' });
  });
  at(90, () => {
    ctx.v2blocked = store.result({ as: 'opus-2', task: `checkout/${ctx.v2t3.id}`, outcome: 'blocked', body: 'Card validation needs the BIN lookup endpoint, and this worktree has no sandbox key for the payment provider.' }).message;
  });
  at(91, () => post('fable', V2, 'note', 'Use the mock BIN table in the test fixtures for now. I have asked for a sandbox key; the task stays blocked until it arrives.', { to: [], reply_to: ctx.v2blocked.id, internal: true }));
  at(100, () => {
    ctx.v2q = post('you', V2, 'question', 'Will the sticky summary cover the pay button on small phones?', { to: ['fable'] });
  });
  at(101, () => post('fable', V2, 'answer', `No: on screens under 700 px tall the summary collapses to one line above the pay button. ${ctx.v2t5.id} covers it with a visual test at 360×640.`, { cc: ['you'], reply_to: ctx.v2q.id, refs: [ctx.v2t5.id] }));
  at(140, () => store.dispatch({ as: 'fable', task: `checkout/${ctx.v2t5.id}`, to: 'opus-2' }));
  at(197.3, () => store.result({ as: 'opus-1', task: `checkout/${ctx.v2t4.id}`, outcome: 'done', body: 'Payment retries now carry an idempotency key; 3 retries with backoff, and a test proves a double submit charges once.' }));

  // ======================================================================
  // checkout/saved-cards — project, design_review (waiting on openai)
  // ======================================================================
  const CARDS = 'checkout/saved-cards';
  at(50, () => store.createThread({ as: 'fable', ref: CARDS, title: 'Saved cards for returning buyers' }));
  at(51, () => {
    brief(CARDS, {
      problem: 'Returning buyers re-enter their card every time. 22% of returning-buyer checkouts stall on the card form.',
      users: 'Returning buyers, about 40% of orders.',
      success: 'Card-form stalls for returning buyers fall below 10%.',
      out: 'Wallets (Apple Pay, Google Pay) and the account page.',
    });
    post('fable', CARDS, 'proposal', 'Saved-cards brief is ready for you.', { to: ['you'] });
  });
  at(56, () => store.review({ as: 'you', ref: CARDS, verdict: 'approve' }));
  at(60, () => {
    store.editSection({ as: 'fable', ref: CARDS, section: 'Design', body: 'Store the provider token and a card fingerprint per buyer. The pay step shows saved cards first, with a **Save card for next time** checkbox on new cards.' });
    store.advance({ as: 'fable', ref: CARDS });
  });
  at(66, () => store.review({
    as: 'openai', ref: CARDS, verdict: 'changes_requested',
    points: [
      { severity: 'high', text: 'Storing the card fingerprint in our database widens PCI scope. Keep only the provider token.' },
      { severity: 'medium', text: 'There is no plan for expiry: expired saved cards will fail at pay time.' },
      { severity: 'low', text: 'Name the checkbox "Remember this card" to match the account page copy.' },
    ],
    body: 'Three points, one of them blocking for compliance.',
  }));
  at(70, () => {
    const r = store.respond({
      as: 'fable', ref: CARDS,
      stances: [
        { point: 1, stance: 'accepted', action: 'Store the provider token only; drop the fingerprint column' },
        { point: 2, stance: 'deferred', reason: 'Expiry handling ships with the account page work next month.' },
        { point: 3, stance: 'rejected', reason: 'The payments team fixed this copy across checkout; the account page is the one that changes.' },
      ],
      body: 'Accepting the PCI point; the other two have reasons below.',
    });
    ctx.cardsTask = r.tasks[0];
  });
  at(72, () => {
    leadDone(`checkout/${ctx.cardsTask.id}`, 'Design updated: we store the provider token only.');
    store.editSection({ as: 'fable', ref: CARDS, section: 'Design', body: 'Store only the provider token per buyer; the provider deduplicates cards for us. The pay step shows saved cards first, with a **Save card for next time** checkbox on new cards.\n\n**Changed after review:** no fingerprint column (keeps us out of wider PCI scope).' });
    post('fable', CARDS, 'note', 'Design updated for the PCI point; sending it back to review.');
    store.advance({ as: 'fable', ref: CARDS });
  });
  at(82, () => store.review({
    as: 'openai', ref: CARDS, verdict: 'changes_requested',
    points: [{ severity: 'medium', text: 'The order event still logs the last four digits of the card. Drop them or hash them.' }],
    body: 'The PCI point is fixed. One logging gap left.',
  }));
  at(86, () => store.respond({ as: 'fable', ref: CARDS, stances: [{ point: 1, stance: 'rejected', reason: 'Last four digits are outside PCI scope and support needs them to identify a card; the payments policy allows it.' }], body: 'Keeping the last four; the policy reference is in the stance.' }));

  // ---- run -----------------------------------------------------------------
  plan.sort((a, b) => a.h - b.h || a.i - b.i);
  for (const step of plan) {
    t = Math.max(t + 1000, t0 + Math.round(step.h * HOUR));
    step.fn();
  }

  const board = store.board();
  return {
    root: abs,
    teams: board.teams.map((x) => x.id),
    threads: board.teams.flatMap((x) => x.threads.map((th) => `${x.id}/${th.id} ${th.kind}:${th.phase}`)),
    openTurns: store.openTurns().map((o) => `${o.team}/${o.thread} → ${o.member} (${o.message.type} from ${o.message.from})`),
    last: new Date(t).toISOString(),
  };
}

const isMain = (() => {
  try {
    return Boolean(process.argv[1]) && fs.realpathSync(process.argv[1]) === fs.realpathSync(fileURLToPath(import.meta.url));
  } catch {
    return false;
  }
})();

if (isMain) {
  const root = process.argv[2];
  if (!root || root === '--help' || root === '-h') {
    process.stderr.write('usage: node tools/factory-ui/seed-demo.mjs <root>\n  Seeds a demo factory root for the board UI (never the repo root).\n');
    process.exit(root ? 0 : 2);
  }
  try {
    const out = seedDemo(root);
    const v = openStore({ root: out.root }).validate();
    process.stdout.write(`Seeded ${out.root}\n  teams: ${out.teams.join(', ')}\n  threads:\n${out.threads.map((x) => `    ${x}`).join('\n')}\n  open turns:\n${out.openTurns.map((x) => `    ${x}`).join('\n')}\n  validate: ${v.errors.length} errors, ${v.warnings.length} warnings\n  view it: node factory/bin/factory.mjs ui --root ${out.root}\n`);
    if (!v.ok) {
      for (const e of v.errors) process.stderr.write(`  error ${e.file}: ${e.message}\n`);
      process.exit(1);
    }
  } catch (e) {
    process.stderr.write(`seed-demo: ${e.message}\n`);
    process.exit(1);
  }
}
