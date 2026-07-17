# Learning log

Reprise is built **baseline-then-justify**: build the simple version, measure where it breaks,
let the data buy the complexity. This directory is the record of those experiments.

Each entry is one incident — one fork in the road, the simple thing we tried, the number that
killed it, and what replaced it. They are written *as they happen*, not reconstructed after.

This is not a confession log. Measuring the naive version before building the complex one is
how you avoid premature optimization — it's the same reason you profile before you optimize.
The entries exist so that every "we chose X over Y" in this repo has a number behind it
instead of an opinion.

## Why this exists

- **It's the ADR set the plan requires** (2-4 ADRs, success criteria) — with real data in them.
- **It's the self-critique Premise 6 demands.**
- **It's the Tradeoff rung of the Project Defense**, pre-answered with evidence.

## Rules

1. **No entry without a pre-registered experiment.** The "How we'll break it" section is
   written *before* the simple version ships. If we can't name the experiment, we don't
   downgrade — we build it right.
2. **Real numbers or it didn't happen.** Paste the actual output: k6 summaries, timings,
   flamegraphs, logs. No "it was slow."
3. **Honest framing.** "I measured the simple version to justify the complex one." Never
   "I always knew." If something surprised us, say it surprised us — that's the valuable part.
4. **One-way doors never get an entry**, because they never get downgraded. Security on
   untrusted execution, worker credentials, secrets, URL identity. See `CLAUDE.md`.

## Naming

`NNN-short-slug.md` — e.g. `001-inline-execution.md`, `002-regex-redos.md`.

## Template

```markdown
# NNN — <the fork, in plain words>

- **Task:** <T-number / plan step>
- **Status:** baseline shipped | broken | upgraded
- **Simple PR:** #N · **Upgrade PR:** #M

## The fork

What decision came up, and why it wasn't obvious.

## Options

| Option | What it costs | What it buys |
|---|---|---|
| <simple> | | |
| <plan's prescription> | | |

## What we chose, and why

The simple one, deliberately — plus the reason it was a reasonable place to start.

## How we'll break it (pre-registered, written BEFORE shipping)

The experiment. What we run, what we measure, what number means "this failed."

## Baseline

Real numbers from the simple version working normally.

## The failure

Real numbers, real logs, from the experiment above. What actually happened, including
anything that surprised us.

## The fix

What we changed and why it addresses the mechanism — not just the symptom.

## After

Same measurement, post-upgrade.

## The delta

The one number that justifies the complexity. This is the sentence that goes on the resume
(only after it's measured — see the plan's `[MEASURE]` rule).

## How I'd catch this earlier next time

The generalizable lesson. What smell, metric, or test would have caught this at design time?

## Defense answer

- **Explain:** what it does
- **Justify:** why this design
- **Tradeoff:** what it cost, what we gave up
- **Scale & Failure:** where it breaks next, and what we'd do about it
```
