# Factory protocol

Every factory member follows this contract. Role files in `factory/roles/` add the per-role loop; they never override this file.

In this file `factory` stands for `node factory/bin/factory.mjs`. It is not an installed command: always type the full form, from the repo root (the shared checkout), or pass `--root <repo root>`.

## 1. Principle

- **The chat tells the story; the files hold the truth.**
- Every state change is a file change under `teams/`. The CLI makes the change and auto-posts an `event` message for it.
- The CLI is the only supported way to write state. Reading files directly is fine; editing them by hand is not.
- Every write names its actor with `--as <member>` (or `$FACTORY_AS`). Write only as yourself.

## 2. Roster

Source of truth: `factory/members.yaml`.

| id | Role | Runs as | Does |
|---|---|---|---|
| `you` | owner | the board UI (writes as `you`) or `factory ... --as you` | Approves briefs, breaks ties, signs off (the sign-off lets the lead merge the PR) |
| `fable` | lead | Headless Claude Code started by the autopilot (§16), or the owner's Claude Code session with skill `/factory` | Brief, design, plan, tasks, dispatch, task review, escalations, decisions |
| `opus-1`, `opus-2` | builder | Claude Code subagent type `builder`, spawned by fable | Implement tasks on the thread branch |
| `opus-monitor` | monitor | Claude Code subagent type `monitor`, spawned by fable | Watch runs |
| `opus-solo` | solo | headless Claude Code (`claude -p`), started by `factory autopilot` | Leads and does the work of single-agent threads (§5) |
| `openai` | reviewer | Codex CLI in the repo root | `design_review` and `code_review` gates |
| `grok` | gatekeeper | Grok with the owner's test and feedback tools | `final_review` gate: tests and evidence against the Brief |
| `security` | security | headless Claude Code (`claude -p`, read-only), started by `factory autopilot` | `security_review` gate, on the threads whose roles pick it (§6, "Roles") |
| `factory` | system | the CLI | Posts `event` messages; nobody else may use this id |

The UI lets the owner send messages, review the gates `you` owns (`brief`, `signoff`), and mark a turn handled. Every message goes to at least one member, picked in the composer (the thread lead by default; a single-agent thread's agent, always), so it opens their turn and the autopilot starts an agent that has one. There is no type to pick: a reply to a `question` or `escalation` addressed to `you` is an `answer`, anything else a `question`. Decisions and gate overrides (`decide`, `decide --gate`) go through the CLI. It always writes as `you`.

Each member's `short` is its two-character avatar label. The builders use `O1` and `O2` so the two can be told apart at a glance. `validate` accepts any two characters, so you can change them in `factory/members.yaml`. A member with `logo` (`claude`, `openai` or `grok`) shows that vendor's mark in its avatar instead: fable, openai and grok do. `security` shows a shield (`logo: shield`).

## 3. Layout

```
factory/PROTOCOL.md, members.yaml, roles/, templates/, lib/, bin/factory.mjs, test/
teams/<team>/
  team.md                 config (set with `factory team edit`) + charter (hand-edited by you or the team lead)
  decisions.md            append-only "## D-###: title" entries
  threads/<thread>.md     one file per thread: frontmatter state + Brief/Design/Plan/Notes
  comms/<id>.md           one file per message; immutable
  tasks/T-###.md
  issues/I-###.md
  reports/<thread>-<yyyymmddThhmmssZ>.md
  metrics.jsonl           one JSON line per watch run
teams/.presence/<member>.json   what each agent is doing, for the board's badges (§16 "Presence")
teams/.autopilot/                the autopilot's state.json and one log per agent run (§16 "Autopilot")
teams/.archive/<team>-<stamp>/   a team `factory team archive` moved off the board, every file kept
```

`teams/` lives in the shared checkout, so one board shows every team. It is gitignored apart from its README and `.gitignore`: factory state stays on this machine and is never committed. Feature code never lives there (§15).

## 4. Ids and refs

| Thing | Format | Ref forms |
|---|---|---|
| Team, thread | `^[a-z0-9][a-z0-9-]{0,40}$` | thread: `<team>/<thread>`, or bare `<thread>` when unique across teams |
| Task | `T-001` (per team, sequential, at least 3 digits) | `<team>/T-001`, or bare `T-001` when unique |
| Issue | `I-001` (per team) | `<team>/I-001`, or bare when unique |
| Decision | `D-001` (per team) | `D-001` inside that team |
| Message | `<yyyymmddThhmmssZ>-<from>-<4 hex>`, e.g. `20261101T153012Z-fable-a3f9` | globally unique; filename stem == id |
| Branch | `factory/<team>/<thread>` | the thread's `branch` field |

- Timestamps are ISO-8601 UTC with milliseconds, e.g. `"2026-11-01T15:30:12.345Z"`.
- Team and thread ids become the branch name (§15).
- A message's `refs` hold `T-`, `I-`, `D-` ids of the same team, or message ids.
- Ordering everywhere: by `ts`, then `id`.

## 5. Threads and gates

Three kinds of thread.

**`kind: project`** moves through these phases in order:

`brief → design → design_review → plan → build → code_review → security_review → final_review → signoff → done`

`security_review` exists only on a thread whose roles picked a security reviewer (§6, "Roles"); a thread without that gate goes from `code_review` straight to `final_review`.

| Gate | Approved by |
|---|---|
| `brief` | `you` |
| `design_review` | `openai` |
| `build` | all tasks done (fable reviews each task); automatic |
| `code_review` | `openai` |
| `security_review` | `security`, when the roles pick it |
| `final_review` | `grok` |
| `signoff` | `you` |

- Review gates have the same name as their phase. `design` and `plan` have no gate; the lead moves them with `advance`.
- Gate fields: `by` (owner), `status` (`pending | approved | changes_requested | blocked`), `at` (last status change), `ref` (message that set it). `gates.build.by` is the thread lead.
- Findings at any gate become issues, and accepted ones become tasks (§8). A brief or design finding is fixed in the document, not in code, so an accepted finding on a `changes_requested` or `blocked` review sends the thread:
  - at `brief`: nowhere; it stays in `brief` and the brief gate resets;
  - at `design_review`: back to `design`;
  - at `code_review`, `security_review`, `final_review` or `signoff`: back to `build`.

  New work on a thread past `build`, including after `done`, always sends it back to `build`: an accepted point on an approve review, `issue accept`, `task new`. Before that, accepted points on an approve review only add document tasks. §7 rows 11 to 13 have the exact rules.

**`kind: watch`** has phase `active` or `paused`, an `owner` (the monitor), a `cadence` (`hourly | daily | weekly | <n>h | <n>d`) and `thresholds` (`{max: v}` or `{min: v}` per metric). Each run does five things (§12): measure, append to `metrics.jsonl`, write a report, open issues on threshold breaches, verify fixed issues in production. `review`, `respond` and `advance` are errors on watch threads. A watch thread holds no code work: a fix for one of its issues is built and reviewed in a project thread (§12, "Fixing a watch issue").

**`kind: solo`** (a single-agent thread) is simple work one agent does on request. It has one agent, its `owner`, which is also its `lead`; it is always in phase `active`, with no gates, tasks, branch work, cadence or thresholds. The agent is an agent with role `solo` and `launch: claude` (`opus-solo`), so its runs keep to the thread's permissions (§16). It works only when the owner asks it there: a `question` (or any non-notice message) addressed to it opens its turn, the autopilot starts it, and it answers with `post --type answer --reply-to <request> --to you`. The owner asks on the board, or from a `/factory` session that posts their words as `you`. Inside its run the agent may start Claude Code subagents, which have its permissions and nothing more.
- Only `you` and the agent are addressed on a single-agent thread (`--to`/`--cc` naming anyone else is refused), so a turn there never starts another agent. A member with role `solo` writes only on the single-agent threads it owns, and is addressed nowhere else.
- `--lead` and `--members` do not apply: the agent leads it, its members are `you` and the agent, and `thread set --owner` moves the lead with it. The agent keeps its open requests, so `--owner` is refused while it holds one. Its Instructions and settings (`thread edit`, `thread set`) are changed by `you` or the team lead, never by the agent; the team lead may also manage its issues. Only `you` records decisions there.
- A single-agent thread made when the team lead led them (lead ≠ owner) still works the old way; `thread set <ref> --owner <its agent>` converts it, closing the turns the old lead held there. What the old lead settled stays settled.
- Its runs may read files, run read-only commands and the factory commands the agent needs, plus the team's `allow` list (team.md, for every single-agent thread of the team) and the thread's own: Claude Code permission rules naming a tool and its command prefix, such as `Bash(npm run report:*)`. Set them with `thread new --allow`, `thread set --add-allow / --remove-allow` (or `--allow`, which replaces the list), `team edit --add-allow / --remove-allow`, or on the board (the thread's Details panel, and permission cards). A rule that is not a tool name with an optional pattern in parentheses, or that allows every shell command (`Bash`, `Bash(*)`), is refused. Everything else the run tries is refused.
- A run never stops to ask. When it was refused commands (Claude Code's `permission_denials`), the autopilot posts a `permission_denied` event from `factory` to `you`: the refused commands and a suggested prefix rule for each part that is not read-only. The board shows it as a permission card. **Allow and retry** adds the (editable) rules to the thread, or the team, and posts a question to the agent so its next run carries on; **Don't allow** posts a note to nobody, which closes the card without starting the agent. A rule that can run any code, covers every subcommand of a program, or can change things is flagged and needs a second click. A newer card carries the rules of an older open one and closes it.
- `review`, `respond`, `advance`, `task new` and `watch run` are errors on it.
- An issue opened there is fixed the way a watch issue is: on a project thread of the same team (§12, "Fixing a watch issue"). When that thread is signed off, the issue's `fixed` event goes to `you`: once it ships, ask the agent there to check it, and it runs `verify`.
- Its agent's role file is `factory/roles/solo.md`.
- `factory init` starts a factory that has no teams with one: `triage/triage`, whose Instructions ask its agent to find the cause and the smallest fix of each bug report the owner posts. Creating it opens no turn. An archived Triage team is not created again.

Defaults on `factory thread new`: lead = team lead; members = `[you, lead, opus-1, opus-2, openai, grok]` for projects, `[you, lead, owner]` for watch threads, `[you, owner]` for single-agent threads (the owner is the lead). A team or thread lead (`--lead`) is a member whose role is `lead`, or `you`: a reviewer, gatekeeper or builder leading a thread would answer its own reviews.

## 6. Thread body

| Kind | Sections | Written by |
|---|---|---|
| project | `## Brief` (Problem / Users / Success criteria / Out of scope), `## Design`, `## Plan`, `## Notes` | the lead, with `factory thread edit <thread-ref> --section <name>` |
| watch | `## What we watch`, `## Thresholds`, `## Runbook` | the lead |
| solo | `## Instructions` (standing rules for every request, often empty: the request is the instruction), `## Notes` | `you` or the team lead, never the agent; the agent re-reads it on every request |

`thread edit` replaces that section's whole content (it adds the section if missing), so send the full new text.

Thread configuration changes go through `factory thread set <thread-ref>` (lead or `you`; on a single-agent thread `you` or the team lead, never its agent): a watch thread's `--cadence`, `--threshold` (each named metric's bounds are replaced), `--clear-threshold` and `--owner`; a single-agent thread's `--owner` and its allowed commands: `--add-allow` and `--remove-allow` (repeat them) change the list, `--allow` (repeat it) replaces it, `--clear-allow` empties it; and any thread's `--members`. The team-wide list changes with `team edit <team> --add-allow / --remove-allow / --allow / --clear-allow` (you or the team lead), which posts no event. It posts a `thread_config` event. A task's title or one section of its body (for example its `## Acceptance`) changes with `factory task edit <task-ref>`, which posts a `task_updated` event.

### Roles

A thread started from the board's New thread carries an optional `roles` key: who the owner picked for each role, and on which model. The board starts project threads only: with every role but the lead unticked, the lead does the work alone and `you` own the review gates. Single-agent threads (§5) are made with `factory thread new --kind solo`. Everyone works from the thread's one request (the `kickoff`, or a single-agent thread's question); a role has no prompt of its own. Threads without `roles` work as before (the roster's models, the default gate owners). `thread show <thread-ref>` prints it, one line per role.

| Role | Played by | What it changes |
|---|---|---|
| `lead` | the thread lead, on the model picked: a Claude model (Fable, Opus, Sonnet or Haiku) or an OpenAI model (GPT-6.1 Sol, GPT-6.1 Terra, GPT-6 Astra, GPT-6 Sol or GPT-6 Luna) | the model of the lead's headless runs (§16). On an OpenAI model the lead runs in Codex and builds by itself: `subagents` must be `null` and `pair` cannot be a Claude model |
| `subagents` | `{model}`, or `null` when the owner left it unticked | on: the lead designs and coordinates, and decides how many builder subagents to start (the builder slots `opus-1`, `opus-2`), each spawned with the Agent tool's `model` set to that model's alias (`fable`, `opus`, `sonnet`, `haiku`). `null`: the lead designs and builds every task itself, and no builder is a member |
| `pair` | `openai` (on an OpenAI model), `grok`, a Claude model, or nobody (`null`) | who the lead brainstorms with in `design`: `openai` or `grok` in the thread, a Claude model as a `general-purpose` subagent on that model, or nobody |
| `code_review` | `openai` (on an OpenAI model) or `grok`, or `you` when the owner left it unticked | owner of the `design_review` and `code_review` gates |
| `final_check` | `grok` or `openai` (on an OpenAI model), or `you` when the owner left it unticked | owner of the `final_review` gate |
| `security` | `{agent: security, model}` (the `security` member on that Claude model), `openai` or `grok`, or `null` when the owner left it unticked | owner of the `security_review` gate, between `code_review` and `final_review`, who follows `factory/skills/factory-security/SKILL.md`. `null`: the thread has no `security_review` gate |

The lead runs in Claude Code on a Claude model or in Codex on an OpenAI model; its subagents run in Claude Code, so they take Claude models only. `openai` and `grok` join as members of the thread (`grok` has no headless mode: the owner starts it). An `openai` role stores `{agent: openai, model}`; an OpenAI model id given as the agent reads as that. Without a model, the roster's decides (§16). `openai` keeps one session per thread, so when its roles there pick different models a run takes the model of the role the phase calls on: `pair` until `design_review`, `code_review` for design and code review, `security` for `security_review`, `final_check` from `final_review` on. A single-agent thread's `roles` holds `agent`: the model of its agent's runs. The roles are set when the thread is created and pick its members (you, the lead, the builder slots when subagents are on, `openai` or `grok` when they pair, review or check, the security reviewer when picked) and gate owners; `factory validate` checks their shape. A thread made before `subagents` existed stores `builders: [{member, model}]`, read as subagents on the first builder's model.

## 7. Phase machine (project threads)

| # | From | To | Triggered by | Command | Requires / effect |
|---|---|---|---|---|---|
| 1 | (new) | `brief` | lead or `you` | `factory thread new <team>/<thread> --title <t>` | Event to the lead: write the brief. |
| 2 | `brief` | `design` | `you` | `factory review <thread-ref> --verdict approve` | Only low/nit points. Authorises the thread's branch work (§15). Event to the lead. |
| 3 | `design` | `design_review` | lead or `you` | `factory advance <thread-ref>` | Every task of the thread done. Event to `openai`. |
| 4 | `design_review` | `plan` | `openai` | `factory review <thread-ref> --verdict approve` | Only low/nit points. Event to the lead. |
| 5 | `plan` | `build` | lead or `you` | `factory advance <thread-ref>` | At least one task in `todo`, `doing`, `review` or `blocked`. |
| 6 | `build` | `code_review` | factory (automatic) | the last `factory task accept <task-ref>` | All tasks done: build gate approved, event to `openai`. `factory advance <thread-ref>` does the same when every task is done. |
| 7 | `code_review` | `security_review`, or `final_review` when the thread has no such gate | `openai` | `factory review <thread-ref> --verdict approve` | Event to the next gate's owner. |
| 7a | `security_review` | `final_review` | `security` | `factory review <thread-ref> --verdict approve` | Event to `grok`. |
| 8 | `final_review` | `signoff` | `grok` | `factory review <thread-ref> --verdict approve` | Event to `you`. |
| 9 | `signoff` | `done` | `you` | `factory review <thread-ref> --verdict approve` | Event cc all thread members. |
| 10 | gate g | g (unchanged) | gate owner | `factory review <thread-ref> --verdict changes_requested` (or `blocked`) | Gate status set, one issue per point, lead's turn opened. `blocked` also cc's `you`. |
| 11 | gate g | back(g) | lead | `factory respond <thread-ref> --stance "<n>=accepted"` (at least one accepted stance) on a non-approve review | back(`brief`) = `brief`, back(`design_review`) = `design`, back(`code_review`, `security_review`, `final_review`, `signoff`) = `build`. Gates after the target reset to `pending`. Event to the lead. |
| 12 | `code_review`, `security_review`, `final_review`, `signoff`, `done` | `build` | lead | `factory respond <thread-ref> --stance "<n>=accepted"` (at least one accepted stance) on an approve review, or on a review a later review or gate decision has superseded | Same resets: code changes need re-review. |
| 13 | `code_review`, `security_review`, `final_review`, `signoff`, `done` | `build` | lead or `you` | new work: `factory task new <thread-ref>`, `factory issue accept <issue-ref>` on a manual issue of that thread, or on a watch issue with `--thread <thread-ref>` (§12) | Same resets. |
| 14 | gate g | as a review of g | `you` only | `factory decide <thread-ref> --title <t> --gate <g> --verdict approve` (or `changes_requested`) | Tie-break or override: same effects as a review with that verdict and no points. It also closes the escalation turns `you` hold in that thread, and the gate owner's turn on the event that put the thread in that gate. |

Rules around the table:

- `review` is accepted only from `gates[phase].by` while the thread is in that gate phase. Anyone else gets a permission error naming the phase and its owner.
- `approve` allows only `low` or `nit` points. A `high` or `medium` point on approve is a usage error: use `changes_requested`.
- An `approve` at `code_review`, `security_review`, `final_review` or `signoff` is refused while the thread has a task that is not `done`: that work has not been built and reviewed. Only `you` can override that, with `decide --gate`.
- `signoff` cannot be approved, by review or by `decide --gate`, while any issue of the thread is still `open`: the lead triages each one first (`respond` for review points, `issue accept|reject|defer` for the rest).
- On approve, these `fixed` issues of the thread become `verified`: every one the approving member raised, at any gate or by hand (a reviewer confirms its own findings when it next approves), and every one raised at this gate. The `signoff` approve verifies every `fixed` issue still left in the thread. Watch-thread issues are verified only by watch runs and `factory verify` (§12).
- `respond` with no accepted stance on a non-approve review: phase unchanged, the response goes `to: [reviewer]`. The reviewer re-reviews or escalates to `you`.
- `respond` with accepted stances on an approve review of `brief` or `design_review`, while the thread has not passed `build`: tasks are created, no phase change. They are lead-owned document tasks, and `advance` out of `design` and the build gate still need every task done.
- A stale review (one a later review, a gate decision or a reset has superseded) never rewinds a thread to `brief` or `design`: its accepted stances count as new work (row 12).
- After `done`, new work still sends the thread back to `build`, with the `build`, `code_review`, `final_review` and `signoff` gates reset: code nobody has reviewed never sits on a done thread.
- `advance` on any other phase is a usage error that names the command that moves it.
- Nothing in this table merges, tags or deploys (§15).

### Estimates

So the owner can see how long a thread will take, its phases and its tasks carry estimates: times such as `45m`, `2h` or `1h30m`, at most 7 days. Setting one posts an `eta` event to nobody: it is news, not a turn.

- `factory thread eta <thread-ref> --eta design=45m,plan=20m,build=3h,code_review=30m,final_review=20m`. The lead estimates every phase from the current one to `final_review` when it takes the thread (when the brief is approved), and sets a phase again when it starts, or when its estimate moves by more than a quarter. For the current phase the value is the time left from now; for a later phase, its length. A gate's owner may also set its own gate when the review reaches it. `signoff` is the owner's and stays out of the total. The thread's `eta` holds `{minutes, by, at}` for each phase estimated.
- Tasks carry their own estimate (§8, "Task estimates").
- The board's Gates panel shows each phase's time: taken (past phases, from the phase events), left or over (the current phase), `~` its estimate (later phases). It also shows when the thread should be ready for sign-off: the current phase's due time plus the later estimates, marked `+` while a phase has none. The thread's board card shows that time too.

## 8. Findings, issues and tasks

The loop is: **finding → issue → stance → task → build → fixed → verified**.

1. Every review point becomes an issue: status `open`, `gate` = the review gate, `source` = the review id, `point` = n, `raised_by` = the reviewer.
2. The lead answers every point with one stance in `factory respond`:
   - `accepted`: a task is created (title = the stance's action, or `Fix: <issue title>`); the issue becomes `accepted` and links the task.
   - `rejected`: the issue becomes `rejected`; a reason is required.
   - `deferred`: the issue becomes `deferred` (reason optional, recommended).
3. Accepted stances send the thread back (§7 rows 11 and 12).
4. A task done whose `issue` is set makes that issue `fixed`.
5. A `fixed` project issue becomes `verified` when the member who raised it (`raised_by`) next approves a gate of that thread, whichever gate that is, or when its own gate approves again, or at the latest when `you` approve `signoff`. So openai's design findings are confirmed by its later approvals, grok's findings by its next `final_review` approve, and issues the lead or a builder raised by the signoff.
6. Manual issues: any thread member runs `factory issue new` (for example grok with `--source "<tool>:<id>"`). The lead or `you` triages them with `issue accept`, `issue reject` or `issue defer`. These are refused on a point of a review that has no response yet: answer that review with `respond`. A review issue reopened after its response is triaged like a manual one.
7. Watch issues: a watch run opens them on breaches and verifies or reopens them on later runs (§12); nothing else verifies them except `factory verify`. Their fixes are built in a project thread (§12, "Fixing a watch issue"). `factory verify` is the manual production check for any `fixed` issue.

| Issue status | Meaning |
|---|---|
| `open` | raised, not triaged (or reopened) |
| `accepted` | a task exists for it |
| `rejected` | will not fix; `reason` set |
| `deferred` | later; `reason` may be set |
| `fixed` | its task is done |
| `verified` | proven: its raiser approved a gate after the fix, its gate approved again, `signoff` approved, a watch run found it in threshold, or `verify --pass` |

| Task status | Set by |
|---|---|
| `todo` | `task new`, an accepted stance, `issue accept` |
| `doing` | `dispatch` (a re-dispatch replies to the task's latest result while a turn on it is open); `task reject` (same owner, with a new `dispatch` message carrying the reason) |
| `review` | `result --outcome done`: waiting for the lead's `task accept` or `task reject` |
| `blocked` | `result --outcome blocked` or `failed` |
| `done` | `task accept` |

### Task estimates

- `factory dispatch <task-ref> --to <member> --eta 30m`: the lead's estimate. Without `--eta`, an estimate the task already has keeps its length and its clock restarts at the dispatch; `task reject` restarts it too.
- `factory task eta <task-ref> --eta 40m`: the task's owner, the lead or `you`. For a task in `doing` the value is the time left from now; for one in `todo`, its length once started. A builder sets its own estimate as soon as it takes a dispatch, before it starts the work, and again when it moves by more than a quarter. Refused on a task in `review`, `blocked` or `done`.
- The task's `eta` is `{minutes, by, at}`; `result` adds `ended`. Task cards on the board show `~` the estimate (to do), the time left or over (doing), and the time taken (after the result).

## 9. Messages

Each message is one file `teams/<team>/comms/<UTC yyyymmddThhmmssZ>-<from>-<4 hex>.md`. The filename stem is the id. Files are created once and never rewritten or deleted.

| Field | Meaning |
|---|---|
| `id` | the filename stem; must match `from` and `ts` |
| `ts` | ISO UTC with milliseconds |
| `thread` | thread id (the team is the folder) |
| `from` | the actor |
| `to` | list; each recipient gets a turn (§10) |
| `cc` | list; FYI only, never a turn |
| `type` | one of the types below |
| `reply_to` | message id or `null` |
| `resolves` | list of message ids whose turns this closes (§10) |
| `refs` | list of `T-`, `I-`, `D-` or message ids |
| `internal` | bool; lead and builder traffic, hidden by `factory log <thread-ref> --no-internal` |

All keys are always present: empty lists as `[]`, no reply as `null`.

| Type | Sent by | Use | Extra keys |
|---|---|---|---|
| `kickoff` | `you`, lead | start a thread or a new round | |
| `proposal` | lead | ask a gate owner to review | |
| `review` | gate owner, via `factory review` | verdict on the current gate | `gate`, `verdict`, `points` |
| `review_response` | lead, via `factory respond` | one stance per review point | `stances` |
| `question` | anyone | needs an answer; builders send it `--internal` to the lead | |
| `answer` | anyone | answers a question (`--reply-to`) | |
| `dispatch` | lead, via `factory dispatch` (and `task reject`) | assign a task | `task` |
| `result` | task owner or lead, via `factory result` | task outcome | `task`, `outcome` |
| `escalation` | anyone | ask `you` to break a tie or decide | |
| `decision` | `you`, lead, via `factory decide` | record a decision | `decision`, optional `gate`, `verdict` |
| `report` | via `factory watch run` | watch report | `report`, `status` |
| `alert` | via `factory watch run` | threshold breach | `metric`, `value`, `threshold`, `issue` |
| `event` | `factory` only | automatic state-change line | `event` |
| `note` | anyone | FYI | |

Type rules:

- **review**: `verdict` is `approve | changes_requested | blocked`. `points` is `[{n, severity, text}]`, n = 1..k and unique, severity `high | medium | low | nit`; `points: []` is allowed. `approve` carries only low/nit points. `blocked` means the reviewer cannot proceed without an owner decision.
- **review_response**: `reply_to` must be the review's id. `stances` is `[{point, stance, reason?, action?}]` with stance `accepted | rejected | deferred`. It covers every point of that review exactly once. `rejected` needs a non-empty `reason`. `action` (accepted only) overrides the task title.
- **result**: `task` (T-###) and `outcome`: `done` (acceptance met, checks run, committed), `blocked` (needs an answer or decision), `failed` (cannot be done as specified; say why).
- **event**: only `from: factory` may post `event`, and `factory` posts nothing else.
- Bodies are Markdown. The first non-empty line is the message summary that inbox, board and log show (up to 140 chars), so make it say what the message is.
- Never put secrets, tokens, passwords or personal data in a message. Messages are permanent; cite ids instead.

### Format

Every message body is Markdown, and the board renders it: headings, bold, lists, code, tables and links. Write it to be scanned, not read through:

- **Line 1 is the outcome or the ask**, in one sentence.
- **Then a blank line and short bullets**, one fact each. With several kinds of facts, group them under bold labels such as **Changed**, **Checks**, **Open**.
- **Paths, functions, commands, flags and SHAs go in backticks.**
- **No paragraph longer than three sentences.** A list beats a paragraph.
- **Write a multi-line body to a file** and pass `--body-file <file>` (or `--body-file -` with the text on stdin); a quoted `--body` loses its newlines easily.

The CLI prints a note when a body has a paragraph over 600 characters. A builder's result, for example:

```
T-001 done in `a1b2c3d`: failed payments retry with backoff.

**Changed**
- `retry.ts`: backoff doubles from 200 ms, at most 3 tries.
- `pay.ts`: calls the payment API through `withRetry`.

**Checks**
- `npm run typecheck`: pass
- `npm test`: 48 passed

**Open**
- 2 failures in `refund.test.ts` also fail on main; not from this change.
```

### Images

The owner can drop or paste an image into the board's message box. The board saves it as `teams/<team>/attachments/<yyyymmddThhmmssZ>-<from>-<4 hex>.<png|jpg|gif|webp>` (PNG, JPEG, GIF or WebP, up to 10 MB; files are written once, like messages, and are not committed) and writes `![<name>](teams/<team>/attachments/<file>)` into the message, where the board shows it. An agent sees the image by opening that path with its Read tool; never guess what an image shows without opening it.

### Between teams

A thread's lead (or a single-agent thread's agent), or `you`, talks to another team with `factory tell <team> --from <own thread-ref> --body ...`. A team name picks that team's one open thread; name `<team>/<thread>` when it has several. The message goes into that thread, addressed to its lead (a single-agent thread's agent), and a copy stays in the sender's thread. Both carry `link: {dir, thread, msg}`: `dir: to` on the copy (it went to `thread`), `dir: from` on the message that arrived (it came from `thread`; `msg` is the copy there). The board shows each with a chip that opens the other thread.

- `--type question` (the default) wants an answer: it is a turn for their lead until they reply to it. `--type note` hands over information; it is a turn too, closed by their lead's next write in that thread.
- A `question`, `answer` or `note` that replies to a linked message (either side) is relayed to the other thread: the same text, from the same writer, addressed to whoever wrote the other side, with `reply_to` that side and its own `link`. So an answer comes back to the asker as a turn on its own thread, and a follow-up there goes back again.
- A relayed answer or note closes on its recipient's next write in that thread; a relayed question waits for a reply, like any question.
- Say what you need in the first line, as for the owner: the other team's lead reads it without your thread's history. Put long material in your thread's Notes and point to it.

### Writing to the owner

The owner reads every message addressed or cc'd to `you`, and every reply in their own session. Each one must be readable in ten seconds:

- **Line 1 is the ask or the news**: what you need from the owner, or what happened.
- **Then at most three lines**, one option or fact each. Put your recommendation first and say it is the recommendation.
- **Under 60 words**, not counting a code block the owner must copy and run.
- **Leave out** history, recaps of reviews, your reasoning, and SHAs, paths or ids the owner does not need to act. One id they can open is enough.
- **Ask only what blocks you now.** Two or three decisions go as a numbered list, one line each. The rest waits.
- **Need the owner to do something? Send a `question`**, not a `note`: a note is for their information.
- **Your question closes when the owner next writes in the thread** (§10). On your next run, check whether what they wrote answers it. If it does, go on. If part is still open, ask again with only that part; never repeat what they settled.
- **Detail goes elsewhere**: the thread body (Notes, Design) or an `--internal` note. Point to it in one line; never paste it.
- Content the owner asked for (a draft, a table, a list) is exempt from the word limit. The lines around it are not.

Example:

```
Need benchmark numbers before signoff (~20 min).
1. Run `npm run bench` on main, then on the thread branch.
2. Recommended: paste both summaries here; I compare p95 and memory.
```

## 10. Turns (@mention model)

- A message with `to: [x, ...]` opens one turn per recipient. `cc` never opens a turn.
- Messages from `factory` open turns too: `thread_created` goes to the lead, and gate-entry events go to the gate owner. When `respond`, `issue accept` or `task new` sends the thread back, its event goes to the lead: the `phase` event back to `build` or `design`, or, at `brief`, the `gate` event that resets the brief gate. Watch `alert` and breach `report` messages also go to the lead.
- **Notification turns.** A turn opened by an `event`, `alert` or `report` message is a notification. It closes by itself on your next write in that thread: the store adds every notification turn you hold there to the `resolves` of the first message that write produces. That is your own message when the command posts one (`post`, `review`, `respond`, `dispatch`, `result`, `decide`), and otherwise the `factory` event the action posts (`thread edit`, `advance`, `task new`, `task accept`, `issue new`, `issue accept`). A notification that your own write produces, such as the `phase` event `respond` sends you, stays open until your next write there. If you handled one and have nothing to write in that thread, post a `note` there.
- **Messages to you.** An `answer`, `question`, `escalation` or `note` addressed to `you` closes once `you` write anything later in the same thread: the owner's next message there is their answer, whether or not it replies to that message, so nothing stays "waiting on you" after they wrote. The asker reads that message on its next run; if it left the question open, the asker asks again in a new, shorter `question` that names only what is still open.
- **Dismiss.** The owner can close any turn they hold without writing in the thread (the board's Dismiss): the board posts a hidden note from `you` (`internal: true`, `dismissal: true`, `dismissed_for: <member>`) that lists just that turn in `resolves`. It closes the turn for that one member only: other recipients of the same message keep theirs. A dismissal is not a write: it closes nothing else, and the board's chat leaves it out. The owner can also dismiss an agent they will not start (the × on a "Start …" item in Needs you): that closes every turn the agent holds in the thread, the same way (rule b lets `you` resolve any turn). When that agent owns the current phase's pending gate, the dismissal also records `dismissed_gate: <phase>`, and the board stops showing the gate as waiting on it until the gate moves or the thread re-enters the phase. Nobody is told, and it approves nothing: the gate stays pending. To move on without that agent, approve the gate with a decision: `factory decide <thread-ref> --gate <gate> --verdict approve --title <t> --as you`, or the board's "Skip <agent>'s review" on that thread. A gate decision also closes the requests still waiting on that gate's reviewer (its proposals and review responses).
- Every other turn, one opened by a `kickoff`, `proposal`, `review`, `review_response`, `question`, `answer`, `dispatch`, `result`, `escalation`, `decision` or `note`, closes only by rule (a) or (b) below: a reply, or an explicit `--resolves`.
- **Factory rule:** turn (m, x) is closed by a later message r when either:
  - (a) `r.from` is x and `r.reply_to` is m's id; or
  - (b) m's id is in `r.resolves` and `r.from` is one of: x, m's sender, the thread lead, the thread owner, `you`, `factory`. The CLI refuses a `resolves` entry from anyone else. A notification closed by your next write is case (b): the message is yours, or it is a `factory` event.
- `decide --reply-to <id>` answers the turn it names; when someone else holds that turn (an escalation to `you` that the lead settles), it also lists it in `resolves`. `decide --gate` closes the escalation turns `you` hold in that thread, and the turn the gate owner holds on the event that put the thread in that gate (its review is moot once `you` decided the gate).
- `--reply-to` and `--resolves` name messages of the same team; the CLI refuses any other id.
- Defaults: `review`, `respond`, `result` and `post --type answer` without `--reply-to` reply to one of your open turns in that thread: `review` to the most recent one, `answer` to the most recent one that is not a notification, `respond` to the latest review awaiting a response, and `result` to the task's latest dispatch to you (else the most recent one). `review` also resolves all of the reviewer's other open turns in that thread.
- The events for `task accept` and `task reject` resolve the result message they act on. Apart from that and the notification rule above, events resolve nothing.
- Re-dispatching a task replies to its latest result while a turn on that result is still open (blocked, failed, or done but not yet accepted), so the lead's turn on it closes (a dispatch by `you` also lists it in `resolves`).
- See your turns with `factory inbox [<member>]` (oldest first); see a thread's with `factory turns [<thread-ref>]`.
- Close every turn you get. Use your role's closing command, a message with `--reply-to <id>`, or `--resolves <id>`. A `note` with neither closes only your notification turns in that thread. If you cannot act, say why in a `question` or `escalation` that replies to the turn.

## 11. Permissions

The CLI and store enforce these; a refusal is error code `permission`.

| Action | Allowed |
|---|---|
| any write except `init` | `--as <member>` from the roster; `--as factory` is refused |
| `post` | thread members, the thread lead, a watch thread's owner, the owner of one of the thread's tasks (a builder it was dispatched to), `you`; `to`/`cc` must be roster members; type `event` refused, and so are the types with their own command (`review`, `review_response`, `dispatch`, `result`, `report`, `alert`); `--type decision` records a decision the way `decide` does (you or the lead) and refuses `--to`, `--cc` and `--internal` |
| `team new` | `you`, or a member whose role is `lead` |
| `team edit` | `you` or the team lead |
| `team archive`, `team restore` | `you` only |
| `thread new`, `thread edit`, `thread set`, `advance`, `task new`, `task edit`, `dispatch`, `task accept`, `task reject`, `issue accept`, `issue reject`, `issue defer`, `watch pause`, `watch resume` | the lead (team lead for `thread new`, thread lead for the rest; `issue accept --thread` needs it on both threads) or `you`. On a single-agent thread the team lead also counts, and its agent (the thread lead) may not `thread edit` or `thread set` |
| `thread eta` | the thread lead or `you`; a gate's owner for its own gate (§7, "Estimates") |
| `merge` | the thread lead or `you`, once `you` signed the thread off (§15, "Merging") |
| `task eta` | the task owner, the thread lead or `you` |
| `review` | the current gate owner only |
| `respond` | the thread lead only |
| `result` | the task owner or the lead |
| `issue new` | anyone who may `post` in the thread |
| `verify` | the owner of a watch or single-agent thread, the lead, or `you` |
| `decide` | `you` or the lead; `--gate` is `you` only; on a single-agent thread `you` only |
| `watch run` | the watch owner or the lead |
| `dispatch --to` | a member with role builder, or the lead itself |
| `resolves` entry | see §10 (b) |

Writes on a team run under the team lock `teams/<team>/.lock`. If a command reports a conflict, retry it; never delete a lock by hand.

## 12. Watch runs

`factory watch run <thread-ref> (--metrics '<json>' | --metrics-file f | --exec) [--from iso] [--to iso] [--note text]` does five steps:

1. **Measure.** Use the metrics given, or `--exec` runs the team's `eval_cmd` in a shell (cwd = root, 10 min timeout) and reads its last stdout line that starts with `{`: `{metric: number}` or `{metrics: {...}}`. That line must be valid JSON; an earlier line is never used instead, so a line holding `NaN` or `Infinity` fails the run. Non-numeric values are an error. A paused thread is an error.
2. **Append** one line to `metrics.jsonl`. Window defaults: from = the previous run's `to` (or the thread's `created`), to = now.
3. **Write the report** `reports/<thread>-<yyyymmddThhmmssZ>.md`.
4. **Open issues on breaches.** A breach is value > `max` or value < `min`. A threshold metric missing from the run is reported `missing`, not a breach. If an `open` or `accepted` issue already exists for this thread and metric, no new issue (the report says so). Otherwise create an issue (gate `null`, source = report path, `metric` set, severity `high` when the breach exceeds the threshold by more than 50% relative, else `medium`) and post an `alert` to the lead.
5. **Verify fixed issues.** Every `fixed` issue of this thread with a `metric` now within threshold becomes `verified`; one still breaching goes back to `open` (history "reopened"). Every issue of this thread still `open` or `accepted` whose metric is now within threshold is listed as `recovered`, in the report frontmatter (`recovered: [I-...]`) and in a body section labelled "recovered without a verified fix — triage". Its status does not change: the lead triages it.

Then the run posts a `report` message (to the lead on breach, else to nobody; cc `you`) and updates `last_run`.

- `factory watch due` lists active watch threads whose `last_run` + cadence is now or past (never run = due).
- `factory verify <issue-ref> --pass|--fail [--note <text>]` is the manual production check for any `fixed` issue: pass → `verified`, fail → `open`.
- `factory watch pause <thread-ref>` and `factory watch resume <thread-ref>` switch `active` and `paused`.

**Fixing a watch issue.** A watch thread has no brief, no review gates and no branch work, so it holds no tasks: `task new` and `issue accept` refuse to put one on it, and its `branch` field is unused (never create a worktree for it). A watch issue that needs a change in the repo is fixed on a project thread of the same team that is in `plan` or later, so the fix is built on that thread's branch and reviewed at `code_review`, `final_review` and `signoff`. The lead:

1. Picks the project thread, or starts one (`factory thread new <team>/<fix-thread> --title "<title>"`), citing `<team>/I-###` and its report in the Brief, and takes it through `brief`, `design` and `design_review`. Meanwhile the issue stays `open`, so later breaching runs track it instead of opening duplicates.
2. Puts the fix on it: `factory issue accept <issue-ref> --thread <team>/<fix-thread> [--action "<task title>"]`, or `factory task new <team>/<fix-thread> --title "<title>" --issue I-###`. The issue becomes `accepted` and its task lives on the project thread. A project thread past `build` goes back to `build`: the new work needs review.
3. Runs the task like any other. Accepting it does not fix the watch issue. The issue becomes `fixed` only when the project thread reaches `done`.
4. Has `you` merge and deploy the fix. The next watch run then verifies the issue if the metric is within threshold, or reopens it. A run between `signoff` and the deploy still measures the old code, so it can reopen a correct fix; the issue's history line says so. In that case defer the issue with the reason "not deployed yet" rather than accepting it again.

A watch issue that needs no change is rejected or deferred with a reason. A `rejected` or `deferred` issue no longer holds back new issues: the next breaching run opens a fresh one for that metric. When a run lists an issue as `recovered`, the lead decides: reject or defer it if the metric came back on its own, or leave it as it is if the fix is on its way or the breach is likely to return.

## 13. Events

The store posts one `event` message `from: factory` for every state change. `thread` is the affected thread, `refs` the affected ids, and the body is one sentence, e.g. "**fable** moved *Checkout v2* from `design` to `design_review` — waiting on **openai**." Frontmatter carries `event: {kind, by, ...}` where `by` is the acting member.

| Kind | Posted for |
|---|---|
| `thread_created` | `thread new` (to the lead) |
| `section_updated` | `thread edit` |
| `thread_config` | `thread set` |
| `phase` | a phase change (entering a review gate: to its owner; back to build or design: to the lead; forward into design, plan or build by anyone but the lead: to the lead) |
| `gate` | a gate status change (the brief gate reset by `respond`: to the lead) |
| `task_created` | `task new`, an accepted stance, `issue accept` |
| `task_status` | `dispatch`, `result`, `task accept`, `task reject` |
| `task_updated` | `task edit` |
| `issue_created` | review points, `issue new`, watch breaches |
| `issue_status` | accept, reject, defer, fixed, verified, reopened |
| `decision` | `decide` |
| `watch_run` | `watch run` |
| `watch_state` | `watch pause`, `watch resume` |
| `eta` | `thread eta`, `task eta`, `dispatch --eta` |

Events that open turns are listed in §10; all others have `to: []`. Done events cc all thread members.

`team new` and `team edit` post no event: messages belong to a thread, and a team-level change has none. The change is in `team.md` and its Git history.

`team archive <team>` (you only; the board's ⋯ menu beside a team) moves the whole team folder to `teams/.archive/<team>-<stamp>/` and posts no event. Nothing is deleted: its threads, messages, tasks and history stay in that folder, the board and `validate` skip it, its open turns leave every inbox, the autopilot's saved sessions for its threads are dropped, and the team id is free for a new team. It is refused while an autopilot run works in the team. `team archived` (and the board's Archived list under Teams) lists archived teams, newest first; `team restore <archived-folder>` (you only; Restore on the board) moves one back to `teams/<team>/` as it was, and is refused while a team with that id is on the board.

## 14. File formats

All `.md` state files are YAML frontmatter plus a Markdown body. Keys are snake_case. The store writes them; you read them. It reads a YAML subset (block and flow maps and lists, plain, quoted and block scalars, `#` comments, a leading byte-order mark; no anchors, aliases or tags) and writes it in one canonical form.

**team.md** (config set with `factory team edit`; the charter body is the one part of `teams/` that `you` or the team lead edit by hand, §17 rule 1):

```
---
id: checkout
title: Checkout
lead: fable
eval_cmd: null
grader: null
data_sources:
  usage: "analytics: weekly checkout starts"
  traces: null
  latency: null
  feedback: "support tickets tagged checkout"
repo_paths: [app/checkout]
created: "2026-11-01T15:30:12.345Z"
---

## Mission
## Scope
## Out of scope
## Working agreements
```

`eval_cmd` prints a JSON object of metrics on its last stdout line. `grader` names who or what grades eval output (informational). `data_sources` has exactly the keys `usage`, `traces`, `latency` and `feedback`. Set them with `factory team edit <team> --eval-cmd <cmd> --grader <text> --data-source "usage=<text>" --repo-paths a,b` (an empty value clears a field). `team edit` rewrites the frontmatter in canonical form, so the template's comments go (this section explains each key), and keeps the charter body as it is.

**threads/<thread>.md**, project:

```
---
id: checkout-v2
title: Checkout v2
kind: project
team: checkout
phase: brief
lead: fable
members: [you, fable, opus-1, opus-2, openai, grok]
gates:
  brief: {by: you, status: pending, at: null, ref: null}
  design_review: {by: openai, status: pending, at: null, ref: null}
  build: {by: fable, status: pending, at: null, ref: null}
  code_review: {by: openai, status: pending, at: null, ref: null}
  final_review: {by: grok, status: pending, at: null, ref: null}
  signoff: {by: you, status: pending, at: null, ref: null}
branch: factory/checkout/checkout-v2
cadence: null
thresholds: null
created: "2026-11-01T15:30:12.345Z"
updated: "2026-11-01T15:30:12.345Z"
eta:
  design: {minutes: 45, by: fable, at: "2026-11-01T16:02:00.000Z"}
  build: {minutes: 180, by: fable, at: "2026-11-01T16:02:00.000Z"}
---

## Brief
## Design
## Plan
## Notes
```

`eta` appears once a phase has an estimate (§7, "Estimates").

**threads/<thread>.md**, watch:

```
---
id: checkout-health
title: Checkout health
kind: watch
team: checkout
phase: active
lead: fable
owner: opus-monitor
members: [you, fable, opus-monitor]
gates: null
branch: factory/checkout/checkout-health
cadence: daily
thresholds:
  error_rate: {max: 0.02}
  success_rate: {min: 0.98}
last_run: null
created: "2026-11-01T15:30:12.345Z"
updated: "2026-11-01T15:30:12.345Z"
---

## What we watch
## Thresholds
## Runbook
```

**comms/<id>.md**, a review:

```
---
id: 20261101T153012Z-openai-1b2c
ts: "2026-11-01T15:30:12.345Z"
thread: checkout-v2
from: openai
to: [fable]
cc: []
type: review
reply_to: 20261101T150000Z-factory-9e01
resolves: []
refs: []
internal: false
gate: code_review
verdict: changes_requested
points:
  - n: 1
    severity: high
    text: Retry loop has no backoff.
  - n: 2
    severity: nit
    text: Rename tmp to attempt.
---

Two points on the retry change.
```

A `review_response` to it ends its frontmatter with:

```
reply_to: 20261101T153012Z-openai-1b2c
...
stances:
  - point: 1
    stance: accepted
    action: Add backoff to the payment retry
  - point: 2
    stance: rejected
    reason: The name matches the existing helper.
```

**tasks/T-###.md**:

```
---
id: T-001
title: Add backoff to the payment retry
thread: checkout-v2
status: todo
owner: null
issue: I-001
refs: []
created: "2026-11-01T15:30:12.345Z"
updated: "2026-11-01T15:30:12.345Z"
eta: {minutes: 30, by: opus-1, at: "2026-11-01T16:40:00.000Z"}
---

Retry the payment call with exponential backoff.

## Acceptance
- Backoff doubles from 200 ms, max 3 tries.
- `npm test` passes.
```

**issues/I-###.md**:

```
---
id: I-001
title: Retry loop has no backoff.
thread: checkout-v2
gate: code_review
source: 20261101T153012Z-openai-1b2c
point: 1
severity: high
status: accepted
raised_by: openai
task: T-001
metric: null
reason: null
created: "2026-11-01T15:30:12.345Z"
updated: "2026-11-01T15:31:02.004Z"
---

Retry loop has no backoff.

## History
- 2026-11-01T15:31:02.004Z accepted by fable: T-001
```

Title = first 80 chars of the point text. `source` is a review id, a report path, or free text such as `sentry:<id>`.

**decisions.md** (append-only; never rewritten):

```
# Decisions — Checkout

## D-001: Use hosted checkout

- ts: 2026-11-01T15:30:12.345Z
- by: you
- thread: checkout-v2
- message: 20261101T153012Z-you-7c1d
- resolves: [20261101T150101Z-fable-0a2b]

Hosted checkout removes PCI scope.
```

A gate override adds `- gate: code_review approve`.

**metrics.jsonl** (append-only; one line per run):

```
{"ts":"2026-11-01T15:30:12.345Z","thread":"checkout-health","window":{"from":"2026-10-31T15:30:00.000Z","to":"2026-11-01T15:30:12.345Z"},"metrics":{"error_rate":0.031},"breaches":["error_rate"],"report":"reports/checkout-health-20261101T153012Z.md","by":"opus-monitor"}
```

**reports/<thread>-<yyyymmddThhmmssZ>.md**:

```
---
thread: checkout-health
ts: "2026-11-01T15:30:12.345Z"
by: opus-monitor
window:
  from: "2026-10-31T15:30:00.000Z"
  to: "2026-11-01T15:30:12.345Z"
status: breach
metrics: {error_rate: 0.031}
breaches: [error_rate]
opened: [I-004]
verified: []
reopened: []
recovered: []
---

| metric | value | threshold | status |
|---|---|---|---|
| error_rate | 0.031 | max 0.02 | breach |
| success_rate | | min 0.98 | missing |
```

Then sections for opened, verified, reopened and recovered issues (the last labelled "recovered without a verified fix — triage") and the run's note.

## 15. Branches and worktrees

- **State in the checkout, code on branches.** `factory/` (committed) and `teams/` (gitignored, local only) live in the shared checkout at the repo root, on `main`. Feature code for a project thread is built on branch `factory/<team>/<thread>` in a worktree outside the shared checkout.
- **Worktree path.** `<parent of repo>/<repo name>-factory/<team>--<thread>`., for example `~/code/app-factory/<team>--<thread>` for a repo at `~/code/app`.
- **`factory worktree <thread-ref>`** prints the branch, the path and the git commands (`git -C <root> fetch origin main`, then `git -C <root> worktree add <path> -b <branch> origin/main`; `git -C <root> worktree add <path> <branch>` when the branch exists locally; and when it exists only on `origin`, `fetch origin main <branch>` then `worktree add --track -b <branch> <path> origin/<branch>`). The branch name is built from the team and thread ids and printed shell-quoted; a thread file whose `branch` field differs is refused. When the team's `team.md` has `setup` (one command line, such as `npm ci`; `team edit <team> --setup <cmd>`), the last command is `cd <path> && <setup>`, so it runs once in the new worktree. It never runs git or the setup. The lead runs the printed commands.
- **The shared checkout never leaves main.** Agents share it, so nobody switches, stashes or resets it, or creates a branch or a worktree inside it. `.claude/worktrees/` is inside it, so builders are never spawned with Agent `isolation: "worktree"`.
- **Run the CLI from the shared checkout only.** A worktree holds its own copy of `factory/` and `teams/`. Running the CLI there would write state onto the feature branch, so that copy refuses writes. Never edit `factory/` or `teams/` inside a worktree.
- **Authorisation.** No agent changes Git unasked. `you` approving a project thread's `brief` gate is the owner's explicit request, for that thread's branch work and only that: the lead creates its branch `factory/<team>/<thread>` and its worktree outside the shared checkout (the printed `worktree add ... -b` creates the branch in the repository and checks it out only in that worktree), builders commit on it, and the lead pushes it and opens a draft PR when the thread reaches `code_review`. It authorises nothing on `main`, nothing for another thread, and nothing for a watch thread, which has no brief and no branch work (§12).
- **The impact note.** When `openai` approves `code_review`, it first posts a `note` to `fable` headed "User impact and what to watch": where users feel the change, what to test before merge, and what to watch after release (the format is in roles/reviewer.md). `fable` copies it to the PR as one comment (`gh pr comment <number> --body-file <file>`) and resolves the note with the comment's URL; `openai` makes no GitHub writes. `grok` plans `final_review` from the latest note, and a later approve posts a new one.
- **Reading Git is always allowed for factory work.** `git diff`, `git log`, `git show`, `git status` and `git rev-parse` on the thread branch or its worktree, and `gh pr diff` or `gh pr view` for its PR, need no further ask.
- **Who does what.**

| Step | Who |
|---|---|
| Create the worktree and branch | lead, after the brief is approved, before the first dispatch; project threads only |
| Commit on the thread branch | builders (the lead for its own document tasks) |
| Push the branch, open the draft PR at `code_review`, push later fix rounds | lead |
| Read the diff (`git diff origin/main...factory/<team>/<thread>` in the worktree, or the PR) | `openai`, `grok`, the lead |
| Merge the thread's PR to main | the lead, with `factory merge`, once `you` signed off (or `you`) |
| Tag, release, deploy | nobody in the factory |

- **Never.** Force-push, rewrite pushed history, push to `main`, or skip hooks (`--no-verify`). Never create or push a tag, use `--tags` or `--follow-tags`, run a workflow (`gh workflow run`) or deploy. Releases are the owner's.
- **Commits.** One imperative subject line naming the surface, unless the repo has its own convention. Configured authorship. Stage explicit paths and commit only those paths: `git -C <worktree> add <paths>`, then `git -C <worktree> commit -m "<Surface>: <imperative summary>" -- <paths>`. Two builders can share the thread worktree and so one Git index; a bare `git commit` would take the other builder's staged files into your commit. Never `git add -A`, `git add .` or `git commit -a`. If Git reports that `index.lock` exists, wait a few seconds and retry; never delete it.
- **Names.** Team and thread ids become branch names (`factory/<team>/<thread>`), so pick ids that read well there.
- **Factory state is never committed.** `teams/` is gitignored (`teams/.gitignore`), so it stays on this machine. Agents write it only through the CLI. It has no Git history, so `git clean -x` deletes it; back it up outside Git if you want a copy.
- **Merging.** `you` approving `signoff` is the owner's go to merge that thread's PR, and only that PR. The done phase event hands the lead a turn, and the lead runs `factory merge <thread-ref>`. It merges only a project thread at `done` with `signoff` approved, only the PR whose head is the thread branch and whose base is `main`, and only if no commit on it is newer than the sign-off (otherwise `you` signs off again). It marks a draft ready, merges with a merge commit pinned to that head (`gh pr merge <n> --merge --match-head-commit <sha>`, never `--admin`), and posts a `merged` event copied to `you`. A plain `gh pr merge` stays refused in lead runs. Tagging and deploying stay the owner's.
- Removing a finished worktree is the owner's call.

## 16. CLI reference

`node factory/bin/factory.mjs <command>`.

- Global options: `--root <dir>` (default `$FACTORY_ROOT`, else the repo holding the CLI), `--as <member>` (default `$FACTORY_AS`), `--json` (exactly one JSON document on stdout, for help and errors too), `--help` / `-h` (per command too). `$FACTORY_NOW` fixes the clock (tests only).
- Exit codes: 0 ok; 1 factory error (stderr `factory: ...`); 2 usage error.
- Bodies: `--body <text>`, `--body-file <path>`, `--body-file -` (reads stdin to the end), a trailing argument, or piped stdin. Piped stdin without `--body-file -` waits 1 s for its first byte: a shell pipe that sends nothing by then is refused (exit 2, nothing written; use `--body-file -` for a slow producer), and a silent stdin inherited from the shell that runs you counts as no stdin. A trailing word that looks like a task, issue, message or thread ref is refused rather than taken as the body.
- Flags: list flags take comma lists (`--to openai,grok`), and repeating one adds to the list. `--point`, `--stance`, `--threshold` and `--data-source` repeat. Any other flag given twice is a usage error.
- `--threshold "<metric><=<v>"` sets a max and `"<metric>>=<v>"` a min. The metric name holds no space, `<`, `>` or `=`; `.5`, `+1` and `1e-3` are numbers. A second bound of the same kind, or a min above its max, is refused.

```
Read:
  members
  team list
  team archived
  thread list [--team t] [--kind project|watch] [--phase p]
  thread show <thread-ref> [--section <name>]
  log <thread-ref> [--brief] [--no-internal] [--limit n]
  show <msg-id>
  inbox [<member>]
  turns [<thread-ref>]
  task list [<thread-ref>] [--status s] [--owner m]
  task show <task-ref>
  issue list [<thread-ref>] [--status s]
  issue show <issue-ref>
  board
  watch due
  worktree <thread-ref>
  validate
  wait <thread-ref> [--timeout 6h]
Write (--as required except init):
  init
  team new <team> --title <t> [--lead m]
  thread new <team>/<thread> --title <t> [--team-title <t>] [--kind project|watch|solo] [--lead m] [--owner m] [--members a,b] [--cadence c] [--threshold "metric<=v" | "metric>=v"]... [--allow "<rule>"]...
  thread edit <thread-ref> --section <name> (--body|--body-file|stdin)
  thread set <thread-ref> [--cadence c] [--threshold "metric<=v" | "metric>=v"]... [--clear-threshold m] [--owner m] [--members a,b] [--add-allow "<rule>"]... [--remove-allow "<rule>"]... [--allow "<rule>"]... [--clear-allow]
  thread eta <thread-ref> --eta <phase>=<time>[,<phase>=<time>...]
  merge <thread-ref>
  team edit <team> [--eval-cmd <cmd>] [--grader <text>] [--data-source "usage|traces|latency|feedback=<text>"]... [--repo-paths a,b]
  team archive <team>
  team restore <archived-folder>
  task edit <task-ref> [--title <t>] [--section <name> (--body|--body-file|stdin)]
  post <thread-ref> --type <type> [--to a,b] [--cc a,b] [--reply-to id] [--resolves a,b] [--refs a,b] [--internal] [body]
  review <thread-ref> --verdict approve|changes_requested|blocked [--point "<severity>: <text>"]... [--points-file f.json] [--reply-to id] [body]
  respond <thread-ref> [--review <msg-id>] --stance "<n>=accepted[: action]" | "<n>=rejected: <reason>" | "<n>=deferred[: <reason>]" ... [--stances-file f.json] [body]
  advance <thread-ref> [body]
  task new <thread-ref> --title <t> [--owner m] [--issue I-###] [body]
  dispatch <task-ref> --to <member> [--eta <time>] [body]
  task eta <task-ref> --eta <time>
  result <task-ref> --outcome done|blocked|failed [body]
  task accept <task-ref> [body]
  task reject <task-ref> --reason <text>
  issue new <thread-ref> --severity high|medium|low|nit --title <t> [--source <text>] [--metric <name>] [body]
  issue accept <issue-ref> [--action <task title>] [--thread <project-thread>]
  issue reject <issue-ref> --reason <text>
  issue defer <issue-ref> [--reason <text>]
  verify <issue-ref> --pass|--fail [--note <text>]
  decide <thread-ref> --title <t> [--reply-to id] [--resolves a,b] [--refs a,b] [--gate g --verdict approve|changes_requested] [body]
  watch run <thread-ref> (--metrics '<json>' | --metrics-file f | --exec) [--from iso] [--to iso] [--note text]
  watch pause <thread-ref>
  watch resume <thread-ref>
  ui [--detach] [--open] [--thread <thread-ref>] [--stop [--runs]] [--at-login | --no-at-login] [--port 4477] [--host 127.0.0.1] [--allow-host a,b]
  autopilot [--detach] [--stop [--runs]] [--dry-run] [--once] [--settle 20s]
  tell <team | team/thread> --from <thread-ref> [--type question|note] [body]
```

`wait` returns when a new message is for `--as`: addressed to them (`to` or `cc`), a reply to one of their messages, or, for the thread's lead, anything `you` writes. Messages nobody is addressed in (an "On it" note, for example) wake nobody.

**Presence.** Every factory command an agent runs (`--as`, or `inbox <member>`) records what it did in `teams/.presence/<member>.json`. A running `wait` records `watching` with its process id. The board shows one badge per agent: `watching` while that `wait` process is alive; `working` for 10 minutes after a command, with what it ran; then `last seen ...`; and `not started` when an agent has no record. The CLI owns these files: never edit them, and they are never committed. Presence only sees factory commands. An agent that reads code or analyses data for a long time looks `last seen` on the board, so when it picks up a turn from `you` it first posts a one-line note in that thread, addressed to nobody: `post <thread-ref> --type note --body "On it: <what it is doing>"`. The note opens no turn and closes none.

**Autopilot.** `autopilot --detach` starts agents that have a headless launcher whenever they hold a turn, so the owner does not relay prompts. A member's `launch` in `factory/members.yaml` names its launcher: `codex` (`openai`) or `claude` (`fable`, `opus-solo`, `security`); `null` means the owner starts it (`grok`). A roster change takes effect when the autopilot restarts; `model` and `effort` edits apply to the next run. Every run gets `FACTORY_ACTOR=<member>`, so its factory commands write as that member and an `--as` for anyone else is refused. A lead run gets a list, the lead first (`fable,opus-1,opus-2,opus-monitor`), so the builders and monitor it starts as subagents write as themselves.

A `claude` run (a single-agent thread's agent) is `claude -p` in the repo root with the model the thread's `roles` picked for it (§6, "Roles"), else the member's `model` (or `$FACTORY_CLAUDE_MODEL`), and the member's `effort` (or `$FACTORY_CLAUDE_EFFORT`), the project's settings only (never the owner's user or local allow lists), no MCP servers, only the Bash, Read, Grep, Glob and Agent (subagent) tools, and permission mode `dontAsk`, which its subagents inherit. A PreToolUse hook (`factory/lib/subagent-guard.mjs`, passed with `--settings`) lets the Agent tool start only the built-in `Explore`, `general-purpose` and `Plan` types, in the run's own checkout: no `isolation` (a worktree is a branch inside the shared checkout), working directory or permission mode, and none of the project's agent definitions. It may read, run read-only commands, the factory commands a single agent needs (`inbox`, `turns`, `thread show`, `thread list`, `log`, `show`, `board`, `members`, `team list`, `task list`, `task show`, `issue list`, `issue show`, `issue new`, `verify`, `post`, `validate`) and the team's then the thread's `allow` rules, each passed as one `--allowedTools=<rule>` argument. Anything else is refused without a prompt. The variables of a Claude Code session that started the autopilot are removed from its environment, and its Bash tool allows a command 10 minutes by default and up to 55 (`BASH_DEFAULT_TIMEOUT_MS`, `BASH_MAX_TIMEOUT_MS`, unless the owner set them). Its run log is Claude Code's stream-json, and the run's cost (`total_cost_usd`) is recorded with its outcome. It keeps one session per thread like openai (`--session-id`, then `--resume`); a run that died before its session started leaves none to resume. The autopilot starts a `claude` member only for turns on single-agent threads it owns, and on a single-agent thread it starts only that thread's agent.

A `claude` run of the lead (`fable`) differs in five ways. It runs in permission mode `auto`, like the owner's own session: a classifier approves each action and what it refuses is refused, never prompted. Its tools add Edit and Write, for its builders. Its guard runs in lead mode (`subagent-guard.mjs lead`): the Agent tool may also start the `builder` and `monitor` types, and Bash refuses the owner's steps (a bare `gh pr merge`: a signed-off PR merges through `factory merge`; create or delete a tag, push to main, force or tag pushes, workflow runs, deploys) and Git commands that move the shared checkout. That guard is a seatbelt against mistakes, not a sandbox. A lead run loads no MCP servers (`--strict-mcp-config`), except the JSON file `$FACTORY_LEAD_MCP_CONFIG` names in the autopilot's environment (unset: `~/.config/software-factory/mcp.json`; empty: none), when it is readable and outside the root (it holds the owner's keys, which never go in the repo); single-agent runs never load it. A lead run may take 3 hours, since it dispatches builders and waits for them. Headless Claude Code stops background subagents 10 minutes after the run's last turn, so every `claude` run gets `CLAUDE_CODE_PRINT_BG_WAIT_CEILING_MS=0`: the run waits for its builders, inside its time limit. The autopilot starts it for turns on project and watch threads it leads, with the kickoff prompt `You are fable, the lead of the software factory. Read .claude/skills/factory/SKILL.md and factory/roles/lead.md and follow them. ...`; a session the owner has open for it still wins (a live `wait`, or a factory command in the last 10 minutes).

A `claude` run of `security` is the single-agent kind above (read-only, `dontAsk`, the same tools and subagent guard), with three differences. The autopilot starts it only for turns on project threads whose `security_review` gate it owns. Its model is the one the thread's roles picked for Security. Its allow list adds `factory review`, `factory worktree`, `git diff`, `git log`, `git show`, `git merge-base` and `npm audit` (`SECURITY_ALLOW` in `factory/lib/autopilot.mjs`), and nothing else. Its instructions are `factory/skills/factory-security/SKILL.md`.

A lead on an OpenAI model (§6, "Roles") runs on Codex instead: `codex exec` in the repo root, on the thread's lead model with openai's reasoning effort, ignoring `~/.codex/config.toml`. It works like the Claude lead's auto mode: commands run in the workspace-write sandbox (the checkout and the worktrees folder writable, network on), and what needs more (a Git write under `.git`, a push, `gh` with the owner's sign-in) is asked for and judged by Codex's automatic reviewer (`approvals_reviewer = "auto_review"`), never the owner. The same lead guard runs as a Codex `PreToolUse` hook on every shell command, so the owner's Git and release steps are refused as for a Claude lead. It loads the HTTP servers of the lead's MCP config; a header's value reaches the run through its environment, never its command line. It starts no subagents, so `FACTORY_ACTOR` is the lead alone. Without a Codex CLI, such a thread's lead turns wait.

**Builders left mid-task.** Builders and the monitor run inside the lead's run and end with it, so when a lead run ends (out of time after 3 hours, a crash or a restart of the machine) while a builder works, nobody works on its task and nothing asks the lead to go on. The autopilot treats such a dispatch as a turn for the lead: for each task a builder still owns in `doing`, its newest open `dispatch` from the lead, posted before the lead's latest run on that thread ended. It starts the lead again on that thread (resuming its session) with a prompt that names those dispatches and asks it to read what each builder committed and spawn the same builder again on each unfinished one. Not after a run the owner stopped, on a thread in `done`, or for a dispatch posted after that run ended (an owner's session, whose builders may still work). A restart the lead ended by itself is not followed by another (it saw the dispatches and left them); one cut off by its time limit or a crash is, at most 2 times in a row on a thread (`MAX_BUILDER_RESTARTS`; `by_thread.<ref>.restarts` in `state.json`). Any run for another turn resets the count. Past it, the thread waits for a new turn, and the autopilot log says so.

**At login.** `ui --at-login` (macOS) writes a launchd login item, `~/Library/LaunchAgents/software-factory.board-<port>.plist`, that runs `factory ui` for this root and port at every login, and starts the board in the background now. The board keeps the autopilot running, and that autopilot takes over the runs a restart of the machine left, so nothing waits on the owner to start it again. The item keeps the installing shell's `PATH`, `LANG` and `FACTORY_*` settings (never `FACTORY_ACTOR`, `FACTORY_ROOT` or `FACTORY_NO_AUTOPILOT`), writes the board's output to `~/Library/Logs/software-factory/board-<port>.log`, and is not kept alive: a board stopped with `ui --stop` stays stopped until the next login. `ui --no-at-login` removes it and leaves a running board running. Start the board with `ui`, never with `node tools/factory-ui/server.mjs`: the server alone runs no autopilot.

**One run per thread.** The autopilot keys runs by member and thread, not by member: a member with turns on several threads gets one run on each, side by side, each in its own session (and, for the lead, its thread's own worktree), up to 4 at once (`MAX_PARALLEL_RUNS`). A thread with a run going waits for that run; a long run on one thread never holds up another. The hourly limit (6 runs) counts per thread. `state.json` keeps each member's live runs in `running_by_ref` (`{thread ref: run}`) and its newest in `running`.

Every run also gets `FACTORY_ROOT=<root>`. With `FACTORY_ACTOR` set, the CLI refuses `ui`, `init`, `autopilot` (except `--dry-run`) and any other `--root`: those are the owner's controls. It also refuses `wait`: a run stops when its inbox is empty, and the autopilot starts it again on its next turn. For a Codex run this binding is a guard against mistakes, not a sandbox: its workspace-write sandbox can run other commands.

A `codex` run (`openai`) is one `codex exec` run per turn, in the repo root, in Codex's workspace-write sandbox with network on and no GitHub sign-in, ignoring the owner's `~/.codex/config.toml` except its model and reasoning effort (so none of the owner's MCP servers or plugins load). openai's `model` and `effort` in `factory/members.yaml`, when set, win over that file. The run works the inbox and exits. `openai` keeps one Codex session per thread: the thread's first run starts it with the kickoff prompt (`You are openai in the software factory. Read factory/skills/factory-openai/SKILL.md and follow it. Work your inbox for thread <ref> until it is empty, then stop ...`), and later runs resume it (`codex exec resume`), so it remembers the brainstorm and the design when it reviews the code. `teams/.autopilot/sessions.json` maps each thread to its session; `autopilot --session <thread-ref>=<id>` makes a thread use an existing Codex session, and a resume that fails is forgotten so the retry starts a new one. `grok` has no headless mode; the owner starts it from the board. The autopilot reads the thread files every 5 seconds and calls no model while idle. It does not start a run for notices (event, alert, report), except a `phase` event that hands the thread to its lead (into design, plan or build), since nothing else asks the lead to go on after an approval, while a run for that member is going, while the owner's own session for it is active (a live `wait`, or a factory command in the last 10 minutes), within `--settle` (20 s) of a new turn, or past 6 runs in an hour. A run that exits with the turn still open is not started again for that turn; a failed run is retried once. Those turns, and the hourly limit, appear in the board's "Needs you" banner with a Copy prompt button. The autopilot keeps its state and run logs in `teams/.autopilot/` (never edit or commit them); `autopilot --dry-run` says what it would start now, and `autopilot --stop` stops it. A stop or restart never interrupts an agent: its runs keep going, and the next autopilot (the board starts one within 30 seconds) takes over every run it finds still going, keeps its time limit and records how it ended, from the run's own log (a run that never finished counts as failed and gets its one retry). A run that ended while no autopilot ran is recorded the same way when one starts. `autopilot --stop --runs` (or `ui --stop --runs`) stops the runs too, and the board's Stop button on a run left going does the same. A run of a member that no longer has a launcher is stopped. One autopilot runs per root (`teams/.autopilot/lock`). A run counts as still running only while its pid's command line holds that run's own session id or output file, so a reused pid is never stopped. Restarting it retries turns a run left open, once; a turn that failed keeps its single retry.

`[body]` means `--body`, `--body-file`, a trailing argument or stdin. `factory ui` starts the Board and Chat UI at `http://127.0.0.1:4477` with the same `--root`. The board has no sign-in, and every write from it acts as `you`. Keep the default loopback `--host`: any other prints a warning, and the board then answers only to this machine's own names plus the `--allow-host` ones.

## 17. Hard rules

1. Write state only through the CLI, only as yourself. Never edit, rename or delete a file under `teams/` by hand; `comms/` files are permanent. The one exception is the charter body of `teams/<team>/team.md` (`## Mission`, `## Scope`, `## Out of scope`, `## Working agreements`), which `you` or the team lead write by hand. Its frontmatter config (`eval_cmd`, `grader`, `data_sources`, `repo_paths`) changes only with `factory team edit`; never touch the frontmatter by hand. Run `factory validate` and `factory team list` after a charter edit: a file that does not parse drops the team from both.
2. Close every turn you are given (§10).
3. Stay inside your role's permissions (§11). The CLI refuses the rest; do not look for a way around it.
4. A gate moves only through `review`, `advance`, the automatic build gate, or `decide --gate` by `you`.
5. Answer every review point with a stance. Reject only with a reason.
6. Ties and owner decisions go to `you` as an `escalation`. Record outcomes with `decide`.
7. The shared checkout stays on main. Feature code lives only in the thread worktree (§15).
8. Only `factory merge` merges to main, and only a PR `you` signed off (§15, "Merging"). Nobody tags or deploys.
9. Never post secrets, passwords, tokens or personal data.
10. Never claim a check, test or run passed without its evidence. Queued is not passed.
11. The repo's own agent instructions (`CLAUDE.md`, `AGENTS.md`) still apply, with the two exceptions §15 states: a project thread's approved brief is the owner's request for that thread's branch work (lead and builders only), and reading Git for factory work needs no further ask.
12. Write to `you` briefly: the ask in one line, then at most three short lines, under 60 words (§9, "Writing to the owner").
