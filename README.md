# Software Factory

A team of coding agents that works in your repo like an engineering team. A Claude lead writes the brief, design and plan. Claude builders write the code. OpenAI reviews the design and the code, an optional security reviewer checks the diff, and Grok runs the final check. You approve the brief and sign off. You watch it all on a local board and chat.

All state is plain files in `teams/`, written through one CLI. Nothing runs in the cloud, and there are no dependencies to install.

## How it works

Each piece of work is a **thread**. A project thread moves through gates:

```
brief → design → design_review → plan → build → code_review → security_review → final_review → signoff → done
```

| member | runs on | does |
|---|---|---|
| `you` | the board | approve the brief, answer questions, sign off |
| `fable` | Claude Code | lead: brief, design, plan, tasks, task review, PR, merge |
| `opus-1`, `opus-2` | Claude Code subagents | build the tasks on the thread's branch |
| `openai` | Codex CLI | brainstorm, `design_review`, `code_review` |
| `security` | Claude Code, read-only | `security_review`, when the thread has one |
| `grok` | Grok, started by you | `final_review`: tests and evidence against the brief |

Code is built on a branch `factory/<team>/<thread>` in a worktree next to your repo; your checkout stays on `main`. The lead opens a draft PR at `code_review` and merges it after you sign off. Nobody in the factory tags, releases or deploys.

The autopilot starts each agent headless when it has a turn, so you never relay prompts. Two other kinds of thread exist. A **solo** thread is one agent doing a quick task on request. A **watch** thread tracks metrics on a schedule and opens issues on a breach.

## Requirements

- Node.js 22 or newer, and Git
- [Claude Code](https://docs.anthropic.com/en/docs/claude-code) (`claude`), signed in
- [GitHub CLI](https://cli.github.com) (`gh`), signed in, for PRs and merges
- Optional: [Codex CLI](https://github.com/openai/codex) (`codex`) for the `openai` reviewer, and Grok for `final_review`. When you start a thread you pick who holds each review: any of these agents, or you.

## Get started

In your repo, run:

```bash
npx github:ELU-Labs/software-factory
```

It copies `factory/`, `tools/factory-ui/` and the Claude Code skill and subagents (`.claude/`) into the repo root, sets up `teams/`, and opens the board. Files you already have are left alone. Run it again with `--update` for a newer version; your `factory/members.yaml` is kept.

The board opens at http://127.0.0.1:4477 and starts the autopilot. Start a thread there (or from a GitHub issue: give its number in the New thread form), or ask Claude Code in your repo:

```
/factory start a thread to add retries to failed payments
```

The lead writes the brief and asks you to approve it. After that, answer what the board shows under **Needs you**. The tab title counts what waits on you, threads with news get a dot, and the bell at the bottom of the sidebar turns on a desktop notification for each new item. Press ⌘K (Ctrl+K) to jump to any thread, team or view. A thread's **Changes** tab shows what its branch changes against main: click **+** beside a line to note what should change, and the notes go to the lead together (or as your review, when the gate is yours).

The board also shows what agent runs cost: per thread in its Details, and today's total at the bottom of the sidebar. To step in yourself, **Continue in terminal** in a thread's Details copies the command that resumes an agent's session in Claude Code or Codex.

A new factory also has a **Triage** thread. Paste a bug report or an error there, and an agent finds the cause and the smallest fix.

Commit `factory/`, `tools/factory-ui/` and `.claude/` if you want them in the repo. `teams/` ignores itself and stays on your machine.

## Commands

```bash
node factory/bin/factory.mjs --help              # every command
node factory/bin/factory.mjs board               # all threads, in the terminal
node factory/bin/factory.mjs inbox fable         # what waits on a member
node factory/bin/factory.mjs ui --stop           # stop the board and autopilot
node factory/bin/factory.mjs ui --at-login       # macOS: start the board at every login
npm test                                         # in a clone of this repo: the factory's own tests
```

## Configure

- `factory/members.yaml`: who is on the team, their models and effort.
- `teams/<team>/team.md`: a team's charter, checks and data sources. Its `setup` runs once in each new worktree: `node factory/bin/factory.mjs team edit <team> --setup "npm ci" --as you`.
- `~/.config/software-factory/mcp.json`: MCP servers for the lead's runs (kept outside the repo, since it holds your keys).

The rules every agent follows are in [factory/PROTOCOL.md](factory/PROTOCOL.md). Each role's loop is in `factory/roles/`.

## License

MIT
