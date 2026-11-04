// `factory ui --at-login`: a macOS login item that starts the board, and so its
// autopilot, at every login, so a restart of the machine leaves no agent
// waiting on nobody (PROTOCOL §16, "At login"). No test touches the owner's
// ~/Library: HOME points at a temp folder.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import net from 'node:net';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { useRoot, runCli, assertExit, makeTempDir, CLI_PATH } from './helpers.mjs';
import { loginItemPlist, loginEnv, loginItemLabel, loginItemPath, loginItemLog } from '../lib/login-item.mjs';

const MAC = process.platform === 'darwin';

function freePort() {
  return new Promise((resolve, reject) => {
    const srv = net.createServer();
    srv.once('error', reject);
    srv.listen(0, '127.0.0.1', () => {
      const { port } = srv.address();
      srv.close(() => resolve(port));
    });
  });
}

test('loginEnv: PATH, LANG and the factory\'s settings; never a run\'s binding, the test switch or anything else', () => {
  const env = loginEnv({
    PATH: '/opt/homebrew/bin:/usr/bin', LANG: 'en_US.UTF-8', HOME: '/Users/x', CLOUDSDK_PYTHON: '/usr/local/bin/python3.10', CLOUDSDK_CORE_PROJECT: 'p',
    FACTORY_CLAUDE_MODEL: 'claude-opus-5-5', FACTORY_LEAD_MCP_CONFIG: '/Users/x/.config/software-factory/mcp.json',
    FACTORY_ACTOR: 'fable', FACTORY_ROOT: '/r', FACTORY_NO_AUTOPILOT: '1', FACTORY_CODEX_EFFORT: '',
    ANTHROPIC_API_KEY: 'sk-secret', GITHUB_TOKEN: 'ghp_secret',
  });
  assert.deepEqual(env, {
    PATH: '/opt/homebrew/bin:/usr/bin', LANG: 'en_US.UTF-8',
    FACTORY_CLAUDE_MODEL: 'claude-opus-5-5', FACTORY_LEAD_MCP_CONFIG: '/Users/x/.config/software-factory/mcp.json',
  });
});

test('loginItemPlist: runs the board once at every login, in the root, escaped, and never kept alive', () => {
  const plist = loginItemPlist({
    label: loginItemLabel(4477),
    argv: ['/usr/local/bin/node', '/r & d/factory/bin/factory.mjs', 'ui', '--root', '/r & d', '--port', '4477', '--host', '127.0.0.1'],
    cwd: '/r & d',
    env: { PATH: '/usr/bin:<odd>' },
    log: '/Users/x/Library/Logs/software-factory/board-4477.log',
  });
  assert.match(plist, /<key>Label<\/key><string>software-factory\.board-4477<\/string>/);
  assert.match(plist, /<string>\/r &amp; d\/factory\/bin\/factory\.mjs<\/string>/);
  assert.match(plist, /<key>WorkingDirectory<\/key><string>\/r &amp; d<\/string>/);
  assert.match(plist, /<key>PATH<\/key><string>\/usr\/bin:&lt;odd&gt;<\/string>/);
  assert.match(plist, /<key>RunAtLoad<\/key>\s*<true\/>/);
  assert.doesNotMatch(plist, /KeepAlive/, 'a board stopped with ui --stop stays stopped until the next login');
  if (MAC) {
    const file = path.join(makeTempDir('factory-plist-'), 'x.plist');
    fs.writeFileSync(file, plist);
    const lint = spawnSync('plutil', ['-lint', file], { encoding: 'utf8' });
    assert.equal(lint.status, 0, lint.stdout + lint.stderr);
  }
});

test('ui --at-login: refuses what cannot work, before it writes anything', async (t) => {
  const { root } = await useRoot(t);
  const home = makeTempDir('factory-home-');
  const env = { HOME: home };
  const both = runCli(['ui', '--at-login', '--no-at-login', '--port', '4799'], { root, env });
  assertExit(both, 2);
  assert.match(both.stderr, /give one/);
  assertExit(runCli(['ui', '--at-login', '--stop', '--port', '4799'], { root, env }), 2);
  assertExit(runCli(['ui', '--no-at-login', '--port', '0'], { root, env }), 2);
  assert.equal(fs.existsSync(path.join(home, 'Library')), false, 'nothing written');
});

test('ui --at-login adds the login item and starts the board now; --no-at-login removes it and leaves the board running', { skip: !MAC && 'login items are macOS launchd' }, async (t) => {
  const { root } = await useRoot(t);
  const home = makeTempDir('factory-home-');
  const port = String(await freePort());
  const env = { HOME: home };
  t.after(() => runCli(['ui', '--stop', '--port', port], { root }));
  const add = runCli(['ui', '--at-login', '--port', port, '--json'], { root, env });
  assertExit(add, 0);
  const out = add.json();
  const file = loginItemPath(home, Number(port));
  assert.equal(out.at_login, file);
  assert.equal(out.detached, true, 'the board runs now too, in the background');
  const plist = fs.readFileSync(file, 'utf8');
  const args = [...plist.matchAll(/^ {4}<string>(.*)<\/string>$/gm)].map((m) => m[1]);
  assert.deepEqual(args, [process.execPath, CLI_PATH, 'ui', '--root', root, '--port', port, '--host', '127.0.0.1'], 'launchd runs the board in the foreground: it owns that process');
  assert.doesNotMatch(plist, /FACTORY_NO_AUTOPILOT|FACTORY_ROOT|FACTORY_ACTOR/, 'the board at login keeps its autopilot running');
  assert.ok(fs.existsSync(path.dirname(loginItemLog(home, Number(port)))), 'the log folder exists before launchd writes to it');
  // Again while the board runs: the item is rewritten and the running board reused.
  const again = runCli(['ui', '--at-login', '--port', port], { root, env });
  assertExit(again, 0);
  assert.match(again.stdout, /already running.*It starts at every login/);
  const off = runCli(['ui', '--no-at-login', '--port', port, '--json'], { root, env });
  assertExit(off, 0);
  assert.equal(off.json().removed, true);
  assert.equal(fs.existsSync(file), false);
  assert.match(runCli(['ui', '--port', port], { root }).stdout, /already running/, 'removing the item leaves the board running');
  const none = runCli(['ui', '--no-at-login', '--port', port], { root, env });
  assertExit(none, 0);
  assert.match(none.stdout, /Nothing to remove/);
});
