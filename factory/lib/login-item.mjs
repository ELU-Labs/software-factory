// The macOS login item that starts a factory board, and so its autopilot, when
// the owner logs in, so a restart of the machine leaves no agent waiting on
// nobody (`factory ui --at-login`). A launchd user agent in
// ~/Library/LaunchAgents: launchd loads it at every login and runs the board
// once. No KeepAlive: a board stopped with `ui --stop` stays stopped until the
// next login. PROTOCOL §16, "At login".
import path from 'node:path';

const LABEL_PREFIX = 'software-factory.board';

/** The launchd label of the login item for the board on this port. */
export const loginItemLabel = (port) => `${LABEL_PREFIX}-${port}`;
/** Where that login item lives under the owner's home. */
export const loginItemPath = (home, port) => path.join(home, 'Library', 'LaunchAgents', `${loginItemLabel(port)}.plist`);
/** Where the board launchd starts writes its output. */
export const loginItemLog = (home, port) => path.join(home, 'Library', 'Logs', 'software-factory', `board-${port}.log`);

/** Set only for one agent run or one test: a board started at login never carries them. */
const RUN_ONLY = new Set(['FACTORY_ACTOR', 'FACTORY_ROOT', 'FACTORY_NO_AUTOPILOT']);

/** Shell settings agent runs rely on. */
const TOOL_VARS = new Set(['PATH', 'LANG']);

/**
 * What the board's environment keeps from the shell that installed it. launchd
 * starts jobs with a bare PATH, where `claude`, `gh`, `git` and `npm` may not
 * be found, so PATH comes along, with LANG and the factory's own settings
 * ($FACTORY_CLAUDE_MODEL, $FACTORY_LEAD_MCP_CONFIG, ...).
 * Nothing else: no keys or tokens are written into the plist.
 */
export function loginEnv(env) {
  const out = {};
  for (const [k, v] of Object.entries(env)) {
    if (typeof v !== 'string' || !v) continue;
    if (TOOL_VARS.has(k) || (k.startsWith('FACTORY_') && !RUN_ONLY.has(k))) out[k] = v;
  }
  return out;
}

const xml = (s) => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

/** The plist: run argv once at load (every login), in cwd, with env, its output in log. */
export function loginItemPlist({ label, argv, cwd, env = {}, log }) {
  const str = (s) => `<string>${xml(s)}</string>`;
  return [
    '<?xml version="1.0" encoding="UTF-8"?>',
    '<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">',
    '<plist version="1.0">',
    '<dict>',
    `  <key>Label</key>${str(label)}`,
    '  <key>ProgramArguments</key>',
    '  <array>',
    ...argv.map((a) => `    ${str(a)}`),
    '  </array>',
    `  <key>WorkingDirectory</key>${str(cwd)}`,
    '  <key>EnvironmentVariables</key>',
    '  <dict>',
    ...Object.entries(env).map(([k, v]) => `    <key>${xml(k)}</key>${str(v)}`),
    '  </dict>',
    '  <key>RunAtLoad</key>',
    '  <true/>',
    `  <key>StandardOutPath</key>${str(log)}`,
    `  <key>StandardErrorPath</key>${str(log)}`,
    '</dict>',
    '</plist>',
    '',
  ].join('\n');
}
