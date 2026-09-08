---
description: Run the review gate on the current slice — the machine reviewer that replaces the human one.
---

Run the review gate defined in `CLAUDE.md`. No slice merges without it.

With no human reading each diff, this gate is the only thing between a
plausible-looking change and `main`. Run it after `pnpm verify` is green and
before opening the PR.

## 1. Get the diff

```
git diff main...HEAD --stat
git diff main...HEAD
```

Identify the issue and T-task this slice implements. Read the T-task's own
`Files:` and `Verify:` lines out of `flagship-design-plan.md`, and read the plan
section that governs it. Reviewers need that context in their prompt — they do
not have this conversation.

## 2. Select lenses by what the diff touches

| Condition | Agent | Model |
|---|---|---|
| **always** | `plan-conformance` | Sonnet |
| **always**, unless the diff is docs-only | `defense-examiner` | Opus |
| `worker/` or `infra/` touched | `threat-auditor` | Opus |
| `web/` touched | `design-fidelity` + `a11y-auditor` | Sonnet |
| a shared seam touched (`shared/*`, event schema, state machine, error envelope, `content_hash`) | `contract-guard` | Sonnet |

**Docs-only carve-out.** A diff that touches only `docs/`, `README.md`, or the
notebook gets `plan-conformance` alone. The Defense rungs interrogate whether
code explains itself; prose has no mechanism behind it for them to bite on, so
running them there produces noise, not safety. Any diff with a code, config, or
workflow file in it is not docs-only.

## 3. Launch them in parallel

One message, multiple Agent calls, so they run concurrently and cannot anchor on
each other. Give each one:

- the branch name and how to get the diff
- the issue number and T-task number
- the T-task's `Files:` and `Verify:` lines verbatim
- anything about the slice that is genuinely load-bearing and not obvious

Do **not** tell them what you think the answer is.

## 4. Verify every finding adversarially

A finding only counts once a **fresh** agent has tried to disprove it and failed.
For each BLOCKING finding, launch a `general-purpose` agent whose task is to
argue the finding is wrong: read the code, check whether the failure scenario
actually holds, and report `CONFIRMED` or `REFUTED` with evidence.

This is what keeps the gate credible. A gate that always finds something teaches
the loop to ignore it.

## 5. Act on what survives

- **Blocking findings are fixed in this slice.** Never deferred to an issue,
  never carried to the next slice. That rule is the whole reason the gate can
  stand in for a human reviewer.
- An unanswerable Defense rung is blocking. The fix is usually a `why` comment
  or a notebook entry, not a rewrite.
- Re-run `pnpm verify` after fixing, then re-run the gate on the amended diff if
  the fix was substantial.

## 6. Record

Append `defense-examiner`'s DEFENSE ENTRY to `docs/notebook.md` for this slice.
That entry is the only study material that exists for code nobody on this side
of the keyboard wrote — write it for a reader who was not there.

Then open the PR with the real `pnpm verify` output and a one-line note of what
the gate found and how it was resolved.
