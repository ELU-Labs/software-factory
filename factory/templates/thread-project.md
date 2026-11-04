---
id: "{{id}}"
title: "{{title}}"
kind: project
team: "{{team}}"
phase: brief
lead: "{{lead}}"
members: [you, "{{lead}}", opus-1, opus-2, openai, grok]
gates:
  brief: {by: you, status: pending, at: null, ref: null}
  design_review: {by: openai, status: pending, at: null, ref: null}
  build: {by: "{{lead}}", status: pending, at: null, ref: null}
  code_review: {by: openai, status: pending, at: null, ref: null}
  final_review: {by: grok, status: pending, at: null, ref: null}
  signoff: {by: you, status: pending, at: null, ref: null}
branch: "factory/{{team}}/{{id}}"
cadence: null
thresholds: null
created: "{{created}}"
updated: "{{created}}"
---

## Brief

_Problem: what is wrong today, for whom, and the evidence (issue links, numbers)._

_Users: who is affected and how often._

_Success criteria: the measurable result that means this thread is done._

_Out of scope: what this thread will not change._

## Design

_The approach, the alternatives rejected and why, the risks and how we will test it._

## Plan

_The tasks in order; create each with `factory task new <team>/<thread> --title <t>`._

## Notes

_Links, open questions and anything the team should remember._
