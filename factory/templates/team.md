---
id: "{{id}}"
title: "{{title}}"
lead: "{{lead}}"
eval_cmd: null          # shell command that prints a JSON object of metrics on its last stdout line
grader: null            # who/what grades eval output: a member id or a command (informational)
setup: null             # one command run in each new worktree, e.g. "npm ci"
data_sources:
  usage: null           # where usage numbers come from (e.g. "analytics: weekly checkout starts")
  traces: null
  latency: null
  feedback: null        # e.g. "support tickets tagged checkout"
repo_paths: []          # repo paths this team changes, e.g. [app/checkout]
created: "{{created}}"
---

## Mission

_What this team exists to improve for users, in one or two sentences._

## Scope

_The product areas, repo paths and metrics this team owns._

## Out of scope

_What this team does not touch, and who owns it instead._

## Working agreements

- Every state change goes through `node factory/bin/factory.mjs` (see factory/PROTOCOL.md); never hand-edit comms/, tasks/ or issues/.
- Build in the thread's worktree (`factory worktree <team>/<thread>`); the shared checkout stays on main.
- Answer every open turn (`factory inbox`) before starting new work.
