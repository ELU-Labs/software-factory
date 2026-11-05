// Factory board: Board, Tasks, Inbox and Chat for the software factory.
// Vanilla JS, no dependencies, nothing loaded from the network but this server.
// The page writes only as `you` (the server enforces it); files are the truth,
// so every change on disk arrives through the SSE feed and triggers a refetch.

(() => {
  'use strict';

  // ---------------------------------------------------------------------------
  // HTML building: html`` escapes every interpolation unless it is raw().
  // ---------------------------------------------------------------------------

  class Raw {
    constructor(s) { this.s = s; }
    toString() { return this.s; }
  }
  const raw = (s) => new Raw(String(s ?? ''));
  const ESC = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' };
  const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ESC[c]);
  const fmt = (v) => (v == null || v === false || v === true ? '' : v instanceof Raw ? v.s : Array.isArray(v) ? v.map(fmt).join('') : esc(v));
  const html = (strings, ...vals) => {
    let out = strings[0];
    for (let i = 0; i < vals.length; i++) out += fmt(vals[i]) + strings[i + 1];
    return new Raw(out);
  };
  const $ = (sel, el = document) => el.querySelector(sel);
  /**
   * Set a region's HTML only when it changed. Rebuilding a region on every
   * refresh clears the reader's text selection and hover state, and the feed
   * refreshes on every write anywhere in the factory. Every write to a region's
   * innerHTML goes through here (or clearHtml) so the cached string stays true.
   * @returns {boolean} whether the DOM was rebuilt
   */
  const setHtml = (el, content) => {
    if (!el) return false;
    const s = typeof content === 'string' ? content : fmt(content);
    if (el._html === s && (s === '' || el.firstChild)) return false;
    el.innerHTML = s;
    el._html = s;
    return true;
  };
  const clearHtml = (el) => setHtml(el, '');
  const uniq = (xs) => [...new Set(xs)];
  const IS_MAC = /Mac|iPhone|iPad/.test(globalThis.navigator?.platform || globalThis.navigator?.userAgent || '');
  const plural = (n, w, p = `${w}s`) => `${n} ${n === 1 ? w : p}`;
  /** Text for one-line rows: drop inline Markdown markers (code ticks, emphasis). */
  const plain = (s) => String(s ?? '').replace(/`([^`]*)`/g, '$1').replace(/\*\*(.+?)\*\*/g, '$1').replace(/(^|\W)[*_](\S.*?)[*_](?=\W|$)/g, '$1$2');

  // ---------------------------------------------------------------------------
  // Vocabulary
  // ---------------------------------------------------------------------------

  const PHASES = ['brief', 'design', 'design_review', 'plan', 'build', 'code_review', 'security_review', 'final_review', 'signoff', 'done'];
  const GATES = ['brief', 'design_review', 'build', 'code_review', 'security_review', 'final_review', 'signoff'];
  const REVIEW_GATES = ['brief', 'design_review', 'code_review', 'security_review', 'final_review', 'signoff'];
  const DEFAULT_GATE_OWNER = { brief: 'you', design_review: 'openai', code_review: 'openai', security_review: 'security', final_review: 'grok', signoff: 'you' };
  /** Gates a thread has only when its roles picked someone for them; a thread without one skips that phase. */
  const OPTIONAL_GATES = ['security_review'];
  /** One project thread's phases, in order. */
  const phasesOf = (th) => PHASES.filter((p) => !OPTIONAL_GATES.includes(p) || th?.gates?.[p]);
  const PHASE_LABEL = {
    brief: 'Brief', design: 'Design', design_review: 'Design review', plan: 'Plan', build: 'Build', code_review: 'Code review',
    security_review: 'Security review', final_review: 'Final review', signoff: 'Sign-off', done: 'Done', active: 'Active', paused: 'Paused',
  };
  const PHASE_SHORT = {
    brief: 'Brief', design: 'Design', design_review: 'D. review', plan: 'Plan', build: 'Build', code_review: 'C. review',
    security_review: 'Security', final_review: 'Final', signoff: 'Sign-off', done: 'Done', active: 'Active', paused: 'Paused',
  };
  const GATE_STATUS = { pending: 'Pending', approved: 'Approved', changes_requested: 'Changes requested', blocked: 'Blocked' };
  const GATE_STATUS_SHORT = { pending: 'Pending', approved: 'Approved', changes_requested: 'Changes', blocked: 'Blocked' };
  const VERDICT = { approve: 'Approved', changes_requested: 'Changes requested', blocked: 'Blocked' };
  const TASK_COLS = [['todo', 'To do'], ['doing', 'Doing'], ['review', 'Review'], ['blocked', 'Blocked'], ['done', 'Done']];
  const TYPE_LABEL = {
    kickoff: 'kickoff', proposal: 'proposal', review: 'review', review_response: 'response', question: 'question', answer: 'answer',
    dispatch: 'dispatch', result: 'result', escalation: 'escalation', decision: 'decision', report: 'report', alert: 'alert', event: 'event', note: 'note',
  };
  const ISSUE_ORDER = ['open', 'accepted', 'fixed', 'deferred', 'rejected', 'verified'];
  /** Message types whose turns are notifications: no command answers them; the holder's next write in the thread closes them. */
  const NOTIFY_TYPES = new Set(['event', 'alert', 'report']);
  const TASK_ORDER = ['doing', 'review', 'blocked', 'todo', 'done'];

  // ---------------------------------------------------------------------------
  // Icons (20×20, stroke)
  // ---------------------------------------------------------------------------

  const ICONS = {
    solo: '<circle cx="10" cy="6.75" r="3.25"/><path d="M4.25 16.75c.85-3.1 3-4.75 5.75-4.75s4.9 1.65 5.75 4.75"/>',
    board: '<rect x="2.75" y="3.25" width="4.25" height="13.5" rx="1.4"/><rect x="7.9" y="3.25" width="4.25" height="9.5" rx="1.4"/><rect x="13.05" y="3.25" width="4.25" height="6" rx="1.4"/>',
    tasks: '<path d="M8.5 5.5h8.5M8.5 10h8.5M8.5 14.5h8.5"/><path d="M3 5.6l1.3 1.3L6.4 4.6M3 10.1l1.3 1.3 2.1-2.3M3 14.6l1.3 1.3 2.1-2.3"/>',
    search: '<circle cx="8.75" cy="8.75" r="5.25"/><path d="m12.75 12.75 4 4"/>',
    bell: '<path d="M5.25 8.5a4.75 4.75 0 0 1 9.5 0c0 3.6 1.5 5.25 1.5 5.25H3.75s1.5-1.65 1.5-5.25z"/><path d="M8.4 16.25a1.75 1.75 0 0 0 3.2 0"/>',
    inbox: '<path d="M3 11.5V15a1.5 1.5 0 0 0 1.5 1.5h11A1.5 1.5 0 0 0 17 15v-3.5"/><path d="M3 11.5 5.2 4.6a1.5 1.5 0 0 1 1.4-1.1h6.8a1.5 1.5 0 0 1 1.4 1.1L17 11.5h-4l-1 2H8l-1-2z"/>',
    project: '<path d="M4 7.5h12.5M3.5 12.5H16M8.5 3.5 7 16.5M13.5 3.5 12 16.5"/>',
    watch: '<path d="M2.5 10.5h3l2-5.5 3.5 10 2.2-4.5h4.3"/>',
    refresh: '<path d="M16 10a6 6 0 1 1-1.76-4.24"/><path d="M16.3 3.4v3.4h-3.4"/>',
    sun: '<circle cx="10" cy="10" r="3.2"/><path d="M10 2.6v1.6M10 15.8v1.6M2.6 10h1.6M15.8 10h1.6M4.8 4.8l1.1 1.1M14.1 14.1l1.1 1.1M4.8 15.2l1.1-1.1M14.1 5.9l1.1-1.1"/>',
    moon: '<path d="M16 12.4A6.5 6.5 0 0 1 7.6 4a6.5 6.5 0 1 0 8.4 8.4z"/>',
    system: '<circle cx="10" cy="10" r="6.5"/><path d="M10 3.5a6.5 6.5 0 0 1 0 13z" fill="currentColor" stroke="none"/>',
    lock: '<rect x="4.75" y="9" width="10.5" height="7.75" rx="2"/><path d="M7.2 9V6.8a2.8 2.8 0 0 1 5.6 0V9"/>',
    reply: '<path d="M8 5 3.5 9.5 8 14"/><path d="M4 9.5h7a5 5 0 0 1 5 5v1"/>',
    chevron: '<path d="m7.5 5 5 5-5 5"/>',
    check: '<path d="m4.5 10.5 3.5 3.5 7.5-8"/>',
    x: '<path d="m5.5 5.5 9 9M14.5 5.5l-9 9"/>',
    panel: '<rect x="3" y="3.5" width="14" height="13" rx="2.5"/><path d="M12.25 3.5v13"/>',
    plus: '<path d="M10 4.5v11M4.5 10h11"/>',
    more: '<circle cx="4.75" cy="10" r="1.35" fill="currentColor" stroke="none"/><circle cx="10" cy="10" r="1.35" fill="currentColor" stroke="none"/><circle cx="15.25" cy="10" r="1.35" fill="currentColor" stroke="none"/>',
    archive: '<rect x="3" y="4" width="14" height="3.5" rx="1"/><path d="M4.5 7.5v7.75a1 1 0 0 0 1 1h9a1 1 0 0 0 1-1V7.5M8.25 10.75h3.5"/>',
    flag: '<path d="M5.5 17V3.5M5.5 4h8.5l-2 3.25 2 3.25H5.5"/>',
    clock: '<circle cx="10" cy="10" r="6.75"/><path d="M10 6.5V10l2.5 1.5"/>',
    shield: '<path d="M10 2.8 4.25 5v4.6c0 3.6 2.5 6.1 5.75 7.6 3.25-1.5 5.75-4 5.75-7.6V5z"/>',
    copy: '<rect x="7" y="7" width="9.5" height="9.5" rx="1.8"/><path d="M13 7V5.3A1.8 1.8 0 0 0 11.2 3.5H5.3A1.8 1.8 0 0 0 3.5 5.3v5.9A1.8 1.8 0 0 0 5.3 13H7"/>',
    branch: '<circle cx="6" cy="4.75" r="1.75"/><circle cx="6" cy="15.25" r="1.75"/><circle cx="14" cy="7.25" r="1.75"/><path d="M6 6.5v7M14 9c0 3.2-3.5 3.4-7.6 4.6"/>',
    doc: '<path d="M5.75 2.75h5.75l3.75 3.75v10.25a.5.5 0 0 1-.5.5h-9a.5.5 0 0 1-.5-.5V3.25a.5.5 0 0 1 .5-.5z"/><path d="M11.25 2.75v4h4M7.75 10.25h4.5M7.75 13.25h4.5"/>',
    chat: '<path d="M4 4.25h12a1 1 0 0 1 1 1v7.75a1 1 0 0 1-1 1H9.25L5.5 16.75v-2.75H4a1 1 0 0 1-1-1V5.25a1 1 0 0 1 1-1z"/>',
    alert: '<path d="M10 3.5 2.75 16h14.5z"/><path d="M10 8.25v3.5M10 13.9v.1"/>',
    send: '<path d="M3.5 10 16.5 4l-4.5 12.5-2.5-5.25z"/><path d="M9.5 11.25 16.5 4"/>',
  };
  const icon = (name, cls = '') => raw(`<svg class="ic ${cls}" viewBox="0 0 20 20" aria-hidden="true" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round">${ICONS[name] || ''}</svg>`);
  // The board's mark: a factory roofline, in the brand colour.
  const LOGO = raw('<svg class="brand-mark" viewBox="0 0 24 24" aria-hidden="true"><path fill="var(--brand)" d="M2 21V10.5l5.5 3.2v-3.2l5.5 3.2v-3.2l5 2.9V3h4v18z"/></svg>');

  // ---------------------------------------------------------------------------
  // Persistence (per-viewer conveniences only)
  // ---------------------------------------------------------------------------

  const LS = {
    get(k, d) {
      try {
        const v = localStorage.getItem(`factory-ui:${k}`);
        return v == null ? d : JSON.parse(v);
      } catch {
        return d;
      }
    },
    set(k, v) {
      try {
        localStorage.setItem(`factory-ui:${k}`, JSON.stringify(v));
      } catch {
        // storage unavailable: the setting lasts for this page only
      }
    },
  };

  // ---------------------------------------------------------------------------
  // State
  // ---------------------------------------------------------------------------

  const state = {
    board: null,
    boardError: null,
    loaded: false,
    route: null,
    thread: null,
    threadRef: null,
    threadError: null,
    inbox: null,
    inboxError: null,
    health: null,
    live: 'connecting',
    root: '',
    filter: '',
    /** The New thread modal's form ({open, ...}): kept while closed, so reopening it keeps what you typed. */
    newThread: null,
    /** What the modal offers (GET /api/thread/options): the models and the agents of each role. */
    ntOptions: null,
    /** A #/new link opened before the board loaded: the team to open the modal on once it has. */
    pendingNew: null,
    boardTeam: LS.get('boardTeam', ''),
    /** Messages the chat hides that the owner opened from a link (ids): shownInChat() then shows them. */
    revealed: new Set(),
    collapsed: new Set(LS.get('collapsed', [])),
    /** Long message bodies the reader unfolded (ids); the rest show their first lines. */
    unfolded: new Set(),
    theme: LS.get('theme', 'system'),
    /** Desktop notifications when something new waits on you: opt-in, and the browser asks once. */
    notify: LS.get('notify', false) === true,
    /** When each thread was last read here ({ref: ts}), and when this browser began tracking: newer activity is unread. */
    seen: LS.get('seen', {}) || {},
    seenSince: LS.get('seenSince', null),
    /** What waited on you at the last refresh (keys), so a notification goes out only for what is new; null before the first. */
    waitingKeys: null,
    /** The Cmd-K jump box while open: {q, i, items}. */
    jump: null,
    waitingCount: 0,
    baseTitle: 'Software Factory',
    /** The answer to the Triage thread's observability offer ('yes' or 'no'); null until the owner picks. */
    offer: LS.get('observability', null),
    sideOpen: false,
    sending: false,
    /** A Stop waiting for its confirming click. */
    confirmStop: null,
    /** The team whose ⋯ menu is open in the rail, and the team waiting on a second Archive click. */
    teamMenu: null,
    confirmArchive: null,
    confirmSkip: null,
    /** Whether the rail's Archived list is open, and the archived team being restored. */
    showArchived: LS.get('showArchived', false) === true,
    restoring: null,
    // Permission cards being answered, by event id: {rules, team, confirm, error}; the May run editor, by thread ref.
    permEdits: {},
    allowEdit: {},
    permBusy: false,
    procBusy: false,
    firstPaint: false,
    pendingRef: null,
    roster: '',
  };
  const drafts = new Map();
  /** Who a new message goes to until you pick: a single-agent thread's agent, otherwise the thread's lead. */
  const defaultTo = (th) => (th?.kind === 'solo' && th.owner ? [th.owner] : th?.lead && th.lead !== 'you' ? [th.lead] : []);
  /** Who a post from the composer goes to: on a single-agent thread always its agent, the only one there to start. */
  const postTo = (th, d) => (th?.kind === 'solo' && th.owner ? [th.owner] : d.to ?? defaultTo(th));
  /**
   * Every message you send asks something of whoever it goes to, so there is no
   * type to pick: a reply to a question or an escalation addressed to you
   * answers it, anything else is a question (it opens their turn either way).
   */
  const postType = (v, d) => {
    const target = d.replyTo ? v.messages.find((m) => m.id === d.replyTo) : null;
    return target && (target.type === 'question' || target.type === 'escalation') && (target.to || []).includes('you') ? 'answer' : 'question';
  };
  const draft = (ref) => {
    // `to: null` means "not picked yet": it follows the thread (defaultTo), read when the thread is on screen.
    if (!drafts.has(ref)) drafts.set(ref, { to: null, body: '', replyTo: null, points: [], error: '' });
    return drafts.get(ref);
  };

  // ---------------------------------------------------------------------------
  // Data helpers
  // ---------------------------------------------------------------------------

  const members = () => state.board?.members || [];
  function memberOf(id) {
    const m = members().find((x) => x.id === id);
    if (m) return m;
    return { id, name: id || 'unknown', short: String(id || '??').slice(0, 2).toUpperCase(), color: '#9CA3AF', role: 'unknown', vendor: '', model: null, kind: 'agent' };
  }
  /** A model's name, as the New thread form lists it ("Opus 5.5", "GPT-6.1 Sol"). */
  const modelName = (id) => [...(state.ntOptions?.models || []), ...NF_MODELS, ...nfOpenAI()].find((x) => x.id === id)?.name || id;
  const isOpenAIModel = (id) => nfOpenAI().some((x) => x.id === id);
  /** The OpenAI model openai runs on in this thread: the role its phase calls on, else the first that names one (roles.mjs roleModel). */
  const OPENAI_ROLE_BY_PHASE = { design_review: 'code_review', code_review: 'code_review', security_review: 'security', final_review: 'final_check', signoff: 'final_check', done: 'final_check' };
  function openaiModelOn(th) {
    const r = th?.roles;
    if (!r || th.kind !== 'project') return null;
    for (const k of [OPENAI_ROLE_BY_PHASE[th.phase] || 'pair', 'code_review', 'security', 'final_check', 'pair']) {
      if (r[k]?.agent === 'openai' && r[k].model) return r[k].model;
    }
    return null;
  }
  /**
   * A member as it shows on one thread. The lead and the builder slots run on the
   * model the owner picked for the thread (its roles), so there they go by that
   * model: a lead picked as Opus 5.5 reads "Opus 5.5", not "Fable", and builders
   * on Sonnet 5.5 read "Sonnet 1" and "Sonnet 2". Without a thread, or on a thread
   * that kept the roster's model, it is the roster member.
   */
  function seatOf(id, th) {
    const m = memberOf(id);
    const r = th?.roles;
    if (r && id === 'openai') {
      const model = openaiModelOn(th);
      return model ? { ...m, name: modelName(model), model } : m;
    }
    // A lead on an OpenAI model runs on Codex: it goes by that model, with OpenAI's mark.
    if (r && id === th.lead && th.kind === 'project' && isOpenAIModel(r.lead?.model)) {
      const o = memberOf('openai');
      return { ...m, name: modelName(r.lead.model), model: r.lead.model, logo: 'openai', color: o.color || m.color, vendor: 'openai' };
    }
    if (!r || !m.model) return m;
    if (m.role === 'security') return r.security?.agent === id && r.security.model ? { ...m, model: r.security.model } : m;
    const model = th.kind === 'solo' ? (id === th.owner ? r.agent?.model : null)
      : id === th.lead ? r.lead?.model
        : m.role === 'builder' ? r.subagents?.model : null;
    if (!model || model === m.model) return m;
    const name = modelName(model);
    const rest = String(m.name || '').split(' ').slice(1).join(' ');
    if (!rest) return { ...m, name, model };
    const family = name.split(' ')[0];
    return { ...m, name: `${family} ${rest}`, short: `${family.charAt(0)}${String(m.short || '').slice(1)}`, model };
  }
  /** A member's name; on a thread, the name of its seat there (seatOf). */
  const displayName = (id, th) => (id === 'you' ? 'You' : seatOf(id, th).name);
  /** A board thread (with its roles) from "team/thread", or null. */
  const threadByRef = (ref) => {
    const [team, id] = String(ref || '').split('/');
    return (state.board?.teams || []).find((t) => t.id === team)?.threads.find((x) => x.id === id) || null;
  };
  const safeColor = (c) => (/^#[0-9a-f]{3,8}$/i.test(String(c || '')) ? c : '#9CA3AF');
  const focusMember = () => state.filter || 'you';
  const teamOf = (id) => state.board?.teams.find((t) => t.id === id) || { id, title: id, threads: [], tasks: [], issues: [] };
  const allThreads = () => (state.board?.teams || []).flatMap((t) => t.threads);
  /**
   * A review gate waits on its owner while it is pending, whether or not the
   * gate-entry event's turn is still open: that turn is a notification, and the
   * owner's next write in the thread (a question, say) closes it. Returns the
   * owner when they hold no open turn in the thread (else the turn already says
   * so). The brief is left out: it is pending from the start, but waits on the
   * lead's proposal (a turn) before the owner can review it.
   */
  const GATE_ENTRY = new Set(['design_review', 'code_review', 'security_review', 'final_review', 'signoff']);
  function gateWait(th, turns = th.openTurns || []) {
    if (th.kind !== 'project' || !GATE_ENTRY.has(th.phase)) return null;
    const g = th.gates?.[th.phase];
    // A gate whose agent the owner dismissed (the × on "Start …") waits on nobody until it moves.
    if (!g || g.status !== 'pending' || !g.by || th.gate_dismissed === th.phase || turns.some((o) => o.member === g.by)) return null;
    return { member: g.by, gate: th.phase };
  }
  /** Members a thread waits on: holders of open turns, then a pending gate's owner. */
  const waitingMembers = (th, turns = th.openTurns || []) => uniq([...turns.map((o) => o.member), ...[gateWait(th, turns)?.member].filter(Boolean)]);
  const waitsOn = (th, m) => waitingMembers(th).includes(m);
  /** Inbox items for `m` across the board: open turns, plus pending gates m owns with no turn. */
  const gateWaitsFor = (m) => allThreads().filter((th) => gateWait(th)?.member === m);
  const involves = (th, m) => th.lead === m || th.owner === m || (th.members || []).includes(m) || waitsOn(th, m);

  function vendorLine(m) {
    if (m.kind === 'human') return m.role === 'owner' ? 'product owner' : m.role;
    if (m.kind === 'system') return 'system';
    return [m.vendor, m.model].filter(Boolean).join(' · ');
  }

  function cadenceMs(c) {
    const H = 3600e3;
    if (c === 'hourly') return H;
    if (c === 'daily') return 24 * H;
    if (c === 'weekly') return 168 * H;
    const m = /^([1-9]\d*)([hd])$/.exec(String(c || ''));
    return m ? Number(m[1]) * (m[2] === 'h' ? H : 24 * H) : null;
  }

  // ---------------------------------------------------------------------------
  // Time and numbers
  // ---------------------------------------------------------------------------

  function ageText(seconds) {
    const s = Math.max(0, Math.floor(seconds));
    if (s < 60) return 'just now';
    if (s < 3600) return `${Math.floor(s / 60)}m`;
    if (s < 86400) return `${Math.floor(s / 3600)}h`;
    return `${Math.floor(s / 86400)}d`;
  }
  const secondsSince = (ts) => (Date.now() - Date.parse(ts)) / 1000;
  const agoText = (seconds) => (seconds < 60 ? 'just now' : `${ageText(seconds)} ago`);
  /** Whole local calendar days from `ts` to today (the same days dayLabel() names). */
  function calendarDaysAgo(ts) {
    const d = new Date(ts);
    const n = new Date(Date.now());
    return Math.round((new Date(n.getFullYear(), n.getMonth(), n.getDate()) - new Date(d.getFullYear(), d.getMonth(), d.getDate())) / 86400e3);
  }
  /** Relative time. Units are truncated, never rounded up, and days count calendar days so they agree with the day separators. */
  function rel(ts) {
    if (!ts) return '—';
    const s = secondsSince(ts);
    if (!Number.isFinite(s)) return '—';
    if (s < 0) return 'now';
    if (s < 45) return 'just now';
    if (s < 3600) return `${Math.max(1, Math.floor(s / 60))}m ago`;
    if (s < 86400) return `${Math.floor(s / 3600)}h ago`;
    const days = Math.max(1, calendarDaysAgo(ts));
    if (days < 7) return `${days}d ago`;
    return shortDate(ts);
  }
  const shortDate = (ts) => new Date(ts).toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
  const clock = (ts) => new Date(ts).toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' });
  const absTime = (ts) => `${new Date(ts).toLocaleString(undefined, { weekday: 'short', year: 'numeric', month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit', second: '2-digit' })} · ${ts}`;

  // ---- estimates (PROTOCOL §7 and §8, "Estimates") ---------------------------

  /** 45m, 2h, 1h 30m. */
  function fmtMin(min) {
    const n = Math.max(0, Math.round(min));
    if (n < 60) return `${n}m`;
    const h = Math.floor(n / 60);
    return n % 60 ? `${h}h ${n % 60}m` : `${h}h`;
  }
  /** Time left until `dueMs`, or past it: {text, over}. */
  function leftOf(dueMs) {
    const min = Math.round((dueMs - Date.now()) / 60000);
    return min >= 0 ? { text: `${fmtMin(min)} left`, over: false } : { text: `${fmtMin(-min)} over`, over: true };
  }
  /** When an estimate given during a phase or task that began at `startMs` runs out. */
  const dueOf = (e, startMs) => Math.max(startMs || 0, Date.parse(e.at)) + e.minutes * 60000;

  /** A task's estimate chip: its length while to do, the time left while in progress, how long it took after. */
  function taskEta(x, th) {
    const e = x.eta;
    if (!e) return '';
    const by = `estimated ${fmtMin(e.minutes)} by ${displayName(e.by, th)}`;
    if (x.status === 'todo') return html`<span class="eta" title="${by}">~${fmtMin(e.minutes)}</span>`;
    if (x.status === 'doing') {
      const due = dueOf(e);
      const l = leftOf(due);
      return html`<span class="eta${l.over ? ' over' : ''}" title="${by}; due ${clock(new Date(due).toISOString())}">${l.text}</span>`;
    }
    if (e.ended) return html`<span class="eta past" title="${by}">took ${fmtMin((Date.parse(e.ended) - Date.parse(e.at)) / 60000)}</span>`;
    return '';
  }

  /** Time spent in each phase and when the current one began, from the thread's phase events. */
  function phaseSpans(th, messages) {
    const spent = {};
    let cur = 'brief';
    let start = Date.parse(th.created);
    for (const m of messages || []) {
      if (m.type !== 'event' || m.event?.kind !== 'phase') continue;
      const at = Date.parse(m.ts);
      spent[cur] = (spent[cur] || 0) + Math.max(0, at - start);
      cur = m.event.to;
      start = at;
    }
    return { spent, since: start };
  }

  /**
   * When a project thread should reach sign-off: the current phase's due time (now
   * when it has no estimate or is over), plus each later phase's estimate up to
   * final_review. {ms, missing} names the phases left without an estimate; null
   * when nothing is estimated.
   */
  function threadFinish(th, sinceMs) {
    const eta = th.eta || {};
    const order = phasesOf(th);
    const here = order.indexOf(th.phase);
    if (th.kind !== 'project' || th.phase === 'done' || th.phase === 'signoff' || !Object.keys(eta).length) return null;
    const missing = [];
    let ms = Date.now();
    const cur = eta[th.phase];
    if (cur) ms = Math.max(ms, dueOf(cur, sinceMs));
    else missing.push(th.phase);
    for (const p of order.slice(here + 1)) {
      if (p === 'signoff' || p === 'done') break;
      if (eta[p]) ms += eta[p].minutes * 60000;
      else missing.push(p);
    }
    return { ms, missing };
  }
  function finishLabel(f) {
    const d = new Date(f.ms);
    const day = d.toDateString() === new Date(Date.now()).toDateString() ? '' : `${d.toLocaleDateString(undefined, { weekday: 'short' })} `;
    return `${day}${clock(d.toISOString())}`;
  }
  function finishTitle(f) {
    return `Ready for your sign-off around ${new Date(f.ms).toLocaleString()}${f.missing.length ? `; not estimated yet: ${f.missing.map((p) => PHASE_LABEL[p]).join(', ')}` : ''}`;
  }
  function dayLabel(ts) {
    const d = new Date(ts);
    const today = new Date(Date.now());
    const y = new Date(Date.now() - 86400e3);
    if (d.toDateString() === today.toDateString()) return 'Today';
    if (d.toDateString() === y.toDateString()) return 'Yesterday';
    return d.toLocaleDateString(undefined, { weekday: 'short', month: 'short', day: 'numeric' });
  }
  function untilText(ms) {
    const s = Math.round(ms / 1000);
    if (s <= 0) return `overdue ${ageText(-s)}`;
    return `due in ${ageText(s)}`;
  }

  function fmtMetric(name, v) {
    if (typeof v !== 'number' || !Number.isFinite(v)) return '—';
    if (/rate|ratio|share|pct/i.test(name) && v >= 0 && v <= 1) return `${Number((v * 100).toPrecision(3))}%`;
    const a = Math.abs(v);
    const n = a >= 1000 ? Math.round(v).toLocaleString('en-US') : String(Number(v.toPrecision(3)));
    return /_ms$/i.test(name) ? `${n} ms` : n;
  }
  function fmtThreshold(name, t) {
    if (!t) return '';
    const parts = [];
    if (t.min != null) parts.push(`≥ ${fmtMetric(name, t.min)}`);
    if (t.max != null) parts.push(`≤ ${fmtMetric(name, t.max)}`);
    return parts.join(' ');
  }
  function breaches(value, t) {
    if (typeof value !== 'number' || !t) return false;
    return (t.max != null && value > t.max) || (t.min != null && value < t.min);
  }

  // ---------------------------------------------------------------------------
  // Markdown (safe subset: everything is escaped first)
  // ---------------------------------------------------------------------------

  const MSG_ID_RE = /\b(\d{8}T\d{6}Z-[a-z0-9][a-z0-9-]*-[0-9a-f]{4})\b/g;

  function msgLabel(id) {
    const m = /^(\d{4})(\d{2})(\d{2})T(\d{2})(\d{2})\d{2}Z-(.+)-[0-9a-f]{4}$/.exec(id);
    if (!m) return id;
    const ts = `${m[1]}-${m[2]}-${m[3]}T${m[4]}:${m[5]}:00Z`;
    return `${displayName(m[6], state.thread?.thread)} · ${shortDate(ts)} ${clock(ts)}`;
  }

  /**
   * Inline Markdown. Code spans, links and refs become placeholders (`\u0000N\u0000`)
   * so the emphasis passes cannot touch them; a link label is itself inline
   * Markdown (code and emphasis, never a nested link or ref button), so a token
   * can hold placeholders of earlier tokens and `restore` expands them all.
   * NULs in the input are dropped first, so text can never forge a placeholder.
   */
  function mdInline(text) {
    const tokens = [];
    const keep = (h) => {
      tokens.push(h);
      return `\u0000${tokens.length - 1}\u0000`;
    };
    const restore = (s) => s.replace(/\u0000(\d+)\u0000/g, (_, i) => restore(tokens[Number(i)] ?? ''));
    const emphasis = (s) => s
      .replace(/\*\*(?=\S)(.+?)\*\*/g, '<strong>$1</strong>')
      .replace(/__(?=\S)(.+?)__/g, '<strong>$1</strong>')
      .replace(/(^|[^\w*])\*(?=\S)([^*\n]+?)\*(?!\w)/g, '$1<em>$2</em>')
      .replace(/(^|[^\w])_(?=\S)([^_\n]+?)_(?!\w)/g, '$1<em>$2</em>')
      .replace(/~~(?=\S)(.+?)~~/g, '<del>$1</del>');
    let s = String(text ?? '').replace(/\u0000/g, '');
    s = s.replace(/`([^`\n]+)`/g, (_, c) => keep(`<code>${esc(c)}</code>`));
    // An image a message carries (§9, "Images"): only the team's saved attachments, served by the board.
    s = s.replace(/!\[([^\]\n]*)\]\((teams\/[a-z0-9][a-z0-9-]*\/attachments\/[A-Za-z0-9.-]+)\)/g, (_, alt, p) => {
      const src = `/api/attachment?path=${encodeURIComponent(p)}`;
      return keep(`<a class="md-img-link" href="${esc(src)}" target="_blank" rel="noopener noreferrer"><img class="md-img" src="${esc(src)}" alt="${esc(alt || 'image')}" loading="lazy"></a>`);
    });
    s = s.replace(/\[([^\]\n]+)\]\(([^)\s\u0000]+)\)/g, (m, label, url) => {
      if (!/^(https?:\/\/|mailto:|#\/)/i.test(url)) return m;
      return keep(`<a href="${esc(url)}" target="_blank" rel="noopener noreferrer">${emphasis(esc(label))}</a>`);
    });
    s = s.replace(/(^|[\s(])(https?:\/\/[^\s<>()\u0000]+[^\s<>().,;:!?'"\u0000])/g, (m, pre, url) => pre + keep(`<a href="${esc(url)}" target="_blank" rel="noopener noreferrer">${esc(url)}</a>`));
    s = s.replace(MSG_ID_RE, (id) => keep(`<button type="button" class="ref" data-act="goto-msg" data-id="${id}" title="${esc(id)}">↪ ${esc(msgLabel(id))}</button>`));
    s = s.replace(/\b([TID]-\d{3,})\b/g, (id) => keep(`<button type="button" class="ref" data-act="ref" data-ref="${id}">${id}</button>`));
    return restore(emphasis(esc(s)));
  }

  const LIST_RE = /^(\s*)([-*+]|\d+[.)])\s+(.*)$/;
  const isBlank = (l) => !String(l).trim();
  const startsBlock = (l) => /^\s*(```|~~~)/.test(l) || /^#{1,6}\s/.test(l) || /^\s*>/.test(l) || LIST_RE.test(l) || /^\s*([-*_])(\s*\1){2,}\s*$/.test(l);

  function md(src) {
    const lines = String(src ?? '').replace(/\r\n?/g, '\n').split('\n');
    const out = [];
    let i = 0;
    while (i < lines.length) {
      const l = lines[i];
      if (isBlank(l)) {
        i += 1;
        continue;
      }
      let m = /^\s*(```|~~~)/.exec(l);
      if (m) {
        const fence = m[1];
        const buf = [];
        i += 1;
        while (i < lines.length && !lines[i].trim().startsWith(fence)) buf.push(lines[i++]);
        i += 1;
        out.push(`<pre><code>${esc(buf.join('\n'))}</code></pre>`);
        continue;
      }
      m = /^(#{1,6})\s+(.*?)\s*#*\s*$/.exec(l);
      if (m) {
        const lvl = Math.min(6, m[1].length + 2);
        out.push(`<h${lvl} class="md-h">${mdInline(m[2])}</h${lvl}>`);
        i += 1;
        continue;
      }
      if (/^\s*([-*_])(\s*\1){2,}\s*$/.test(l)) {
        out.push('<hr>');
        i += 1;
        continue;
      }
      if (/^\s*>/.test(l)) {
        const buf = [];
        while (i < lines.length && /^\s*>/.test(lines[i])) buf.push(lines[i++].replace(/^\s*>\s?/, ''));
        out.push(`<blockquote>${md(buf.join('\n'))}</blockquote>`);
        continue;
      }
      if (l.includes('|') && i + 1 < lines.length && /^\s*\|?\s*:?-{3,}:?\s*(\|\s*:?-{3,}:?\s*)*\|?\s*$/.test(lines[i + 1])) {
        const row = (s) => s.trim().replace(/^\||\|$/g, '').split('|').map((c) => c.trim());
        const head = row(l);
        i += 2;
        const body = [];
        while (i < lines.length && lines[i].includes('|') && !isBlank(lines[i])) body.push(row(lines[i++]));
        out.push(`<div class="md-table"><table><thead><tr>${head.map((c) => `<th>${mdInline(c)}</th>`).join('')}</tr></thead><tbody>${body.map((r) => `<tr>${r.map((c) => `<td>${mdInline(c)}</td>`).join('')}</tr>`).join('')}</tbody></table></div>`);
        continue;
      }
      if (LIST_RE.test(l)) {
        const first = LIST_RE.exec(l);
        const indent = first[1].length;
        const ordered = /\d/.test(first[2]);
        const items = [];
        while (i < lines.length) {
          const lm = LIST_RE.exec(lines[i]);
          if (lm && lm[1].length === indent) {
            items.push([lm[3]]);
            i += 1;
          } else if (items.length && !isBlank(lines[i]) && /^\s/.test(lines[i]) && (!lm || lm[1].length > indent)) {
            items[items.length - 1].push(lines[i].slice(Math.min(indent + 2, lines[i].search(/\S/))));
            i += 1;
          } else if (isBlank(lines[i]) && i + 1 < lines.length && LIST_RE.test(lines[i + 1]) && LIST_RE.exec(lines[i + 1])[1].length === indent) {
            i += 1;
          } else break;
        }
        const lis = items.map(([head, ...rest]) => {
          const task = /^\[( |x|X)\]\s+(.*)$/.exec(head);
          const first = task ? `<span class="cb${task[1] === ' ' ? '' : ' on'}">${task[1] === ' ' ? '' : '✓'}</span>${mdInline(task[2])}` : mdInline(head);
          const nested = rest.length ? md(rest.join('\n')) : '';
          return `<li${task ? ' class="task"' : ''}>${first}${nested}</li>`;
        });
        out.push(`<${ordered ? 'ol' : 'ul'}>${lis.join('')}</${ordered ? 'ol' : 'ul'}>`);
        continue;
      }
      const buf = [];
      while (i < lines.length && !isBlank(lines[i]) && !(buf.length && startsBlock(lines[i]))) buf.push(lines[i++]);
      out.push(`<p>${buf.map(mdInline).join('<br>')}</p>`);
    }
    return out.join('');
  }

  // ---------------------------------------------------------------------------
  // Network
  // ---------------------------------------------------------------------------

  async function api(path, body) {
    const opts = { cache: 'no-store', headers: {} };
    if (body !== undefined) {
      opts.method = 'POST';
      opts.headers = { 'Content-Type': 'application/json', 'X-Factory-UI': '1' };
      opts.body = JSON.stringify(body);
    }
    let res;
    try {
      res = await fetch(path, opts);
    } catch {
      const e = new Error('The board server is not answering. Is `factory ui` still running?');
      e.code = 'offline';
      throw e;
    }
    let data = null;
    try {
      data = await res.json();
    } catch {
      data = null;
    }
    if (!res.ok) {
      const e = new Error(data?.error || `${res.status} ${res.statusText}`);
      e.code = data?.code || 'http';
      e.status = res.status;
      throw e;
    }
    return data;
  }

  let inflight = null;
  let rerun = false;
  async function refresh() {
    if (inflight) {
      rerun = true;
      return inflight;
    }
    inflight = (async () => {
      const r = state.route;
      const jobs = [
        api('/api/board').then((b) => {
          // Message links in rendered bodies name their sender; re-render them if the roster changed.
          const roster = JSON.stringify((b.members || []).map((m) => [m.id, m.name]));
          if (roster !== state.roster) {
            state.roster = roster;
            mdCache.clear();
          }
          state.board = b;
          state.boardError = null;
        }).catch((e) => {
          state.boardError = e;
        }),
      ];
      if (r.name === 'thread') jobs.push(loadThread(r.ref));
      if (r.name === 'inbox') jobs.push(loadInbox(inboxMember()));
      if (r.name === 'health' || !state.health) jobs.push(loadHealth());
      await Promise.all(jobs);
      state.loaded = true;
      if (state.board) {
        if (!state.seenSince) {
          state.seenSince = state.board.generated;
          LS.set('seenSince', state.seenSince);
        }
        if (r.name === 'thread' && state.thread && state.threadRef === r.ref && document.visibilityState === 'visible') markSeen(state.thread);
        notifyWaiting();
      }
      render();
      if (state.pendingNew !== null) {
        const team = state.pendingNew;
        state.pendingNew = null;
        openNewThread(team);
      }
      scheduleHealth();
    })();
    try {
      await inflight;
    } finally {
      inflight = null;
      if (rerun) {
        rerun = false;
        refresh();
      }
    }
  }

  async function loadThread(ref) {
    try {
      const v = await api(`/api/thread?ref=${encodeURIComponent(ref)}`);
      state.thread = v;
      state.threadRef = ref;
      state.threadError = null;
    } catch (e) {
      state.threadError = e;
      if (state.threadRef !== ref || e.status === 404) {
        state.thread = null;
        state.threadRef = ref;
      }
    }
  }

  async function loadInbox(member) {
    try {
      state.inbox = await api(`/api/inbox?member=${encodeURIComponent(member)}`);
      state.inboxError = null;
    } catch (e) {
      state.inboxError = e;
    }
  }

  async function loadHealth() {
    try {
      state.health = await api('/api/validate');
    } catch (e) {
      state.health = { ok: false, errors: [{ file: '', message: e.message }], warnings: [], failed: true };
    }
  }

  let healthTimer = null;
  function scheduleHealth() {
    clearTimeout(healthTimer);
    healthTimer = setTimeout(async () => {
      await loadHealth();
      renderRailFoot();
      if (state.route.name === 'health') renderMain();
    }, 900);
  }

  let es = null;
  let changeTimer = null;
  function connectFeed() {
    if (!('EventSource' in window)) return;
    es = new EventSource('/api/events');
    es.addEventListener('hello', (e) => {
      const wasOff = state.live === 'off';
      state.live = 'on';
      try {
        state.root = JSON.parse(e.data).root || state.root;
      } catch {
        // keep the last root
      }
      renderRail();
      if (wasOff && state.loaded) refresh();
    });
    es.addEventListener('change', () => {
      clearTimeout(changeTimer);
      changeTimer = setTimeout(refresh, 120);
    });
    es.onerror = () => {
      if (state.live !== 'off') {
        state.live = 'off';
        renderRailFoot();
      }
    };
  }

  // ---------------------------------------------------------------------------
  // Routing
  // ---------------------------------------------------------------------------

  function parseHash() {
    const h = location.hash.replace(/^#\/?/, '');
    const [p, query] = h.split('?');
    const parts = p.split('/').filter(Boolean).map((x) => {
      try {
        return decodeURIComponent(x);
      } catch {
        return x;
      }
    });
    const q = new URLSearchParams(query || '');
    if (parts[0] === 't' && parts[1] && parts[2]) {
      return { name: 'thread', ref: `${parts[1]}/${parts[2]}`, focus: q.get('m'), findRef: q.get('ref'), tab: q.get('tab') === 'doc' ? 'doc' : 'chat' };
    }
    if (parts[0] === 'tasks') return { name: 'tasks' };
    if (parts[0] === 'inbox') return { name: 'inbox', member: parts[1] || null };
    if (parts[0] === 'health') return { name: 'health' };
    if (parts[0] === 'new') return { name: 'new', team: parts[1] || null };
    return { name: 'board' };
  }

  const inboxMember = () => state.route.member || state.filter || 'you';
  const threadHash = (team, id, extra = '') => `#/t/${encodeURIComponent(team)}/${encodeURIComponent(id)}${extra}`;

  function onRoute() {
    const prev = state.route;
    state.route = parseHash();
    // #/new and #/new/<team> open the New thread modal over the board.
    if (state.route.name === 'new') {
      const team = state.route.team || '';
      history.replaceState(null, '', '#/board');
      state.route = { name: 'board' };
      if (state.loaded) setTimeout(() => openNewThread(team), 0);
      else state.pendingNew = team;
    }
    state.sideOpen = false;
    const r = state.route;
    if (r.name === 'thread' && (!prev || prev.name !== 'thread' || prev.ref !== r.ref || r.focus || r.findRef)) {
      state.firstPaint = true;
      if (state.threadRef !== r.ref) state.thread = null;
    }
    render();
    refresh();
  }

  // ---------------------------------------------------------------------------
  // Atoms
  // ---------------------------------------------------------------------------

  /**
   * Vendor marks a roster `logo` names, drawn white on the member's color.
   * openai and grok: @lobehub/icons-static-svg@1.95.1 (MIT); claude: Anthropic's published Claude mark;
   * shield (the security member): drawn here, a shield with a check cut out.
   */
  const LOGOS = {
    claude: { box: '0 0 44 44', d: 'M8.624 29.26L17.292 24.42L17.424 23.98L17.292 23.76H16.852L15.4 23.672L10.472 23.54L6.16 23.32L1.98 23.1L0.924 22.88L0 21.56L0.088 20.9L0.968 20.328L2.244 20.416L5.016 20.636L9.196 20.9L12.232 21.076L16.72 21.604H17.424L17.512 21.296L17.292 21.12L17.116 20.944L12.76 18.04L8.096 14.96L5.632 13.156L4.312 12.276L3.652 11.396L3.388 9.548L4.576 8.228L6.204 8.36L6.6 8.448L8.228 9.724L11.748 12.408L16.28 15.84L16.94 16.368L17.204 16.192L17.248 16.06L16.94 15.576L14.52 11L11.88 6.424L10.692 4.532L10.384 3.388C10.252 2.948 10.208 2.508 10.208 2.068L11.528 0.22L12.32 0L14.168 0.264L14.872 0.88L16.016 3.52L17.82 7.612L20.68 13.156L21.56 14.828L22 16.324L22.132 16.764H22.44V16.544L22.66 13.376L23.1 9.548L23.54 4.62L23.672 3.212L24.376 1.54L25.696 0.66L26.84 1.144L27.72 2.42L27.588 3.212L27.104 6.6L25.96 11.924L25.3 15.532H25.696L26.136 15.048L27.94 12.672L30.976 8.888L32.296 7.348L33.88 5.72L34.892 4.928H36.784L38.148 6.996L37.532 9.152L35.596 11.616L33.968 13.684L31.636 16.808L30.228 19.316L30.36 19.492H30.668L35.948 18.348L38.764 17.864L42.108 17.292L43.648 17.996L43.824 18.7L43.208 20.196L39.6 21.076L35.376 21.956L29.084 23.408L28.996 23.452L29.084 23.584L31.9 23.848L33.132 23.936H36.124L41.668 24.376L43.12 25.256L43.956 26.444L43.824 27.324L41.58 28.468L38.588 27.764L31.548 26.092L29.172 25.52H28.82V25.696L30.844 27.676L34.496 30.976L39.16 35.244L39.38 36.3L38.808 37.18L38.192 37.092L34.144 34.012L32.56 32.692L29.04 29.7H28.82V30.008L29.612 31.196L33.924 37.664L34.144 39.644L33.836 40.26L32.692 40.7L31.504 40.436L28.952 36.916L26.312 32.956L24.244 29.348L24.024 29.524L22.748 42.812L22.176 43.472L20.856 44L19.756 43.12L19.14 41.8L19.756 39.072L20.46 35.552L21.032 32.736L21.56 29.26L21.868 28.116V28.028H21.56L18.92 31.68L14.96 37.092L11.792 40.436L11.044 40.744L9.724 40.084L9.856 38.852L10.56 37.84L14.96 32.208L17.6 28.732L19.36 26.708L19.316 26.488H19.184L7.568 34.056L5.5 34.32L4.62 33.44L4.708 32.12L5.148 31.68L8.668 29.26H8.624Z' },
    openai: { box: '0 0 24 24', d: 'M9.205 8.658v-2.26c0-.19.072-.333.238-.428l4.543-2.616c.619-.357 1.356-.523 2.117-.523 2.854 0 4.662 2.212 4.662 4.566 0 .167 0 .357-.024.547l-4.71-2.759a.797.797 0 00-.856 0l-5.97 3.473zm10.609 8.8V12.06c0-.333-.143-.57-.429-.737l-5.97-3.473 1.95-1.118a.433.433 0 01.476 0l4.543 2.617c1.309.76 2.189 2.378 2.189 3.948 0 1.808-1.07 3.473-2.76 4.163zM7.802 12.703l-1.95-1.142c-.167-.095-.239-.238-.239-.428V5.899c0-2.545 1.95-4.472 4.591-4.472 1 0 1.927.333 2.712.928L8.23 5.067c-.285.166-.428.404-.428.737v6.898zM12 15.128l-2.795-1.57v-3.33L12 8.658l2.795 1.57v3.33L12 15.128zm1.796 7.23c-1 0-1.927-.332-2.712-.927l4.686-2.712c.285-.166.428-.404.428-.737v-6.898l1.974 1.142c.167.095.238.238.238.428v5.233c0 2.545-1.974 4.472-4.614 4.472zm-5.637-5.303l-4.544-2.617c-1.308-.761-2.188-2.378-2.188-3.948A4.482 4.482 0 014.21 6.327v5.423c0 .333.143.571.428.738l5.947 3.449-1.95 1.118a.432.432 0 01-.476 0zm-.262 3.9c-2.688 0-4.662-2.021-4.662-4.519 0-.19.024-.38.047-.57l4.686 2.71c.286.167.571.167.856 0l5.97-3.448v2.26c0 .19-.07.333-.237.428l-4.543 2.616c-.619.357-1.356.523-2.117.523zm5.899 2.83a5.947 5.947 0 005.827-4.756C22.287 18.339 24 15.84 24 13.296c0-1.665-.713-3.282-1.998-4.448.119-.5.19-.999.19-1.498 0-3.401-2.759-5.947-5.946-5.947-.642 0-1.26.095-1.88.31A5.962 5.962 0 0010.205 0a5.947 5.947 0 00-5.827 4.757C1.713 5.447 0 7.945 0 10.49c0 1.666.713 3.283 1.998 4.448-.119.5-.19 1-.19 1.499 0 3.401 2.759 5.946 5.946 5.946.642 0 1.26-.095 1.88-.309a5.96 5.96 0 004.162 1.713z' },
    shield: { box: '0 0 24 24', d: 'M12 2.2 4.5 5v6.1c0 4.7 3.2 9 7.5 10.7 4.3-1.7 7.5-6 7.5-10.7V5L12 2.2Zm-1.2 13.6-3.4-3.4 1.4-1.4 2 2 4.6-4.6 1.4 1.4-6 6Z' },
    grok: { box: '0 0 24 24', d: 'M9.27 15.29l7.978-5.897c.391-.29.95-.177 1.137.272.98 2.369.542 5.215-1.41 7.169-1.951 1.954-4.667 2.382-7.149 1.406l-2.711 1.257c3.889 2.661 8.611 2.003 11.562-.953 2.341-2.344 3.066-5.539 2.388-8.42l.006.007c-.983-4.232.242-5.924 2.75-9.383.06-.082.12-.164.179-.248l-3.301 3.305v-.01L9.267 15.292M7.623 16.723c-2.792-2.67-2.31-6.801.071-9.184 1.761-1.763 4.647-2.483 7.166-1.425l2.705-1.25a7.808 7.808 0 00-1.829-1A8.975 8.975 0 005.984 5.83c-2.533 2.536-3.33 6.436-1.962 9.764 1.022 2.487-.653 4.246-2.34 6.022-.599.63-1.199 1.259-1.682 1.925l7.62-6.815' },
  };
  function avatar(id, size = 24, th = null) {
    const m = seatOf(id, th);
    const tip = `${id === 'you' ? 'You' : m.name} · ${m.role}${m.model ? ` · ${m.model}` : ''}`;
    const logo = Object.hasOwn(LOGOS, m.logo) ? LOGOS[m.logo] : null;
    const inner = logo
      ? raw(`<svg viewBox="${logo.box}" fill="currentColor" aria-hidden="true"><path fill-rule="evenodd" d="${logo.d}"/></svg>`)
      : m.short || String(id).slice(0, 2).toUpperCase();
    return html`<span class="av${logo ? ' logo' : ''}" style="--av:${safeColor(m.color)};--s:${String(size)}px" title="${tip}" aria-label="${displayName(id, th)}">${inner}</span>`;
  }
  function avatarStack(ids, size = 20, max = 4, th = null) {
    const list = uniq(ids);
    const shown = list.slice(0, max);
    return html`<span class="av-stack">${shown.map((id) => avatar(id, size, th))}${list.length > max ? html`<span class="av-more">+${list.length - max}</span>` : ''}</span>`;
  }
  // Presence: what each agent is doing, from teams/.presence (the CLI writes it).
  const WORKING_FRESH_S = 600;
  function presenceOf(id, p, withThread, th = null) {
    const who = displayName(id, th);
    if (!p) return { cls: 'off', label: 'not started', tip: `${who} has not run a factory command yet` };
    const ago = secondsSince(p.at);
    const where = withThread && p.thread ? ` · ${p.thread}` : '';
    if (p.state === 'watching' && p.alive) return { cls: 'watching', label: `watching${where}`, tip: `${who} is waiting for a message${p.thread ? ` on ${p.thread}` : ''}, since ${agoText(ago)}` };
    if (p.state === 'working' && ago < WORKING_FRESH_S) return { cls: 'working', label: `working${where} · ${agoText(ago)}`, tip: `${who}, ${agoText(ago)}: ${p.activity || 'ran a factory command'}${p.thread ? ` (${p.thread})` : ''}` };
    if (p.waiting) {
      const on = p.waiting.thread;
      return { cls: 'watching', label: `watching${withThread && on ? ` · ${on}` : ''}`, tip: `${who} is waiting for a message${on ? ` on ${on}` : ''}; last ${p.activity || 'ran a factory command'}, ${agoText(ago)}` };
    }
    return { cls: 'idle', label: `last seen ${agoText(ago)}`, tip: `${who} last ${p.state === 'watching' ? 'stopped waiting' : 'ran'}: ${p.activity || 'a factory command'}${p.thread ? ` (${p.thread})` : ''}, ${agoText(ago)}` };
  }
  // openai and grok run in sessions the owner starts; fable spawns the builders and the monitor itself.
  const ownerStarts = (id) => ['reviewer', 'gatekeeper', 'solo'].includes(memberOf(id).role);
  const isActive = (p) => !!p && ((p.state === 'watching' && p.alive) || !!p.waiting || (p.state === 'working' && secondsSince(p.at) < WORKING_FRESH_S));
  /**
   * Active in a session the owner started: presence written by an autopilot run
   * (before its last run ended, or since the current one started) does not count.
   * m is the member's raw autopilot record, alive or not.
   */
  const activeOutsideRuns = (p, m) => {
    if (!isActive(p)) return false;
    const at = Date.parse(p.at);
    if (m?.last?.ended_at && at <= Date.parse(m.last.ended_at)) return false;
    // Presence written since any of its runs started is that run's.
    if (runsOf(m).some((r) => r.started_at && at >= Date.parse(r.started_at))) return false;
    return true;
  };
  /** A member's runs going, one per thread (the board payload's `runs`; `running` alone from an older autopilot). */
  const runsOf = (m) => (Array.isArray(m?.runs) ? m.runs : m?.running ? [m.running] : []);
  /** The member's run on one thread, or null. */
  const runOn = (m, ref) => (ref ? runsOf(m).find((r) => r.ref === ref) || null : null);
  /** The member's autopilot record whether or not the autopilot still runs (its last run explains its presence). */
  const apRaw = (id, ap = state.board?.autopilot) => ap?.members?.[id] || null;
  const RUN_SHORT = { answered: 'done', left_open: 'left a turn open', failed: 'failed', timed_out: 'timed out', stopped: 'stopped' };
  /** The autopilot's record for a member, when the autopilot runs (factory autopilot). */
  const apMember = (id, ap = state.board?.autopilot) => (ap?.alive ? ap.members?.[id] || null : null);
  const RUN_OUTCOME = { left_open: 'left the turn open', failed: 'failed twice', timed_out: 'ran out of time twice', stopped: 'was stopped' };
  /**
   * Whether the owner must start an agent for these held items: null when it runs,
   * or the autopilot will start it; else {kind: start|stuck|capped, text, tip}.
   * Notices (events, alerts, reports) never need a start.
   */
  function needsStart(id, held, presence, ap = state.board?.autopilot) {
    const mine = held.filter((h) => h.member === id && !NOTIFY_TYPES.has(h.type));
    if (!mine.length || !ownerStarts(id)) return null;
    const raw = apRaw(id, ap);
    const m = apMember(id, ap);
    if (activeOutsideRuns(presence?.[id], raw)) return null; // the owner's own session has it
    const who = displayName(id, threadByRef(mine[0].ref));
    // Stuck first: a run on another thread does not take this turn off the owner's list.
    const stuck = m ? mine.filter((h) => h.msgId && m.stuck.includes(h.msgId)) : [];
    if (stuck.length) {
      const note = m.notes?.[stuck[0].msgId] || {};
      return { kind: 'stuck', text: `${who}'s run ${RUN_OUTCOME[note.outcome] || 'did not finish'}`, tip: `Log: ${note.log || 'teams/.autopilot/runs'}${note.said ? `\nIt said: ${note.said}` : ''}` };
    }
    // Each thread runs on its own: only a run on the held turns' own threads covers them.
    if (m && mine.every((h) => runOn(m, h.ref))) return null;
    if (m?.enabled && m.capped) return { kind: 'capped', text: `${who} hit 6 runs this hour on that thread`, tip: 'The autopilot carries on within the hour. That many runs usually means something loops: see teams/.autopilot/runs', copy: false };
    if (m?.enabled && mine.some((h) => h.msgId)) return null;
    return { kind: 'start', text: `Start ${who}`, tip: '' };
  }

  /**
   * The fresh-session prompt the owner pastes to start an agent on one thread: the
   * same text as factory/lib/autopilot.mjs kickoffPrompt (not auto, not resumed),
   * with the single-agent prompt only for that thread's own agent.
   */
  const kickoffPrompt = (id, ref) => (allThreads().some((x) => `${x.team}/${x.id}` === ref && x.kind === 'solo' && x.owner === id)
    ? `You are ${id}, the agent and lead of the single-agent thread ${ref} in the software factory. Read factory/roles/solo.md and follow it. Work your inbox for thread ${ref} until it is empty, then stop and tell me what you did.`
    : memberOf(id)?.role === 'lead'
      ? `You are ${id}, the lead of the software factory. Read .claude/skills/factory/SKILL.md and factory/roles/lead.md and follow them. Work your inbox for thread ${ref} until it is empty, then stop and tell me what you did.`
      : `You are ${id} in the software factory. Read factory/skills/factory-${id}/SKILL.md and follow it. Work your inbox for thread ${ref} until it is empty, then stop and tell me what you did.`);
  /**
   * What each member owes: open turns plus pending gates with no turn, as
   * {member, msgId, ref, what, ts}. Turns come from one thread view or the whole board.
   */
  function heldItems(threads, turnsOf) {
    const out = [];
    for (const th of threads) {
      const ref = `${th.team}/${th.id}`;
      const turns = turnsOf(th);
      for (const o of turns) out.push({ member: o.member, msgId: o.message.id, type: o.message.type, ref, team: th.team, thread: th.id, what: o.message.kind === 'permission_denied' ? 'permission request' : `${TYPE_LABEL[o.message.type] || o.message.type} from ${displayName(o.message.from, th)}`, ts: o.message.ts });
      const gw = gateWait(th, turns);
      if (gw) out.push({ member: gw.member, msgId: null, ref, team: th.team, thread: th.id, what: `${(PHASE_LABEL[gw.gate] || gw.gate).toLowerCase()} gate`, ts: th.updated });
    }
    return out.sort((a, b) => String(a.ts).localeCompare(String(b.ts)));
  }
  /** One badge per agent: the lead and reviewers always, builders and the monitor once they have run or hold a turn. */
  function presenceStrip(ids, presence, withThread, held = [], th = null) {
    const list = uniq(ids).filter((id) => id !== 'you' && id !== 'factory' && memberOf(id).kind !== 'human' && memberOf(id).kind !== 'system')
      .filter((id) => presence[id] || held.some((h) => h.member === id) || !['builder', 'monitor'].includes(memberOf(id).role));
    if (!list.length) return '';
    return html`<div class="presence" role="status" aria-label="What each agent is doing and waiting on"><span class="presence-k">Agents</span>${list.map((id) => {
      const am = apMember(id);
      const mine = held.filter((h) => h.member === id);
      const first = mine[0];
      // On the board, a member goes by its seat on the thread it is running on, holds a turn in, or last wrote in.
      const where = th || threadByRef(am?.running?.ref || first?.ref || presence[id]?.thread);
      let s = presenceOf(id, presence[id], withThread, where);
      // On a thread page, only this thread's run counts: a run on another thread is that thread's business.
      const run = th ? runOn(am, `${th.team}/${th.id}`) : am?.running || null;
      const others = runsOf(am).length - (run ? 1 : 0);
      if (run) {
        s = { cls: 'working', label: `running${withThread ? ` · ${runsOf(am).map((r) => r.ref).join(', ')}` : ''} · ${agoText(secondsSince(run.started_at))}`, tip: `The autopilot started ${displayName(id, where)} on ${run.ref}, ${agoText(secondsSince(run.started_at))}. Log: ${run.log}${others ? `\nAlso running on ${plural(others, 'other thread')}.` : ''}` };
      } else if (th && !withThread && others) {
        s = { cls: 'idle', label: 'not running here', tip: `${displayName(id, where)} is running on ${runsOf(am).map((r) => r.ref).join(', ')}; this thread gets its own run when it has work.` };
      } else if (apRaw(id)?.last?.ended_at && !activeOutsideRuns(presence[id], apRaw(id))) {
        const l = apRaw(id).last;
        s = { cls: 'idle', label: `last run ${RUN_SHORT[l.outcome] || l.outcome} · ${agoText(secondsSince(l.ended_at))}`, tip: `The autopilot's last ${displayName(id, where)} run on ${l.ref}: ${l.outcome}, ${agoText(secondsSince(l.ended_at))}.${l.said ? `\nIt said: ${l.said}` : ''}\nLog: ${l.log}` };
      }
      // Only a plain turn starts by itself: not a notice, a gate with no turn, or a turn a run left open.
      const autoNext = !runOn(am, first?.ref) && am?.enabled && first?.msgId && !NOTIFY_TYPES.has(first.type) && !am.stuck.includes(first.msgId)
        && !needsStart(id, held, presence) && !activeOutsideRuns(presence[id], apRaw(id));
      const owes = first ? ` · has ${first.what}, ${ageText(secondsSince(first.ts))}${mine.length > 1 ? ` +${mine.length - 1}` : ''}${autoNext ? ' · starting by itself' : ''}` : '';
      const tip = `${s.tip}${mine.length ? `\nHolds: ${mine.map((h) => `${h.what} (${h.ref})`).join('; ')}` : ''}`;
      const inner = html`${avatar(id, 18, where)}<span class="pres-who">${displayName(id, where)}</span><span class="pres-dot" aria-hidden="true"></span><span class="pres-what">${s.label}${owes}</span>`;
      if (!first) return html`<span class="pres ${s.cls}" title="${tip}">${inner}</span>`;
      if (!withThread && first.msgId) return html`<button type="button" class="pres ${s.cls} holds" data-act="goto-msg" data-id="${first.msgId}" title="${tip}">${inner}</button>`;
      return html`<a class="pres ${s.cls} holds" href="${threadHash(first.team, first.thread)}" title="${tip}">${inner}</a>`;
    })}</div>`;
  }
  function threadPresence(v) {
    const th = { ...v.thread, team: v.team };
    return presenceStrip([th.lead, th.owner, ...(th.members || [])].filter(Boolean), v.presence || state.board?.presence || {}, false, heldItems([th], () => v.openTurns).filter((h) => h.member !== 'you'), th);
  }
  const count = (n, cls = '') => html`<span class="count ${cls || (n ? '' : 'zero')}">${String(n)}</span>`;
  const sevChip = (s) => html`<span class="sev ${s}">${s}</span>`;
  const pill = (cls, label, dot = false) => html`<span class="pill ${cls}">${dot ? raw('<span class="dot"></span>') : ''}${label}</span>`;
  const typeChip = (t) => html`<span class="tchip ${t}">${TYPE_LABEL[t] || t}</span>`;
  const verdictBadge = (v) => html`<span class="verdict ${v}">${v === 'approve' ? icon('check', 'xs') : ''}${VERDICT[v] || v}</span>`;

  function phasePill(th, mini = false) {
    if (th.kind === 'solo') return pill(`active${mini ? ' mini' : ''}`, mini ? 'Agent' : 'Single agent', !mini);
    if (th.kind === 'watch') return pill(`${th.phase}${mini ? ' mini' : ''}`, mini ? PHASE_SHORT[th.phase] : PHASE_LABEL[th.phase], !mini);
    const g = th.gates?.[th.phase];
    const cls = th.phase === 'done' ? 'done' : g && g.status !== 'pending' ? g.status : 'gate';
    return pill(`${cls}${mini ? ' mini' : ''}`, mini ? PHASE_SHORT[th.phase] || th.phase : PHASE_LABEL[th.phase] || th.phase);
  }

  function gateStatus(th) {
    if (th.kind !== 'project') return '';
    if (th.phase === 'done') return html`<span class="gstat approved">${icon('check', 'xs')}Done</span>`;
    if (th.phase === 'build') return html`<span class="gstat" title="The build gate approves itself when every task is done"><span class="gdot auto"></span>Auto</span>`;
    const g = th.gates?.[th.phase];
    if (!g) return html`<span class="gstat">No gate</span>`;
    return html`<span class="gstat ${g.status}" title="${PHASE_LABEL[th.phase]} gate: ${GATE_STATUS[g.status]} (${displayName(g.by, th)})"><span class="gdot ${g.status}"></span>${GATE_STATUS_SHORT[g.status]}</span>`;
  }

  function issueChip(teamId, issueId) {
    const is = teamOf(teamId).issues.find((x) => x.id === issueId);
    return html`<span class="chip" title="${is ? `${issueId} · ${is.severity} · ${is.status}: ${is.title}` : issueId}">${icon('flag', 'xs')}${issueId}${is ? html` · ${is.status}` : ''}</span>`;
  }

  // ---------------------------------------------------------------------------
  // Rail
  // ---------------------------------------------------------------------------

  function ensureRail() {
    const rail = $('#rail');
    if (rail.dataset.ready) return rail;
    rail.dataset.ready = '1';
    rail.innerHTML = '<div id="rail-top"></div><section class="run-box" id="rail-running" aria-label="Running"></section><div class="rail-label rail-label-row" id="rail-teams-head"></div><div class="teams" id="rail-teams"></div><footer class="rail-foot" id="rail-foot"></footer>';
    return rail;
  }

  const isField = (el) => Boolean(el) && (el.tagName === 'INPUT' || el.tagName === 'TEXTAREA' || el.tagName === 'SELECT');

  /** A selector that finds the same control after a rebuild (data-act plus its data keys, data-team, or href). */
  function focusKey(el) {
    if (el.dataset.act) {
      return `[data-act="${CSS.escape(el.dataset.act)}"]${['verdict', 'id', 'i', 'team'].filter((k) => el.dataset[k] !== undefined).map((k) => `[data-${k}="${CSS.escape(el.dataset[k])}"]`).join('')}`;
    }
    if (el.dataset.team !== undefined) return `[data-team="${CSS.escape(el.dataset.team)}"]`;
    if (el.getAttribute('href')) return `[href="${CSS.escape(el.getAttribute('href'))}"]`;
    return null;
  }

  /**
   * Re-render a region when its HTML changed, keeping keyboard focus on the same
   * control. With `fields: 'keep'` a region whose focused element is a form
   * field is left alone, so a refresh never eats what is being typed.
   */
  function paint(el, content, { fields = 'replace' } = {}) {
    if (!el) return;
    const active = document.activeElement;
    const inside = active && active !== document.body && el.contains(active);
    if (inside && fields === 'keep' && isField(active)) return;
    const key = inside ? focusKey(active) : null;
    if (setHtml(el, content) && key) el.querySelector(key)?.focus({ preventScroll: true });
  }

  function renderRail() {
    ensureRail();
    const b = state.board;
    const r = state.route;
    const focus = focusMember();
    const threads = allThreads();
    const myTurns = threads.flatMap((th) => th.openTurns).filter((o) => o.member === focus).length + gateWaitsFor(focus).length;
    const openTasks = (b?.teams || []).flatMap((t) => t.tasks).filter((x) => x.status !== 'done').length;
    const rootName = state.root ? state.root.split('/').filter(Boolean).slice(-2).join('/') : 'local root';
    paint($('#rail-top'), html`
      <div class="rail-head"><div class="brand">${LOGO}<div style="min-width:0"><div class="brand-name">Software Factory</div><div class="brand-root mono" title="${state.root}">${rootName}</div></div></div></div>
      <nav class="nav" aria-label="Views">
        <button class="nav-item jump-open" type="button" data-act="jump-open" title="Jump to a thread, team or view">${icon('search')}<span>Jump to</span><kbd>${IS_MAC ? '⌘' : 'Ctrl+'}K</kbd></button>
        <a class="nav-item${r.name === 'board' ? ' on' : ''}" href="#/board">${icon('board')}<span>Board</span>${count(threads.filter((x) => x.kind === 'project' && x.phase !== 'done').length)}</a>
        <a class="nav-item${r.name === 'tasks' ? ' on' : ''}" href="#/tasks">${icon('tasks')}<span>Tasks</span>${count(openTasks)}</a>
        <a class="nav-item${r.name === 'inbox' ? ' on' : ''}" href="#/inbox">${icon('inbox')}<span>Inbox</span>${count(myTurns, myTurns ? 'hot' : '')}</a>
      </nav>`);
    paint($('#rail-teams-head'), html`<span>Teams</span><button type="button" class="rail-add" data-act="nf-open" data-team="" title="New thread in a new team" aria-label="New thread in a new team">${icon('plus', 'sm')}</button>`);
    paint($('#rail-teams'), railTeams());
    paint($('#rail-running'), railRunning());
    renderRailFoot();
  }

  /**
   * What is running now, so nothing is left behind: each agent run this root's
   * autopilot started (or a stopped one left going), and each agent active in a
   * session the owner started. Factory processes for other folders (the test
   * suite's throwaway autopilots, say) are not this board's business and are not shown.
   */
  function railRunning() {
    const b = state.board;
    if (!b) return '';
    const ap = b.autopilot || {};
    const runs = ap.alive ? Object.entries(ap.members || {}).flatMap(([id, m]) => runsOf(m).map((r) => ({ id, ref: r.ref, since: r.started_at }))) : [];
    // Runs going while no autopilot runs: the next one takes them over, and `autopilot --stop --runs` ends them.
    const orphans = ap.alive ? [] : (ap.leftover_runs || []).map((r) => ({ id: r.member, ref: r.ref, since: r.started_at }));
    const running = new Set([...runs, ...orphans].map((r) => r.id));
    const sessions = Object.entries(b.presence || {})
      .filter(([id, p]) => id !== 'you' && !running.has(id) && activeOutsideRuns(p, apRaw(id, ap)))
      .map(([id, p]) => ({ id, p }));
    const agents = runs.length + orphans.length + sessions.length;
    // key: 'autopilot', this root's (a dead one's leftover runs).
    const stopBtn = (key, what) => {
      const sure = state.confirmStop === String(key);
      return html`<button class="btn ${sure ? 'btn-danger' : 'btn-outline'} xs" type="button" data-act="proc-stop" data-id="${String(key)}"${state.procBusy ? raw(' disabled') : ''} title="${sure ? `Click again to stop ${what}` : `Stop ${what}`}">${sure ? 'Confirm' : 'Stop'}</button>`;
    };
    // The autopilot is not shown: the board keeps it running (factory ui), so agents always start by themselves.
    const agentRows = [
      ...orphans.map((r) => { const t = threadByRef(r.ref); return html`<div class="run-row left" title="${displayName(r.id, t)}: a run going while the autopilot restarts${r.ref ? ` on ${r.ref}` : ''}. The autopilot takes it over when it is back (within 30 seconds); Stop ends it."><span class="pres-dot working"></span>${avatar(r.id, 18, t)}<span class="run-name">${displayName(r.id, t)}</span><span class="run-what warn">running${r.ref ? ` · ${r.ref.split('/').pop()}` : ''}</span>${stopBtn('autopilot', `${displayName(r.id, t)}'s leftover run`)}</div>`; }),
      ...runs.map((r) => { const t = threadByRef(r.ref); return html`<a class="run-row" href="#/t/${r.ref}" title="${displayName(r.id, t)}: a run the autopilot started on ${r.ref}; it ends by itself when it has answered (60 minutes at most; 3 hours for the lead)"><span class="pres-dot working"></span>${avatar(r.id, 18, t)}<span class="run-name">${displayName(r.id, t)}</span><span class="run-what">${r.ref.split('/').pop()} · ${ageText(secondsSince(r.since))}</span></a>`; }),
      ...sessions.map(({ id, p }) => {
        const pr = presenceOf(id, p, false, threadByRef(p.thread));
        const tip = `${pr.tip}. It runs in a session you started (Claude Code or Codex): close that session to stop it.`;
        // A wait that outlived its later commands is on the thread it waits on.
        const th = pr.cls === 'watching' && p.state !== 'watching' ? p.waiting?.thread || p.thread : p.thread;
        const t = threadByRef(th);
        const inner = html`<span class="pres-dot ${pr.cls === 'watching' ? 'ok' : 'working'}"></span>${avatar(id, 18, t)}<span class="run-name">${displayName(id, t)}</span><span class="run-what">${pr.cls}${th ? ` · ${th.split('/').pop()}` : ''}</span>`;
        return th ? html`<a class="run-row" href="#/t/${th}" title="${tip}">${inner}</a>` : html`<div class="run-row" title="${tip}">${inner}</div>`;
      }),
    ];
    return html`
      <div class="rail-label run-head"><span>Running</span>${count(agents)}<span class="run-sub">${agents === 1 ? 'agent' : 'agents'}</span></div>
      ${agentRows.length ? agentRows : html`<div class="run-row empty">No agent is working now</div>`}`;
  }

  async function procAction(body) {
    state.procBusy = true;
    state.confirmStop = null;
    paint($('#rail-running'), railRunning());
    try {
      await api('/api/process', body);
      toast(body.action === 'start' ? 'Autopilot started' : 'Stopped');
    } catch (err) {
      toast(err.message || 'That did not work', true);
    } finally {
      state.procBusy = false;
      await refresh();
    }
  }

  /** A team's ⋯ menu: start a thread in it, or archive it (a second click within 4 s confirms). */
  function teamMenu(t) {
    const sure = state.confirmArchive === t.id;
    return html`<div class="team-menu" role="menu" aria-label="${t.title}">
      <button type="button" role="menuitem" data-act="nf-open" data-team="${t.id}">${icon('plus', 'sm')}<span>New thread</span></button>
      <button type="button" role="menuitem" class="${sure ? 'danger' : ''}" data-act="team-archive" data-team="${t.id}" title="Moves the team to teams/.archive/; nothing is deleted">${icon('archive', 'sm')}<span>${sure ? 'Click again to archive' : 'Archive team'}</span></button>
    </div>`;
  }

  const paintTeams = () => paint($('#rail-teams'), railTeams());

  async function archiveTeam(id) {
    const title = (state.board?.teams || []).find((t) => t.id === id)?.title || id;
    try {
      const r = await api('/api/team/archive', { team: id });
      toast(`Archived ${title}. Nothing was deleted: it is in ${r.path}.`);
      if (state.route?.ref?.startsWith(`${id}/`)) location.hash = '#/board';
      if (state.newThread?.team === id) state.newThread.team = '';
      await refresh();
    } catch (err) {
      toast(err.message || 'That did not work', true);
    }
  }

  function railTeams() {
    const b = state.board;
    if (!b) return html`<div class="faint" style="padding:6px 12px;font-size:12.5px">${state.boardError ? 'Board unavailable' : 'Loading…'}</div>`;
    if (!b.teams.length) return html`<div class="faint" style="padding:6px 12px;font-size:12.5px">No teams yet.</div>${railArchived(b)}`;
    const focus = focusMember();
    const current = state.route.name === 'thread' ? state.route.ref : null;
    return html`${b.teams.map((t) => {
      const collapsed = state.collapsed.has(t.id);
      return html`<div class="team">
        <div class="team-row"><button class="team-head" type="button" data-act="toggle-team" data-team="${t.id}" aria-expanded="${String(!collapsed)}">${icon('chevron', collapsed ? 'sm' : 'sm open')}<span class="team-title">${t.title}</span>${count(t.threads.length)}</button><button type="button" class="team-more${state.teamMenu === t.id ? ' on' : ''}" data-act="team-menu" data-team="${t.id}" title="${t.title}: more" aria-label="More for ${t.title}" aria-haspopup="menu" aria-expanded="${String(state.teamMenu === t.id)}">${icon('more', 'sm')}</button>${state.teamMenu === t.id ? teamMenu(t) : ''}</div>
        ${collapsed ? '' : html`<ul class="tlist">${t.threads.map((th) => {
          // Orange counts only what waits on the focused member; agent-to-agent turns stay grey.
          const gw = gateWait(th);
          // For the owner, openai or grok holding a turn while not running also needs you: only you can start them.
          const heldHere = focus === 'you' ? heldItems([{ ...th, team: t.id }], () => th.openTurns) : [];
          const idle = focus === 'you' ? uniq(heldHere.map((h) => h.member)).filter((m) => m !== 'you' && needsStart(m, heldHere, state.board?.presence)).length : 0;
          const mineN = th.openTurns.filter((o) => o.member === focus).length + (gw?.member === focus ? 1 : 0) + idle;
          const n = mineN || th.openTurns.length + (gw ? 1 : 0);
          const mine = mineN > 0;
          const dim = state.filter && !involves(th, state.filter);
          const unread = current !== `${t.id}/${th.id}` && isUnread(th);
          return html`<li><a class="titem${current === `${t.id}/${th.id}` ? ' on' : ''}${dim ? ' dim' : ''}${unread ? ' unread' : ''}" href="${threadHash(t.id, th.id)}" title="${th.title}${unread ? ' (new since you last looked)' : ''}">
            <span class="titem-ic">${icon(th.kind === 'watch' ? 'watch' : th.kind === 'solo' ? 'solo' : 'project', 'sm')}</span>
            <span class="titem-title">${th.title}</span>${unread ? raw('<span class="unread-dot" aria-label="unread"></span>') : ''}
            ${phasePill(th, true)}
            ${n ? html`<span title="${mine ? `${plural(mineN, 'item')} waiting on ${focus === 'you' ? 'you' : displayName(focus)}` : `${plural(n, 'open turn')} between agents`}">${count(n, mine ? 'hot' : '')}</span>` : ''}
          </a></li>`;
        })}</ul>`}
      </div>`;
    })}${railArchived(b)}`;
  }

  /** Teams moved off the board with Archive team, newest first; Restore brings one back as it was. */
  function railArchived(b) {
    const list = b.archivedTeams || [];
    if (!list.length) return '';
    const open = state.showArchived;
    return html`<div class="team archived">
      <div class="team-row"><button class="team-head" type="button" data-act="toggle-archived" aria-expanded="${String(open)}">${icon('chevron', open ? 'sm open' : 'sm')}<span class="team-title">Archived</span>${count(list.length)}</button></div>
      ${open ? html`<ul class="tlist">${list.map((a) => html`<li><div class="titem arch-item" title="${a.title}: ${a.path}">
        <span class="titem-ic">${icon('archive', 'sm')}</span>
        <span class="arch-text"><span class="titem-title">${a.title}</span><small>${plural(a.threads, 'thread')} · ${agoText(secondsSince(a.archived_at))}</small></span>
        <button type="button" class="arch-restore" data-act="team-restore" data-name="${a.name}"${state.restoring ? ' disabled' : ''}>${state.restoring === a.name ? 'Restoring…' : 'Restore'}</button>
      </div></li>`)}</ul>` : ''}
    </div>`;
  }

  async function restoreTeam(name) {
    const a = (state.board?.archivedTeams || []).find((x) => x.name === name);
    state.restoring = name;
    paintTeams();
    try {
      const r = await api('/api/team/restore', { name });
      toast(`Restored ${r.team.title} with ${plural(r.threads, 'thread')}.`);
      state.collapsed.delete(r.team.id);
      await refresh();
    } catch (err) {
      toast(err.message || `Could not restore ${a?.title || name}`, true);
    } finally {
      state.restoring = null;
      paintTeams();
    }
  }

  /** A cost total ({usd, runs, unpriced}, store.costs) as dollars, and what it covers. */
  const usd = (n) => `$${(Number(n) || 0).toFixed(2)}`;
  const costTip = (c) => `${plural(c.runs, 'agent run')}${c.unpriced ? `; ${c.unpriced} reported no cost (Codex runs report none)` : ''}`;
  /** A thread's Cost row for its Details panel. */
  const costRow = (c) => html`<dt>Cost</dt><dd class="mono" title="${c ? costTip(c) : ''}">${c ? `${usd(c.usd)} · ${plural(c.runs, 'run')}` : 'no runs yet'}</dd>`;

  function renderRailFoot() {
    const foot = $('#rail-foot');
    if (!foot) return;
    const h = state.health;
    const live = state.live === 'on' ? ['on', 'Live'] : state.live === 'off' ? ['off', 'Reconnecting…'] : ['', 'Connecting…'];
    let health = html`<a class="health" href="#/health" title="factory validate">${icon('shield', 'sm')}…</a>`;
    if (h && !h.failed) {
      const cls = h.errors.length ? 'bad' : h.warnings.length ? 'warn' : '';
      const label = h.errors.length ? plural(h.errors.length, 'error') : h.warnings.length ? plural(h.warnings.length, 'warning') : 'Valid';
      health = html`<a class="health ${cls}" href="#/health" title="factory validate: ${h.errors.length} errors, ${h.warnings.length} warnings">${icon('shield', 'sm')}${label}</a>`;
    }
    const themeIcon = state.theme === 'dark' ? 'moon' : state.theme === 'light' ? 'sun' : 'system';
    const costs = state.board?.costs;
    paint(foot, html`<span class="live ${live[0]}" title="Live updates from the files on disk"><span class="live-dot"></span>${live[1]}</span>
      ${health}
      ${costs?.since ? html`<span class="cost-today" title="What agent runs cost today: ${costTip(costs.today)}">${usd(costs.today.usd)} today</span>` : ''}
      ${canNotify() ? html`<button class="icon-btn${notifyOn() ? ' on' : ''}" type="button" data-act="notify" title="${notifyTip()}" aria-label="${notifyTip()}" aria-pressed="${String(notifyOn())}">${icon('bell')}</button>` : ''}
      <button class="icon-btn" type="button" data-act="theme" title="Theme: ${state.theme}" aria-label="Theme: ${state.theme}">${icon(themeIcon)}</button>
      <button class="icon-btn" type="button" data-act="refresh" title="Refresh now" aria-label="Refresh">${icon('refresh')}</button>`);
  }

  // ---------------------------------------------------------------------------
  // Views
  // ---------------------------------------------------------------------------

  function render() {
    renderRail();
    renderMain();
  }

  function setTitle(t) {
    state.baseTitle = t ? `${t} · Software Factory` : 'Software Factory';
    applyTitle();
  }

  /** The tab title, led by how many items wait on you, so a background tab shows it. */
  function applyTitle(n = state.waitingCount) {
    state.waitingCount = n;
    document.title = `${n ? `(${n}) ` : ''}${state.baseTitle}`;
  }

  // ---- notifications and unread ----------------------------------------------

  /** What waits on you across the board: turns addressed to you, and pending gates you own; keyed to compare refreshes. */
  function waitingOnYou(b = state.board) {
    const out = [];
    for (const t of b?.teams || []) {
      for (const th of t.threads) {
        for (const o of th.openTurns || []) {
          if (o.member !== 'you') continue;
          out.push({ key: o.message.id, th, from: o.message.from, text: o.message.summary || TYPE_LABEL[o.message.type] || o.message.type, href: threadHash(th.team, th.id, `?m=${encodeURIComponent(o.message.id)}`) });
        }
        if (gateWait(th)?.member === 'you') out.push({ key: `gate:${th.team}/${th.id}:${th.phase}`, th, from: null, text: `The ${PHASE_LABEL[th.phase].toLowerCase()} gate waits for you`, href: threadHash(th.team, th.id) });
      }
    }
    return out;
  }

  /** The items in `now` that did not wait at the last refresh; none on the first, since the backlog is not news. */
  const newlyWaiting = (prevKeys, now) => (prevKeys ? now.filter((x) => !prevKeys.has(x.key)) : []);

  const canNotify = () => typeof Notification === 'function' && window.isSecureContext !== false;

  /**
   * After each board refresh: the tab title's count, and a desktop notification for each item that
   * newly waits on you (two, then one that counts the rest) while the board is not in front.
   */
  function notifyWaiting() {
    const now = waitingOnYou();
    const fresh = newlyWaiting(state.waitingKeys, now);
    state.waitingKeys = new Set(now.map((x) => x.key));
    applyTitle(now.length);
    if (!fresh.length || !state.notify || !canNotify() || Notification.permission !== 'granted') return;
    if (document.visibilityState === 'visible' && document.hasFocus?.()) return;
    const shown = fresh.length > 3 ? fresh.slice(0, 2) : fresh;
    for (const x of shown) desktopNotice(`${x.from ? `${displayName(x.from, x.th)} · ` : ''}${x.th.title}`, x.text, x.key, x.href);
    if (fresh.length > shown.length) desktopNotice('Software Factory', `${fresh.length - shown.length} more waiting on you`, 'more', '#/inbox');
  }

  function desktopNotice(title, body, tag, href) {
    try {
      const n = new Notification(title, { body: plain(body).slice(0, 180), tag });
      n.onclick = () => {
        window.focus();
        location.hash = href;
        n.close();
      };
    } catch {
      // the browser would not show it; the tab title still counts what waits
    }
  }

  const notifyOn = () => state.notify && canNotify() && Notification.permission === 'granted';
  const notifyTip = () => (notifyOn() ? 'Desktop notifications are on: click to turn them off'
    : canNotify() && Notification.permission === 'denied' ? 'Notifications are blocked for this page in the browser\'s site settings'
      : 'Notify me when something new waits on me');

  async function toggleNotify() {
    if (!canNotify()) return;
    if (notifyOn()) {
      state.notify = false;
    } else {
      let p = Notification.permission;
      if (p === 'default') {
        try {
          p = await Notification.requestPermission();
        } catch {
          p = 'denied';
        }
      }
      state.notify = p === 'granted';
      toast(state.notify ? 'You get a notification when something new waits on you' : 'Notifications are blocked for this page: allow them in the browser\'s site settings', !state.notify);
    }
    LS.set('notify', state.notify);
    renderRailFoot();
  }

  // ---- quick jump (Cmd-K) ------------------------------------------------------

  const JUMP_MAX = 9;

  /**
   * What the jump box offers for a query: threads (those waiting on you first, then the latest),
   * teams and the views. Every word typed must appear in the item's title, team or ref; a title
   * that starts with the query ranks first.
   */
  function jumpItems(q) {
    const words = String(q || '').trim().toLowerCase().split(/\s+/).filter(Boolean);
    const threads = allThreads().map((th) => ({
      title: th.title, sub: `${teamOf(th.team).title} · ${PHASE_LABEL[th.phase] || th.phase}`, href: threadHash(th.team, th.id),
      ic: th.kind === 'watch' ? 'watch' : th.kind === 'solo' ? 'solo' : 'project', hay: `${th.title} ${th.team}/${th.id} ${teamOf(th.team).title}`,
      waits: waitsOn(th, 'you'), updated: String(th.updated || ''),
    })).sort((a, b) => Number(b.waits) - Number(a.waits) || b.updated.localeCompare(a.updated));
    const teams = (state.board?.teams || []).map((t) => ({ title: t.title, sub: `Team · ${plural(t.threads.length, 'thread')}`, href: '#/board', team: t.id, ic: 'board', hay: `${t.title} ${t.id}` }));
    const views = [['Board', '#/board', 'board'], ['Tasks', '#/tasks', 'tasks'], ['Inbox', '#/inbox', 'inbox']].map(([title, href, ic]) => ({ title, sub: 'View', href, ic, hay: title }));
    if (!words.length) return [...threads, ...views].slice(0, JUMP_MAX);
    const query = words.join(' ');
    const rank = (x) => {
      const hay = x.hay.toLowerCase();
      if (!words.every((w) => hay.includes(w))) return -1;
      const title = x.title.toLowerCase();
      return title.startsWith(query) ? 0 : words.every((w) => title.includes(w)) ? 1 : 2;
    };
    return [...threads, ...teams, ...views].map((x) => ({ x, r: rank(x) })).filter((y) => y.r >= 0).sort((a, b) => a.r - b.r).map((y) => y.x).slice(0, JUMP_MAX);
  }

  function jumpList() {
    const j = state.jump;
    j.items = jumpItems(j.q);
    j.i = Math.min(j.i, Math.max(0, j.items.length - 1));
    if (!j.items.length) return html`<li class="jump-empty">Nothing matches.</li>`;
    return j.items.map((x, i) => html`<li role="option" aria-selected="${String(i === j.i)}"><a class="jump-item${i === j.i ? ' on' : ''}" href="${x.href}" data-act="jump-go" data-i="${String(i)}">${icon(x.ic, 'sm')}<span class="jump-title">${x.title}</span><span class="jump-sub">${x.sub}</span></a></li>`);
  }

  function renderJump() {
    let box = $('#jump');
    if (!box) {
      box = document.createElement('div');
      box.id = 'jump';
      document.body.appendChild(box);
    }
    if (!state.jump) return setHtml(box, '');
    if (!$('#jump-input')) {
      setHtml(box, html`<div class="modal-backdrop jump-backdrop" data-act="jump-close"><div class="jump" role="dialog" aria-modal="true" aria-label="Jump to">
        <input class="field jump-input" id="jump-input" placeholder="Jump to a thread, team or view" autocomplete="off" spellcheck="false" aria-controls="jump-list">
        <ul class="jump-list" id="jump-list" role="listbox"></ul>
      </div></div>`);
      $('#jump-input').focus();
    }
    setHtml($('#jump-list'), jumpList());
  }

  function openJump() {
    if (state.newThread?.open) return;
    state.jump = { q: '', i: 0, items: [] };
    renderJump();
  }

  function closeJump() {
    state.jump = null;
    renderJump();
  }

  function jumpGo(x) {
    if (x.team) {
      state.boardTeam = x.team;
      LS.set('boardTeam', x.team);
    }
    closeJump();
    if (location.hash === x.href) render();
    else location.hash = x.href;
  }

  /** Whether a thread has activity you have not seen in this browser: a last message, not yours, newer than your last look. */
  function isUnread(th) {
    const last = th.lastMessage;
    if (!last || last.from === 'you') return false;
    const seen = state.seen[`${th.team}/${th.id}`] || state.seenSince;
    return Boolean(seen) && Date.parse(last.ts) > Date.parse(seen);
  }

  /** Reading a thread marks it read up to its newest message; threads no longer on the board are forgotten. */
  function markSeen(v) {
    const ref = `${v.team}/${v.thread.id}`;
    const ts = v.messages.reduce((a, m) => (!a || Date.parse(m.ts) > Date.parse(a) ? m.ts : a), null);
    if (!ts || (state.seen[ref] && Date.parse(state.seen[ref]) >= Date.parse(ts))) return;
    const live = new Set(allThreads().map((th) => `${th.team}/${th.id}`));
    state.seen = Object.fromEntries(Object.entries({ ...state.seen, [ref]: ts }).filter(([k]) => k === ref || live.has(k)));
    LS.set('seen', state.seen);
  }

  function renderMain() {
    const main = $('#main');
    if (!state.loaded) return;
    const r = state.route;
    if (r.name === 'thread') return renderThreadView(main);
    main.dataset.view = r.name;
    const page = r.name === 'tasks' ? viewTasks() : r.name === 'inbox' ? viewInbox() : r.name === 'health' ? viewHealth() : viewBoard();
    const prev = main.querySelector('.page');
    const scroll = prev && prev.dataset.view === r.name ? prev.scrollTop : 0;
    const kscroll = prev && prev.dataset.view === r.name ? prev.querySelector('.kanban')?.scrollLeft || 0 : 0;
    if (!setHtml(main, page)) return;
    const next = main.querySelector('.page');
    if (next) {
      next.dataset.view = r.name;
      next.scrollTop = scroll;
      const k = next.querySelector('.kanban');
      if (k) {
        k.scrollLeft = kscroll;
        edgeFade(k);
      }
    }
  }

  /** Fade the kanban's clipped edges so a board wider than the window reads as scrollable. */
  function edgeFade(k) {
    const more = k.scrollWidth > k.clientWidth + 1;
    k.classList.toggle('scrolls', more);
    k.classList.toggle('at-start', k.scrollLeft <= 1);
    k.classList.toggle('at-end', k.scrollLeft + k.clientWidth >= k.scrollWidth - 1);
  }

  function errorPanel(e, what = 'the board') {
    return html`<div class="page"><div class="panel errbox" role="alert"><h2>Could not load ${what}</h2><p>${e?.message || String(e)}</p>
      <p class="faint">If the root has no factory yet, run <code>node factory/bin/factory.mjs init --root &lt;dir&gt;</code>.</p>
      <div><button class="btn btn-outline sm" type="button" data-act="refresh">${icon('refresh', 'sm')}Try again</button></div></div></div>`;
  }

  function teamTabs() {
    const teams = state.board?.teams || [];
    if (teams.length < 2) return '';
    return html`<div class="seg" role="group" aria-label="Team">
      <button type="button" class="${state.boardTeam ? '' : 'on'}" data-act="board-team" data-team="">All teams</button>
      ${teams.map((t) => html`<button type="button" class="${state.boardTeam === t.id ? 'on' : ''}" data-act="board-team" data-team="${t.id}">${t.title}</button>`)}
    </div>`;
  }

  // ---- board --------------------------------------------------------------

  function viewBoard() {
    setTitle('Board');
    if (state.boardError && !state.board) return errorPanel(state.boardError);
    const b = state.board;
    if (!b.teams.length) {
      return html`<div class="page"><header class="page-head"><div><h1>Board</h1><p class="sub">Every team's threads, by phase.</p></div></header>
        <div class="panel empty">${icon('board')}<h3>No teams yet</h3><p>Start one from the CLI:</p><p><code>node factory/bin/factory.mjs team new checkout --title "Checkout" --as you</code></p></div></div>`;
    }
    const focus = focusMember();
    let threads = allThreads();
    if (state.boardTeam) threads = threads.filter((th) => th.team === state.boardTeam);
    if (state.filter) threads = threads.filter((th) => involves(th, state.filter));
    const projects = threads.filter((th) => th.kind === 'project');
    const watches = threads.filter((th) => th.kind === 'watch');
    const solos = threads.filter((th) => th.kind === 'solo');
    const rank = (th) => (waitsOn(th, focus) ? 0 : 1);
    const byPhase = PHASES.map((p) => [p, projects.filter((th) => th.phase === p).sort((a, c) => rank(a) - rank(c) || String(c.updated).localeCompare(String(a.updated)))]);
    const cols = byPhase.map(([, list]) => (list.length ? 'minmax(184px, 1fr)' : '28px')).join(' ');
    const waiting = threads.filter((th) => waitsOn(th, focus)).length;
    const active = projects.filter((th) => th.phase !== 'done').length;
    return html`<div class="page">
      <header class="page-head">
        <div><h1>Board</h1><p class="sub">${plural(active, 'active project')} · ${plural(watches.length, 'watch', 'watches')}${solos.length ? ` · ${plural(solos.length, 'single-agent thread')}` : ''}${state.filter ? html` · involving ${displayName(state.filter)}` : ''}${waiting ? html` · <strong>${waiting} waiting on ${focus === 'you' ? 'you' : displayName(focus)}</strong>` : ''}</p></div>
        <div class="head-tools">${teamTabs()}</div>
      </header>
      ${presenceStrip(members().map((m) => m.id), state.board?.presence || {}, true, heldItems(allThreads(), (th) => th.openTurns || []).filter((h) => h.member !== 'you'))}
      ${projects.length
        ? html`<section class="kanban" style="grid-template-columns:${cols}" aria-label="Project threads by phase">${byPhase.map(([p, list]) => boardColumn(p, list))}</section>`
        : html`<div class="empty-inline">No project threads${state.filter ? ` involving ${displayName(state.filter)}` : ''}. Start one with <span class="mono">factory thread new &lt;team&gt;/&lt;thread&gt; --title &lt;t&gt; --as fable</span>.</div>`}
      <div class="section-head"><h2>Watching</h2>${count(watches.length)}<span class="hint">Production checks: cadence, last run, latest numbers</span></div>
      ${watches.length
        ? html`<div class="watch-grid">${watches.map(watchCard)}</div>`
        : html`<div class="empty-inline">No watch threads. A watch measures a journey on a cadence: <span class="mono">factory thread new &lt;team&gt;/&lt;id&gt; --kind watch --threshold "error_rate&lt;=0.02" --as fable</span>.</div>`}
      ${solos.length ? html`<div class="section-head"><h2>Single agent</h2>${count(solos.length)}<span class="hint">One agent each; it works when you ask it in the thread</span></div>
        <div class="watch-grid">${solos.map(soloCard)}</div>` : ''}
    </div>`;
  }

  function boardColumn(phase, list) {
    if (!list.length) {
      return html`<div class="col col-empty" title="${PHASE_LABEL[phase]}: no threads"><span class="count">0</span><span class="col-empty-label">${PHASE_LABEL[phase]}</span></div>`;
    }
    const owner = DEFAULT_GATE_OWNER[phase];
    const ownerMark = phase === 'build' ? html`<span class="auto" title="Approves itself when every task is done">auto</span>` : owner ? html`<span style="margin-left:auto" title="Gate owner">${avatar(list[0].gates?.[phase]?.by || owner, 18, list[0])}</span>` : '';
    return html`<div class="col">
      <header class="col-head"><span class="col-title">${PHASE_LABEL[phase]}</span>${count(list.length)}${ownerMark}</header>
      <div class="col-body">${list.map(threadCard)}</div>
    </div>`;
  }

  function waitingFoot(th) {
    const focus = focusMember();
    const turns = th.openTurns;
    const gw = gateWait(th, turns);
    if (!turns.length && !gw) {
      const so = th.gates?.signoff;
      if (th.phase === 'done' && so?.status === 'approved') {
        return html`<div class="tcard-foot"><span class="last">Signed off by</span>${avatar(so.by, 18, th)}<span class="age" title="${so.at ? absTime(so.at) : ''}">${so.at ? rel(so.at) : ''}</span></div>`;
      }
      const lm = th.lastMessage;
      return html`<div class="tcard-foot"><span class="last">${lm ? html`${displayName(lm.from, th)} · ${TYPE_LABEL[lm.type]}` : 'No messages yet'}</span><span class="age">${lm ? rel(lm.ts) : ''}</span></div>`;
    }
    const who = waitingMembers(th, turns);
    const label = who.includes(focus) && focus === 'you' ? 'Waiting on you' : 'Waiting on';
    const age = turns.length
      ? html`<span class="age" title="Oldest open turn">${ageText(Math.max(...turns.map((o) => o.age_seconds)))}</span>`
      : html`<span class="age" title="${displayName(gw.member, th)} owns the pending ${PHASE_LABEL[gw.gate].toLowerCase()} gate">gate</span>`;
    return html`<div class="tcard-foot"><span class="wait-label">${label}</span>${avatarStack(who, 20, 4, th)}${age}</div>`;
  }

  function threadCard(th) {
    const team = teamOf(th.team);
    const focus = focusMember();
    const mine = waitsOn(th, focus);
    const t = th.tasks;
    const openIssues = th.issues.open + th.issues.accepted;
    const pct = t.total ? Math.round((t.done / t.total) * 100) : 0;
    const finish = threadFinish(th, Date.parse(th.phase_since || th.updated));
    return html`<a class="tcard${mine ? ' mine' : ''}${th.phase === 'done' ? ' done' : ''}" href="${threadHash(th.team, th.id)}">
      <div class="tcard-top"><span class="chip team">${team.title}</span>${gateStatus(th)}</div>
      <div class="tcard-title" title="${th.title}">${th.title}</div>
      <div class="tcard-meta">
        ${avatar(th.lead, 20, th)}
        ${t.total
          ? html`<span class="prog${t.done === t.total ? ' full' : ''}" title="${t.done} of ${t.total} tasks done"><span class="prog-bar"><i style="width:${String(pct)}%"></i></span>${t.done}/${t.total}</span>`
          : html`<span class="faint">no tasks</span>`}
        ${openIssues ? html`<span class="iss${th.issues.open ? ' hot' : ''}" title="${th.issues.open} open, ${th.issues.accepted} accepted">${icon('flag', 'xs')}${openIssues}</span>` : ''}
        ${finish ? html`<span class="eta finish" title="${finishTitle(finish)}">ETA ${finishLabel(finish)}${finish.missing.length ? '+' : ''}</span>` : ''}
      </div>
      ${waitingFoot(th)}
    </a>`;
  }

  function metricRows(th) {
    const thr = th.thresholds || {};
    const last = th.lastMetrics?.metrics || {};
    const names = uniq([...Object.keys(thr), ...Object.keys(last)]);
    return names.map((n) => {
      const v = last[n];
      const has = typeof v === 'number';
      const bad = has && breaches(v, thr[n]);
      const st = !has ? 'missing' : bad ? 'breach' : thr[n] ? 'ok' : '';
      return html`<tr class="${st}">
        <td class="mname" title="${n}">${n}</td>
        <td class="mval">${has ? fmtMetric(n, v) : '—'}</td>
        <td class="mth">${fmtThreshold(n, thr[n]) || '—'}</td>
        <td class="mst ${st}">${st === 'ok' ? icon('check', 'xs') : st === 'breach' ? icon('alert', 'xs') : ''}</td>
      </tr>`;
    });
  }

  function watchCard(th) {
    const team = teamOf(th.team);
    const lm = th.lastMetrics;
    const breach = Boolean(lm && lm.breaches.length);
    const period = cadenceMs(th.cadence);
    const due = th.phase === 'paused' ? 'paused' : !th.last_run ? 'never run' : period ? untilText(Date.parse(th.last_run) + period - Date.now()) : '';
    const mine = th.openTurns.some((o) => o.member === focusMember());
    return html`<a class="wcard${breach ? ' breach' : ''}${th.phase === 'paused' ? ' paused' : ''}${mine ? ' mine' : ''}" href="${threadHash(th.team, th.id)}">
      <div class="wcard-top"><span class="chip team">${team.title}</span><span class="wtitle" title="${th.title}">${th.title}</span>${phasePill(th)}</div>
      <div class="wmeta">${th.cadence} · ${th.last_run ? `last run ${rel(th.last_run)}` : 'no runs yet'}${due && th.last_run ? ` · ${due}` : ''}</div>
      ${lm || Object.keys(th.thresholds || {}).length ? html`<table class="mtable"><tbody>${metricRows(th)}</tbody></table>` : ''}
      <div class="tcard-foot">
        ${th.issues.open + th.issues.accepted ? html`<span class="iss${th.issues.open ? ' hot' : ''}">${icon('flag', 'xs')}${plural(th.issues.open + th.issues.accepted, 'open issue')}</span>` : html`<span class="last">${th.issues.verified ? `${th.issues.verified} verified` : 'No issues'}</span>`}
        ${th.openTurns.length ? html`<span class="wait-label" style="margin-left:auto">Waiting on</span>${avatarStack(th.openTurns.map((o) => o.member), 20, 4, th)}` : html`<span class="age">${avatar(th.owner || th.lead, 18, th)}</span>`}
      </div>
    </a>`;
  }

  /** A member's latest autopilot run on one thread ({ended_at, outcome, cost_usd}), or null. */
  function lastRunOn(id, ref, ap) {
    const raw = apRaw(id, ap);
    if (raw?.last && raw.last.ref === ref) return raw.last;
    return raw?.by_thread?.[ref] || null;
  }

  /** A single-agent thread on the board: its agent, whether it is working, and its last run here. */
  function soloCard(th) {
    const team = teamOf(th.team);
    const ref = `${th.team}/${th.id}`;
    const mine = th.openTurns.some((o) => o.member === focusMember());
    const raw = apRaw(th.owner);
    const running = Boolean(state.board?.autopilot?.alive && runOn(raw, ref));
    const asks = th.openTurns.filter((o) => o.member === th.owner && !NOTIFY_TYPES.has(o.message.type));
    const yours = th.openTurns.filter((o) => o.member === 'you').map((o) => o.message.type);
    const held = asks.length ? needsStart(th.owner, asks.map((o) => ({ member: o.member, msgId: o.message.id, type: o.message.type })), state.board?.presence) : null;
    const status = running ? 'working on it'
      : asks.length ? (held ? `${plural(asks.length, 'request')} waiting: ${held.text}` : `${plural(asks.length, 'request')} queued`)
        : yours.includes('question') ? 'asks you something'
          : yours.includes('answer') ? 'answered you'
            : yours.length ? 'something waits on you' : 'ready';
    const last = lastRunOn(th.owner, ref);
    return html`<a class="wcard solo${mine ? ' mine' : ''}" href="${threadHash(th.team, th.id)}">
      <div class="wcard-top"><span class="chip team">${team.title}</span><span class="wtitle" title="${th.title}">${th.title}</span>${phasePill(th)}</div>
      <div class="wmeta">${displayName(th.owner, th)} · ${status}</div>
      <div class="tcard-foot">
        <span class="last">${last ? `last run ${rel(last.ended_at)}${last.cost_usd != null ? ` · $${last.cost_usd}` : ''}` : 'not run yet'}</span>
        ${th.openTurns.length ? html`<span class="wait-label" style="margin-left:auto">Waiting on</span>${avatarStack(th.openTurns.map((o) => o.member), 20, 4, th)}` : html`<span class="age" style="margin-left:auto">${avatar(th.owner, 18, th)}</span>`}
      </div>
    </a>`;
  }

  // ---- tasks ----------------------------------------------------------------

  function viewTasks() {
    setTitle('Tasks');
    if (state.boardError && !state.board) return errorPanel(state.boardError);
    const b = state.board;
    let tasks = b.teams.flatMap((t) => t.tasks.map((x) => ({ ...x, team: t.id })));
    if (state.boardTeam) tasks = tasks.filter((x) => x.team === state.boardTeam);
    if (state.filter) tasks = tasks.filter((x) => x.owner === state.filter);
    const open = tasks.filter((x) => x.status !== 'done').length;
    return html`<div class="page">
      <header class="page-head">
        <div><h1>Tasks</h1><p class="sub">${plural(open, 'open task')} · ${tasks.length - open} done${state.filter ? html` · owned by ${displayName(state.filter)}` : ''}</p></div>
        <div class="head-tools">${teamTabs()}</div>
      </header>
      ${b.teams.length ? html`<section class="kanban tasks" aria-label="Tasks by status">${TASK_COLS.map(([s, label]) => {
        const list = tasks.filter((x) => x.status === s).sort((a, c) => String(c.updated).localeCompare(String(a.updated)));
        return html`<div class="col">
          <header class="col-head"><span class="tdot ${s}"></span><span class="col-title">${label}</span>${count(list.length)}</header>
          <div class="col-body">${list.length ? list.map(taskCard) : html`<div class="col-empty-box">Nothing ${s === 'todo' ? 'to do' : s === 'done' ? 'done yet' : `in ${label.toLowerCase()}`}</div>`}</div>
        </div>`;
      })}</section>` : html`<div class="panel empty">${icon('tasks')}<h3>No tasks yet</h3><p>Tasks appear here when a lead plans a thread.</p></div>`}
    </div>`;
  }

  function taskCard(x) {
    const team = teamOf(x.team);
    const th = team.threads.find((t) => t.id === x.thread);
    const mine = state.filter && x.owner === state.filter;
    return html`<a class="kcard${mine ? ' mine' : ''}" href="${threadHash(x.team, x.thread, `?ref=${encodeURIComponent(x.id)}`)}">
      <div class="kcard-top"><span class="id">${x.id}</span>${x.issue ? issueChip(x.team, x.issue) : ''}</div>
      <div class="kcard-title" title="${plain(x.title)}">${plain(x.title)}</div>
      <div class="kcard-thread" title="${team.title} / ${th ? th.title : x.thread}"><span class="chip team">${team.title}</span><span class="kcard-th">${th ? th.title : x.thread}</span></div>
      <div class="kcard-foot">
        ${x.owner ? html`${avatar(x.owner, 18, th)}<span class="who">${displayName(x.owner, th)}</span>` : html`<span class="who faint">Unassigned</span>`}
        ${taskEta(x, th)}
        <span class="age" title="${absTime(x.updated)}">${rel(x.updated)}</span>
      </div>
    </a>`;
  }

  // ---- inbox ----------------------------------------------------------------

  function viewInbox() {
    const member = inboxMember();
    const who = member === 'you' ? 'you' : displayName(member);
    setTitle('Inbox');
    const data = state.inbox && state.inbox.member === member ? state.inbox : null;
    const options = members().filter((m) => m.id !== 'factory');
    const head = html`<header class="page-head">
      <div><h1>Inbox</h1><p class="sub">Open turns waiting on ${who}, oldest first, then review gates ${who === 'you' ? 'you own' : `${who} owns`} that are waiting.</p></div>
      <div class="head-tools"><label class="c-label" for="inbox-member">Member</label><select class="select sm" id="inbox-member" data-act="inbox-member">${options.map((m) => html`<option value="${m.id}"${m.id === member ? raw(' selected') : ''}>${displayName(m.id)}</option>`)}</select></div>
    </header>`;
    if (state.inboxError && !data) return html`<div class="page">${head}${errorPanel(state.inboxError, 'the inbox')}</div>`;
    if (!data) return html`<div class="page">${head}<div class="panel empty">Loading…</div></div>`;
    const gates = gateWaitsFor(member);
    if (!data.turns.length && !gates.length) {
      return html`<div class="page">${head}<div class="panel empty">${icon('check')}<h3>Nothing is waiting on ${who}</h3><p>New turns appear here when someone addresses ${who} with <span class="mono">to</span>, or a review gate ${who === 'you' ? 'you own' : `${who} owns`} opens.</p></div></div>`;
    }
    const notify = data.turns.filter((o) => NOTIFY_TYPES.has(o.message.type)).length;
    const turnRows = data.turns.map((o) => {
      const team = teamOf(o.team);
      const th = team.threads.find((x) => x.id === o.thread);
      const isNotify = NOTIFY_TYPES.has(o.message.type);
      return html`<div class="irow-item">
        <a class="irow" href="${threadHash(o.team, o.thread, `?m=${encodeURIComponent(o.message.id)}`)}">
          ${avatar(o.message.from, 32, th)}
          <div style="min-width:0">
            <div class="irow-top"><strong>${displayName(o.message.from, th)}</strong>${typeChip(o.message.type)}<span>in</span><span class="chip team">${team.title}</span><span>${th ? th.title : o.thread}</span></div>
            <div class="irow-sum">${o.message.summary || TYPE_LABEL[o.message.type]}</div>
          </div>
          <span class="irow-age" title="${absTime(o.message.ts)}">${ageText(o.age_seconds)}</span>
        </a>
        ${member === 'you' ? handledButton(o.message.id, `${o.team}/${o.thread}`) : ''}
      </div>`;
    });
    // A pending review gate whose entry notification is already closed (its owner wrote in the thread since).
    const gateRows = gates.map((th) => {
      const team = teamOf(th.team);
      const g = PHASE_LABEL[th.phase];
      return html`<div class="irow-item">
        <a class="irow" href="${threadHash(th.team, th.id)}">
          ${avatar(member, 32, th)}
          <div style="min-width:0">
            <div class="irow-top"><strong>${g} gate</strong>${pill('gate', 'pending')}<span>in</span><span class="chip team">${team.title}</span><span>${th.title}</span></div>
            <div class="irow-sum">${member === 'you' ? 'Approve it or request changes' : `${displayName(member, th)} reviews it`}; no open turn asks for it any more.</div>
          </div>
          <span class="irow-age" title="Gate pending">gate</span>
        </a>
      </div>`;
    });
    return html`<div class="page">${head}<div class="panel ilist">${turnRows}${gateRows}</div>${notify ? html`<p class="inbox-note">${icon('clock', 'xs')}${plural(notify, 'event, alert or report turn', 'event, alert and report turns')} close${notify === 1 ? 's' : ''} on ${member === 'you' ? 'your next post, review or decision' : `${displayName(member)}'s next write`} in ${notify === 1 ? 'its' : 'their'} thread${member === 'you' ? '; Mark handled closes one with a short note' : ''}.</p>` : ''}</div>`;
  }

  // ---- health ---------------------------------------------------------------

  function viewHealth() {
    setTitle('Health');
    const h = state.health;
    const head = html`<header class="page-head"><div><h1>Health</h1><p class="sub">What <span class="mono">factory validate</span> finds in the files.</p></div>
      <div class="head-tools"><button class="btn btn-outline sm" type="button" data-act="revalidate">${icon('refresh', 'sm')}Run again</button></div></header>`;
    if (!h) return html`<div class="page">${head}<div class="panel empty">Checking…</div></div>`;
    const list = (items, kind) => html`<ul class="hlist">${items.map((x) => html`<li><span class="sev ${kind === 'error' ? 'high' : 'medium'}">${kind}</span><div><div>${x.message}</div><div class="file">${x.file}</div></div></li>`)}</ul>`;
    return html`<div class="page">${head}
      ${!h.errors.length && !h.warnings.length ? html`<div class="panel empty">${icon('shield')}<h3>Every file checks out</h3><p>Roster, teams, threads, messages, tasks, issues, decisions and metrics all match the protocol.</p></div>` : ''}
      ${h.errors.length ? html`<div class="section-head"><h2>Errors</h2>${count(h.errors.length, 'hot')}</div><div class="panel">${list(h.errors, 'error')}</div>` : ''}
      ${h.warnings.length ? html`<div class="section-head"><h2>Warnings</h2>${count(h.warnings.length)}</div><div class="panel">${list(h.warnings, 'warning')}</div>` : ''}
    </div>`;
  }

  // ---------------------------------------------------------------------------
  // New thread (#/new for a new team, #/new/<team> for a thread in one)
  // ---------------------------------------------------------------------------

  const NF_MODELS = [
    { id: 'claude-fable-5-1', name: 'Fable 5.1' },
    { id: 'claude-opus-5-5', name: 'Opus 5.5' },
    { id: 'claude-sonnet-5-5', name: 'Sonnet 5.5' },
    { id: 'claude-haiku-5-5', name: 'Haiku 5.5' },
  ];
  const nfModels = () => state.ntOptions?.models?.length ? state.ntOptions.models : NF_MODELS;
  // OpenAI's models (Codex), for the lead and every role openai can play.
  const NF_OPENAI = [
    { id: 'gpt-6.1-sol', name: 'GPT-6.1 Sol' },
    { id: 'gpt-6.1-terra', name: 'GPT-6.1 Terra' },
    { id: 'gpt-6-astra', name: 'GPT-6 Astra' },
    { id: 'gpt-6-sol', name: 'GPT-6 Sol' },
    { id: 'gpt-6-luna', name: 'GPT-6 Luna' },
  ];
  function nfOpenAI() {
    return state.ntOptions?.openai_models?.length ? state.ntOptions.openai_models : NF_OPENAI;
  }
  const nfRole = (agent, extra = {}) => ({ agent, on: true, ...extra });
  /** The thread the form would start, as far as names go: the lead on the model picked. */
  const nfThread = (f) => ({ kind: 'project', lead: f.lead.agent, roles: { lead: { model: f.lead.model } } });
  const rosterModel = (id, fallback) => {
    const m = members().find((x) => x.id === id)?.model;
    return nfModels().some((x) => x.id === m) ? m : fallback;
  };

  /** The New thread modal's form: kept while it is closed, so reopening it keeps what you typed. */
  function newForm(team) {
    const lead = members().find((m) => m.role === 'lead')?.id || 'fable';
    const builder = members().find((m) => m.role === 'builder')?.id;
    if (!state.newThread) {
      state.newThread = {
        open: false, team: '', newTeam: '', title: '', prompt: '', busy: false, error: '', issue: '', issueBusy: false,
        lead: nfRole(lead, { model: rosterModel(lead, 'claude-fable-5-1') }),
        subagents: nfRole(null, { model: rosterModel(builder, 'claude-opus-5-5') }),
        pair: nfRole('gpt-6.1-sol'),
        code_review: nfRole('gpt-6.1-sol'),
        // A Claude model runs the roster's security member on it; openai or grok can take the gate instead.
        security: nfRole(rosterModel('security', 'claude-opus-5-5')),
        final_check: nfRole('grok'),
      };
    }
    if (team !== undefined) state.newThread.team = team || '';
    return state.newThread;
  }

  function openNewThread(team) {
    const f = newForm(team);
    f.open = true;
    f.error = '';
    if (!state.ntOptions) {
      api('/api/thread/options').then((o) => {
        state.ntOptions = o;
        renderModal(true);
      }).catch(() => {});
    }
    renderModal(true);
    document.body.classList.add('modal-open');
    setTimeout(() => $('#nf-title')?.focus({ preventScroll: true }), 0);
  }

  function closeNewThread() {
    if (!state.newThread?.open) return;
    state.newThread.open = false;
    document.body.classList.remove('modal-open');
    renderModal(true);
  }

  /** Paint the modal. `force` repaints even while a field has focus (after a select changed the layout). */
  function renderModal(force = false) {
    let box = $('#modal');
    if (!box) {
      box = document.createElement('div');
      box.id = 'modal';
      document.body.appendChild(box);
    }
    const f = state.newThread;
    if (!f?.open) return setHtml(box, '');
    const content = viewNew();
    if (force) {
      const active = document.activeElement;
      const key = active && box.contains(active) ? (active.id ? `#${CSS.escape(active.id)}` : focusKey(active)) : null;
      if (setHtml(box, content) && key) box.querySelector(key)?.focus({ preventScroll: true });
      return;
    }
    paint(box, content, { fields: 'keep' });
  }

  /** Set a form value from its data-new path, e.g. "subagents.model". */
  function setNew(pathText, value) {
    const keys = pathText.split('.');
    let o = state.newThread;
    for (const k of keys.slice(0, -1)) o = o?.[k];
    if (o) o[keys[keys.length - 1]] = value;
  }

  function viewNew() {
    const f = state.newThread;
    const teams = state.board?.teams || [];
    // `options`: a flat list, or groups ({label, items}) drawn as optgroups.
    const opt = (o, value) => html`<option value="${o.id}"${o.id === value ? raw(' selected') : ''}>${o.name}</option>`;
    const sel = (id, pathText, options, value, off) => html`<select class="select nf-sel" id="${id}" data-new="${pathText}"${off ? raw(' disabled') : ''}>${options.map((o) => (o.items ? html`<optgroup label="${o.label}">${o.items.map((x) => opt(x, value))}</optgroup>` : opt(o, value)))}</select>`;
    const models = nfModels();
    const openaiModels = nfOpenAI();
    const claudeGroup = { label: 'Claude', items: models };
    const openaiGroup = { label: 'OpenAI', items: openaiModels };
    const grokGroup = { label: 'Grok', items: [{ id: 'grok', name: 'Grok' }] };
    // An OpenAI lead runs on Codex: it builds by itself, and a Claude pair (a subagent of the lead) is not open to it.
    const openaiLead = isOpenAIModel(f.lead.model);
    if (openaiLead && models.some((x) => x.id === f.pair.agent)) f.pair.agent = openaiModels[0].id;
    // One role: a checkbox that adds it (a fixed role has none), its name, and who plays it.
    // `fixed`: always on (the lead). `locked`: off and not open to change (subagents under an OpenAI lead).
    const row = (key, label, sub, played, r, fixed = false, locked = false) => html`
      <div class="nf-role${r.on ? '' : ' off'}">
        <label class="nf-pick">
          <span class="nf-check">${fixed ? html`<input type="checkbox" checked disabled aria-label="${label} (always on)">` : locked ? html`<input type="checkbox" disabled aria-label="${label} (not available)">` : html`<input type="checkbox" id="nf-${key}-on" data-new="${key}.on"${r.on ? raw(' checked') : ''}>`}</span>
          <span class="nf-role-name"><strong>${label}</strong><small>${sub}</small></span>
        </label>
        <span class="nf-played">${played}</span>
      </div>`;
    // The lead runs in Claude Code on a Claude model, or in Codex on an OpenAI model. Subagents are Claude
    // Code builders. OpenAI (on the model picked) and Grok join the other roles as agents in the thread.
    const subOn = f.subagents.on && !openaiLead;
    const leadName = displayName(f.lead.agent, nfThread(f));
    // Unticking every other role leaves the lead to do it all, with you reviewing each gate.
    const roles = [
      row('lead', 'Lead', subOn ? `${leadName}: brief, design, plans and coordinates the subagents` : `${leadName}: brief, design and the build itself`, sel('nf-lead-model', 'lead.model', [claudeGroup, openaiGroup], f.lead.model), f.lead, true),
      row('subagents', 'Subagents', openaiLead ? 'Off: an OpenAI lead writes the code itself' : subOn ? 'Write the code; the lead decides how many to start' : 'Off: the lead writes the code itself',
        sel('nf-sub-model', 'subagents.model', models, f.subagents.model, !subOn), { ...f.subagents, on: subOn }, false, openaiLead),
      row('pair', 'Pair engineer', f.pair.on ? 'Brainstorms the approach with the lead' : 'Off: no brainstorm',
        sel('nf-pair', 'pair.agent', openaiLead ? [openaiGroup, grokGroup] : [openaiGroup, grokGroup, claudeGroup], f.pair.agent, !f.pair.on), f.pair),
      row('code_review', 'Code review', f.code_review.on ? 'Reviews the design and the code' : 'Off: you review the design and the code',
        sel('nf-code-review', 'code_review.agent', [openaiGroup, grokGroup], f.code_review.agent, !f.code_review.on), f.code_review),
      row('security', 'Security', f.security.on ? 'Checks the code for security holes after code review' : 'Off: no security review',
        sel('nf-security', 'security.agent', [claudeGroup, openaiGroup, grokGroup], f.security.agent, !f.security.on), f.security),
      row('final_check', 'Final check', f.final_check.on ? 'Tests the PR before your sign-off' : 'Off: you test the PR yourself',
        sel('nf-final-check', 'final_check.agent', [grokGroup, openaiGroup], f.final_check.agent, !f.final_check.on), f.final_check),
    ];
    return html`<div class="modal-backdrop" data-act="nf-backdrop">
      <div class="modal" role="dialog" aria-modal="true" aria-labelledby="nf-heading">
        <header class="modal-head">
          <h2 id="nf-heading">New thread</h2>
          <button type="button" class="icon-btn" data-act="nf-close" title="Close (Esc)" aria-label="Close">${icon('x')}</button>
        </header>
        <div class="modal-body new-form">
          <label class="nf-label" for="nf-team">Team</label>
          <div class="nf-row">
            <select class="select" id="nf-team" data-new="team">${teams.map((t) => html`<option value="${t.id}"${f.team === t.id ? raw(' selected') : ''}>${t.title}</option>`)}<option value=""${f.team ? '' : raw(' selected')}>New team…</option></select>
            ${f.team ? '' : html`<input class="field" id="nf-newteam" data-new="newTeam" placeholder="New team name, e.g. Checkout" value="${f.newTeam}">`}
          </div>
          <label class="nf-label" for="nf-issue">From a GitHub issue (optional)</label>
          <div class="nf-row">
            <input class="field" id="nf-issue" data-new="issue" placeholder="Issue number or link" value="${f.issue}" autocomplete="off" spellcheck="false">
            <button class="btn btn-outline" type="button" data-act="nf-issue"${f.issueBusy ? raw(' disabled') : ''}>${f.issueBusy ? 'Loading…' : 'Use issue'}</button>
          </div>
          <label class="nf-label" for="nf-title">Title</label>
          <input class="field" id="nf-title" data-new="title" placeholder="Short name, e.g. Cut chat latency" value="${f.title}">
          <label class="nf-label" for="nf-prompt">What to do (everyone you pick works from this)</label>
          <textarea class="field nf-prompt" id="nf-prompt" data-new="prompt" rows="5" placeholder="Describe the work. The lead gets this as the kickoff.">${f.prompt}</textarea>
          <label class="nf-label">Who works on it</label>
          <div class="nf-roles">
            <div class="nf-role nf-role-head"><span class="nf-pick"><span></span><span>Role</span></span><span>Model</span></div>
            ${roles}
          </div>
          ${f.error ? html`<div class="nf-error">${f.error}</div>` : ''}
        </div>
        <footer class="modal-foot">
          <button class="btn" type="button" data-act="nf-close">Cancel</button>
          <button class="btn btn-primary" type="button" data-act="nf-start"${f.busy ? raw(' disabled') : ''}>${f.busy ? 'Starting…' : 'Start'}</button>
        </footer>
      </div>
    </div>`;
  }

  /** Fill the form from a GitHub issue (GET /api/issue): its title when none is typed, and its link and text as the request. */
  async function loadIssue() {
    const f = state.newThread;
    if (!f || f.issueBusy) return;
    const ref = String(f.issue || '').trim();
    if (!ref) {
      f.error = 'Type the issue number or link first.';
      return renderModal(true);
    }
    f.issueBusy = true;
    f.error = '';
    renderModal(true);
    try {
      const r = await api(`/api/issue?ref=${encodeURIComponent(ref)}`);
      if (!String(f.title).trim()) f.title = r.title;
      const prompt = String(f.prompt).trim();
      if (!prompt.includes(r.url)) f.prompt = prompt ? `${prompt}\n\n${r.request}` : r.request;
      toast(`Loaded issue #${r.number}`);
    } catch (e) {
      f.error = e.message;
    } finally {
      f.issueBusy = false;
      renderModal(true);
    }
  }

  /** The roles to send: the lead's model, the subagents' Claude model, and who plays each other role (an OpenAI model id reads as openai on it). */
  function newRoles(f) {
    return {
      lead: { model: f.lead.model },
      subagents: f.subagents.on && !isOpenAIModel(f.lead.model) ? { model: f.subagents.model } : null,
      pair: f.pair.on ? { agent: f.pair.agent } : null,
      code_review: { agent: f.code_review.on ? f.code_review.agent : 'you' },
      security: f.security.on ? { agent: f.security.agent } : null,
      final_check: { agent: f.final_check.on ? f.final_check.agent : 'you' },
    };
  }

  async function startNewThread() {
    const f = state.newThread;
    if (!f || f.busy) return;
    f.busy = true;
    f.error = '';
    renderModal(true);
    try {
      const r = await api('/api/thread/new', {
        team: f.team || null, new_team: f.team ? null : f.newTeam, title: f.title, prompt: f.prompt,
        kind: 'project', roles: newRoles(f),
      });
      state.newThread = null;
      document.body.classList.remove('modal-open');
      renderModal(true);
      toast(`Started. ${displayName(f.lead.agent, nfThread(f))} picks it up in about 20 seconds.`);
      await refresh();
      const [team, id] = r.ref.split('/');
      location.hash = threadHash(team, id);
    } catch (err) {
      f.error = err.message || 'That did not work';
      f.busy = false;
      renderModal(true);
    }
  }

  // ---------------------------------------------------------------------------
  // Thread view
  // ---------------------------------------------------------------------------

  function renderThreadView(main) {
    const r = state.route;
    let root = main.querySelector('.thread-view');
    if (!root || root.dataset.ref !== r.ref) {
      main.dataset.view = 'thread';
      setHtml(main, html`<div class="thread-view" data-ref="${r.ref}">
        <section class="chat" aria-label="Thread">
          <div id="t-head"></div>
          <div id="t-offer"></div>
          <div id="t-banner"></div>
          <div id="t-presence"></div>
          <div class="t-body" id="t-body"><div class="empty">Loading…</div></div>
          <div class="composer" id="composer" hidden></div>
        </section>
        <aside class="side" id="side" aria-label="Thread details"></aside>
        <div class="scrim" data-act="close-side"></div>
      </div>`);
      root = main.querySelector('.thread-view');
      state.firstPaint = true;
    }
    $('#side').classList.toggle('open', state.sideOpen);
    const v = state.thread && state.threadRef === r.ref ? state.thread : null;
    if (!v) {
      if (state.threadError) {
        clearHtml($('#t-head'));
        clearHtml($('#t-offer'));
        clearHtml($('#t-banner'));
        clearHtml($('#t-presence'));
        setHtml($('#t-body'), html`<div class="empty">${icon('alert')}<h3>Could not open ${r.ref}</h3><p>${state.threadError.message}</p><p><a class="btn btn-outline sm" href="#/board">Back to the board</a></p></div>`);
        $('#composer').hidden = true;
        clearHtml($('#side'));
        setTitle(r.ref);
      }
      return;
    }
    setTitle(v.thread.title);
    paint($('#t-head'), threadHead(v));
    paint($('#t-offer'), offerCard(v));
    paint($('#t-banner'), banner(v));
    paint($('#t-presence'), threadPresence(v));
    renderComposer(v);
    renderThreadBody(v);
    paint($('#side'), sidePanel(v), { fields: 'keep' });
  }

  function threadHead(v) {
    const th = v.thread;
    const nMsgs = v.messages.filter((m) => m.type !== 'event' && shownInChat(m)).length;
    const tab = state.route.tab;
    const base = threadHash(v.team, th.id);
    return html`<header class="t-head">
      <div class="t-title-row">
        <span class="kind-ic" title="${th.kind === 'watch' ? 'Watch thread' : th.kind === 'solo' ? 'Single-agent thread' : 'Project thread'}">${icon(th.kind === 'watch' ? 'watch' : th.kind === 'solo' ? 'solo' : 'project')}</span>
        <h1 class="t-title" title="${th.title}">${th.title}</h1>
        ${phasePill(th)}
      </div>
      <div class="t-meta">
        <span class="chip team">${v.teamTitle || v.team}</span>
        <span class="mono">${v.team}/${th.id}</span>
        ${th.kind === 'solo' ? '' : html`<span class="sep">·</span>
        <span class="mono branch" title="Branch (build in its worktree: factory worktree ${v.team}/${th.id})">${icon('branch', 'xs')}${th.branch}</span>`}
        <span class="sep">·</span>
        <span title="Members">${avatarStack(th.members || [], 18, 7, th)}</span>
      </div>
      <div class="t-tools">
        <div class="tabs" role="tablist">
          <a class="tab${tab === 'chat' ? ' on' : ''}" role="tab" aria-selected="${String(tab === 'chat')}" href="${base}">${icon('chat', 'sm')}Chat${count(nMsgs)}</a>
          <a class="tab${tab === 'doc' ? ' on' : ''}" role="tab" aria-selected="${String(tab === 'doc')}" href="${base}?tab=doc">${icon('doc', 'sm')}${th.kind === 'watch' ? 'Runbook' : th.kind === 'solo' ? 'Instructions' : 'Brief & plan'}</a>
        </div>
        <button class="icon-btn details-btn" type="button" data-act="open-side" title="Details" aria-label="Show details">${icon('panel')}</button>
      </div>
    </header>`;
  }

  /** The Triage thread init creates (TRIAGE_REF in factory/lib/store.mjs), and where its offer's Yes goes. */
  const TRIAGE_REF = 'triage/triage';
  const OBSERVABILITY_URL = 'https://elu.dev/promo';

  /** On the Triage thread, until the owner answers it: an offer of live product observability. Yes opens it in a new tab. */
  function offerCard(v) {
    if (state.offer || `${v.team}/${v.thread.id}` !== TRIAGE_REF) return '';
    return html`<div class="offer" role="region" aria-label="Live product observability">
      <div class="offer-text"><strong>Want live product observability?</strong><span>See the bugs real users hit, before they report them.</span></div>
      <div class="offer-actions">
        <a class="btn btn-primary sm" href="${OBSERVABILITY_URL}" target="_blank" rel="noopener" data-act="offer" data-choice="yes">Yes</a>
        <button class="btn btn-outline sm" type="button" data-act="offer" data-choice="no">No</button>
      </div>
    </div>`;
  }

  /**
   * The orange banner: only what needs the owner. Turns addressed to you, a gate
   * you own, and openai or grok holding a turn while not running (only you can
   * start them). Agents waiting on each other show in the Agents row instead.
   */
  function banner(v) {
    const ref = `${v.team}/${v.thread.id}`;
    const presence = v.presence || state.board?.presence || {};
    const held = heldItems([{ ...v.thread, team: v.team }], () => v.openTurns);
    const items = [];
    const mine = held.filter((h) => h.member === 'you');
    for (const h of mine.slice(0, 3)) {
      items.push(h.msgId
        ? html`<span class="turn-pair"><button type="button" class="turn mine" data-act="goto-msg" data-id="${h.msgId}" title="Go to the message"><span class="turn-who">${h.what.charAt(0).toUpperCase()}${h.what.slice(1)}</span><span class="turn-what">${ageText(secondsSince(h.ts))}</span></button><button type="button" class="turn-x" data-act="handled" data-id="${h.msgId}" data-ref="${ref}" title="Dismiss: stop waiting on you for this one" aria-label="Dismiss">${icon('x', 'xs')}</button></span>`
        : html`<span class="turn mine" title="Approve it or request changes below"><span class="turn-who">You own the ${h.what}</span></span>`);
    }
    if (mine.length > 3) items.push(html`<a class="turn-more" href="#/inbox">+${mine.length - 3} more in your inbox</a>`);
    const ap = v.autopilot || state.board?.autopilot;
    for (const id of uniq(held.map((h) => h.member)).filter((x) => x !== 'you')) {
      const need = needsStart(id, held, presence, ap);
      if (!need) continue;
      const h = held.find((x) => x.member === id && !NOTIFY_TYPES.has(x.type));
      const prompt = kickoffPrompt(id, ref);
      // Dismiss: you will not start this agent for these turns; every turn it holds in this thread closes.
      const ids = held.filter((x) => x.member === id && x.msgId).map((x) => x.msgId);
      const who = displayName(id, v.thread);
      const x = html`<button type="button" class="turn-x" data-act="handled" data-id="${ids.join(',')}" data-member="${id}" data-ref="${ref}" title="Dismiss: stop asking you to start ${who} on this thread. It approves nothing: a gate ${who} reviews stays pending." aria-label="Dismiss">${icon('x', 'xs')}</button>`;
      items.push(html`<span class="turn-pair"><span class="turn start ${need.kind}" title="${need.tip ? `${need.tip}\n\n` : ''}${prompt}">${avatar(id, 20, v.thread)}<span class="turn-who">${need.text}</span><span class="turn-what">(${h.what}, ${ageText(secondsSince(h.ts))})</span>${need.copy === false ? '' : html`<button type="button" class="copy-btn" data-act="copy-prompt" data-member="${id}" data-ref="${ref}">${icon('copy', 'xs')}Copy prompt</button>`}</span>${x}</span>`);
    }
    if (!items.length) return '';
    return html`<div class="banner" role="status"><span class="banner-k">${icon('clock', 'sm')}Needs you:</span>${items}</div>`;
  }

  function threadCtx(v) {
    const byId = new Map(v.messages.map((m) => [m.id, m]));
    const responses = new Map(v.messages.filter((m) => m.type === 'review_response' && m.reply_to).map((m) => [m.reply_to, m]));
    const issues = new Map(v.issues.map((i) => [i.id, i]));
    const tasks = new Map(v.tasks.map((t) => [t.id, t]));
    const issueFor = (src, n) => v.issues.find((i) => i.source === src && Number(i.point) === Number(n));
    const decisionsByMsg = new Map(v.decisions.map((d) => [d.message, d]));
    const awaiting = new Map();
    for (const o of v.openTurns) awaiting.set(o.message.id, [...(awaiting.get(o.message.id) || []), o.member]);
    return { byId, responses, issues, tasks, issueFor, decisionsByMsg, awaiting, v };
  }

  function renderThreadBody(v) {
    const body = $('#t-body');
    if (state.route.tab === 'doc') {
      setHtml(body, html`<div class="doc"><div class="md">${raw(md(v.thread.body || '_This thread has no document yet._'))}</div></div>`);
      return;
    }
    let box = $('#msgs');
    const keep = box ? { bottom: box.scrollHeight - box.scrollTop - box.clientHeight < 80 } : null;
    if (!box) {
      setHtml(body, '<div class="msgs" id="msgs" role="log" aria-label="Messages"></div>');
      box = $('#msgs');
    }
    // Patch the list in place: only entries whose HTML changed are replaced, so
    // a write elsewhere (or a new message below) keeps the reader's selection.
    const changed = patchChildren(box, messageEntries(v));
    fillTimes(box);
    if (state.firstPaint || !keep || (changed && keep.bottom)) box.scrollTop = box.scrollHeight;
    if (state.firstPaint) {
      state.firstPaint = false;
      const r = state.route;
      if (r.focus) requestAnimationFrame(() => gotoMessage(r.focus));
      else if (r.findRef) requestAnimationFrame(() => findRef(r.findRef));
    }
  }

  /**
   * Make `box`'s children match `entries` ([{key, html}], one root element each),
   * reusing every child whose key and HTML are unchanged.
   * @returns {boolean} whether anything moved, appeared, changed or went away
   */
  function patchChildren(box, entries) {
    const old = new Map();
    for (const el of [...box.children]) {
      if (el.dataset.key && !old.has(el.dataset.key)) old.set(el.dataset.key, el);
      else el.remove();
    }
    let changed = false;
    let prev = null;
    for (const e of entries) {
      let el = old.get(e.key);
      old.delete(e.key);
      if (!el || el._html !== e.html) {
        const t = document.createElement('template');
        t.innerHTML = e.html;
        const fresh = t.content.firstElementChild;
        fresh.dataset.key = e.key;
        fresh._html = e.html;
        if (el) el.replaceWith(fresh);
        el = fresh;
        changed = true;
      }
      const want = prev ? prev.nextElementSibling : box.firstElementChild;
      if (el !== want) {
        box.insertBefore(el, want);
        changed = true;
      }
      prev = el;
    }
    for (const el of old.values()) {
      el.remove();
      changed = true;
    }
    return changed;
  }

  /** Relative times live outside the entry HTML (they drift every minute); fill them in. */
  function fillTimes(root) {
    for (const t of root.querySelectorAll('time.msg-time')) {
      const text = rel(t.getAttribute('datetime'));
      if (t.textContent !== text) t.textContent = text;
    }
  }

  /** Rendered Markdown of each message body by id (messages never change); cleared when the roster does. */
  const mdCache = new Map();
  const mdBody = (m) => {
    if (!mdCache.has(m.id)) mdCache.set(m.id, md(m.body));
    return mdCache.get(m.id);
  };

  /** A body past this many characters or lines shows folded, with Show more. */
  const FOLD_CHARS = 700;
  const FOLD_LINES = 14;
  /** A message body as Markdown; a long one folds to its first lines until the reader unfolds it. */
  function msgBody(m) {
    const body = String(m.body || '');
    const long = body.length > FOLD_CHARS || body.split('\n').length > FOLD_LINES;
    if (!long) return html`<div class="md msg-body">${raw(mdBody(m))}</div>`;
    const open = state.unfolded.has(m.id);
    return html`<div class="md msg-body${open ? '' : ' folded'}">${raw(mdBody(m))}</div><button type="button" class="msg-more" data-act="msg-more" data-id="${m.id}" aria-expanded="${open ? 'true' : 'false'}">${open ? 'Show less' : 'Show more'}</button>`;
  }

  /**
   * The chat shows what the owner reads. Messages between the agents (internal:
   * dispatches, results) and the factory's automatic events stay out, unless they
   * are to, cc or from you, a permission request, or a message you opened from a link.
   */
  function shownInChat(m) {
    // A dismissal is bookkeeping: the turn it closed stops showing "waiting on you".
    if (m.dismissal === true && !state.revealed.has(m.id)) return false;
    if (m.from === 'you' || state.revealed.has(m.id)) return true;
    if (m.type === 'event' && m.event?.kind === 'permission_denied') return true;
    if (!m.internal && m.type !== 'event') return true;
    return [...(m.to || []), ...(m.cc || [])].includes('you');
  }

  /** The chat as keyed entries: day separators, runs of events, and messages. */
  function messageEntries(v) {
    const ctx = threadCtx(v);
    const out = [];
    let lastDay = null;
    let evts = [];
    const flush = () => {
      if (evts.length) out.push({ key: `e:${evts[0].id}`, html: fmt(html`<div class="evts">${evts.map((m) => eventLine(m, ctx))}</div>`) });
      evts = [];
    };
    for (const m of v.messages) {
      // A permission request is a card the owner answers.
      const card = m.type === 'event' && m.event?.kind === 'permission_denied';
      if (!shownInChat(m)) continue;
      const day = new Date(m.ts).toDateString();
      if (day !== lastDay) {
        flush();
        out.push({ key: `d:${day}`, html: fmt(html`<div class="day-sep">${dayLabel(m.ts)}</div>`) });
        lastDay = day;
      }
      if (m.type === 'event' && !card) evts.push(m);
      else {
        flush();
        out.push({ key: `m:${m.id}`, html: fmt(card ? permissionCard(m, ctx, v) : messageItem(m, ctx)) });
      }
    }
    flush();
    if (!out.length) {
      out.push({ key: 'empty', html: fmt(html`<div class="empty">${icon('chat')}<h3>No messages for you yet</h3><p>${v.messages.length ? 'The agents are working; their messages to each other stay out of the chat. You can post below.' : 'The lead starts the thread; you can post below.'}</p></div>`) });
    }
    return out;
  }

  const RISK_LABEL = { any: 'runs any code', broad: 'broad', changes: 'can change things' };
  /** How far a rule reaches beyond reading (allowRuleRisk on the server), as a small warning chip. */
  function riskChip(risk) {
    return risk ? html`<span class="risk ${risk.level}" title="${risk.text}">${icon('alert', 'xs')}${RISK_LABEL[risk.level] || risk.level}</span>` : '';
  }

  /** The rules a permission request asks for: [{rule, risk}]. */
  const permRules = (m) => (m.event?.rules || []).map((r) => (typeof r === 'string' ? { rule: r, risk: null } : r)).filter((r) => r && typeof r.rule === 'string');

  /** What the owner has typed into a permission card so far (kept across re-renders). */
  function permEdit(m) {
    if (!state.permEdits[m.id]) state.permEdits[m.id] = { rules: permRules(m).map((r) => r.rule), team: false, confirm: null, error: '' };
    return state.permEdits[m.id];
  }

  /**
   * A permission_denied event: the commands a single-agent run was refused, the
   * rules that would allow them (editable), and Allow / Don't allow. Once answered
   * it shows what was decided.
   */
  function permissionCard(m, ctx, v) {
    const e = m.event || {};
    const agent = e.member || e.by;
    const waiting = (ctx.awaiting.get(m.id) || []).includes('you');
    const asked = permRules(m);
    const have = new Set((v.allowRules || []).map((x) => x.rule));
    const cmds = (e.commands || []).filter((c) => c && c.command);
    const allowed = asked.length > 0 && asked.every((r) => have.has(r.rule));
    let form = '';
    if (waiting) {
      const ed = permEdit(m);
      const busy = state.permBusy ? raw(' disabled') : '';
      form = html`<div class="perm-form">
        ${ed.rules.map((val, i) => {
          const orig = asked.find((r) => r.rule === val);
          return html`<div class="perm-rule"><input class="field mono rule-field" type="text" data-perm="${m.id}" data-i="${String(i)}" value="${val}" spellcheck="false" autocomplete="off" aria-label="Rule to allow">${orig ? riskChip(orig.risk) : ''}</div>`;
        })}
        <label class="perm-scope"><input type="checkbox" data-act="perm-team" data-id="${m.id}"${ed.team ? raw(' checked') : ''}><span>Also for every single-agent thread in ${v.teamTitle}</span></label>
        ${ed.confirm ? html`<p class="perm-warn" role="alert">${icon('alert', 'xs')}<span>${ed.confirm}</span></p>` : ''}
        ${ed.error ? html`<p class="perm-err" role="alert">${ed.error}</p>` : ''}
        <div class="perm-actions">
          <button class="btn ${ed.confirm ? 'btn-danger' : 'btn-primary'} sm" type="button" data-act="perm-allow" data-id="${m.id}"${busy}>${ed.confirm ? 'Allow anyway' : 'Allow and retry'}</button>
          <button class="btn btn-outline sm" type="button" data-act="perm-deny" data-id="${m.id}"${busy}>Don't allow</button>
        </div>
      </div>`;
    } else {
      form = html`<ul class="perm-done">${asked.map((r) => html`<li><span class="mono">${r.rule}</span>${have.has(r.rule) ? html`<span class="perm-ok">${icon('check', 'xs')}allowed</span>` : html`<span class="faint">not allowed</span>`}</li>`)}</ul>`;
    }
    return html`<article class="msg perm${waiting ? ' awaiting' : ''}" id="m-${m.id}" data-id="${m.id}">
      ${avatar(agent, 32, v.thread)}
      <div class="msg-main">
        <header class="msg-head">
          <span class="msg-name">${displayName(agent, v.thread)}</span>
          <span class="tchip perm-chip">${icon('lock', 'xs')}needs permission</span>
          ${waiting ? html`<span class="waiting-tag mine">${icon('clock', 'xs')}waiting on you</span>` : allowed ? html`<span class="perm-ok">${icon('check', 'xs')}allowed</span>` : html`<span class="faint">answered</span>`}
        </header>
        <time class="msg-time" datetime="${m.ts}" title="${absTime(m.ts)}"></time>
        <div class="perm-body">
          <p>Its last run was refused ${cmds.length === 1 ? 'this command' : 'these commands'}. Runs can't stop to ask you, so ${cmds.length === 1 ? 'it needs' : 'they need'} allowing here first.</p>
          <ul class="perm-cmds">${cmds.map((c) => html`<li class="mono">${c.command}</li>`)}</ul>
          ${form}
        </div>
      </div>
    </article>`;
  }

  function eventKindClass(m) {
    const e = m.event || {};
    if (e.kind === 'phase') return 'phase';
    if (e.kind === 'gate') return e.to === 'approved' ? 'good' : e.to === 'changes_requested' ? 'warn' : e.to === 'blocked' ? 'bad' : '';
    if (e.kind === 'issue_created') return 'bad';
    if (e.kind === 'issue_status') return e.to === 'verified' || e.to === 'fixed' ? 'good' : e.to === 'open' ? 'bad' : '';
    if (e.kind === 'task_status') return e.to === 'done' ? 'good' : e.to === 'blocked' ? 'bad' : '';
    if (e.kind === 'watch_run') return e.status === 'breach' ? 'bad' : 'good';
    if (e.kind === 'decision') return 'phase';
    if (e.kind === 'merged') return 'good';
    return '';
  }

  /** Factory events name members by id ("fable moved …"); a seat renamed on this thread reads by its seat name. */
  function seatWords(text, th) {
    const ids = uniq([th?.lead, th?.owner, ...(th?.members || [])].filter(Boolean)).filter((id) => seatOf(id, th).name !== memberOf(id).name);
    if (!ids.length) return text;
    const re = new RegExp(`(?<![\\w-])(${ids.map((id) => id.replace(/[^\w-]/g, '')).join('|')})(?![\\w-])`, 'g');
    return text.replace(re, (id) => seatOf(id, th).name);
  }

  function eventLine(m, ctx) {
    const th = ctx.v.thread;
    const text = seatWords(String(m.body || '').trim().replace(/\n+/g, ' — ') || TYPE_LABEL.event, th);
    const waiting = ctx.awaiting.get(m.id) || [];
    const tip = waiting.length
      ? `Waiting on ${waiting.map((id) => displayName(id, th)).join(', ')}; ${notifyCloseText(waiting, th)}`
      : `Opened a turn for ${(m.to || []).map((id) => displayName(id, th)).join(', ')}; closed`;
    return html`<div class="evt${waiting.length ? ' awaiting' : ''}" id="m-${m.id}" data-id="${m.id}">
      <span class="evt-dot ${eventKindClass(m)}"></span>
      <span class="evt-text">${raw(mdInline(text))}</span>
      ${m.to?.length ? html`<span class="evt-to" title="${tip}">→ ${avatarStack(m.to, 16, 4, th)}</span>` : ''}
      ${waiting.includes('you') ? handledButton(m.id) : ''}
      <time datetime="${m.ts}" title="${absTime(m.ts)}">${clock(m.ts)}</time>
    </div>`;
  }

  /** How a notification turn closes (event, alert and report turns: the holder's next write in the thread). */
  function notifyCloseText(holders, th) {
    if (holders.length === 1 && holders[0] === 'you') return 'it closes on your next post, review or decision in this thread';
    return `it closes on the holder's next write in this thread (${holders.map((id) => displayName(id, th)).join(', ')})`;
  }

  function handledButton(id, ref = '') {
    return html`<button type="button" class="handled" data-act="handled" data-id="${id}"${ref ? html` data-ref="${ref}"` : ''} title="Stop waiting on you for this one, without writing anything in the thread">${icon('check', 'xs')}Dismiss</button>`;
  }

  function recipients(m, th) {
    const to = m.to || [];
    const cc = m.cc || [];
    if (!to.length && !cc.length) return '';
    return html`<span class="rcpt">
      ${to.length ? html`<span class="rcpt-k">to</span>${to.map((id) => html`<span class="mchip">${avatar(id, 16, th)}${displayName(id, th)}</span>`)}` : ''}
      ${cc.length ? html`<span class="rcpt-k">cc</span>${cc.map((id) => html`<span class="mchip cc">${avatar(id, 16, th)}${displayName(id, th)}</span>`)}` : ''}
    </span>`;
  }

  /** A message to or from another team (factory tell): a chip that opens that team's thread. */
  function teamLink(m) {
    const l = m.link;
    if (!l || typeof l.thread !== 'string' || !/^[^/]+\/[^/]+$/.test(l.thread) || (l.dir !== 'to' && l.dir !== 'from')) return '';
    const [teamId] = l.thread.split('/');
    const team = teamOf(teamId).title;
    const other = threadByRef(l.thread);
    const where = other ? `${team} · ${other.title}` : l.thread;
    const tip = l.dir === 'to' ? `Sent to ${where}; their reply comes back here` : `From ${where}; a reply goes back there`;
    return html`<a class="chip team" href="#/t/${l.thread}" title="${tip}">${l.dir === 'to' ? `to ${team}` : `from ${team}`}</a>`;
  }

  function messageItem(m, ctx) {
    const th = ctx.v.thread;
    const mem = seatOf(m.from, th);
    const waiting = ctx.awaiting.get(m.id) || [];
    return html`<article class="msg${m.internal ? ' internal' : ''}${waiting.includes('you') ? ' awaiting' : ''}" id="m-${m.id}" data-id="${m.id}">
      ${avatar(m.from, 32, th)}
      <div class="msg-main">
        <header class="msg-head">
          <span class="msg-name">${displayName(m.from, th)}</span>
          <span class="msg-vendor">${vendorLine(mem)}</span>
          ${typeChip(m.type)}
          ${teamLink(m)}
          ${m.internal ? html`<span class="chip internal" title="Lead ↔ builder traffic">${icon('lock', 'xs')}internal</span>` : ''}
          ${recipients(m, th)}
          ${waiting.length ? html`<span class="waiting-tag${waiting.includes('you') ? ' mine' : ''}" title="${NOTIFY_TYPES.has(m.type) ? `Open turn; ${notifyCloseText(waiting, th)}` : ['answer', 'question', 'escalation', 'note'].includes(m.type) && waiting.length === 1 && waiting[0] === 'you' ? 'Open turn; it closes on your next message in this thread, or Dismiss it' : 'Open turn'}">${icon('clock', 'xs')}waiting on ${waiting.map((id) => displayName(id, th)).join(', ')}</span>` : ''}
          ${waiting.includes('you') ? handledButton(m.id) : ''}
        </header>
        <time class="msg-time" datetime="${m.ts}" title="${absTime(m.ts)}"></time>
        <button class="msg-reply" type="button" data-act="reply" data-id="${m.id}" aria-label="Reply to this message">${icon('reply', 'sm')}Reply</button>
        ${m.reply_to ? replyQuote(m.reply_to, ctx) : ''}
        ${String(m.body || '').trim() && !isDefaultReviewBody(m) ? msgBody(m) : ''}
        ${typeBlock(m, ctx)}
        ${refsLine(m)}
      </div>
    </article>`;
  }

  /** The store writes "`verdict` at `gate`: N points (…)." when a review has no body; the review block already says that. */
  function isDefaultReviewBody(m) {
    return m.type === 'review' && /^`[a-z_]+` at `[a-z_]+`(: \d+ points? \([^)]*\))?\.$/.test(String(m.body || '').trim());
  }

  function replyQuote(id, ctx) {
    const t = ctx.byId.get(id);
    if (!t) return html`<button type="button" class="quote" data-act="goto-msg" data-id="${id}"><span>↪ replying to a message elsewhere</span></button>`;
    return html`<button type="button" class="quote" data-act="goto-msg" data-id="${id}" title="Jump to it"><span>↪ replying to <strong>${displayName(t.from, ctx.v.thread)}</strong> · ${TYPE_LABEL[t.type]}</span><span class="quote-sum">${t.summary}</span></button>`;
  }

  function refsLine(m) {
    if (!['note', 'question', 'answer', 'proposal', 'kickoff', 'escalation'].includes(m.type)) return '';
    const refs = (m.refs || []).filter((x) => /^[TID]-\d{3,}$/.test(x));
    if (!refs.length) return '';
    return html`<div class="refs">refs ${refs.map((x) => html`<button type="button" class="ref" data-act="ref" data-ref="${x}">${x}</button>`)}</div>`;
  }

  function taskRef(ctx, id) {
    const t = ctx.tasks.get(id);
    return html`<button type="button" class="ref ${t?.status === 'done' ? 'done' : ''}" data-act="ref" data-ref="${id}" title="${t ? `${t.status}: ${t.title}` : id}">${id}</button>`;
  }

  function typeBlock(m, ctx) {
    switch (m.type) {
      case 'review': {
        const pts = m.points || [];
        return html`<div class="block">
          <div class="block-head">${verdictBadge(m.verdict)}<span>at</span><span class="mono">${PHASE_LABEL[m.gate] || m.gate}</span><span>· ${pts.length ? plural(pts.length, 'point') : 'no points'}</span></div>
          ${pts.length ? html`<ol class="points">${pts.map((p) => {
            const is = ctx.issueFor(m.id, p.n);
            return html`<li class="point"><span class="pn">${String(p.n)}</span>${sevChip(p.severity)}<span class="ptext">${raw(mdInline(p.text))}</span>${is ? html`<button type="button" class="ref ${is.status}" data-act="ref" data-ref="${is.id}" title="${is.id}: ${is.status}">${is.id} · ${is.status}</button>` : raw('<span></span>')}</li>`;
          })}</ol>` : ''}
        </div>`;
      }
      case 'review_response': {
        const rv = ctx.byId.get(m.reply_to);
        const st = m.stances || [];
        return html`<div class="block">
          <div class="block-head">Response to <strong>${rv ? displayName(rv.from, ctx.v.thread) : 'the review'}</strong>${rv ? html`<span>at</span><span class="mono">${PHASE_LABEL[rv.gate] || rv.gate}</span>` : ''}<span>· ${st.map((s) => s.stance).filter((x, i, a) => a.indexOf(x) === i).map((x) => `${st.filter((s) => s.stance === x).length} ${x}`).join(', ')}</span></div>
          ${st.length ? html`<ol class="points">${st.map((s) => {
            const p = rv?.points?.find((x) => Number(x.n) === Number(s.point));
            const is = rv ? ctx.issueFor(rv.id, s.point) : null;
            return html`<li class="point"><span class="pn">${String(s.point)}</span><span class="stance ${s.stance}">${s.stance === 'accepted' ? icon('check', 'xs') : s.stance === 'rejected' ? icon('x', 'xs') : icon('clock', 'xs')}${s.stance}</span>
              <span class="ptext">${p ? html`<span class="pquote">${p.text}</span>` : ''}${s.reason ? html`<span class="preason">${raw(mdInline(s.reason))}</span>` : ''}${s.stance === 'accepted' && is?.task ? html`<span class="ptask">→ ${taskRef(ctx, is.task)} ${ctx.tasks.get(is.task)?.title || s.action || ''}</span>` : ''}</span>
              ${is ? html`<button type="button" class="ref ${is.status}" data-act="ref" data-ref="${is.id}">${is.id}</button>` : raw('<span></span>')}</li>`;
          })}</ol>` : ''}
        </div>`;
      }
      case 'dispatch': {
        const t = ctx.tasks.get(m.task);
        return html`<div class="block"><div class="block-row">${taskRef(ctx, m.task)}<span class="t">${t?.title || ''}</span><span>→</span>${(m.to || []).map((id) => html`<span class="mchip">${avatar(id, 16, ctx.v.thread)}${displayName(id, ctx.v.thread)}</span>`)}</div></div>`;
      }
      case 'result': {
        const t = ctx.tasks.get(m.task);
        return html`<div class="block"><div class="block-row">${verdictBadge(m.outcome)}${taskRef(ctx, m.task)}<span class="t">${t?.title || ''}</span>${t ? pill(t.status, `now ${t.status}`) : ''}</div></div>`;
      }
      case 'decision': {
        const d = ctx.decisionsByMsg.get(m.id);
        return html`<div class="block"><div class="block-row"><span class="ref">${m.decision}</span><span class="t">${d?.title || ''}</span>${m.gate ? html`<span class="mono">${PHASE_LABEL[m.gate] || m.gate}</span>${verdictBadge(m.verdict)}` : ''}</div></div>`;
      }
      case 'report':
        return html`<div class="block"><div class="block-row">${pill(m.status === 'breach' ? 'breach' : 'done', m.status === 'breach' ? 'breach' : 'ok', true)}<span class="mono">${m.report}</span></div></div>`;
      case 'alert':
        return html`<div class="block"><div class="block-row">${icon('alert', 'sm')}<span class="mono t">${m.metric}</span><span class="mono" style="color:var(--danger);font-weight:650">${fmtMetric(m.metric, m.value)}</span><span class="mono">${fmtThreshold(m.metric, m.threshold)}</span>${m.issue ? html`<button type="button" class="ref" data-act="ref" data-ref="${m.issue}">${m.issue}</button>` : ''}</div></div>`;
      default:
        return '';
    }
  }

  // ---- side panel -------------------------------------------------------------

  function scard(title, right, body) {
    return html`<section class="scard"><header class="scard-head"><h2>${title}</h2>${right}</header>${body}</section>`;
  }

  function sidePanel(v) {
    const th = v.thread;
    const parts = th.kind === 'watch'
      ? [watchStatusCard(v), metricsCard(v), issuesCard(v), fixesCard(v), reportsCard(v), sessionsCard(v)]
      : th.kind === 'solo'
        ? [soloAgentCard(v), sessionsCard(v), issuesCard(v)]
        : [gatesCard(v), tasksCard(v), issuesCard(v), decisionsCard(v), membersCard(v), sessionsCard(v)];
    if (th.kind !== 'project' && v.decisions.length) parts.push(decisionsCard(v));
    return parts;
  }

  function gatesCard(v) {
    const th = v.thread;
    const order = phasesOf(th);
    const idx = order.indexOf(th.phase);
    const spans = phaseSpans(th, v.messages);
    const eta = th.eta || {};
    const stepEta = (p, pos) => {
      const e = eta[p];
      if (pos === 'past') return spans.spent[p] >= 60000 ? html`<span class="seta" title="${e ? `estimated ${fmtMin(e.minutes)}` : ''}">${fmtMin(spans.spent[p] / 60000)}</span>` : '';
      if (!e) return '';
      const tip = `estimated ${fmtMin(e.minutes)} by ${displayName(e.by, th)}`;
      if (pos === 'current') {
        const l = leftOf(dueOf(e, spans.since));
        return html`<span class="seta${l.over ? ' over' : ''}" title="${tip}">${l.text}</span>`;
      }
      return html`<span class="seta" title="${tip}">~${fmtMin(e.minutes)}</span>`;
    };
    const finish = threadFinish(th, spans.since);
    const steps = order.map((p, i) => {
      const g = th.gates?.[p];
      const pos = th.phase === 'done' ? (p === 'done' ? 'current done-final' : 'past') : i < idx ? 'past' : i === idx ? 'current' : 'future';
      const status = g && i === idx ? ` ${g.status}` : '';
      const right = g
        ? html`<span class="sgate">${p === 'build' ? html`<span class="s ${g.status}" title="Approves itself when every task is done">auto</span>` : html`<span class="s ${g.status}" title="${g.at ? `${GATE_STATUS[g.status]} ${rel(g.at)}` : GATE_STATUS[g.status]}">${GATE_STATUS_SHORT[g.status]}</span>`}${avatar(g.by, 18, th)}</span>`
        : raw('<span></span>');
      return html`<li class="step ${pos}${status}"><span class="smark">${pos === 'past' || pos.includes('done-final') ? icon('check') : ''}</span><span class="slabel">${PHASE_LABEL[p]}${p === 'done' ? '' : stepEta(p, pos)}</span>${right}</li>`;
    });
    const head = th.phase === 'done' ? 'done' : `step ${idx + 1} of ${order.length}`;
    return scard('Gates', html`<span class="faint">${head}${finish ? html` · <span class="finish" title="${finishTitle(finish)}">ETA ${finishLabel(finish)}${finish.missing.length ? '+' : ''}</span>` : ''}</span>`, html`<ol class="stepper">${steps}</ol>`);
  }

  function tasksCard(v) {
    const tasks = [...v.tasks].sort((a, b) => TASK_ORDER.indexOf(a.status) - TASK_ORDER.indexOf(b.status) || a.id.localeCompare(b.id));
    const done = v.tasks.filter((t) => t.status === 'done').length;
    return scard('Tasks', html`<span class="faint">${v.tasks.length ? `${done}/${v.tasks.length} done` : ''}</span>`, tasks.length
      ? html`<div class="rows">${tasks.map((t) => html`<button type="button" class="row ${t.status}" data-act="ref" data-ref="${t.id}" title="${t.id}: ${t.title}${t.owner ? ` · ${displayName(t.owner, v.thread)}` : ''}">
          <span class="rid">${t.id}</span><span class="rt">${plain(t.title)}</span><span class="rr">${taskEta(t, v.thread)}${pill(t.status, t.status)}${t.owner ? avatar(t.owner, 18, v.thread) : ''}</span></button>`)}</div>`
      : html`<p class="none">No tasks yet.</p>`);
  }

  /** A watch thread holds no tasks: its issues are fixed by tasks on project threads, linked here. */
  function fixesCard(v) {
    const team = teamOf(v.team);
    const fixes = v.issues.filter((i) => i.task).map((i) => ({ issue: i, task: (team?.tasks || []).find((t) => t.id === i.task) }));
    return scard('Fixes', count(fixes.length), fixes.length
      ? html`<div class="rows">${fixes.map(({ issue, task }) => {
          const th = task && team.threads.find((x) => x.id === task.thread);
          const tip = `${issue.id} → ${issue.task}${task ? `: ${task.title} (${task.status}) on ${th ? th.title : task.thread}` : ''}`;
          return html`<a class="row ${task ? task.status : ''}" href="${task ? threadHash(v.team, task.thread) : '#'}" title="${tip}">
            <span class="rid">${issue.task}</span><span class="rt">${th ? th.title : task ? task.thread : plain(issue.title)}</span><span class="rr">${task ? pill(task.status, task.status) : ''}${task?.owner ? avatar(task.owner, 18, th) : ''}</span></a>`;
        })}</div>`
      : html`<p class="none">Fixes run on project threads: <span class="mono">factory issue accept &lt;team&gt;/I-… --thread &lt;team&gt;/&lt;thread&gt;</span>.</p>`);
  }

  function issuesCard(v) {
    const issues = [...v.issues].sort((a, b) => ISSUE_ORDER.indexOf(a.status) - ISSUE_ORDER.indexOf(b.status) || a.id.localeCompare(b.id));
    const open = v.issues.filter((i) => i.status === 'open' || i.status === 'accepted').length;
    return scard('Issues', html`<span class="faint">${v.issues.length ? `${open} open of ${v.issues.length}` : ''}</span>`, issues.length
      ? html`<div class="rows">${issues.map((i) => html`<button type="button" class="row ${i.status}" data-act="ref" data-ref="${i.id}" title="${i.id} (${i.severity}, ${i.status}): ${i.title}${i.reason ? ` — ${i.reason}` : ''}">
          <span class="lead-in">${sevChip(i.severity)}<span class="rid">${i.id}</span></span><span class="rt">${plain(i.title)}</span><span class="rr">${pill(i.status, i.status)}</span></button>`)}</div>`
      : html`<p class="none">No issues raised.</p>`);
  }

  function decisionsCard(v) {
    return scard('Decisions', count(v.decisions.length), v.decisions.length
      ? html`<div class="rows">${v.decisions.map((d) => html`<button type="button" class="row" data-act="goto-msg" data-id="${d.message || ''}" title="${d.id}: ${d.title}${d.gate ? ` (${d.gate} ${d.verdict})` : ''}">
          <span class="rid">${d.id}</span><span class="rt">${d.title}</span><span class="rr">${d.by ? avatar(d.by, 18, v.thread) : ''}</span></button>`)}</div>`
      : html`<p class="none">No decisions recorded.</p>`);
  }

  function membersCard(v) {
    const th = v.thread;
    return scard('People', count((th.members || []).length), html`<dl class="kv">
      <dt>Lead</dt><dd>${avatar(th.lead, 18, th)}${displayName(th.lead, th)}</dd>
      <dt>Members</dt><dd>${avatarStack(th.members || [], 20, 8, th)}</dd>
      <dt>Updated</dt><dd class="mono" title="${absTime(th.updated)}">${rel(th.updated)}</dd>
      ${costRow(v.cost)}
    </dl>`);
  }

  /**
   * Each agent's session on this thread, with the command that continues it in a terminal
   * (Claude Code or Codex, where the agent left off). Hidden while that agent's run is going.
   */
  function sessionsCard(v) {
    const list = v.sessions || [];
    if (!list.length) return '';
    const ref = `${v.team}/${v.thread.id}`;
    const ap = v.autopilot || state.board?.autopilot;
    return scard('Continue in terminal', '', html`<dl class="kv">${list.map((s) => {
      const running = Boolean(ap?.alive && runOn(apRaw(s.member, ap), ref));
      return html`<dt>${displayName(s.member, v.thread)}</dt><dd>${running
        ? html`<span class="faint" title="Wait for its run to end: two writers in one session lose work">running now</span>`
        : html`<button class="btn btn-outline xs" type="button" data-act="copy-resume" data-cmd="${s.command}" title="${s.command}">${icon('copy', 'xs')}Copy command</button>`}</dd>`;
    })}</dl><p class="scard-note">Paste it in a terminal to pick up the agent's session where it left off.</p>`);
  }

  /** A single-agent thread's agent: model, effort, how it gets started, what it may run, its last run here. */
  function soloAgentCard(v) {
    const th = v.thread;
    const m = memberOf(th.owner);
    const ap = v.autopilot || state.board?.autopilot;
    const raw = apRaw(th.owner, ap);
    const ref = `${v.team}/${th.id}`;
    const last = lastRunOn(th.owner, ref, ap);
    const auto = Boolean(ap?.alive && raw?.enabled);
    const started = auto ? 'by the autopilot, 20 s after you ask'
      : !ap?.alive ? 'by you: the autopilot is off (factory autopilot --detach)'
        : raw ? `by you: ${raw.reason || 'the autopilot cannot start it'}` : 'by you: restart the autopilot so it knows this agent';
    return scard('Agent', phasePill(th), html`<dl class="kv">
      <dt>Agent</dt><dd>${avatar(th.owner, 18, th)}${displayName(th.owner, th)}<span class="faint">leads the thread; may start subagents</span></dd>
      <dt>Model</dt><dd class="mono">${m.model || '—'}${m.effort ? ` · ${m.effort}` : ''}</dd>
      <dt>Started</dt><dd>${started}</dd>
      <dt>May run</dt><dd>${allowEditor(v)}<span class="faint">plus reading files, read-only commands and the factory CLI${auto ? '' : '. That applies when the autopilot starts it; a session you start uses your own permissions'}</span></dd>
      <dt>Last run</dt><dd class="mono" title="${last ? absTime(last.ended_at) : ''}">${last ? `${rel(last.ended_at)} · ${last.outcome}${last.cost_usd != null ? ` · $${last.cost_usd}` : ''}` : 'not yet'}</dd>
      ${costRow(v.cost)}
    </dl>`);
  }

  /** The commands a single-agent thread's agent may run beyond the defaults, with remove buttons and an add box. */
  function allowEditor(v) {
    const ref = `${v.team}/${v.thread.id}`;
    const ed = state.allowEdit[ref] || {};
    const rules = v.allowRules || [];
    const busy = state.permBusy ? raw(' disabled') : '';
    return html`${rules.length ? html`<ul class="allow">${rules.map((r) => html`<li>
        <span class="mono">${r.rule}</span>
        ${r.scope === 'team' ? html`<span class="scope-chip" title="Every single-agent thread in ${v.teamTitle} may run this">team</span>` : ''}
        ${riskChip(r.risk)}
        <button type="button" class="icon-btn xs allow-x" data-act="allow-remove" data-rule="${r.rule}" data-scope="${r.scope}"${busy} title="${r.scope === 'team' ? `Stop allowing this for every single-agent thread in ${v.teamTitle}` : 'Stop allowing this'}" aria-label="Stop allowing ${r.rule}">${icon('x', 'xs')}</button>
      </li>`)}</ul>` : ''}
      <div class="allow-add">
        <input class="field mono rule-field" type="text" id="allow-input" data-allow="${ref}" value="${ed.value || ''}" placeholder="Bash(gcloud logging read:*)" spellcheck="false" autocomplete="off" aria-label="A command rule to allow">
        <button class="btn ${ed.confirm ? 'btn-danger' : 'btn-outline'} xs" type="button" data-act="allow-add"${busy}>${ed.confirm ? 'Add anyway' : 'Add'}</button>
      </div>
      <label class="perm-scope"><input type="checkbox" data-act="allow-team" data-ref="${ref}"${ed.team ? raw(' checked') : ''}><span>For every single-agent thread in ${v.teamTitle}</span></label>
      ${ed.confirm ? html`<p class="perm-warn" role="alert">${icon('alert', 'xs')}<span>${ed.confirm}</span></p>` : ''}
      ${ed.error ? html`<p class="perm-err" role="alert">${ed.error}</p>` : ''}`;
  }

  function watchStatusCard(v) {
    const th = v.thread;
    const period = cadenceMs(th.cadence);
    const next = th.phase === 'paused' ? 'paused' : !th.last_run ? 'due now (never run)' : period ? untilText(Date.parse(th.last_run) + period - Date.now()) : '—';
    return scard('Watch', phasePill(th), html`<dl class="kv">
      <dt>Owner</dt><dd>${avatar(th.owner || th.lead, 18, th)}${displayName(th.owner || th.lead, th)}</dd>
      <dt>Lead</dt><dd>${avatar(th.lead, 18, th)}${displayName(th.lead, th)}</dd>
      <dt>Cadence</dt><dd class="mono">${th.cadence}</dd>
      <dt>Last run</dt><dd class="mono" title="${th.last_run ? absTime(th.last_run) : ''}">${th.last_run ? rel(th.last_run) : 'never'}</dd>
      <dt>Next run</dt><dd class="mono">${next}</dd>
      <dt>Runs</dt><dd class="mono">${v.metrics.length}</dd>
      ${costRow(v.cost)}
    </dl>`);
  }

  function metricsCard(v) {
    const th = v.thread;
    const thr = th.thresholds || {};
    const names = uniq([...Object.keys(thr), ...v.metrics.flatMap((r) => Object.keys(r.metrics || {}))]);
    if (!names.length) return scard('Metrics', '', html`<p class="none">No runs yet. The monitor posts one with <span class="mono">factory watch run</span>.</p>`);
    const first = v.metrics[0]?.ts;
    const last = v.metrics[v.metrics.length - 1]?.ts;
    return scard('Metrics', html`<span class="faint">${plural(v.metrics.length, 'run')}</span>`, names.map((n) => {
      const series = v.metrics.filter((r) => typeof r.metrics?.[n] === 'number');
      const lastV = series.length ? series[series.length - 1].metrics[n] : null;
      const bad = lastV != null && breaches(lastV, thr[n]);
      return html`<div class="metric${bad ? ' breach' : ''}">
        <div class="metric-head"><span class="metric-name" title="${n}">${n}</span><span class="metric-th">${fmtThreshold(n, thr[n])}</span><span class="metric-val">${fmtMetric(n, lastV)}</span></div>
        ${sparkline(series, n, thr[n])}
        ${first ? html`<div class="spark-axis"><span>${shortDate(first)}</span><span>${shortDate(last)}</span></div>` : ''}
      </div>`;
    }));
  }

  function sparkline(rows, metric, t) {
    const pts = rows.map((r) => ({ ts: Date.parse(r.ts), v: r.metrics[metric], breach: (r.breaches || []).includes(metric) || breaches(r.metrics[metric], t) })).filter((p) => Number.isFinite(p.ts));
    if (!pts.length) return html`<p class="none">No data for ${metric} yet.</p>`;
    const W = 288;
    const H = 58;
    const PX = 5;
    const PT = 6;
    const PB = 6;
    const vals = pts.map((p) => p.v);
    const lims = t ? [t.min, t.max].filter((x) => typeof x === 'number') : [];
    let lo = Math.min(...vals, ...lims);
    let hi = Math.max(...vals, ...lims);
    if (lo === hi) {
      const d = Math.abs(lo) * 0.1 || 1;
      lo -= d;
      hi += d;
    }
    const pad = (hi - lo) * 0.14;
    lo -= pad;
    hi += pad;
    const t0 = pts[0].ts;
    const t1 = pts[pts.length - 1].ts;
    const x = (p, i) => (pts.length === 1 ? W / 2 : t1 === t0 ? PX + (i / (pts.length - 1)) * (W - 2 * PX) : PX + ((p.ts - t0) / (t1 - t0)) * (W - 2 * PX));
    const y = (val) => PT + (1 - (val - lo) / (hi - lo)) * (H - PT - PB);
    const xy = pts.map((p, i) => [x(p, i), y(p.v)]);
    const line = xy.map(([a, b], i) => `${i ? 'L' : 'M'}${a.toFixed(1)} ${b.toFixed(1)}`).join(' ');
    const area = `${line} L${xy[xy.length - 1][0].toFixed(1)} ${H - PB} L${xy[0][0].toFixed(1)} ${H - PB} Z`;
    const parts = [];
    if (t && typeof t.max === 'number') {
      const yy = y(t.max);
      parts.push(`<rect class="band" x="0" y="0" width="${W}" height="${Math.max(0, yy).toFixed(1)}"/>`, `<line class="thr" x1="0" x2="${W}" y1="${yy.toFixed(1)}" y2="${yy.toFixed(1)}"/>`);
    }
    if (t && typeof t.min === 'number') {
      const yy = y(t.min);
      parts.push(`<rect class="band" x="0" y="${yy.toFixed(1)}" width="${W}" height="${Math.max(0, H - yy).toFixed(1)}"/>`, `<line class="thr" x1="0" x2="${W}" y1="${yy.toFixed(1)}" y2="${yy.toFixed(1)}"/>`);
    }
    parts.push(`<path class="area" d="${area}"/>`, `<path class="line" d="${line}"/>`);
    pts.forEach((p, i) => {
      const [a, b] = xy[i];
      const label = `${new Date(p.ts).toLocaleString(undefined, { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' })} · ${fmtMetric(metric, p.v)}${p.breach ? ' · breach' : ''}`;
      parts.push(`<circle class="pt${p.breach ? ' breach' : ''}${i === pts.length - 1 ? ' last' : ''}" cx="${a.toFixed(1)}" cy="${b.toFixed(1)}" r="${i === pts.length - 1 ? 3.4 : 2.6}"><title>${esc(label)}</title></circle>`);
    });
    return raw(`<svg class="spark" viewBox="0 0 ${W} ${H}" role="img" aria-label="${esc(`${metric}: ${pts.length} runs, latest ${fmtMetric(metric, pts[pts.length - 1].v)}`)}">${parts.join('')}</svg>`);
  }

  function reportsCard(v) {
    const reps = [...v.reports].reverse();
    return scard('Reports', count(v.reports.length), reps.length
      ? html`<div class="rows">${reps.slice(0, 10).map((r) => html`<button type="button" class="row rep" data-act="find-report" data-file="${r.file}" title="${r.path}">
          <span class="lead-in">${pill(r.status === 'breach' ? 'breach' : 'done', r.status === 'breach' ? 'breach' : 'ok')}</span><span class="rt mono" style="font-size:11.5px">${r.ts ? `${shortDate(r.ts)} ${clock(r.ts)}` : r.file}</span><span class="rr faint mono" style="font-size:11px">${r.ts ? rel(r.ts) : ''}</span></button>`)}</div>${reps.length > 10 ? html`<p class="none">${reps.length - 10} older reports in <span class="mono">reports/</span>.</p>` : ''}`
      : html`<p class="none">No reports yet.</p>`);
  }

  // ---- composer -------------------------------------------------------------

  function ownsGate(th) {
    return th.kind === 'project' && REVIEW_GATES.includes(th.phase) && th.gates?.[th.phase]?.by === 'you';
  }

  function renderComposer(v) {
    const box = $('#composer');
    const ref = state.route.ref;
    const d = draft(ref);
    const th = v.thread;
    if (box.dataset.ref !== ref) {
      box.dataset.ref = ref;
      box.innerHTML = '<div id="c-gate"></div><div class="c-top" id="c-top"></div><div class="c-extra" id="c-extra"></div><div class="c-input"><textarea id="c-body" rows="2" data-input="body" aria-label="Message"></textarea></div><div class="c-foot" id="c-foot"></div><div class="c-error" id="c-error" role="alert"></div>';
      const ta = $('#c-body');
      ta.value = d.body;
      autosize(ta);
    }
    // The doc tab is for reading; the composer stays only when you own the
    // current gate, so the brief (or plan) can be approved where it is read.
    box.hidden = state.route.tab === 'doc' && !ownsGate(th);
    const ta = $('#c-body');
    ta.placeholder = d.replyTo ? 'Write your reply…' : th.kind === 'solo' && th.owner ? `Ask ${displayName(th.owner, th)}: what should it do?` : `Message ${th.title} as the product owner…`;
    paint($('#c-gate'), gateStrip(th, d), { fields: 'keep' });
    paint($('#c-top'), composerTop(v, d), { fields: 'keep' });
    paint($('#c-extra'), composerExtra(th, d), { fields: 'keep' });
    paint($('#c-foot'), composerFoot(v, d));
    $('#c-error').textContent = d.error || '';
  }

  /**
   * A review gate owned by an agent only the owner can start (grok): the owner
   * can skip it, a decision approving the gate (decide --gate, verdict approve).
   * Two clicks: the first asks to confirm.
   */
  function skipStrip(th) {
    if (th.kind !== 'project' || !REVIEW_GATES.includes(th.phase)) return '';
    const gate = th.gates?.[th.phase];
    if (!gate || gate.status !== 'pending' || !gate.by || gate.by === 'you' || !ownerStarts(gate.by) || apMember(gate.by)?.enabled) return '';
    const who = displayName(gate.by, th);
    const g = PHASE_LABEL[th.phase];
    const sure = state.confirmSkip === `${th.team}/${th.id}:${th.phase}`;
    return html`<div class="gate-strip">
      <span class="gtext">${icon('shield', 'sm')}<span><strong>The ${g.toLowerCase()} gate is ${displayName(gate.by, th)}'s.</strong> <span class="faint">${who} runs only when you start it. Skip it to approve ${g.toLowerCase()} yourself.</span></span></span>
      ${sure ? html`<button class="btn btn-ghost sm" type="button" data-act="skip-gate-cancel">Cancel</button>` : ''}
      <button class="btn ${sure ? 'btn-primary' : 'btn-outline'} sm" type="button" data-act="skip-gate" data-gate="${th.phase}"${state.sending ? raw(' disabled') : ''}>${sure ? html`${icon('check', 'sm')}Approve ${g.toLowerCase()} without ${who}` : `Skip ${who}'s review`}</button>
    </div>`;
  }

  async function skipGate(ref, gate, btn) {
    const th = state.thread?.thread;
    if (!ref || !gate || !th || state.sending) return;
    const who = displayName(th.gates?.[gate]?.by, th);
    const g = PHASE_LABEL[gate].toLowerCase();
    state.sending = true;
    if (btn) btn.disabled = true;
    try {
      await api('/api/decide', { ref, gate, verdict: 'approve', title: `Skip ${who}'s ${g}`, body: `Approved ${g} without ${who}'s review.` });
      toast(`Approved ${g} without ${who}`);
    } catch (e) {
      toast(e.message, true);
      if (btn) btn.disabled = false;
    } finally {
      state.sending = false;
    }
    await refresh();
  }

  function gateStrip(th, d) {
    if (!ownsGate(th)) return skipStrip(th);
    const g = PHASE_LABEL[th.phase];
    const gate = th.gates[th.phase];
    return html`<div class="gate-strip">
      <span class="gtext">${icon('shield', 'sm')}<span><strong>You own the ${g} gate.</strong> <span class="faint">${GATE_STATUS[gate.status]}${gate.at ? ` · ${rel(gate.at)}` : ''}</span></span></span>
      ${state.route.tab === 'doc'
        ? html`<a class="btn btn-ghost sm" href="${threadHash(th.team, th.id)}">${icon('chat', 'sm')}Back to the chat</a>`
        : html`<a class="btn btn-ghost sm" href="${threadHash(th.team, th.id, '?tab=doc')}">${icon('doc', 'sm')}Read the ${th.phase === 'brief' ? 'brief' : 'thread doc'}</a>`}
      <button class="btn btn-ghost sm" type="button" data-act="add-point">${icon('plus', 'sm')}Point</button>
      <button class="btn btn-outline sm" type="button" data-act="review" data-verdict="changes_requested"${state.sending ? raw(' disabled') : ''}>Request changes</button>
      <button class="btn btn-primary sm" type="button" data-act="review" data-verdict="approve"${state.sending ? raw(' disabled') : ''}>${icon('check', 'sm')}Approve ${g.toLowerCase()}</button>
    </div>`;
  }

  function composerTop(v, d) {
    const th = v.thread;
    const to = postTo(th, d);
    const choices = uniq([th.lead, th.owner, ...(th.members || [])].filter((x) => x && x !== 'you' && x !== 'factory'));
    const target = d.replyTo ? v.messages.find((m) => m.id === d.replyTo) : null;
    return html`
      <span class="c-label">to</span>
      ${th.kind === 'solo' && th.owner
        ? html`<span class="to-chip on to-fixed" title="Everything you send here goes to ${displayName(th.owner, th)} and starts it">${avatar(th.owner, 20, th)}${displayName(th.owner, th)}</span>`
        : choices.map((id) => html`<button type="button" class="to-chip${to.includes(id) ? ' on' : ''}" data-act="to" data-id="${id}" aria-pressed="${String(to.includes(id))}" title="${to.includes(id) ? `Sends to ${displayName(id, th)} and starts it` : `Also send to ${displayName(id, th)}`}">${avatar(id, 20, th)}${displayName(id, th)}</button>`)}
      ${target ? html`<span class="reply-pill">${icon('reply', 'xs')}<span>Replying to ${displayName(target.from, th)} · ${TYPE_LABEL[target.type]}: ${target.summary}</span><button class="icon-btn" type="button" data-act="clear-reply" aria-label="Stop replying">${icon('x', 'xs')}</button></span>` : ''}`;
  }

  function composerExtra(th, d) {
    const parts = [];
    if (ownsGate(th) && d.points.length) {
      parts.push(html`${d.points.map((p, i) => html`<div class="c-row">
        <span class="pn">${String(i + 1)}</span>
        <select class="select sm" data-act="point-sev" data-i="${String(i)}" aria-label="Severity">${['high', 'medium', 'low', 'nit'].map((s) => html`<option value="${s}"${p.severity === s ? raw(' selected') : ''}>${s}</option>`)}</select>
        <input class="field" data-input="point" data-i="${String(i)}" value="${p.text}" placeholder="What needs to change" aria-label="Point ${String(i + 1)}">
        <button class="icon-btn" type="button" data-act="drop-point" data-i="${String(i)}" aria-label="Remove point">${icon('x', 'sm')}</button>
      </div>`)}`);
    }
    return parts;
  }

  /** Your open turns in this thread that your next write here closes: events, alerts, reports, and answers, questions and escalations to you. */
  const myNotifyTurns = (v) => v.openTurns.filter((o) => o.member === 'you' && (NOTIFY_TYPES.has(o.message.type) || ['answer', 'question', 'escalation', 'note'].includes(o.message.type)));

  function composerFoot(v, d) {
    const label = d.replyTo ? 'Send reply' : 'Send';
    const notify = myNotifyTurns(v).length;
    const nobody = !postTo(v.thread, d).length;
    return html`<span class="c-hint"><kbd>${IS_MAC ? '⌘' : 'Ctrl'}</kbd> <kbd>Enter</kbd> to send · Markdown works · drop or paste an image${nobody ? html` · <span class="c-warn">pick who to send it to</span>` : ''}${notify ? html` · <span title="Questions, answers, notes, escalations, events, alerts and reports addressed to you close on your next post, review or decision in the thread; an agent whose question your message left open asks again">sending closes ${plural(notify, 'turn')} waiting on you</span>` : ''}</span>
      <button class="btn btn-primary" type="button" data-act="send"${state.sending ? raw(' disabled') : ''}>${icon('send', 'sm')}${label}</button>`;
  }

  /** Review points with text, while you own the current gate (they go out only with a verdict). */
  const pendingPoints = (th, d) => (ownsGate(th) ? d.points.filter((p) => String(p.text || '').trim()) : []);
  const POINTS_NEED_VERDICT = 'Review points go out with a verdict: use Approve or Request changes above, or remove the points first.';

  /**
   * Open turns a gate decision settles: the gate-entry event that asked the gate
   * owner to review `gate`. Deciding the gate yourself answers it for them, and
   * nothing they write later would close it once the thread has moved on.
   */
  function gateEntryTurns(v, gate) {
    const byId = new Map(v.messages.map((m) => [m.id, m]));
    return v.openTurns.filter((o) => {
      const m = byId.get(o.message.id);
      return m && m.type === 'event' && m.event?.kind === 'phase' && m.event?.to === gate;
    }).map((o) => o.message.id);
  }

  function autosize(ta) {
    ta.style.height = 'auto';
    ta.style.height = `${Math.min(240, Math.max(64, ta.scrollHeight + 2))}px`;
  }

  async function send(kind) {
    const v = state.thread;
    if (!v || state.sending) return;
    const ref = state.route.ref;
    const d = draft(ref);
    const ta = $('#c-body');
    d.body = ta.value;
    d.error = '';
    const th = v.thread;
    let done = '';
    try {
      if (kind === 'approve' || kind === 'changes_requested') {
        const pts = d.points.filter((p) => p.text.trim());
        if (kind === 'approve' && pts.some((p) => p.severity === 'high' || p.severity === 'medium')) {
          throw new Error('Approve carries only low or nit points. Use Request changes for high or medium points.');
        }
        state.sending = true;
        renderComposer(v);
        await api('/api/review', { ref, verdict: kind, points: pts, body: d.body });
        done = kind === 'approve' ? `Approved ${PHASE_LABEL[th.phase].toLowerCase()}` : `Requested changes at ${PHASE_LABEL[th.phase].toLowerCase()}`;
      } else if (pendingPoints(th, d).length) {
        throw new Error(POINTS_NEED_VERDICT);
      } else {
        if (!d.body.trim()) throw new Error('Write a message first.');
        const to = postTo(th, d);
        if (!to.length) throw new Error('Pick who to send it to.');
        state.sending = true;
        renderComposer(v);
        await api('/api/post', { ref, type: postType(v, d), to, reply_to: d.replyTo, body: d.body });
        done = d.replyTo ? 'Reply sent' : 'Posted';
      }
      // Points belong to a review: only a sent review spends them.
      const reviewed = kind === 'approve' || kind === 'changes_requested';
      Object.assign(d, { body: '', replyTo: null, to: null, error: '', ...(reviewed ? { points: [] } : {}) });
      ta.value = '';
      autosize(ta);
      toast(done);
      state.sending = false;
      state.firstPaint = false;
      await refresh();
      const box = $('#msgs');
      if (box) box.scrollTop = box.scrollHeight;
    } catch (e) {
      d.error = e.message;
      if (e.code === 'permission' || e.code === 'conflict') refresh();
    } finally {
      state.sending = false;
      if (state.thread && state.route.ref === ref) {
        ['c-top', 'c-gate', 'c-extra'].forEach((id) => {
          const el = $(`#${id}`);
          clearHtml(el);
        });
        renderComposer(state.thread);
      }
    }
  }

  /**
   * Close a notification turn (event, alert or report) you hold: post a short
   * note that replies to it. No command answers these turns, and a note is the
   * smallest write that closes one; it also closes your other notification
   * turns in that thread.
   */
  /** Answer a permission card: allow its (edited) rules and ask the agent to carry on, or decline. */
  async function permAction(id, action) {
    const v = state.thread;
    const m = v?.messages.find((x) => x.id === id);
    if (!v || !m || state.permBusy) return;
    const ref = `${v.team}/${v.thread.id}`;
    const ed = permEdit(m);
    ed.error = '';
    state.permBusy = true;
    renderThreadBody(v);
    try {
      if (action === 'deny') {
        await api('/api/permission', { ref, event: id, action: 'deny' });
        delete state.permEdits[id];
        toast('Not allowed');
      } else {
        const rules = ed.rules.map((x) => x.trim()).filter(Boolean);
        if (!rules.length) throw new Error('Name at least one rule to allow.');
        await api('/api/permission', { ref, event: id, action: 'allow', rules, scope: ed.team ? 'team' : 'thread', confirm: Boolean(ed.confirm) });
        delete state.permEdits[id];
        toast(`Allowed. ${displayName(v.thread.owner, v.thread)} carries on`);
      }
    } catch (e) {
      // A rule that reaches beyond reading: show why, and the button becomes "Allow anyway".
      if (e.code === 'confirm') ed.confirm = e.message;
      else ed.error = e.message;
    } finally {
      state.permBusy = false;
    }
    await refresh();
  }

  /** Add or remove a rule in the May run list (this thread's, or the team's). */
  async function allowAction(kind, rule, scope) {
    const v = state.thread;
    if (!v || state.permBusy) return;
    const ref = `${v.team}/${v.thread.id}`;
    const ed = (state.allowEdit[ref] ||= {});
    ed.error = '';
    const value = kind === 'add' ? String(ed.value || '').trim() : rule;
    if (!value) {
      ed.error = 'Type a rule, such as Bash(gcloud logging read:*).';
      paint($('#side'), sidePanel(v));
      return;
    }
    state.permBusy = true;
    try {
      await api('/api/allow', kind === 'add'
        ? { ref, add: [value], scope: ed.team ? 'team' : 'thread', confirm: Boolean(ed.confirm) }
        : { ref, remove: [value], scope });
      if (kind === 'add') {
        ed.value = '';
        ed.confirm = null;
      }
      toast(kind === 'add' ? `Allowed ${value}` : `Stopped allowing ${value}`);
    } catch (e) {
      if (e.code === 'confirm' && kind === 'add') ed.confirm = e.message;
      else ed.error = e.message;
    } finally {
      state.permBusy = false;
    }
    await refresh();
  }

  async function markHandled(ref, id, btn, member) {
    if (!ref || (!id && !member) || state.sending) return;
    state.sending = true;
    if (btn) btn.disabled = true;
    try {
      await api('/api/dismiss', { ref, ids: String(id || '').split(',').filter(Boolean), ...(member ? { member } : {}) });
      toast('Dismissed');
    } catch (e) {
      toast(e.message, true);
      if (btn) btn.disabled = false;
    } finally {
      state.sending = false;
    }
    await refresh();
  }

  // ---------------------------------------------------------------------------
  // Jumping around a thread
  // ---------------------------------------------------------------------------

  function flash(el) {
    el.classList.remove('flash');
    void el.offsetWidth;
    el.classList.add('flash');
  }

  function gotoMessage(id) {
    if (!id) return;
    const v = state.thread;
    const m = v?.messages.find((x) => x.id === id);
    if (!m) {
      toast('That message is in another thread', true);
      return;
    }
    if (state.route.tab !== 'chat') {
      location.hash = threadHash(v.team, v.thread.id, `?m=${encodeURIComponent(id)}`);
      return;
    }
    if (!shownInChat(m)) {
      state.revealed.add(id);
      renderThreadView($('#main'));
    }
    const el = document.getElementById(`m-${id}`);
    if (!el) return;
    el.scrollIntoView({ block: 'center', behavior: matchMedia('(prefers-reduced-motion: reduce)').matches ? 'auto' : 'smooth' });
    flash(el);
  }

  function findRef(id) {
    const v = state.thread;
    if (!v) return;
    const hits = v.messages.filter((m) => m.type !== 'event' && ((m.refs || []).includes(id) || m.task === id || m.issue === id || m.decision === id || (m.type === 'review' && v.issues.some((i) => i.id === id && i.source === m.id))));
    const target = hits[hits.length - 1] || v.messages.filter((m) => (m.refs || []).includes(id)).pop();
    if (target) gotoMessage(target.id);
    else toast(`No message mentions ${id} yet`);
  }

  // ---------------------------------------------------------------------------
  // Events
  // ---------------------------------------------------------------------------

  let toastTimer = null;
  /** Clipboard API on the loopback board; a hidden textarea where it is missing. */
  function copyText(text) {
    if (navigator.clipboard?.writeText) return navigator.clipboard.writeText(text);
    return new Promise((resolve, reject) => {
      const ta = document.createElement('textarea');
      ta.value = text;
      ta.setAttribute('readonly', '');
      ta.style.position = 'fixed';
      ta.style.opacity = '0';
      document.body.append(ta);
      ta.select();
      const ok = document.execCommand('copy');
      ta.remove();
      if (ok) resolve();
      else reject(new Error('copy failed'));
    });
  }

  function toast(text, bad = false) {
    const el = $('#toast');
    el.textContent = text;
    el.classList.toggle('bad', bad);
    el.classList.add('on');
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => el.classList.remove('on'), 2400);
  }

  function applyTheme() {
    const t = state.theme;
    if (t === 'light' || t === 'dark') document.documentElement.dataset.theme = t;
    else delete document.documentElement.dataset.theme;
  }

  function focusComposer() {
    const ta = $('#c-body');
    if (ta) {
      ta.focus();
      ta.setSelectionRange(ta.value.length, ta.value.length);
    }
  }

  document.addEventListener('click', (e) => {
    // A click anywhere outside an open team menu (or its ⋯ button) closes it, then acts as usual.
    if (state.teamMenu && !(e.target instanceof Element && e.target.closest('.team-menu, [data-act="team-menu"]'))) {
      state.teamMenu = null;
      state.confirmArchive = null;
      paintTeams();
    }
    const el = e.target.closest('[data-act]');
    if (!el || el.tagName === 'SELECT' || (el.tagName === 'INPUT' && el.type === 'checkbox')) return;
    const act = el.dataset.act;
    const ref = state.route?.ref;
    switch (act) {
      case 'proc-stop': {
        const key = el.dataset.id;
        if (state.confirmStop === key) {
          procAction({ action: 'stop-autopilot' });
          break;
        }
        // A second click within a few seconds stops it: one stray click never does.
        state.confirmStop = key;
        paint($('#rail-running'), railRunning());
        setTimeout(() => {
          if (state.confirmStop !== key) return;
          state.confirmStop = null;
          paint($('#rail-running'), railRunning());
        }, 4000);
        break;
      }
      case 'refresh':
        refresh();
        break;
      case 'revalidate':
        state.health = null;
        renderMain();
        loadHealth().then(() => {
          renderMain();
          renderRailFoot();
        });
        break;
      case 'offer':
        state.offer = el.dataset.choice === 'yes' ? 'yes' : 'no';
        LS.set('observability', state.offer);
        if (state.thread) paint($('#t-offer'), offerCard(state.thread));
        break;
      case 'notify':
        toggleNotify();
        break;
      case 'jump-open':
        openJump();
        break;
      case 'jump-close':
        if (e.target === el) closeJump();
        break;
      case 'jump-go': {
        e.preventDefault();
        const x = state.jump?.items?.[Number(el.dataset.i)];
        if (x) jumpGo(x);
        break;
      }
      case 'theme':
        state.theme = state.theme === 'system' ? 'light' : state.theme === 'light' ? 'dark' : 'system';
        LS.set('theme', state.theme);
        applyTheme();
        renderRailFoot();
        break;
      case 'toggle-team': {
        const t = el.dataset.team;
        if (state.collapsed.has(t)) state.collapsed.delete(t);
        else state.collapsed.add(t);
        LS.set('collapsed', [...state.collapsed]);
        renderRail();
        break;
      }
      case 'board-team':
        state.boardTeam = el.dataset.team || '';
        LS.set('boardTeam', state.boardTeam);
        renderMain();
        break;
      case 'copy-prompt': {
        const text = kickoffPrompt(el.dataset.member, el.dataset.ref);
        copyText(text).then(
          () => toast(`Prompt for ${displayName(el.dataset.member, threadByRef(el.dataset.ref))} copied: paste it into a fresh session`),
          () => toast('Could not copy; hover the item to see the prompt', true),
        );
        break;
      }
      case 'copy-resume':
        copyText(el.dataset.cmd).then(() => toast('Copied: paste it in a terminal'), () => toast('Could not copy; hover the button to see the command', true));
        break;
      case 'goto-msg':
        e.preventDefault();
        if (state.sideOpen) {
          state.sideOpen = false;
          $('#side')?.classList.remove('open');
        }
        gotoMessage(el.dataset.id);
        break;
      case 'ref':
        e.preventDefault();
        if (state.sideOpen) {
          state.sideOpen = false;
          $('#side')?.classList.remove('open');
        }
        findRef(el.dataset.ref);
        break;
      case 'find-report': {
        const m = state.thread?.messages.filter((x) => x.type === 'report' && x.report === el.dataset.file).pop();
        if (m) gotoMessage(m.id);
        break;
      }
      case 'open-side':
        state.sideOpen = true;
        $('#side')?.classList.add('open');
        break;
      case 'close-side':
        state.sideOpen = false;
        $('#side')?.classList.remove('open');
        break;
      case 'reply': {
        const v = state.thread;
        const m = v?.messages.find((x) => x.id === el.dataset.id);
        if (!m) break;
        const d = draft(ref);
        d.replyTo = m.id;
        if (m.from !== 'you' && m.from !== 'factory') d.to = uniq([m.from]);
        ['c-top', 'c-extra'].forEach((id) => clearHtml($(`#${id}`)));
        renderComposer(v);
        focusComposer();
        break;
      }
      case 'clear-reply': {
        const d = draft(ref);
        d.replyTo = null;
        clearHtml($('#c-top'));
        renderComposer(state.thread);
        break;
      }
      case 'to': {
        const d = draft(ref);
        const id = el.dataset.id;
        const cur = postTo(state.thread.thread, d);
        d.to = cur.includes(id) ? cur.filter((x) => x !== id) : [...cur, id];
        el.classList.toggle('on', d.to.includes(id));
        el.setAttribute('aria-pressed', String(d.to.includes(id)));
        paint($('#c-foot'), composerFoot(state.thread, d));
        break;
      }
      case 'skip-gate': {
        const th = state.thread?.thread;
        if (!th) break;
        const key = `${th.team}/${th.id}:${el.dataset.gate}`;
        if (state.confirmSkip !== key) {
          state.confirmSkip = key;
          paint($('#c-gate'), gateStrip(th, draft(ref)), { fields: 'keep' });
          break;
        }
        state.confirmSkip = null;
        skipGate(ref, el.dataset.gate, el);
        break;
      }
      case 'skip-gate-cancel':
        state.confirmSkip = null;
        if (state.thread?.thread) paint($('#c-gate'), gateStrip(state.thread.thread, draft(ref)), { fields: 'keep' });
        break;
      case 'add-point': {
        const d = draft(ref);
        d.points.push({ severity: 'medium', text: '' });
        setHtml($('#c-extra'), composerExtra(state.thread.thread, d));
        const inputs = document.querySelectorAll('#c-extra input[data-input="point"]');
        inputs[inputs.length - 1]?.focus();
        break;
      }
      case 'drop-point': {
        const d = draft(ref);
        d.points.splice(Number(el.dataset.i), 1);
        setHtml($('#c-extra'), composerExtra(state.thread.thread, d));
        break;
      }
      case 'review':
        send(el.dataset.verdict);
        break;
      case 'handled':
        e.preventDefault();
        markHandled(el.dataset.ref || ref, el.dataset.id, el, el.dataset.member);
        break;
      case 'perm-allow':
        permAction(el.dataset.id, 'allow');
        break;
      case 'perm-deny':
        permAction(el.dataset.id, 'deny');
        break;
      case 'allow-add':
        allowAction('add');
        break;
      case 'allow-remove':
        allowAction('remove', el.dataset.rule, el.dataset.scope);
        break;
      case 'send':
        send('post');
        break;
      case 'nf-open':
        if (state.teamMenu) {
          state.teamMenu = null;
          state.confirmArchive = null;
          paintTeams();
        }
        openNewThread(el.dataset.team || '');
        break;
      case 'msg-more': {
        const id = el.dataset.id;
        if (state.unfolded.has(id)) state.unfolded.delete(id);
        else state.unfolded.add(id);
        if (state.thread) renderThreadBody(state.thread);
        break;
      }
      case 'toggle-archived':
        state.showArchived = !state.showArchived;
        LS.set('showArchived', state.showArchived);
        paintTeams();
        break;
      case 'team-restore':
        if (!state.restoring) restoreTeam(el.dataset.name);
        break;
      case 'team-menu':
        state.teamMenu = state.teamMenu === el.dataset.team ? null : el.dataset.team;
        state.confirmArchive = null;
        paintTeams();
        break;
      case 'team-archive': {
        const id = el.dataset.team;
        if (state.confirmArchive !== id) {
          state.confirmArchive = id;
          paintTeams();
          setTimeout(() => {
            if (state.confirmArchive !== id) return;
            state.confirmArchive = null;
            paintTeams();
          }, 4000);
          break;
        }
        state.confirmArchive = null;
        state.teamMenu = null;
        paintTeams();
        archiveTeam(id);
        break;
      }
      case 'nf-issue':
        loadIssue();
        break;
      case 'nf-close':
        closeNewThread();
        break;
      case 'nf-backdrop':
        // Only a click that started and ended on the dim backdrop closes it: never one inside the dialog.
        if (e.target === el && state.nfDownOnBackdrop) closeNewThread();
        break;
      case 'nf-start':
        startNewThread();
        break;
      default:
        break;
    }
  });

  document.addEventListener('mousedown', (e) => {
    state.nfDownOnBackdrop = e.target instanceof Element && e.target.classList.contains('modal-backdrop');
  });

  document.addEventListener('change', (e) => {
    const el = e.target;
    if (el.dataset?.new && state.newThread) {
      const box = el.type === 'checkbox';
      setNew(el.dataset.new, box ? el.checked : el.value);
      if (box) state.newThread.error = '';
      if (el.tagName === 'SELECT' || box) renderModal(true);
      return;
    }
    const act = el.dataset?.act;
    if (!act) return;
    const ref = state.route?.ref;
    switch (act) {
      case 'filter':
        state.filter = el.value;
        LS.set('member', state.filter);
        el.blur();
        render();
        if (state.route.name === 'inbox') refresh();
        break;
      case 'inbox-member':
        location.hash = `#/inbox/${encodeURIComponent(el.value)}`;
        break;
      case 'point-sev':
        draft(ref).points[Number(el.dataset.i)].severity = el.value;
        break;
      case 'perm-team': {
        const m = state.thread?.messages.find((x) => x.id === el.dataset.id);
        if (m) permEdit(m).team = el.checked;
        break;
      }
      case 'allow-team':
        (state.allowEdit[el.dataset.ref] ||= {}).team = el.checked;
        break;
      default:
        break;
    }
  });

  document.addEventListener('input', (e) => {
    const el = e.target;
    if (el.id === 'jump-input' && state.jump) {
      state.jump.q = el.value;
      state.jump.i = 0;
      setHtml($('#jump-list'), jumpList());
      return;
    }
    if (el.dataset?.new && state.newThread) {
      setNew(el.dataset.new, el.value);
      state.newThread.error = '';
      return;
    }
    // A permission card's rule, or the May run add box: kept in state, and an edit asks for confirmation afresh.
    if (el.dataset?.perm) {
      const m = state.thread?.messages.find((x) => x.id === el.dataset.perm);
      if (m) {
        const ed = permEdit(m);
        ed.rules[Number(el.dataset.i)] = el.value;
        ed.confirm = null;
      }
      return;
    }
    if (el.dataset?.allow) {
      const ed = (state.allowEdit[el.dataset.allow] ||= {});
      ed.value = el.value;
      ed.confirm = null;
      return;
    }
    const k = el.dataset?.input;
    if (!k || !state.route?.ref) return;
    const d = draft(state.route.ref);
    if (k === 'body') {
      d.body = el.value;
      autosize(el);
    } else if (k === 'point') d.points[Number(el.dataset.i)].text = el.value;
    if (d.error) {
      d.error = '';
      $('#c-error').textContent = '';
    }
  });

  // ---- images in the composer ----------------------------------------------

  const IMAGE_TYPES = new Set(['image/png', 'image/jpeg', 'image/gif', 'image/webp']);
  const MAX_IMAGE_BYTES = 10 * 1024 * 1024;

  function insertAtCursor(ta, text) {
    const start = ta.selectionStart ?? ta.value.length;
    const end = ta.selectionEnd ?? start;
    const before = ta.value.slice(0, start);
    const after = ta.value.slice(end);
    const lead = before && !before.endsWith('\n') ? '\n' : '';
    const tail = after.startsWith('\n') ? '' : '\n';
    ta.value = `${before}${lead}${text}${tail}${after}`;
    const at = (before + lead + text + tail).length;
    ta.setSelectionRange(at, at);
    ta.focus();
  }

  const fileBase64 = (f) => new Promise((resolve, reject) => {
    const r = new FileReader();
    r.onload = () => resolve(String(r.result).replace(/^data:[^,]*,/, ''));
    r.onerror = () => reject(r.error || new Error('could not read the file'));
    r.readAsDataURL(f);
  });

  /** Save each image with the thread (POST /api/attach), then write it into the message as Markdown. */
  async function attachImages(files) {
    const ref = state.route?.ref;
    const ta = $('#c-body');
    const box = $('#composer');
    if (!ref || !ta || !box || box.hidden) return;
    const d = draft(ref);
    const say = (text) => {
      d.error = text;
      $('#c-error').textContent = text;
    };
    const list = [...files];
    const imgs = list.filter((f) => IMAGE_TYPES.has(f.type));
    if (!imgs.length) return say('Only images go in a message: PNG, JPEG, GIF or WebP.');
    say('');
    for (const f of imgs) {
      if (f.size > MAX_IMAGE_BYTES) {
        say(`${f.name || 'That image'} is over 10 MB.`);
        continue;
      }
      try {
        box.classList.add('uploading');
        const out = await api('/api/attach', { ref, type: f.type, name: f.name || 'pasted image', data: await fileBase64(f) });
        insertAtCursor(ta, out.markdown);
        d.body = ta.value;
        autosize(ta);
      } catch (e) {
        say(e.message);
      } finally {
        box.classList.remove('uploading');
      }
    }
    if (imgs.length < list.length) say('Only the images were added: PNG, JPEG, GIF or WebP.');
  }

  // Drop an image anywhere on a thread's chat, or paste one into the message box.
  const canDrop = () => Boolean(state.route?.ref) && $('#composer') && !$('#composer').hidden;
  const draggingFiles = (e) => [...(e.dataTransfer?.types || [])].includes('Files');
  let dropTimer = null;
  document.addEventListener('dragover', (e) => {
    if (!draggingFiles(e) || !canDrop()) return;
    e.preventDefault();
    e.dataTransfer.dropEffect = 'copy';
    $('#composer').classList.add('drop');
    clearTimeout(dropTimer);
    dropTimer = setTimeout(() => $('#composer')?.classList.remove('drop'), 200);
  });
  document.addEventListener('drop', (e) => {
    if (!draggingFiles(e) || !canDrop()) return;
    e.preventDefault();
    $('#composer').classList.remove('drop');
    attachImages(e.dataTransfer.files);
  });
  document.addEventListener('paste', (e) => {
    if (!e.target?.closest?.('#composer')) return;
    const files = [...(e.clipboardData?.files || [])].filter((f) => IMAGE_TYPES.has(f.type));
    if (!files.length) return;
    e.preventDefault();
    attachImages(files);
  });

  document.addEventListener('keydown', (e) => {
    if ((IS_MAC ? e.metaKey : e.ctrlKey) && !e.shiftKey && !e.altKey && (e.key === 'k' || e.key === 'K')) {
      e.preventDefault();
      if (state.jump) closeJump();
      else openJump();
      return;
    }
    if (state.jump) {
      const n = state.jump.items?.length || 0;
      if ((e.key === 'ArrowDown' || e.key === 'ArrowUp') && n) {
        e.preventDefault();
        state.jump.i = (state.jump.i + (e.key === 'ArrowDown' ? 1 : n - 1)) % n;
        setHtml($('#jump-list'), jumpList());
        return;
      }
      if (e.key === 'Enter' && e.target?.id === 'jump-input') {
        e.preventDefault();
        const x = state.jump.items?.[state.jump.i];
        if (x) jumpGo(x);
        return;
      }
      if (e.key === 'Escape') {
        closeJump();
        return;
      }
    }
    if (e.key === 'Enter' && e.target?.id === 'nf-issue') {
      e.preventDefault();
      loadIssue();
      return;
    }
    if (e.key === 'Enter' && e.target?.id === 'allow-input') {
      e.preventDefault();
      allowAction('add');
      return;
    }
    if (e.key === 'Enter' && (e.metaKey || e.ctrlKey) && e.target.closest?.('#composer')) {
      e.preventDefault();
      // In the gate bar or a review point, the shortcut would post a plain note
      // and drop the points; a review is sent only with its verdict button.
      if (e.target.closest('#c-gate') || e.target.closest('[data-input="point"], [data-act="point-sev"]')) {
        const d = state.route?.ref ? draft(state.route.ref) : null;
        if (d) {
          d.error = POINTS_NEED_VERDICT;
          $('#c-error').textContent = d.error;
        }
        return;
      }
      send('post');
      return;
    }
    if (e.key === 'Escape') {
      if (state.newThread?.open) {
        closeNewThread();
        return;
      }
      if (state.teamMenu) {
        state.teamMenu = null;
        state.confirmArchive = null;
        paintTeams();
        return;
      }
      if (state.sideOpen) {
        state.sideOpen = false;
        $('#side')?.classList.remove('open');
        return;
      }
      if (e.target.closest?.('#composer') && state.route?.ref && draft(state.route.ref).replyTo) {
        draft(state.route.ref).replyTo = null;
        clearHtml($('#c-top'));
        renderComposer(state.thread);
      }
    }
  });

  window.addEventListener('hashchange', onRoute);
  document.addEventListener('scroll', (e) => {
    if (e.target instanceof Element && e.target.classList.contains('kanban')) edgeFade(e.target);
  }, true);
  window.addEventListener('resize', () => document.querySelectorAll('.kanban').forEach(edgeFade));
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'visible' && state.loaded) refresh();
  });

  // Relative times drift; repaint them once a minute without refetching.
  setInterval(() => {
    if (!state.loaded || document.visibilityState !== 'visible') return;
    renderRail();
    if (state.route.name === 'thread') {
      if (state.thread) {
        paint($('#t-banner'), banner(state.thread));
        paint($('#t-presence'), threadPresence(state.thread));
        paint($('#side'), sidePanel(state.thread), { fields: 'keep' });
        const box = $('#msgs');
        if (box) fillTimes(box);
      }
    } else renderMain();
  }, 60000);

  // ---------------------------------------------------------------------------
  // Start
  // ---------------------------------------------------------------------------

  // factory/test/ui.test.mjs runs this file in a VM with `__factoryUiTest` set:
  // it gets the pure helpers below and the page never starts.
  if (globalThis.__factoryUiTest) {
    Object.assign(globalThis.__factoryUiTest, { shownInChat, mdInline, md, rel, dayLabel, gateWait, waitingMembers, gateEntryTurns, pendingPoints, threadCtx, typeBlock, state, NOTIFY_TYPES, GATE_ENTRY, messageEntries, heldItems, permissionCard, allowEditor, offerCard, newForm, viewNew, sidePanel, usd, costRow, waitingOnYou, newlyWaiting, notifyWaiting, isUnread, markSeen, railTeams, jumpItems });
    return;
  }

  applyTheme();
  state.route = parseHash();
  if (state.route.name === 'thread') state.firstPaint = true;
  ensureRail();
  refresh().then(() => {
    if (!state.board && state.boardError) renderMain();
  });
  connectFeed();
})();
