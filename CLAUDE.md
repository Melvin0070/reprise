# Reprise

Collaborative runnable postmortems on a self-hostable code-execution engine: capture a bug as a
reproducible, forkable snapshot, share the link, and co-debug it live with someone else. Built to
carry two Kalvium resumes at once — the sandbox is the backend story, the CRDT collaboration is
the frontend story — and to be defended line by line.

- **Spec:** `flagship-design-plan.md` — APPROVED, reviewed by three eng passes, two design passes,
  and a DX pass. It is the spec, not a suggestion. `reviews/decisions.jsonl` and
  `reviews/learnings.jsonl` are its audit trail.
- **Design:** Modernist, in Claude Design (`reprise/` group) — the source of truth for look and
  feel. Six approved mockups; local sources at
  `~/.gstack/projects/fullstackproject/designs/reprise-modernist-20260714/reprise/`.
- **Deferred work:** `TODOS.md`. **Experiments and incidents:** `docs/learning-log/`.
  **Running record:** `docs/notebook.md`.

## Operating manual

### Start of a session

Read the injected state block — the SessionStart hook prints the branch, working tree, recent
commits, open issues, and the latest notebook entry, so none of that needs asking. If a task
isn't already named, take the lowest-numbered unblocked issue in the current milestone. Skim that
issue for the plan section that governs it, and read that section before writing anything. If
resuming mid-task, run `pnpm verify` first and confirm a green baseline before changing anything.

### Autonomous mode

Melvin is not in the build loop. Set 2026-09-08, superseding the "I build, you review" model
that stood until then: he asked for autonomous delivery, and that is his call to make. Do not
stop for approval, do not propose slice boundaries for review, do not idle between slices.

The loop, one vertical slice at a time:

1. Take the lowest-numbered unblocked issue in the current milestone; read the plan section
   that governs it.
2. Write the failing test from the T-task's own `Verify:` line. Red.
3. Implement until green. Refactor.
4. `pnpm verify` — real output, no exceptions.
5. Run the review gate below. Blocking findings get FIXED in the same slice, never deferred.
6. Branch, commit, PR, merge on green CI. Close the issue.
7. Append what happened to `docs/notebook.md`. Next slice.

Dependency PRs are the one work item the loop's intake misses — they are pull
requests, not issues in a milestone, so nothing above ever selects one. Check open
Dependabot PRs at the start of each session: merge green ones, and when a grouped
one is red, split it (`ignore` the suspect package, then `@dependabot recreate`)
rather than leaving a security patch parked behind an unrelated breakage.

Keep commits small and reviewable anyway — the commit history is read as a senior-engineer
signal and is part of the artifact. Never batch multiple issues into one commit.

**What is lost by Melvin not being in the loop, and the mitigation.** The Project Defense
(Explain → Justify → Tradeoff → Scale & Failure) questions him line by line on code he did not
write. Nothing fully replaces having built it. The mitigation: every slice ships a defense entry
in `docs/notebook.md` answering all four rungs for the code it added. Write those for a reader
who was not there — they are the only study material he will have.

### The review gate replaces the human reviewer

No slice merges without it. With no second pair of human eyes, this gate is the only thing
between a plausible-looking diff and `main`:

- **Always** — `plan-conformance` (diff vs. the T-task's `Files:`/`Verify:` lines, and scope
  creep) and `defense-examiner` (all four rungs per changed file; an unanswerable rung is
  **blocking**, not advisory — it means the code does not explain itself).
- **`worker/` or `infra/` touched** → `threat-auditor` (Opus). Mandatory, never skipped.
- **`web/` touched** → `design-fidelity` + `a11y-auditor`.
- **A shared seam touched** → `contract-guard`.
- Every finding is adversarially verified by a fresh agent before it counts, so noise never
  reaches the fix list. Findings that survive are fixed in the slice that raised them.

### Stop conditions — the only things that still need Melvin

Halt, open an issue labelled `blocked` + `build:melvin`, and say so plainly in the session:

- **Credentials, billing, or identity.** `fly auth login`, `fly secrets set`, creating the
  GitHub OAuth app, provisioning paid infrastructure. These cannot be done on his behalf.
- **Flipping the repo public.**
- **A decision that contradicts the APPROVED spec** rather than filling a gap in it.

Everything else is yours to decide and to do.

### Verify before commit (non-negotiable)

```
pnpm verify   =   pnpm ultracite check && pnpm -r typecheck && pnpm -r test
```

CI runs exactly these three. A red CI is a stop-the-line event: fix it before anything else and
never merge past it. Commit, push and merge freely otherwise.

`main` SHOULD carry a ruleset requiring a pull request and all three CI jobs, so the gate is
mechanical rather than a promise. As of 2026-09-08 it does NOT — creating it was blocked, and the
open item is tracked in `docs/notebook.md`. Check `gh api repos/Melvin0070/reprise/rulesets`; while
it returns `[]`, the review gate is only as strong as this instruction, so do not skip it.

CI additionally runs what cannot run per-commit: Playwright E2E, the isolation suite (Linux runner
only — OV-8), and k6 in the step-3 window. Those are a superset, never a substitute. `pnpm verify`
is what gates a commit.

### Engineering standards (build like a senior engineer)

- **Optimize for the artifact, not the effort.** When weighing a technical decision, give
  essentially NO weight to development cost — solo-dev hours, time pressure, how hard something is
  to write. Weigh quality, simplicity, modern industry practice, robustness, scalability,
  long-term maintainability. Choose the correct, durable design over the expedient one — the proper
  abstraction, the right data structure, the type-safe API, the honest error path — even when a
  shortcut would ship sooner. "It's just a solo project / that's faster to hack" is not a valid
  reason to pick the lesser option.
  - This governs HOW each slice is built, not WHICH slices exist, and it is NOT license to
    gold-plate or add speculative features. Simplicity is itself a quality goal: build the
    highest-quality *simplest* implementation of the thing actually needed now, and reach for
    complexity only when the problem genuinely demands it.
  - **The five budgeted teaching moments below are the only exception.** Everywhere else, build it
    right the first time.
- **Vertical slices, not horizontal layers.** The walking skeleton — `POST /submissions {language:
  "python", code: 'print("hello")'}` reaching terminal `succeeded` with exit 0 and stdout `hello`,
  executed in the jail, on the real Fly target — works end-to-end at every commit. Thicken it.
  Never build a module ahead of the need it serves.
- **Contracts first.** Name the seam every consumer reads. Change it deliberately, version it,
  never fork it per-consumer. The plan already names the load-bearing ones: the run-event schema
  (9A — one schema serves live, `event_log`, and replay), the submission state machine (7A), the
  API error envelope (DX7), and the `content_hash` canonical form (8A).
- **Types over stringly-typed.** Real types and explicit error returns over panics and
  stringly-typed state on the library path. Keep I/O and async at the edges; keep the core sync and
  pure. Concretely: the jail is a pure module from commit 1 — the HTTP handler, and later the
  worker, are thin callers of the same function.
- **Tests are part of done.** New behavior ships with a test. **The canonical guard: recorded
  playback bytes == live bytes (9A).** If that invariant breaks, the product's promise is broken.
- **Honesty in artifacts.** Report the number you measured, the caveat, the coverage. A flake is a
  failure, not a retry. Correct a flattering number when a fuller run contradicts it. No latency or
  throughput number reaches the resume until k6 has actually measured it.
- **Small, conventional commits** (`feat:`/`fix:`/`docs:`/`chore:`), one logical change each,
  message says why.
- **No scope creep.** Planning freeze until v0.1 ships: new thinking goes to `docs/notebook.md` or
  an issue, not a new root-level doc.

### Complexity is earned by evidence — measured, not shipped

The five forks below were budgeted *teaching moments*, and the premise under every one of them was
a human learning by shipping the naive version and watching it break. With Melvin out of the build
loop that premise is gone, so as of 2026-09-08 the mechanism changes:

**Build the correct version first. Prove the naive one wrong in a benchmark, not in production.**

For each fork, still pre-register the experiment in `docs/learning-log/` and still run it — as a
committed benchmark that measures the naive implementation beside the real one. That yields the ADR
with real numbers, which is what the plan actually wanted, while `main` never carries a
known-inferior implementation and no upgrade debt is created.

| Fork | Naive version (benchmark only) | What ships | The number the benchmark must produce |
|---|---|---|---|
| Execution | Inline in the HTTP handler | Redis + BullMQ | Head-of-line blocking under concurrent submits |
| Regex contract (T6) | Native `RegExp` | RE2 | `(a+)+$` wall-clock against a long input, vs. RE2 |
| Event log (T13) | One INSERT per event | Buffered batch writes | Write amplification under print-flood |
| Collab sync (T1) | Broadcast full doc / LWW | Yjs CRDT | Updates lost under concurrent edits |
| Reconnect (T10) | Naive resubscribe | Subscribe-then-backfill + seq dedup | Events lost in the gap window |

Row one is the exception, because it already happened: v0.1's inline execution **is shipped**, and
its experiment is already pre-registered in `docs/learning-log/001-inline-execution.md`. Run that
experiment against the deployed skeleton, record the number, then build the queue. Do not ship a
second inline subsystem on the strength of it.

**One-way doors are built right immediately and never get an experiment.** You cannot A/B a
container escape. Never downgrade: sandbox exposure, worker credential blast radius (OV-10),
committed secrets, auth on execution, egress default-deny, or URL identity (`short_id`, never
`content_hash` — see `reviews/learnings.jsonl`; URLs are forever).

The sandbox ships simple-first by the plan itself, not as a budgeted downgrade: T5 crude jail
(non-root + rlimits + timeout + SIGKILL) → step 3 hardening (namespaces + cgroups v2 + seccomp).
Keep it API-key-gated (OV-1) and never public while crude.

### At a fork

Melvin is not available to decide. Resolve in this order, and never block the loop waiting:

1. **The APPROVED spec decides.** `flagship-design-plan.md` already carries ~60 reviewed decisions
   across four review passes. If it covers the fork, follow it — it is the spec, not a suggestion.
2. **Otherwise the engineering standards above decide.** Optimize for the artifact: quality,
   simplicity, robustness, long-term maintainability. Development cost gets no weight.
3. **Record it either way.** `docs/notebook.md` gets the fork, the options, what was chosen, and
   what evidence would prove the choice wrong. A fork resolved without a record is a fork that gets
   relitigated by the next session.
4. **Load-bearing and genuinely balanced?** Choose, ship, and label the issue `defense-critical` so
   it surfaces for Melvin's review later. Deciding badly is recoverable; stalling is not.

### The learning log

Every experiment gets an entry in `docs/learning-log/` — see the README there for the shape. These
become the ADRs the plan requires (2-4), except with real data in them, and they are the
self-critique Premise 6 demands. Write them honestly: "I measured the simple version to justify the
complex one," never "I always knew." Interviewers can smell theater.

`docs/notebook.md` is the append-only running record — every experiment, measurement, decision, and
dead end. Dead ends are the highest-value entries: they are why the locked decisions stay locked.

### Decisions already locked (don't relitigate)

The full set lives in `flagship-design-plan.md`; `reviews/decisions.jsonl` is the audit trail.
These are the ones that get relitigated in practice — each with the evidence that settled it.

| Decision | Evidence |
|---|---|
| TypeScript everywhere; NestJS + React. Go is post-v1 and on no resume until built. | One language across both halves maximizes openings and lets both resumes claim the work credibly. |
| Fly.io Machines or a root VPS. Never Railway. | The sandbox needs real kernel privileges; Railway grants no privileged containers or cgroups-v2 / user-namespace delegation. |
| No Docker on the sandbox path at step 1 (5A). | The crude jail spawns processes directly and step 3 hardens it in place — zero throwaway isolation code, real target from day one. |
| `short_id` is the only public identifier. Never `content_hash`. (E7) | `content_hash` excludes title/description, so an unedited fork is byte-identical to its parent — a content_hash URL collides at the first fork. URLs are forever. |
| GitHub OAuth only in v1.0. (D15) | It supplies the avatar + handle that D5's presence labels need. Email/password is out. |
| v1.0 is stdlib-only. (OV-2) | Third-party deps contradict default-deny egress; lockfile pinning lands in v1.1 with deterministic re-run, where it belongs. |
| Execution is auth-gated. (OV-1) | A public endpoint running untrusted code is an abuse magnet. One narrow exception: OV-6 guest-run on seeded public postmortems only. |
| Workers hold no DB or object-store credentials. (OV-10) | A sandbox escape is a residual accepted risk — it must reach at most one worker, never Postgres. This is the Scale-and-Failure answer for the headline risk. |
| No AI in this flagship. | GenAI and Data get separate focused projects; the engine is positioned so an agent layer plugs in later without rework. |
| Verdict stays mono — ink check, no green token. (D6) | Modernist is a deliberately single-accent system. Green is a documented exception only on user-test evidence. |
| The scripted ghost participant is dead, not deferred. (D14) | A fake teammate is a Defense liability in a product whose thesis is real multiplayer. |
| Wake fires on enqueue, not just on landing. (E16) | Redis/BullMQ is invisible to Fly's proxy — landing-only wake leaves a deep-linked or API run queued forever on a stopped worker. |
| The signed-out read-only live room is v1.1. (E6) | It silently reintroduced the roles subsystem deferred to v1.1 and carried five unbudgeted findings. |

### Skill routing

When the request matches a skill, invoke it via the Skill tool. When in doubt, invoke the skill.

- Product ideas / brainstorming → `/office-hours`
- Strategy / scope → `/plan-ceo-review`
- Architecture → `/plan-eng-review`
- Design system / plan review → `/design-consultation` or `/plan-design-review`
- Full review pipeline → `/autoplan`
- Bugs / errors → `/investigate`
- QA / testing site behavior → `/qa` or `/qa-only`
- Code review / diff check → `/review`
- Visual polish → `/design-review`
- Ship / deploy / PR → `/ship` or `/land-and-deploy`
- Save progress → `/context-save` · Resume context → `/context-restore`
- Author a backlog-ready spec/issue → `/spec`
