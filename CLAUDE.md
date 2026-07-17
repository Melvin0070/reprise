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

### Collaboration mode — "I build, you review."

Melvin is a final-year student with ~1.5 years experience, learning proper software development.
Work ONE vertical slice at a time and teach through it:

1. State the contract and the test you'll write.
2. Test-first: red → green → refactor.
3. Show the diff and the WHY behind each choice.
4. WAIT for review and approval before committing or merging.
5. Next slice.

Keep commits small and reviewable. Never batch multiple issues silently. This is a learning
collaboration, not autonomous delivery — code Melvin never reasoned through is code he cannot
defend, and the Project Defense (Explain → Justify → Tradeoff → Scale & Failure) checks every line.

### Slice boundaries are mine to approve

On a multi-part issue, propose the slice boundaries — or the reason to merge them — BEFORE
building, and let Melvin decide. Never collapse a review checkpoint unilaterally.

### Verify before commit (non-negotiable)

```
pnpm verify   =   pnpm ultracite check && pnpm -r typecheck && pnpm -r test
```

CI runs exactly these three. A red CI is a stop-the-line event. Commit or push only when asked.

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

### Complexity must be earned by evidence

Build the simple version, measure where it breaks, let the numbers buy the complex version. This is
not sandbagging — it is how you avoid premature optimization, and it produces the tradeoff evidence
the Project Defense demands. It governs at the five forks below and nowhere else.

Guardrails — a downgrade without all five is just bad code with a story attached:

- **No downgrade without a pre-registered experiment.** Before choosing the simple version, write
  down how we will make it fail and what we will measure, in `docs/learning-log/`. If neither of us
  can name that experiment, the downgrade teaches nothing — build it right the first time.
- **A downgrade never reaches an unauthenticated surface.** The experiment runs locally or behind
  the OV-1 key. Measuring a ReDoS in a unit test is the lesson; shipping one is not.
- **The simple version is a swap, not a wall.** Factor the seam first, so the upgrade replaces a
  module rather than a subsystem. If the upgrade would be a rewrite, this isn't a teaching moment —
  build it right the first time.
- **One-way doors get built right immediately.** You cannot A/B a container escape. Never
  downgrade: sandbox exposure, worker credential blast radius (OV-10), committed secrets, auth on
  execution, egress default-deny, or URL identity (`short_id`, never `content_hash` — see
  `reviews/learnings.jsonl`; URLs are forever).
- **WIP limit: max 2 open downgrades.** The upgrade PR is scheduled before the downgrade lands.
  Debt that never gets paid isn't a lesson, it's just debt.

| Fork | Simple version | Upgrade | Lesson |
|---|---|---|---|
| Execution (v0.1) | Inline in the HTTP handler | Redis + BullMQ | Head-of-line blocking, no backpressure |
| Regex contract (T6) | Native `RegExp` | RE2 | ReDoS — user input as a DoS vector |
| Event log (T13) | One INSERT per event | Buffered batch writes | Write amplification under print-flood |
| Collab sync (T1) | Broadcast full doc / LWW | Yjs CRDT | Concurrent edits clobber — why CRDTs exist |
| Reconnect (T10) | Naive resubscribe | Subscribe-then-backfill + seq dedup | Silent data loss in the gap window |

**This table overrides the plan where they conflict** — specifically 5A/step 1, which specifies
`submit → queue → worker`. v0.1 runs inline; the queue is earned. Every other 5A commitment (crude
jail, no Docker, deployed day 1, OV-1 key gate) stands untouched.

The sandbox ships simple-first by the plan itself, not as a budgeted downgrade: T5 crude jail
(non-root + rlimits + timeout + SIGKILL) → step 3 hardening (namespaces + cgroups v2 + seccomp).
Keep it API-key-gated (OV-1) and never public while crude.

### At a fork

**Normal fork** — an unplanned decision the plan doesn't cover, where reversing is cheap: present
the plan's prescription, the simpler option, the experiment that would expose the difference, and a
recommendation. Keep it to a compact block. Melvin decides.

**Load-bearing fork** — where a competent engineer would plausibly choose differently AND reversing
later costs real work: lay out the options and their consequences and WITHHOLD the recommendation.
Melvin picks and states a one-line why first. Then compare, and record both positions in
`docs/notebook.md` — including the disagreement, and including which of us the evidence later
proved right.

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
