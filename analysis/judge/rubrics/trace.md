---
title: Process (trace)
target: trace
extra: |
  "loops": [{ "turns": "12-19", "what": "what it kept going around", "brokenBy": "what finally got it out, or 'never'" }],
  "verification": ["each distinct way it checked its work, e.g. 'ran full test suite', 'compared screenshots to design/'"],
  "wastedTurnsEstimate": 0
---
# Dimension: process (agent trace)

This time you're judging **how the agent worked**, not the code. `trace.md` in the working
directory is a condensed transcript of the agent's session: every turn's thinking (trimmed),
each tool call, and the start of each result. Measured facts about the trace are below in
place of code facts. The app the agent produced is in `app/` if you need to check something.

Read `trace.md` in full (in chunks with `read`'s offset and limit), then score.

## Criteria

**`circularity`** — Does the agent go round in circles: re-deriving the same plan, re-reading
files it just read, re-running the same failing command, flip-flopping between two
approaches, or re-fixing the same test without new information?
- 5: Steady progress; every turn adds information. 3: One or two loops it gets out of on its
  own. 1: Long stretches of repetition.

**`debugging`** — When something fails, does it read the error, form a hypothesis, test it
and fix the cause, rather than guessing or patching symptoms?
- 5: Systematic. 3: Gets there with some flailing. 1: Shotgun edits.

**`verification_quality`** — How well it checked its work: did it run the full suite after
its last change, look at the result in a browser or against the reference screenshots,
check edge cases the tests don't cover, or only re-run the one test it was fixing?
- 5: Thorough and proportionate, and re-verified after the final edit. 3: Tests only.
  1: Stopped without confirming the final state.

**`tool_use`** — Effective use of tools: few failed calls, edits that apply first time,
reasonable use of search/docs/MCP/skills when unsure, no wasteful large reads.
- 5: Efficient. 3: Some waste. 1: Many failed or pointless calls.

**`planning`** — Did it understand the task up front and work in a sensible order, or
discover requirements late and redo work?
- 5: Clear plan, little rework. 3: Some rework. 1: Mostly rework.

Set `wastedTurnsEstimate` to roughly how many turns could have been skipped.
