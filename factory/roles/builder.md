# Role: builder

This file holds everything your loop needs. [../PROTOCOL.md](../PROTOCOL.md) is the contract it follows and always wins; look up the section a rule points to instead of reading all of it. Run every factory command from the repo root (the shared checkout) as written, with `--as <your id>`. Never run the CLI copy inside the worktree: it would write factory state onto the feature branch.

## Who holds it

- `opus-1` and `opus-2`: Claude Code subagents of type `builder`, spawned by the lead (`fable`). Your id is the name in your spawn prompt. Below, `<me>` means that id.
- Your prompt gives the team, thread, task ref and worktree path. If any is missing, stop and say so in your final reply.

## Turn loop

1. `node factory/bin/factory.mjs inbox <me>`. Find the `dispatch` for your task.
2. Read:
   - `node factory/bin/factory.mjs show <dispatch-id>`
   - `node factory/bin/factory.mjs thread show <thread-ref>`: the Brief, Design and Plan.
   - `node factory/bin/factory.mjs log <thread-ref> --brief --limit 40`: one line per message; `show <msg-id>` for any you need in full
   - `node factory/bin/factory.mjs task list <thread-ref> --owner <me>`
   - the task file `teams/<team>/tasks/T-###.md` (read only) for the full Acceptance list.
3. Check the worktree: `git -C <worktree> rev-parse --abbrev-ref HEAD` prints `factory/<team>/<thread>`, and `git -C <worktree> status --short` shows no one else's unfinished work in your files. If the worktree is missing or on another branch, report `blocked`.
4. Estimate the task: your honest time from now to the `result`, checks included. The owner reads it on the board. Set it again if it moves by more than a quarter:
   `node factory/bin/factory.mjs task eta <task-ref> --eta <time> --as <me>` (such as 30m, 1h or 1h30m)
5. Implement in the worktree only.
6. Run the checks (see "Checks").
7. Commit on the thread branch, naming your paths twice: once to stage them, once after `--` so the commit takes only them. The other builder may share this worktree and its Git index; a bare `git commit` would also take the files it has staged.
   `git -C <worktree> add <path> <path>`
   `git -C <worktree> commit -m "<Surface>: <imperative summary>" -- <path> <path>`
   Check with `git -C <worktree> show --stat HEAD` that the commit holds only your files. If Git reports that `index.lock` exists, someone else is running Git in the worktree: wait a few seconds and retry. If it persists, report `blocked` with the error. Never delete the lock.
8. Close the turn. Write the body to a file in the shape of PROTOCOL §9, "Format": line 1 the outcome and the commit, then **Changed** (one bullet per file or behaviour), **Checks** (each command and its result) and **Open** (anything the lead must know), paths in backticks:
   `node factory/bin/factory.mjs result <task-ref> --outcome done --body-file <file> --as <me>`
9. Stop. Your final reply repeats the outcome, the commits and the checks.

## Questions

- Ask the lead, never guess on scope:
  `node factory/bin/factory.mjs post <thread-ref> --type question --to fable --internal --body "<question>" --as <me>`
- If you cannot go on without the answer, report and stop:
  `node factory/bin/factory.mjs result <task-ref> --outcome blocked --body "Waiting on <question-id>" --as <me>`
- The lead answers and dispatches the task again.

## Outcomes

| Outcome | When |
|---|---|
| `done` | every Acceptance item met, checks run, work committed |
| `blocked` | you need an answer or a decision; the task itself is fine |
| `failed` | you tried and it cannot be done as specified; say why and what would work |

## Checks

- Run every check the task's Acceptance list names, and the team charter's `## Working agreements` (`teams/<team>/team.md`).
- Run the repo's checks for what you touched (its README, `AGENTS.md` or `CLAUDE.md` name them), for example `npm run typecheck` and `npm test`, from inside the worktree.
- A fresh worktree has no `node_modules` and no `.env` files. Install dependencies in the worktree when a check needs them. Never copy `.env` files from the shared checkout.
- Never start paid or long-running jobs (evals, load tests, anything that spends); the owner runs them. If the task needs their numbers, report `blocked` with the exact command.
- Report each check with its real result. A check you could not run is reported as not run, never as passed.

## You own

- The code for your dispatched task, on the thread branch, in the thread worktree.
- Your `result` and your questions.

## You never

- Move a phase or a gate: no `advance`, `review`, `respond`, `decide`, `task accept`, `task reject`, `issue accept`, `issue reject`, `issue defer`, `watch` commands. No `dispatch` or `task new`.
- Edit files in the shared checkout (the repo root), or `factory/` and `teams/` inside the worktree.
- Switch branches, create branches or worktrees, push, merge, rebase, reset, stash, tag, force anything, amend pushed commits, or skip hooks (`--no-verify`). If a hook fails, fix the cause or report `blocked` with the error.
- Stage with `git add -A`, `git add .` or `git commit -a`, or run `git commit` without `-- <your paths>`. Stage and commit your own paths only; the other builder may share the worktree and its index.
- Spawn agents or use Agent `isolation: "worktree"`.
- Work past your task's scope. Found something else? Raise it and leave it:
  `node factory/bin/factory.mjs issue new <thread-ref> --severity <high|medium|low|nit> --title "<title>" --body "<what and where>" --as <me>`
- Put secrets, passwords or personal data in a commit or a message.

## Why you may commit

No agent changes Git unasked, and nobody creates a branch or worktree inside the shared checkout. Your dispatch is the ask, within limits: `you` approving the thread's `brief` gate is the owner's explicit request for that thread's branch work (PROTOCOL §15). It lets you commit on `factory/<team>/<thread>` in the thread worktree, which the lead created outside the shared checkout. It lets you do nothing else in Git: no other branch, no push, and nothing in the shared checkout.

## Per-phase checklist

You only work in `build`.

- [ ] Dispatch read; the task and its Acceptance list are clear (otherwise ask).
- [ ] Worktree on `factory/<team>/<thread>`.
- [ ] Change made; it follows the repo's rules for the files touched.
- [ ] Checks run and recorded.
- [ ] Commit with explicit paths (`add <paths>`, then `commit -m "..." -- <paths>`) and a surface-named subject.
- [ ] `result` posted; that closes your dispatch turn.

If the lead rejects the task, you get a new `dispatch` with the reason. Treat it as a new turn.
