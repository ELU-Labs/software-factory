#!/usr/bin/env node
// Board + Chat UI server for the software factory. Zero dependencies.
//
//   node tools/factory-ui/server.mjs [--root dir] [--port 4477] [--host 127.0.0.1] [--allow-host name,...]
//
// Files are the truth: every request opens a fresh store on the root. Reads are
// open to the page; writes are the owner's only (always `as: 'you'`), must carry
// `X-Factory-UI: 1`, and are refused when an Origin header names another site.
// Every request must name an allowed Host (the DNS-rebinding guard), on every
// bind. The board has no sign-in: binding anything but loopback makes it, and
// its owner-only writes, reachable from the network, so startServer warns.
// `GET /api/events` streams `event: change` whenever teams/ changes on disk.

import http from 'node:http';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import { CLAUDE_MODELS, OPENAI_MODELS } from '../../factory/lib/roles.mjs';
import { openStore, FactoryError, REVIEW_GATES, PRESENCE_DIR, AUTOPILOT_DIR, pidAlive, factoryProcesses, allowRuleProblem, allowRuleRisk, ATTACHMENT_PATH_RE, ATTACHMENT_TYPES, MAX_ATTACHMENT_BYTES } from '../../factory/lib/store.mjs';

const UI_DIR = path.dirname(fileURLToPath(import.meta.url));

const STATIC = {
  '/': ['index.html', 'text/html; charset=utf-8'],
  '/index.html': ['index.html', 'text/html; charset=utf-8'],
  '/app.js': ['app.js', 'text/javascript; charset=utf-8'],
  '/style.css': ['style.css', 'text/css; charset=utf-8'],
};

/** Message types the owner can post from the board (the rest record state through their own commands). */
export const UI_POST_TYPES = Object.freeze(['note', 'question', 'answer', 'decision', 'escalation', 'kickoff']);

// `confirm`: the request needs the owner to confirm it (a rule that reaches beyond reading); resend it with confirm: true.
const HTTP_STATUS = { usage: 400, invalid: 400, permission: 403, not_found: 404, conflict: 409, confirm: 409 };
const POLL_MS = 1500;
const HEARTBEAT_MS = 15000;
const MAX_BODY_BYTES = 1024 * 1024;
/** An image upload is base64 in JSON: a third larger than the image, plus the other fields. */
const MAX_ATTACH_BODY_BYTES = Math.ceil(MAX_ATTACHMENT_BYTES * 4 / 3) + 64 * 1024;
/** POST routes whose body may be larger than MAX_BODY_BYTES. */
const BODY_LIMITS = { '/api/attach': MAX_ATTACH_BODY_BYTES };
const LOOPBACK_NAMES = ['127.0.0.1', 'localhost', '[::1]'];
const WILDCARD_HOSTS = new Set(['0.0.0.0', '::', '[::]', '']);
const HOST_NAME_RE = /^(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?)(?:\.[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?)*$|^\[[0-9a-f:.]+\]$|^\d{1,3}(?:\.\d{1,3}){3}$/;

const SECURITY_HEADERS = {
  'X-Content-Type-Options': 'nosniff',
  'Referrer-Policy': 'no-referrer',
  'X-Frame-Options': 'DENY',
  'Cross-Origin-Opener-Policy': 'same-origin',
  'Cross-Origin-Resource-Policy': 'same-origin',
};
const CSP = [
  "default-src 'self'",
  "script-src 'self'",
  "style-src 'self' 'unsafe-inline'",
  "img-src 'self' data:",
  "connect-src 'self'",
  "font-src 'self'",
  "base-uri 'none'",
  "form-action 'none'",
  "frame-ancestors 'none'",
].join('; ');

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function sendJson(res, status, value) {
  const text = JSON.stringify(value);
  res.writeHead(status, {
    ...SECURITY_HEADERS,
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': 'no-store',
    'Content-Length': Buffer.byteLength(text),
  });
  res.end(text);
}

function sendError(res, status, code, message) {
  sendJson(res, status, { error: message, code });
}

function sendFactoryError(res, err) {
  if (err instanceof FactoryError || (err && typeof err.code === 'string' && err.code in HTTP_STATUS && err.name === 'FactoryError')) {
    return sendError(res, HTTP_STATUS[err.code] ?? 400, err.code, err.message);
  }
  return sendError(res, 500, 'internal', `the board server failed: ${err && err.message ? err.message : String(err)}`);
}

function readJsonBody(req, limit = MAX_BODY_BYTES) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    let done = false;
    req.on('data', (chunk) => {
      if (done) return;
      size += chunk.length;
      if (size > limit) {
        done = true;
        reject(new FactoryError('usage', `the request body is over ${limit} bytes`));
        req.resume();
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => {
      if (done) return;
      done = true;
      const text = Buffer.concat(chunks).toString('utf8').trim();
      if (!text) return resolve({});
      try {
        const value = JSON.parse(text);
        if (value === null || typeof value !== 'object' || Array.isArray(value)) {
          reject(new FactoryError('usage', 'the request body must be a JSON object'));
          return;
        }
        resolve(value);
      } catch (e) {
        reject(new FactoryError('usage', `the request body is not valid JSON (${e.message})`));
      }
    });
    req.on('error', (e) => {
      if (done) return;
      done = true;
      reject(e);
    });
  });
}

/** Optional string field from a JSON body. */
function str(v) {
  if (v == null) return undefined;
  const s = String(v);
  return s.trim() === '' ? undefined : s;
}

/** List field: an array of strings or a comma list. */
function list(v) {
  if (v == null || v === '') return [];
  if (Array.isArray(v)) return v.map((x) => String(x).trim()).filter(Boolean);
  return String(v).split(',').map((x) => x.trim()).filter(Boolean);
}

/**
 * A cheap signature of everything the board shows: file count, total size and
 * newest mtime under teams/, plus the roster. Writer locks and atomic-write
 * leftovers are ignored so a write in progress does not flicker. A `wait` that
 * dies changes no file, so the liveness of every watching agent is part of it.
 */
export function signature(root) {
  let count = 0;
  let size = 0;
  let newest = 0;
  const walk = (dir) => {
    let ents;
    try {
      ents = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const e of ents) {
      if (e.name === '.lock' || e.name.startsWith('.tmp-')) continue;
      // Agent run logs grow while a run streams; state.json says when a run starts or ends.
      if (path.basename(dir) === AUTOPILOT_DIR && (e.name === 'runs' || e.name.endsWith('.log'))) continue;
      const abs = path.join(dir, e.name);
      if (e.isDirectory()) {
        walk(abs);
        continue;
      }
      if (!e.isFile()) continue;
      let st;
      try {
        st = fs.statSync(abs);
      } catch {
        continue;
      }
      count += 1;
      size += st.size;
      if (st.mtimeMs > newest) newest = st.mtimeMs;
    }
  };
  walk(path.join(root, 'teams'));
  let alive = '';
  try {
    const dir = path.join(root, 'teams', PRESENCE_DIR);
    for (const name of fs.readdirSync(dir).sort()) {
      if (!name.endsWith('.json')) continue;
      try {
        const rec = JSON.parse(fs.readFileSync(path.join(dir, name), 'utf8'));
        if (rec && rec.state === 'watching') alive += pidAlive(rec.pid) ? '1' : '0';
        else if (rec && rec.wait) alive += pidAlive(rec.wait.pid) ? 'w1' : 'w0';
      } catch {
        // half-written or hand-edited: the next poll sees it whole
      }
    }
  } catch {
    // no presence yet
  }
  try {
    // The autopilot and its runs dying change no file, so their liveness is part of the signature.
    const rec = JSON.parse(fs.readFileSync(path.join(root, 'teams', AUTOPILOT_DIR, 'state.json'), 'utf8'));
    alive += `a${pidAlive(rec.pid) ? 1 : 0}`;
    for (const m of Object.values(rec.members || {})) {
      if (!m) continue;
      const list = [...Object.values(m.running_by_ref && typeof m.running_by_ref === 'object' ? m.running_by_ref : {}), ...(m.running ? [m.running] : [])];
      for (const r of list) if (r && typeof r === 'object') alive += pidAlive(r.pid) ? '1' : '0';
    }
  } catch {
    // no autopilot yet
  }
  try {
    const st = fs.statSync(path.join(root, 'factory', 'members.yaml'));
    size += st.size;
    if (st.mtimeMs > newest) newest = st.mtimeMs;
  } catch {
    // no roster yet: the board reports it
  }
  return `${count}:${size}:${Math.floor(newest)}:${alive}`;
}

// ---------------------------------------------------------------------------
// Access: which Host and Origin values the board answers to
// ---------------------------------------------------------------------------

/** A host as it appears in a Host header, lowercased: `[v6]` for IPv6 literals, zone ids dropped. */
function hostLiteral(h) {
  let s = String(h ?? '').trim().toLowerCase();
  if (s.startsWith('[') && s.endsWith(']')) s = s.slice(1, -1);
  if (!/^[0-9a-f:.]+(%.*)?$/.test(s) || !s.includes(':')) return s;
  return `[${s.replace(/%.*$/, '')}]`;
}

function isLoopbackName(h) {
  const s = hostLiteral(h);
  return s === 'localhost' || s === '[::1]' || /^127\.\d{1,3}\.\d{1,3}\.\d{1,3}$/.test(s);
}

/** This machine's names on a network bind: every interface address and the host name. */
function machineNames() {
  const out = [];
  for (const list of Object.values(os.networkInterfaces())) {
    for (const a of list || []) out.push(hostLiteral(a.address));
  }
  const hn = hostLiteral(os.hostname());
  if (hn) out.push(hn, ...(hn.endsWith('.local') ? [hn.slice(0, -'.local'.length)] : hn.includes('.') ? [] : [`${hn}.local`]));
  return out.filter(Boolean);
}

/** `--allow-host` values: host names or IP literals, without a port. */
function allowHostList(v) {
  const out = list(Array.isArray(v) ? v.join(',') : v).map(hostLiteral);
  for (const h of out) {
    if (!HOST_NAME_RE.test(h)) throw new FactoryError('usage', `--allow-host "${h}" is not a host name or IP address (give it without a port, for example --allow-host my-mac.local)`);
  }
  return out;
}

/**
 * Who the board answers to once it listens on `port`. Every request, on every
 * bind, must carry one of `hosts` (host:port) as its Host header: a page on
 * another site that rebinds its own name to this machine sends its own name and
 * is refused. Writes need an Origin from `origins` when one is sent, and must
 * send one when the bind is not loopback.
 * @param {{host?: string, port: number, allowHosts?: string[], names?: string[]}} options
 *   names: this machine's names for a network bind (default: its interfaces and host name)
 * @returns {{bind: string, loopback: boolean, wildcard: boolean, url: string, names: string[], hosts: Set<string>, origins: Set<string>}}
 */
export function boardAccess({ host = '127.0.0.1', port, allowHosts = [], names } = {}) {
  const bindHost = host == null ? '127.0.0.1' : String(host);
  const wildcard = WILDCARD_HOSTS.has(bindHost);
  const bind = wildcard ? (bindHost.includes(':') ? '[::]' : '0.0.0.0') : hostLiteral(bindHost);
  const loopback = !wildcard && isLoopbackName(bindHost);
  const extra = allowHostList(allowHosts);
  const machine = loopback ? [] : (names ?? machineNames()).map(hostLiteral);
  const all = [...new Set([...(wildcard ? [] : [bind]), ...(loopback || wildcard ? LOOPBACK_NAMES : []), ...machine, ...extra])].filter(Boolean);
  const hostports = all.flatMap((n) => (port === 80 ? [`${n}:${port}`, n] : [`${n}:${port}`]));
  const shown = wildcard ? '127.0.0.1' : bind;
  return {
    bind,
    loopback,
    wildcard,
    url: `http://${shown}:${port}`,
    names: all,
    hosts: new Set(hostports),
    origins: new Set(hostports.map((h) => `http://${h}`)),
  };
}

/** The startup warning for a bind the network can reach (null on loopback). */
function exposureWarning(access, port) {
  if (access.loopback) return null;
  const v6 = (n) => n.startsWith('[');
  const shown = [...access.names.filter((n) => !v6(n)), ...access.names.filter(v6)].slice(0, 8);
  return [
    `factory-ui: warning: the board listens on ${access.bind}:${port}, so anyone who can reach this machine can open it.`,
    '  It has no sign-in, and every write from it acts as you: notes, reviews, gate decisions and sign-offs.',
    `  It answers only to the Host names ${shown.join(', ')}${access.names.length > shown.length ? ', …' : ''} (add one by starting the board with \`--allow-host <name>\`).`,
    '  Leave out --host (it defaults to 127.0.0.1) unless you mean this.',
  ].join('\n');
}

function parseArgs(argv) {
  const out = {};
  const usage = 'usage: node tools/factory-ui/server.mjs [--root dir] [--port 4477] [--host 127.0.0.1] [--allow-host name,...]';
  const set = (k, v) => {
    if (k === 'allow-host') out.allowHosts = [...(out.allowHosts || []), v];
    else if (k === 'root' || k === 'port' || k === 'host') out[k] = v;
    else throw new FactoryError('usage', `unknown argument "--${k}"; ${usage}`);
  };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--help' || a === '-h') out.help = true;
    else if (a.startsWith('--') && a.includes('=')) {
      const [k, ...rest] = a.slice(2).split('=');
      set(k, rest.join('='));
    } else if (a === '--root' || a === '--port' || a === '--host' || a === '--allow-host') {
      const v = argv[i + 1];
      if (v === undefined || v.startsWith('--')) throw new FactoryError('usage', `${a} needs a value`);
      set(a.slice(2), v);
      i += 1;
    } else {
      throw new FactoryError('usage', `unknown argument "${a}"; ${usage}`);
    }
  }
  return out;
}

function portOf(v, fallback) {
  if (v === undefined || v === null || v === '') return fallback;
  const n = Number(v);
  if (!Number.isInteger(n) || n < 0 || n > 65535) throw new FactoryError('usage', `--port must be a number from 0 to 65535 (got "${v}")`);
  return n;
}

// ---------------------------------------------------------------------------
// Server
// ---------------------------------------------------------------------------

/**
 * Start the board server. A bind other than loopback (for example `0.0.0.0` or
 * a LAN address) still answers only to this machine's own names, and prints a
 * warning through `warn` (stderr by default) because the board has no sign-in.
 * @param {{root?: string, port?: number, host?: string, allowHosts?: string[], warn?: (text: string) => void}} [options]
 *   port 0 picks a free port; allowHosts adds Host names the board answers to
 * @returns {Promise<{server: http.Server, url: string, bind: string, warning: string|null, close: () => Promise<void>}>}
 */
export function startServer({ root, port = 4477, host = '127.0.0.1', allowHosts = [], warn = (text) => process.stderr.write(`${text}\n`) } = {}) {
  const factoryRoot = openStore({ root }).root;
  const bindHost = host == null ? '127.0.0.1' : String(host);
  const wantPort = portOf(port, 4477);
  let access = boardAccess({ host: bindHost, port: wantPort, allowHosts });

  const clients = new Set();
  let pollTimer = null;
  let beatTimer = null;
  let lastSig = null;

  const broadcast = (text) => {
    for (const res of clients) {
      try {
        res.write(text);
      } catch {
        clients.delete(res);
      }
    }
  };

  const startFeed = () => {
    if (pollTimer) return;
    lastSig = signature(factoryRoot);
    pollTimer = setInterval(() => {
      const sig = signature(factoryRoot);
      if (sig === lastSig) return;
      lastSig = sig;
      broadcast(`event: change\ndata: ${JSON.stringify({ sig, ts: new Date().toISOString() })}\n\n`);
    }, POLL_MS);
    beatTimer = setInterval(() => broadcast(`: heartbeat ${new Date().toISOString()}\n\n`), HEARTBEAT_MS);
    pollTimer.unref?.();
    beatTimer.unref?.();
  };

  const stopFeed = () => {
    if (pollTimer) clearInterval(pollTimer);
    if (beatTimer) clearInterval(beatTimer);
    pollTimer = null;
    beatTimer = null;
  };

  const store = () => openStore({ root: factoryRoot });

  const writeGuard = (req) => {
    if (req.headers['x-factory-ui'] !== '1') {
      return 'writes from the board need the header X-Factory-UI: 1';
    }
    const origin = req.headers.origin;
    if (origin === undefined) {
      if (!access.loopback) return `the board listens on ${access.bind}, so writes are accepted only from the board page itself (the request has no Origin header)`;
    } else if (!access.origins.has(String(origin).toLowerCase())) {
      return `writes are only accepted from the board itself; Origin ${origin} is not ${access.url}`;
    }
    const site = req.headers['sec-fetch-site'];
    if (site && site !== 'same-origin' && site !== 'none') return `writes are only accepted from the board itself (Sec-Fetch-Site: ${site})`;
    return null;
  };

  const CLI = fileURLToPath(new URL('../../factory/bin/factory.mjs', import.meta.url));
  const realRoot = (r) => {
    try {
      return fs.realpathSync(path.resolve(r));
    } catch {
      return path.resolve(r);
    }
  };
  const processList = () => {
    const here = realRoot(factoryRoot);
    const ap = store().autopilot();
    const scan = factoryProcesses();
    const list = (scan || []).map((p) => {
      // This root's autopilot is the one its state names, however it was started.
      const main = p.kind === 'autopilot' && ap.alive && p.pid === ap.pid;
      return { ...p, here: main || (p.root != null && realRoot(p.root) === here), self: p.pid === process.pid, main };
    });
    return { generated: new Date().toISOString(), root: factoryRoot, list, scan_failed: scan == null };
  };
  /** Runs `factory autopilot <flag>` for this root, as the owner would. */
  const autopilotCli = (...flags) => {
    const env = { ...process.env };
    delete env.FACTORY_ACTOR;
    const r = spawnSync(process.execPath, [CLI, 'autopilot', ...flags, '--root', factoryRoot, '--json'], { env, encoding: 'utf8', timeout: 20000 });
    let out = null;
    try {
      out = JSON.parse(r.stdout);
    } catch {
      out = null;
    }
    if (r.status !== 0 || !out) throw new FactoryError('conflict', (r.stderr || r.stdout || `autopilot ${flags.join(' ')} failed`).trim().split('\n').pop());
    return out;
  };

  const GET_ROUTES = {
    '/api/board': () => store().board(),
    // What the New thread form offers: the models a Claude role runs on, OpenAI's models, and the agents of each role.
    '/api/thread/options': () => {
      const roster = store().members();
      const byRole = (r) => roster.filter((m) => m.kind === 'agent' && m.role === r).map((m) => ({ id: m.id, name: m.name }));
      return {
        models: CLAUDE_MODELS.map((m) => ({ id: m.id, name: m.name })),
        openai_models: OPENAI_MODELS.map((m) => ({ id: m.id, name: m.name })),
        leads: byRole('lead'),
        builders: byRole('builder'),
        solo: roster.filter((m) => m.kind === 'agent' && m.role === 'solo' && m.launch === 'claude').map((m) => ({ id: m.id, name: m.name, model: m.model || null })),
      };
    },
    '/api/thread': (q) => {
      const ref = str(q.get('ref'));
      if (!ref) throw new FactoryError('usage', 'name the thread: /api/thread?ref=<team>/<thread>');
      return store().threadView(ref);
    },
    '/api/inbox': (q) => {
      const s = store();
      const member = str(q.get('member')) || 'you';
      s.member(member);
      return { member, generated: new Date().toISOString(), turns: s.openTurns({ member }) };
    },
    '/api/validate': () => store().validate(),
    // What runs on this machine: this root's autopilot, and leftover autopilots or boards (other roots, extra copies).
    '/api/processes': () => processList(),
    // Lets `factory ui` find a board that is already running for this root.
    '/api/info': () => ({ app: 'factory-board', root: factoryRoot, pid: process.pid, url: access.url }),
  };

  /** Permission rules from a request body: an array of strings (a rule may hold commas), each a usable rule. */
  const rulesIn = (v, what) => {
    if (v == null) return [];
    if (!Array.isArray(v)) throw new FactoryError('usage', `${what}: a list of permission rules, such as ["Bash(gcloud logging read:*)"]`);
    const out = [...new Set(v.map((x) => String(x ?? '').trim()).filter(Boolean))];
    for (const x of out) {
      const why = allowRuleProblem(x);
      if (why) throw new FactoryError('usage', `${x}: ${why}`);
    }
    return out;
  };
  /** A rule that reaches beyond reading needs the owner's explicit second click (confirm: true). */
  const requireConfirm = (rules, b) => {
    const risky = rules.map((rule) => ({ rule, risk: allowRuleRisk(rule) })).filter((x) => x.risk);
    if (risky.length && b.confirm !== true) {
      throw new FactoryError('confirm', `${risky.map((x) => `${x.rule}: ${x.risk.text}.`).join(' ')} Allow anyway?`);
    }
  };
  const soloThread = (s, ref) => {
    const th = s.thread(ref);
    if (th.kind !== 'solo') throw new FactoryError('usage', `${th.team}/${th.id} is a ${th.kind} thread; allowed commands apply to single-agent threads only`);
    return th;
  };
  const codeSpan = (x) => (String(x).includes('`') ? `\`\` ${x} \`\`` : `\`${x}\``);

  /** A short id from a title: lowercase words joined by dashes, at most 4 words and 41 characters. */
  const slugOf = (title, fallback) => {
    const words = String(title || '').toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim().split(' ').filter(Boolean).slice(0, 4);
    const s = words.join('-').slice(0, 38).replace(/-+$/, '');
    return s || fallback;
  };
  /** The first of base, base-2, base-3, ... that `taken` says is free. */
  const freeId = (base, taken) => {
    for (let i = 1; ; i++) {
      const id = i === 1 ? base : `${base}-${i}`;
      if (!taken(id)) return id;
    }
  };
  const exists = (fn) => {
    try {
      fn();
      return true;
    } catch {
      return false;
    }
  };

  const POST_ROUTES = {
    // Start a thread from the board (the + next to Teams or on a team): the thread,
    // then your request to its lead (a kickoff) or its agent (a question). The
    // autopilot starts whoever it is addressed to. A new team is created with it.
    '/api/thread/new': (b) => {
      const s = store();
      const title = str(b.title);
      const prompt = b.prompt == null ? '' : String(b.prompt).trim();
      if (!title) throw new FactoryError('usage', 'give the thread a title');
      if (!prompt) throw new FactoryError('usage', 'say what to do: it is the request the lead or agent starts from');
      const kind = str(b.kind) === 'solo' ? 'solo' : 'project';
      const newTeam = str(b.new_team);
      const teamId = newTeam ? freeId(slugOf(newTeam, 'team'), (x) => exists(() => s.team(x))) : str(b.team);
      if (!teamId) throw new FactoryError('usage', 'pick a team, or name a new one');
      if (!newTeam) s.team(teamId);
      const id = freeId(slugOf(title, 'thread'), (x) => exists(() => s.thread(`${teamId}/${x}`)));
      const ref = `${teamId}/${id}`;
      const roster = s.members();
      const roles = b.roles && typeof b.roles === 'object' && !Array.isArray(b.roles) ? b.roles : null;
      if (kind === 'solo') {
        const agent = str(b.agent) || undefined;
        const made = s.createThread({ as: 'you', ref, title, kind: 'solo', owner: agent, teamTitle: newTeam || undefined, ...(roles ? { roles } : {}) });
        const message = s.post({ as: 'you', ref, type: 'question', to: [made.thread.owner], body: prompt });
        return { ref, thread: made.thread, message: message.message };
      }
      // With roles, they pick the builders, the pair engineer and the review gate owners.
      // Without (an older board page), a project's lead and gate owners are members and you pick its builders.
      const builders = list(b.builders).filter((x) => roster.some((m) => m.id === x && m.role === 'builder'));
      const made = roles
        ? s.createThread({ as: 'you', ref, title, kind: 'project', roles, teamTitle: newTeam || undefined })
        : s.createThread({ as: 'you', ref, title, kind: 'project', members: ['you', ...builders], teamTitle: newTeam || undefined });
      const message = s.post({ as: 'you', ref, type: 'kickoff', to: [made.thread.lead], body: prompt });
      return { ref, thread: made.thread, message: message.message };
    },
    // Archive a team: its folder moves to teams/.archive/, nothing is deleted (store.archiveTeam).
    '/api/team/archive': (b) => {
      const id = str(b.team);
      if (!id) throw new FactoryError('usage', 'name the team to archive');
      return store().archiveTeam({ as: 'you', id });
    },
    '/api/team/restore': (b) => {
      const name = str(b.name);
      if (!name) throw new FactoryError('usage', 'name the archived team to restore');
      return store().restoreTeam({ as: 'you', name });
    },
    // Close a turn waiting on you without answering it: a hidden note that resolves just that turn.
    '/api/dismiss': (b) => store().dismiss({ as: 'you', ref: str(b.ref), ids: list(b.ids ?? b.id), member: str(b.member) || undefined }),
    // An image dropped or pasted into the composer: saved beside the team's messages; the reply carries its markdown.
    '/api/attach': (b) => store().attach({ as: 'you', ref: str(b.ref), type: str(b.type), name: str(b.name), data: typeof b.data === 'string' ? b.data : '' }),
    '/api/post': (b) => {
      const type = str(b.type) || 'note';
      if (!UI_POST_TYPES.includes(type)) {
        throw new FactoryError('usage', `the board posts ${UI_POST_TYPES.join(', ')}; a ${type} is recorded by its own factory command`);
      }
      return store().post({
        as: 'you',
        ref: str(b.ref),
        type,
        to: list(b.to),
        cc: list(b.cc),
        reply_to: str(b.reply_to) ?? null,
        resolves: list(b.resolves),
        refs: list(b.refs),
        internal: false,
        body: b.body == null ? '' : String(b.body),
      });
    },
    '/api/review': (b) => {
      const s = store();
      const ref = str(b.ref);
      const th = s.thread(ref);
      const g = th.phase;
      if (th.kind !== 'project' || !REVIEW_GATES.includes(g) || th.gates?.[g]?.by !== 'you') {
        const mine = th.kind === 'project' ? REVIEW_GATES.filter((x) => th.gates?.[x]?.by === 'you') : [];
        const owner = th.kind === 'project' && REVIEW_GATES.includes(g) ? th.gates?.[g]?.by : null;
        throw new FactoryError('permission', `${th.team}/${th.id} is in ${g}${owner ? `, a gate ${owner} reviews` : ''}; the board reviews only gates you own (${mine.join(', ') || 'none'}) while the thread is in them — use a decision to override another gate`);
      }
      const points = Array.isArray(b.points)
        ? b.points.filter((p) => p && String(p.text ?? '').trim()).map((p) => ({ severity: String(p.severity ?? '').trim(), text: String(p.text) }))
        : [];
      return s.review({ as: 'you', ref, verdict: str(b.verdict), points, body: b.body == null ? '' : String(b.body) });
    },
    // Start or stop this root's autopilot, or stop a leftover factory process listed by /api/processes.
    '/api/process': (b) => {
      const action = str(b.action);
      if (action === 'start') return autopilotCli('--detach');
      // The Stop button on a run left going: this root's autopilot and its runs. A stop by pid leaves the runs going.
      if (action === 'stop-autopilot') return autopilotCli('--stop', '--runs');
      if (action !== 'stop') throw new FactoryError('usage', 'action is start, stop-autopilot or stop (with a pid)');
      const pid = Number(b.pid);
      if (!Number.isInteger(pid) || pid <= 0) throw new FactoryError('usage', 'pid: the process to stop');
      const ap = store().autopilot();
      if (ap.alive && pid === ap.pid) return autopilotCli('--stop');
      const { list, scan_failed: failed } = processList();
      if (failed) throw new FactoryError('conflict', 'could not list the running processes (ps failed); try again');
      const p = list.find((x) => x.pid === pid);
      if (!p) throw new FactoryError('not_found', `pid ${b.pid} is not a factory autopilot or board running on this machine`);
      if (p.self) throw new FactoryError('usage', 'that is this board; stop it with `node factory/bin/factory.mjs ui --stop`');
      try {
        process.kill(pid, 'SIGTERM');
      } catch (err) {
        if (err.code === 'ESRCH') return { stopped: pid, kind: p.kind, root: p.root };
        throw new FactoryError('conflict', `could not stop pid ${pid}: ${err.code || err.message}`);
      }
      return { stopped: pid, kind: p.kind, root: p.root };
    },
    // Change what a single-agent thread's agent may run: this thread's own rules, or (scope: team) every single-agent thread of its team.
    '/api/allow': (b) => {
      const s = store();
      const th = soloThread(s, str(b.ref));
      const add = rulesIn(b.add, 'add');
      const remove = [...new Set((Array.isArray(b.remove) ? b.remove : []).map((x) => String(x ?? '').trim()).filter(Boolean))];
      if (!add.length && !remove.length) throw new FactoryError('usage', 'name a rule to add or remove');
      requireConfirm(add, b);
      if (b.scope === 'team') s.editTeam({ as: 'you', id: th.team, allowAdd: add, allowRemove: remove });
      else s.setThreadConfig({ as: 'you', ref: `${th.team}/${th.id}`, allowAdd: add, allowRemove: remove });
      return { team: s.teamAllow(th.team), thread: s.thread(`${th.team}/${th.id}`).allow || [] };
    },
    // Answer a permission card (a permission_denied event): allow its rules and ask the agent to carry on, or decline them.
    '/api/permission': (b) => {
      const s = store();
      const th = soloThread(s, str(b.ref));
      const ref = `${th.team}/${th.id}`;
      const ev = s.message(str(b.event));
      if (ev.thread !== th.id || ev.team !== th.team || ev.type !== 'event' || ev.event?.kind !== 'permission_denied') {
        throw new FactoryError('not_found', `${b.event} is not a permission request in ${ref}`);
      }
      const action = str(b.action);
      if (action === 'deny') {
        const asked = (ev.event.rules || []).map((r) => (typeof r === 'string' ? r : r?.rule)).filter(Boolean);
        // A note to nobody: it records the answer and closes the card without starting the agent.
        return s.post({ as: 'you', ref, type: 'note', to: [], refs: [ev.id], body: `Not allowed: ${asked.map(codeSpan).join(', ') || 'the refused commands'}.` });
      }
      if (action !== 'allow') throw new FactoryError('usage', 'action is allow or deny');
      const rules = rulesIn(b.rules, 'rules');
      if (!rules.length) throw new FactoryError('usage', 'name at least one rule to allow');
      requireConfirm(rules, b);
      const team = b.scope === 'team';
      const have = new Set(team ? s.teamAllow(th.team) : th.allow || []);
      const add = rules.filter((x) => !have.has(x));
      if (add.length && team) s.editTeam({ as: 'you', id: th.team, allowAdd: add });
      else if (add.length) s.setThreadConfig({ as: 'you', ref, allowAdd: add });
      const where = team ? `for every single-agent thread in ${s.team(th.team).title}` : 'on this thread';
      const turns = (ev.event.turns || []).filter((x) => typeof x === 'string');
      // A request to the thread's agent: the autopilot starts it, and its run reads the new list.
      const posted = s.post({
        as: 'you', ref, type: 'question', to: [th.owner], refs: [ev.id, ...turns],
        body: `Allowed ${rules.map(codeSpan).join(', ')} ${where}. Carry on with what I asked before; your next run can use ${rules.length === 1 ? 'it' : 'them'}.`,
      });
      return { ...posted, allowed: rules, scope: team ? 'team' : 'thread' };
    },
    '/api/decide': (b) => store().decide({
      as: 'you',
      ref: str(b.ref),
      title: str(b.title),
      body: b.body == null ? '' : String(b.body),
      reply_to: str(b.reply_to) ?? null,
      resolves: list(b.resolves),
      refs: list(b.refs),
      gate: str(b.gate),
      verdict: str(b.verdict),
    }),
  };

  const serveStatic = (res, pathname, method) => {
    const [file, type] = STATIC[pathname];
    let body;
    try {
      body = fs.readFileSync(path.join(UI_DIR, file));
    } catch {
      return sendError(res, 404, 'not_found', `${file} is missing from tools/factory-ui`);
    }
    res.writeHead(200, {
      ...SECURITY_HEADERS,
      'Content-Type': type,
      'Cache-Control': 'no-cache',
      'Content-Length': body.length,
      ...(file === 'index.html' ? { 'Content-Security-Policy': CSP } : {}),
    });
    res.end(method === 'HEAD' ? undefined : body);
  };

  const serveEvents = (req, res) => {
    res.writeHead(200, {
      ...SECURITY_HEADERS,
      'Content-Type': 'text/event-stream; charset=utf-8',
      'Cache-Control': 'no-cache, no-transform',
      Connection: 'keep-alive',
      'X-Accel-Buffering': 'no',
    });
    res.flushHeaders?.();
    clients.add(res);
    startFeed();
    res.write(`retry: 2000\nevent: hello\ndata: ${JSON.stringify({ sig: lastSig, root: factoryRoot, ts: new Date().toISOString() })}\n\n`);
    const drop = () => {
      clients.delete(res);
      if (!clients.size) stopFeed();
    };
    req.on('close', drop);
    res.on('error', drop);
  };

  const handler = async (req, res) => {
    let url;
    try {
      url = new URL(req.url || '/', 'http://board.local');
    } catch {
      return sendError(res, 400, 'usage', 'bad request URL');
    }
    if (!access.hosts.has(String(req.headers.host || '').toLowerCase())) {
      req.resume();
      const where = access.loopback ? [...access.hosts].join(', ') : `${access.url} or a name of this machine (more with \`--allow-host <name>\`)`;
      return sendError(res, 403, 'permission', `the board answers only on ${where} (Host was ${req.headers.host || 'missing'})`);
    }
    const { pathname } = url;
    const method = req.method || 'GET';
    try {
      if (STATIC[pathname]) {
        if (method !== 'GET' && method !== 'HEAD') return sendError(res, 405, 'usage', `${pathname} only answers GET`);
        return serveStatic(res, pathname, method);
      }
      if (pathname === '/favicon.ico') {
        res.writeHead(204, SECURITY_HEADERS);
        return res.end();
      }
      if (pathname === '/api/events') {
        if (method !== 'GET') return sendError(res, 405, 'usage', '/api/events only answers GET');
        return serveEvents(req, res);
      }
      if (pathname === '/api/attachment') {
        if (method !== 'GET') return sendError(res, 405, 'usage', '/api/attachment only answers GET');
        return serveAttachment(res, url.searchParams.get('path'));
      }
      if (GET_ROUTES[pathname]) {
        if (method !== 'GET') return sendError(res, 405, 'usage', `${pathname} only answers GET`);
        return sendJson(res, 200, GET_ROUTES[pathname](url.searchParams));
      }
      if (POST_ROUTES[pathname]) {
        if (method !== 'POST') return sendError(res, 405, 'usage', `${pathname} only answers POST`);
        const refused = writeGuard(req);
        if (refused) {
          req.resume();
          return sendError(res, 403, 'permission', refused);
        }
        const body = await readJsonBody(req, BODY_LIMITS[pathname]);
        return sendJson(res, 200, POST_ROUTES[pathname](body));
      }
      return sendError(res, 404, 'not_found', `no route ${method} ${pathname}`);
    } catch (err) {
      return sendFactoryError(res, err);
    }
  };

  /** An image a message carries: only teams/<team>/attachments/<id>.<ext> under this root, never another path. */
  const serveAttachment = (res, rel) => {
    const m = ATTACHMENT_PATH_RE.exec(String(rel || ''));
    if (!m) return sendError(res, 400, 'usage', 'path must be teams/<team>/attachments/<image file>');
    const type = Object.entries(ATTACHMENT_TYPES).find(([, ext]) => ext === m[3])?.[0];
    let bytes;
    try {
      bytes = fs.readFileSync(path.join(factoryRoot, 'teams', m[1], 'attachments', m[2]));
    } catch {
      return sendError(res, 404, 'not_found', `no image ${rel}`);
    }
    res.writeHead(200, {
      ...SECURITY_HEADERS,
      'Content-Type': type,
      'Content-Length': bytes.length,
      // Files are written once and never change.
      'Cache-Control': 'private, max-age=31536000, immutable',
      'Content-Security-Policy': "default-src 'none'; sandbox",
    });
    return res.end(bytes);
  };

  const server = http.createServer((req, res) => {
    handler(req, res).catch((err) => {
      try {
        sendFactoryError(res, err);
      } catch {
        res.destroy();
      }
    });
  });

  return new Promise((resolve, reject) => {
    const onError = (err) => {
      if (err.code === 'EADDRINUSE') reject(new FactoryError('conflict', `port ${wantPort} on ${bindHost} is already in use; pass --port <n> (or --port 0 for any free port)`));
      else if (err.code === 'EACCES') reject(new FactoryError('permission', `cannot listen on ${bindHost}:${wantPort} (${err.code})`));
      else reject(err);
    };
    server.once('error', onError);
    server.listen(wantPort, bindHost === '' ? undefined : bindHost.replace(/^\[(.*)\]$/, '$1'), () => {
      server.off('error', onError);
      const actualPort = server.address().port;
      access = boardAccess({ host: bindHost, port: actualPort, allowHosts });
      const { url } = access;
      const warning = exposureWarning(access, actualPort);
      if (warning) warn(warning);
      let closing = null;
      const close = () => {
        if (closing) return closing;
        closing = new Promise((done) => {
          stopFeed();
          for (const res of clients) {
            try {
              res.end();
            } catch {
              // already gone
            }
          }
          clients.clear();
          server.close(() => done());
          server.closeAllConnections?.();
        });
        return closing;
      };
      resolve({ server, url, bind: `${access.bind}:${actualPort}`, warning, close, root: factoryRoot });
    });
  });
}

// ---------------------------------------------------------------------------
// Command line
// ---------------------------------------------------------------------------

const isMain = (() => {
  try {
    return Boolean(process.argv[1]) && fs.realpathSync(process.argv[1]) === fs.realpathSync(fileURLToPath(import.meta.url));
  } catch {
    return false;
  }
})();

if (isMain) {
  (async () => {
    try {
      const args = parseArgs(process.argv.slice(2));
      if (args.help) {
        process.stdout.write([
          'Usage: node tools/factory-ui/server.mjs [--root dir] [--port 4477] [--host 127.0.0.1] [--allow-host name,...]',
          '',
          'Serves the factory Board and Chat UI. Writes from the page act as `you`, and the board has no sign-in,',
          'so keep the default loopback --host. Another --host (0.0.0.0, a LAN address) lets the network reach it;',
          'it still answers only to this machine\'s names, plus any --allow-host names.',
          '',
        ].join('\n'));
        return;
      }
      const { url, bind, warning, close, root } = await startServer({ root: args.root, port: portOf(args.port, 4477), host: args.host || '127.0.0.1', allowHosts: args.allowHosts || [] });
      process.stdout.write(`Factory board: ${url}  (root ${root}${warning ? `; listening on ${bind}` : ''}) — Ctrl-C to stop\n`);
      const stop = () => close().then(() => process.exit(0));
      process.on('SIGINT', stop);
      process.on('SIGTERM', stop);
    } catch (err) {
      process.stderr.write(`factory-ui: ${err && err.message ? err.message : err}\n`);
      process.exit(err instanceof FactoryError && err.code === 'usage' ? 2 : 1);
    }
  })();
}
