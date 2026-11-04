---
id: "{{id}}"
title: "{{title}}"
kind: watch
team: "{{team}}"
phase: active
lead: "{{lead}}"
owner: "{{owner}}"
members: [you, "{{lead}}", "{{owner}}"]
gates: null
branch: "factory/{{team}}/{{id}}"
cadence: daily
thresholds: {}
last_run: null
created: "{{created}}"
updated: "{{created}}"
---

## What we watch

_The user journey or system this watch protects, and where each number comes from (team.md data_sources)._

## Thresholds

_Why each threshold sits where it does. The frontmatter `thresholds` is what runs are checked against._

## Runbook

_What the monitor checks first on a breach, what goes in the run's note, and when the lead escalates to **you**. A fix that needs a code change is built in a project thread, never on this watch thread (factory/PROTOCOL.md §12, "Fixing a watch issue")._
