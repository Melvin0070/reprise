# Notebook

The append-only running record — every experiment, measurement, decision, and
dead end. Dead ends are the highest-value entries: they are why the locked
decisions stay locked.

Decisions predating this file live in `reviews/decisions.jsonl` and the plan;
this log starts where it was created rather than back-filling from memory.

---

## 2026-07-25 — Production build: source in dev, `dist` in prod (4a.1)

**Context.** The walking skeleton had no build. Every workspace package exports
its `.ts` source directly, which vitest and `tsc --noEmit` read natively but
`node` cannot run — so there was no artifact to deploy. The deploy forced the
seam. Constraint: add a production build without giving up the zero-build dev
loop, because that loop is a real DX asset (edit a shared file, typecheck against
it, no rebuild).

**Fork (load-bearing — a competent engineer differs, and reversing touches every
`package.json`).** Two options were laid out and the recommendation withheld:

- **A — `tsc` project references + dual-condition exports.** Each package exposes
  `development` → `.ts` and `default` → `dist/*.js`; `tsc -b` builds the graph.
  Uses only tools already in the repo.
- **B — bundle per service with tsup/esbuild.** One inlined `dist/main.js`, no
  exports change, but a new bundler dependency and NestJS's reflect-metadata /
  optional-platform footguns to configure.

**Decision: A.** Chosen for no new dependency and the standard durable monorepo
shape. The `default`/`development` split is the whole trick: vitest activates
`development` on its own (zero config), `tsc` does once `customConditions` names
it, and a plain `node` run sets neither so it falls to `default` → `dist`.

**Verified before writing, because TS 7 is the native (Go) compiler and its
behavior can't be assumed:** it emits `dist`, honors `customConditions`, emits
`design:paramtypes` for Nest DI, and `tsc -b` orchestrates references. A
discriminating probe (source and `dist` returning different strings) confirmed
vitest loads source and `node` loads `dist`. Full picture proven end to end by
`main.smoke.test.ts` spawning the compiled server.

**Cost noted:** the dual-condition exports are the fiddly part of TS monorepos,
and project references add composite/`tsbuildinfo` machinery whose incremental
benefit is marginal at four packages. Accepted as the price of the durable seam;
revisit if build time ever bites.

---

## 2026-07-25 — Hosting and cost posture (4b prep)

**Fly stays — reconfirmed, not relitigated.** Research across three fronts
confirmed the locked decision for the reason it was locked: a custom sandbox
(namespaces + cgroups v2 + seccomp) has to run in a host you get a kernel in.
Every managed PaaS (Render, Railway, Cloud Run, Fargate, Cloudflare Containers,
Vercel/Netlify functions) is disqualified — they spend the namespace budget
isolating you from them. Fly Machines are Firecracker microVMs with their own
kernel and real root. Koyeb (documented privileged toggle) is the one credible
fallback; a root VPS (Hetzner ~€5.49/mo, netcup ~€3.08/mo) is the other.

**No free tier clears the bar cleanly.** Fly removed its free allowance in Oct
2024. Oracle Always Free is the only genuinely-free option with a real kernel,
but its documented policy reclaims instances idle under 20% over 7 days — exactly
a demo sandbox's profile — so it's unfit as the primary. Cost was never the
constraint anyway: one 256–512MB machine with scale-to-zero is ~$0.30/mo idle.

**Dead end recorded — there is no hard spend cap on Fly.** Not even a soft
alert. The widely-repeated "exhaust prepaid credits → apps suspend" advice is
stale; Fly support (Jun 2026) confirms credits are prepayment and any overage
bills the card on file. The real bound is structural: Fly Proxy never
auto-provisions, so worst-case compute = (machines you created) × size × 730h.
Mitigation: create exactly one small machine, scale-to-zero, no volumes, shared
IPv4. Untracked tail = egress; bounded in practice by the OV-1 key gate.

**Decision:** deploy live with scale-to-zero rather than deploy-verify-destroy.
At ~$0.30/mo a live URL an interviewer can hit is worth more than the pennies
saved. Follow-up for `TODOS.md`: per-key run quotas and per-run wall-clock caps
are billing controls, not only security controls.

---

## 2026-09-08 — Autonomous delivery replaces "I build, you review"

**The change.** Melvin asked to be out of the build loop entirely: "I dont wish to be involved
in the development... can you make it autonomous instead." That supersedes the collaboration
model this repo has run under since day one, and it is his call. `CLAUDE.md` was rewritten in
four places to match — the loop, the review gate, the fork protocol, and the budgeted downgrades.

**What this costs, stated plainly.** The Project Defense (Explain → Justify → Tradeoff → Scale &
Failure) questions him line by line on code he did not write. Nothing fully substitutes for
having built it. This is a real, accepted cost, not a solved problem.

**The mitigation.** Two mechanisms, both cheap because they ride work the gate does anyway:

1. `defense-examiner` runs on every slice and judges the four rungs **from the repository only** —
   never from the session that produced the diff. An unanswerable rung is blocking. The practical
   effect is that code which needs narration to make sense cannot merge, so the repo is forced to
   explain itself to a reader who was not there. That reader is Melvin, later.
2. Every slice appends a four-rung defense entry to this notebook. It is the study material.

**Consequence: the five budgeted downgrades are dead, and that is an improvement.** Their entire
premise was a human learning by shipping the naive version and watching it break. With no human
learner, shipping known-inferior code buys nothing and costs an upgrade cycle on five subsystems.
Replaced with: **build the correct version first, prove the naive one wrong in a committed
benchmark.** The learning-log entry still gets its real number — which is what the plan actually
wanted from those forks — and `main` never carries the inferior implementation.

The one exception is row one: inline execution is already shipped and its experiment is already
pre-registered (`001-inline-execution.md`). Run it against the deployed skeleton, take the number,
then build the queue.

**Fork policy without a decider.** Order: the APPROVED spec decides (it holds ~60 reviewed
decisions); failing that, the engineering standards decide; record it here either way; if it is
load-bearing and genuinely balanced, choose, ship, and label `defense-critical` for later human
review. Stalling is worse than deciding.

**Open items that need Melvin — the irreducible set.** Everything here is credentials, billing,
or identity, which cannot be done on his behalf:

- `flyctl` is **not installed** and no Fly session exists. Issue #4 (deploy + OV-1 gate) cannot
  proceed past config until `fly auth login`, app creation, and `fly secrets set REPRISE_API_KEY`.
- GitHub OAuth app (D15) for S2 — created in GitHub settings, secret set on Fly.
- Postgres/Redis provisioning when S5 needs them.
- Flipping the repo public.

**Blocked, not irreducible — retry these.** Two GitHub governance writes were refused by the
permission layer this session: the `main` ruleset (require PR + the three CI checks) and enabling
auto-merge. Both are mechanical and both matter more now than they did under human review, because
the ruleset is what stops a red CI reaching `main` when nobody is watching.

---

## 2026-09-08 — Fly Sprites evaluated; Fly Machines stays

**The question.** Fly launched **Sprites** (announced Jan 2026) — instant-create Linux VMs
with root, a 100GB object-storage-backed root filesystem, auto-sleep, no time limit, aimed
squarely at running coding agents. Since Reprise's backend half *is* a sandbox for untrusted
code, this needed a real answer rather than an assumption.

**Sources.** `fly.io/blog/design-and-implementation/` (Thomas Ptacek, 13 min, last updated
2026-01-14), plus the Sprites blog and docs index at `docs.sprites.dev`.

**What Sprites actually are.** Fly Machines with three decisions reversed: no user container
(every Sprite boots from one standard image, so pools of empty Sprites stand by and create is
~1-2s); disks rooted in S3-compatible object storage with NVMe as a read-through cache, via a
hacked JuiceFS with a SQLite metadata backend kept durable by Litestream; and *inside-out
orchestration*, where the orchestration services run in the VM's root namespace.

**Why this does not replace Fly Machines for us — the load-bearing sentence.** From the post:
"user code running on a Sprite isn't running in the root namespace. We've slid a container
between you and the kernel."

That is precisely the thing the locked hosting decision exists to avoid. Step-3 hardening needs
namespaces + cgroups v2 + seccomp applied *by us*, which requires either real root in the root
namespace or verified user-namespace and cgroup delegation into the inner container. A Fly
Machine is a Firecracker microVM with its own kernel and root in the root namespace — no
question to answer. A Sprite puts a Fly-managed container in between, which turns "can we
build the sandbox here" back into an unverified premise of exactly the kind DX4/V5 forced us
to spike before trusting.

**Decision: no change.** `fly.toml` and the Machines target stand. Sprites is not a downgrade
we rejected on taste; it is a different product optimized for interactive agent workloads with
aggressive sleep, and its central design choice is antagonistic to ours.

**What would prove this wrong:** documented evidence that a Sprite's inner container gets
cgroups-v2 delegation and unprivileged user namespaces (an `unshare -Ur` that succeeds, a
writable `/sys/fs/cgroup` subtree). If that turns out to be true, Sprites' 1-2s create and
scale-to-near-zero would be a genuinely better fit than a Machine with `auto_stop`, and this
entry should be reopened. Not worth spending the spike now: the Machines path is already
proven by `infra/smoke-image.sh` and needs no new premise.

**Unrelated, and worth reading anyway.** The post is a good senior engineer explaining sandbox
tradeoffs — containers vs. microVMs, object-storage-rooted disks, why attached storage anchors
workloads to physicals. Useful Defense ammunition on the Scale & Failure rung.

**Also noted, without alarm.** Sprites, E2B and Modal all being in this space is the premise
the plan already stated ("the same core product Judge0, Piston, E2B, and Modal sandboxes are
built on"). A well-marketed product in the same space makes the domain more legible to a
reader, not less — the signal was never that nobody else built one.
## 2026-09-08 — Supply chain: CI token scope and dependency updates (defense entry)

First slice through the new review gate, and the gate earned its keep immediately:
`defense-examiner` returned five blocking findings against a two-file diff I had
written, four of which were factual errors in my own comments. All five were verified
against the files and fixed in the same slice, per `CLAUDE.md`. Recording them because
the corrections are more useful than the change.

**What the gate caught.** (1) The file opened by asserting the repo has two supply
chains; it has three, and the missing one is `infra/Dockerfile` — the artifact
`fly.toml` deploys, whose apt layer *is* the jail's userland (`prlimit` and `python3`).
(2) The comment claimed weekly checks protect "those pins"; `ci.yml` uses floating
major tags, not SHA pins, so a force-moved tag leaves the version looking current and
Dependabot opens nothing. (3) The actions group omitted `update-types`, so it silently
included majors — the exact opposite of the policy stated three lines above it. (4) The
coverage claim ignored `pnpm-workspace.yaml`'s `catalog:` block, where `@types/node`,
`typescript` and `vitest` actually live. (5) A red grouped dependency PR had no owner:
the loop's intake is issues in a milestone, and a PR is neither.

**Explain.** `permissions: contents: read` replaces the default `GITHUB_TOKEN` scope
for all three CI jobs. `dependabot.yml` schedules weekly updates for docker, GitHub
Actions and npm, grouped to one PR per ecosystem with majors excluded from the groups.

**Justify.** The workflow checks out, installs, and runs three gates; it writes nothing.
A write scope no step uses is spendable by any of the four third-party actions or the
whole npm tree that `pnpm install` pulls in. Declared at workflow level because a job
added later then inherits read-only and must opt into more — the mistake points the
safe way. Grouping exists because the loop merges on green: twelve single-dependency
PRs a week would bury the milestone work.

**Tradeoff.** Grouping trades bisection for quiet — a red group names the failing gate,
not the failing package, and a security patch bundled with a breaking minor waits on the
breakage. The `permissions` block buys a future 403: the planned container-publish job
must declare `packages: write` itself. Both accepted; both now written where the next
reader hits them.

**Scale and failure.** Two silent-failure paths are live and UNVERIFIED until the first
weekly run: `infra/dev/linux-test.Dockerfile` does not use the default filename and may
not be scanned, and a catalog-unaware npm update could bump the root manifest while
leaving `pnpm-workspace.yaml` behind — producing a workspace compiling against two
TypeScript versions with every gate green. A dependency updater doing nothing is
indistinguishable from a repo with no outdated dependencies, so both need confirming
against real PRs rather than assuming.

**The catalog finding escalated on a second look.** `plan-conformance` independently
reached the same `catalog:` gap and went further, naming two open upstream bugs. Both
verified against the tracker rather than taken on the agent's word:
`dependabot-core#14339` (open, 2026-03-03) — a catalog dependency's committed lockfile
update drops an entry from the catalogs block, and that lockfile then fails
`pnpm install --frozen-lockfile`, the first step of the verify job; and
`dependabot-core#16049` (open, 2026-08-27) — a catalog dependency that also resolves
elsewhere in the lockfile, routine for exactly these three, resolves to the wrong
version or raises `NoChangeError` and opens nothing at all.

So "mark it UNVERIFIED and check the first run" was too weak: one branch of that is a
red stuck PR on the shared toolchain, the other is silent staleness with no signal. The
three catalog-pinned devDependencies are now explicitly ignored. That trades automation
for a lockfile that stays installable, and the cost is named in the file: those three go
stale unless bumped by hand in `pnpm-workspace.yaml`. Revisit when either issue closes.

**Two decisions left open, deliberately.** SHA-pinning the CI actions (buys defence
against a moved tag; costs readability and churn) and digest-pinning the base image
(buys reproducibility; costs the automatic patch freshness a mutable tag gives on every
rebuild). Neither is settled; both are cheap to reverse and neither is a one-way door.

**What the gate did NOT catch, worth noting against itself.** One premise in finding 5
was stale — it cited a notebook entry saying auto-merge and the `main` ruleset were
blocked, which had been true when written and was fixed an hour earlier. The gate reads
the repo, so the repo being out of date makes the gate out of date. That is an argument
for writing notebook entries at the end of a slice, not the middle.

---

## 2026-09-08 — Dependabot's first run resolves both UNVERIFIED paths

The supply-chain entry above left two things marked UNVERIFIED rather than assumed.
Merging the config answered both within minutes, so replacing the guesses with the
measurement while the evidence is in front of us.

**Seven PRs opened on the first run.** #66 and #67 — docker, `node:24-bookworm-slim`
→ `26`, one per directory. #68 — the grouped npm minor/patch: oxfmt 0.59.0→0.66.0,
oxlint 1.74.0→1.81.0, ultracite 7.9.4→7.10.8, zod 4.4.3→4.5.4. #69–#72 — NestJS
11.1.28 → 12.0.1, arriving one PR per package.

**Both open questions closed, with evidence rather than inference:**

1. **The non-default filename IS scanned.** `infra/dev/linux-test.Dockerfile` produced
   its own PR (#67) alongside `infra/Dockerfile` (#66). No rename needed. This was the
   finding-1 fix proving itself: nothing else in the repo would ever have proposed a
   base-image major for the image that runs untrusted code.
2. **The catalog ignore holds.** Checked all seven diffs for `typescript`, `vitest` and
   `@types/node`: zero hits, and `pnpm-workspace.yaml` is untouched throughout. Neither
   dependabot-core#14339 nor #16049 was triggered.

**Also confirmed by construction:** majors arrive ungrouped. Four separate NestJS PRs
rather than one bundle is exactly the designed behaviour — a major is a behaviour change
and CI has no reason to fail on one, so under a loop that merges on green it must arrive
alone and legible.

**Left open, deliberately, for the next slice.** None of the seven is a rubber stamp:
`node:24 → 26` changes the runtime under the jail, and NestJS 11 → 12 is a framework
major across four packages. Green CI is necessary and not sufficient for either. They
go through the review gate like any other slice, and the node bump specifically needs
`threat-auditor`, since `infra/` is the image that executes untrusted code.

---

## 2026-09-08 — The walking skeleton runs on the real target (T5, #4)

`POST /submissions` reached terminal `succeeded` on Fly, executed in the jail. Both halves
of T5's verify line hold, on the deployed artifact rather than in a test:

```
$ curl -s https://reprise-api.fly.dev/submissions -X POST \
    -H 'Content-Type: application/json' \
    -H "Authorization: Bearer $REPRISE_KEY" \
    -d '{"language":"python","code":"print(\"hello\")"}'
{"duration_ms":79,"exit_code":0,"state":"succeeded","stderr":"","stdout":"hello\n","truncated":false}
```

Unkeyed, the same request returns 401 with the envelope, `WWW-Authenticate: Bearer`. An
empty bearer token is rejected too, not treated as absent — which is the more interesting
of the two, because "absent" and "present but empty" taking different code paths is a
classic auth bypass shape.

**On the 79ms.** It is one sample, from one region, on a warm machine, for a
`print("hello")`. It is NOT a p50, a p95, or anything that goes near a claim. The rule
stands: no latency number is quotable until k6 has measured it in the step-3 window. It
is recorded here because the first observation is worth having, not because it means
anything yet.

**Explain.** An HTTP request carrying language + code reaches a NestJS controller, passes
the OV-1 key guard, is parsed into a typed submission, and is handed to `runSubmission`,
which writes the code to a temp workspace and spawns it under `prlimit` as an unprivileged
uid in its own process group with an empty environment and closed stdin. The child's exit
code and signal are classified into the 7A terminal state vocabulary, output is captured
under a byte cap, the workspace is removed, and the result is mapped to the snake_case
wire shape at the controller boundary.

**Justify.** Every layer here exists because a shortcut at it was rejected for a reason
already recorded: no Docker on the sandbox path (5A — the crude jail spawns directly and
step 3 hardens it in place, so no throwaway isolation code); the jail as a pure module
with the HTTP handler as a thin caller, so the worker can call the identical function
later without a rewrite; deployed on day one rather than after hardening, because a jail
that only works on the dev host has proven nothing about the thing that ships. Fly rather
than any managed PaaS because step-3 hardening needs a kernel, which is the same reason
Sprites was rejected earlier today.

**Tradeoff.** This is the crude tier, and it is honest about what that means: it contains
fork bombs, memory exhaustion and infinite loops, and it does NOT contain network exfil or
container escape, and only reduces filesystem escape. The price of shipping it now is that
the static OV-1 key is the entire boundary between the internet and a process running
attacker-supplied code. That is why execution is auth-gated and why this must never go
public while the tier is crude. The second cost is inline execution: one run occupies a
request, so the 25-request concurrency ceiling is doing real work as a bound.

**Scale and failure.** The next thing to break is head-of-line blocking under concurrent
submits, which is exactly what `docs/learning-log/001-inline-execution.md` pre-registered
and which is now runnable for the first time, because it needed a deployed skeleton to run
against. After that: scale-to-zero means a cold request pays a machine boot, and once
Redis/BullMQ lands, Fly Proxy cannot see a queued job at all — a deep-linked run would sit
on a stopped worker forever (E16, T55's job). The 512MB machine gives the Node parent
headroom above the child's 256MB RLIMIT_AS; a jailed child cannot OOM the parent, but 25
concurrent ones would.

**Found while verifying, filed not fixed.** Every error response points at
`docs/api.md#<code>`, and that file does not exist — `DOCS_BASE` in
`shared/api-error/src/envelope.ts:63` is unconditional. An envelope field whose purpose is
routing a confused caller currently routes them to a 404, on a repo that goes public.
Filed into #50 (T48), which owns the envelope, with the fix scoped to include a test
asserting every `ErrorCode` has an anchor so the drift cannot recur silently.

**Operational note.** `fly secrets set REPRISE_API_KEY=$(openssl rand -hex 32)` sets a key
nobody ever sees — Fly secrets are write-only and `fly secrets list` returns a digest. The
value is unrecoverable, so generate into a shell variable first and keep it, or plan on a
rotation and a machine restart.

---

## 2026-09-08 — S1.5: the jail gets fixed before more surface is built on it

**The decision.** Melvin's call, on being shown the audit findings: pull #78 forward, fix the
jail before building further. #78 and #79 move into a new `S1.5 sandbox correctness`
milestone, which sorts ahead of `S2 auth + budgets`.

**Why it needed a milestone rather than a label.** The loop's intake is "lowest-numbered
unblocked issue in the current milestone". Both mechanisms were working against pulling
these forward: they sat in S3, and even inside S2 they would have sorted last, because #78
and #79 are the highest issue numbers in the repo. A priority label would not have moved
them — the rule reads issue numbers, not priorities.

So the fix is a milestone whose title sorts first. `S1.5` before `S2` is a string
comparison the session hook already does. Zero code change; the ordering mechanism is the
milestone list, and it turns out to be the right lever precisely because it is the one the
loop actually reads.

**The judgement, recorded because it was genuinely arguable.** Exposure for #78 requires
the OV-1 key, which only Melvin holds, so leaving it until S3 was defensible and I said so.
The counter-argument that won: S2 builds OAuth, sessions and per-account budgets directly on
top of the execution path, so every surface added before the fix inherits a jail that can
hang a request forever and a documented boundary that was wrong. Fixing a load-bearing
mechanism is cheaper before things depend on it, and "the key holder is trustworthy" stops
being the answer the moment OV-6 guest-run exists.

**#79 was re-scoped rather than moved wholesale.** Its urgent half — the threat model
claiming containment it does not have — already landed in #80. What remains is a fork:
either an isolated Fly network (the real fix, but it means destroying and recreating the
app, which is Melvin's infrastructure and so halts the loop), or a standing constraint that
nothing else is provisioned in this org while the tier is crude. The second is autonomous
and strictly weaker; it is what gets built absent a decision.

**What would prove this ordering wrong:** if #78's fix turns out to need machinery that
only exists after S2 — it does not, the reap-by-uid approach uses the dedicated run uid that
already exists — or if S1.5 stretches long enough that the collaborative half's risk
concentrates at the end again, which is the exact failure OV-4 exists to prevent. Two
issues is not that.

---

## 2026-09-09 — Reaping by uid: the setsid escape, and what the fix cost (T5, #78)

**The bug, restated from the evidence.** `runInJail` spawned with `detached: true` and
reaped with `process.kill(-child.pid, "SIGKILL")`. The negative pid targets a process
group, and a child that calls `setsid(2)` gets a session and a group of its own, so the
kill missed it. Worse, the code read the resulting `ESRCH` as proof the reap had worked —
the group was empty *because* the survivor had left it. The orphan kept fd 1 and 2, so the
pipes never drained, `close` never fired, and the promise the HTTP request sat on never
settled. Twenty-five of those exhaust `hard_limit` in `fly.toml` and the app stops serving.

**Explain.** Three mechanisms, in the order a run meets them.

`assertUidIsClean` runs before anything is spawned: it enumerates `/proc` for live
processes whose real uid is the run uid and refuses the run if there are any. Census only,
never a reap.

`spawnJailed` is unchanged in shape — `prlimit` execs the runner in a new process group as
the unprivileged uid with an empty environment. What is new is that the group kill is the
*first* step of a reap rather than the whole of it, and that a hard settle deadline
(`SETTLE_GRACE_MS`, 1000ms) resolves the promise on the record it has instead of waiting on
pipes that may never drain.

`reapUid` in `worker/src/sandbox/reap.ts` is what makes containment true. It lists `/proc`,
reads `status` for each numeric entry at a concurrency of 64, keeps the pids whose **real**
uid matches, re-confirms ownership immediately before signalling, SIGKILLs, and
re-censuses — up to 5 passes at 100ms. It returns the pids still alive, which is a fact for
the caller to report, not an error to throw.

`runOnce` ties them together: pre-spawn census, spawn, then — on every run — an awaited
final sweep before the queue slot is released. Survivors replace the outcome with a new
`JailOutcome` member, `unreaped`, which maps to `failed-infra`. All of `runInJail` is
serialised per uid.

**Justify — the decisions, and what each one beat.**

*Why uid, not pgid.* The uid is the only identity an unprivileged child cannot shed. It
leaves its process group with one syscall and leaves its parent behind simply by outliving
it; it cannot change its real uid without privilege. Real rather than effective for the
same reason, and because `RLIMIT_NPROC` is counted against the real uid — so the census and
the fork-bomb ceiling talk about the same set.

*Why read `/proc` instead of forking a helper that runs `kill(-1)` as the run uid.* The
case this exists for is a fork bomb, which by definition has exhausted that uid's
`RLIMIT_NPROC` budget. Anything that must `fork()` or `setuid()` to do the reaping fails
with `EAGAIN` exactly when it is needed. A `readdir` needs no new process.

*Why the post-run sweep is unconditional rather than armed off the pipes.* This is the
finding the first version of the fix missed, and it is the most important line in the
change. An escapee that calls `setsid(2)` **and** closes fd 0, 1 and 2 holds nothing: the
pipes drain, `close` fires in single-digit milliseconds, the drain timer is disarmed, and a
sweep armed off the pipes never runs. Measured before the unconditional sweep existed: a
**4ms run reporting `{exitCode: 0}` with the escapee still alive in the census.** So the
sweep hangs off the end of every run, not off a symptom.

*Why the sweep is awaited inside the queue slot.* A fire-and-forget sweep outlives its run.
Reproduced **25/25**: the sweep from a timing-out run reached into the next run and
SIGKILLed a healthy program, reported `killed-limit` — blamed for a ceiling it never
approached. The queue's unit is the run **plus its reap**. The `Reaper`'s `start`/`finish`
split exists because the two callers have different obligations: the in-run sweep is fired
from a timer where nobody can await it (its job is to unblock pipes so the promise can
settle at all), while `finish` is the one the slot waits on, and it resolves only after
every sweep this run started.

*Why the pre-spawn check is a census and never a reap.* "Clean it up first, then run" would
perform a host-wide SIGKILL itself on a misconfigured `REPRISE_RUN_UID=www-data`, on the
first run, before any submitted code executed. For the same reason a census that *cannot be
taken* — EACCES from a `hidepid=` mount, EMFILE — is a refusal and not a pass. Reading a
failed census as an empty one is the identical mistake to reading `ESRCH` as proof the kill
worked, which is the bug this whole change removes.

**Tradeoff — the bill, itemised.**

*Throughput collapses to one run per worker process.* No depth cap, no per-entry timeout.
The worst-case slot is not `wallClockMs` alone: it is `wallClockMs` + `SETTLE_GRACE_MS` +
up to two chained reap budgets, ~12s with the defaults. With Fly's `hard_limit = 25`,
twenty-five sleeping submissions hold every connection for **~300s** and the machine stops
serving. Accepted rather than bounded because execution is OV-1 key-gated and `hard_limit`
is already the backpressure control, and because rejecting over a depth cap would invent an
error contract the API does not have. The form that buys concurrency back is a uid *pool*;
step-3 cgroups make the question moot, since `pids.max` and a cgroup-scoped kill are
per-run by construction.

*Every run now pays two `/proc` censuses.* Measured in the isolation image: **p50 0.34ms /
p95 1.34ms at 6 processes; p50 9.05ms / p95 21.8ms / max 36.3ms at 306.** So ~0.7ms on a
Fly machine, ~18ms on a busy VPS, against a 10s wall clock — and inside the serialised
slot, where it delays the next run rather than this one.

*The census ignores zombies, and that is a real blind spot.* Signalling a zombie does
nothing, and counting them would make the reap kill, re-census, see the same set and never
converge — the #78 hang one layer down. But a zombie still holds a slot in the per-uid
`RLIMIT_NPROC` budget, so something must reap reparented orphans: `/.fly/init` in
production, `docker run --init` for the isolation image (added here). The production image
supplies no init of its own, so a self-hosted `docker run` must pass `--init` or inherit
the failure.

*`buildJailArgv` now rejects `maxCpuSeconds * 1000 >= wallClockMs`,* which broke several
existing tests that paired a short wall clock with the default 5s CPU ceiling. That is the
check working. Not a universal law — `RLIMIT_CPU` counts CPU aggregated across the thread
group, so a four-thread program reaches a 10s ceiling in ~2.5s of wall clock — but it only
ever tightens, so the weaker single-threaded case is the one worth enforcing. Consequence:
any `wallClockMs` at or below 1000 is now unconfigurable.

**Scale and failure.**

*The headline failure is a genuinely unreapable process, and it is a hard fail-closed.* A
process wedged in uninterruptible `D` state survives `reapUid`. That run reports
`failed-infra`, honestly. But the next run's `assertUidIsClean` finds the same survivor and
refuses, and so does every run after it — the instance permanently answers `failed-infra`
for every submission, **and does so silently**: `infraError` is stripped at the controller
boundary because it names our paths, the worker has no structured logging, and no health
probe reflects reap state. Restarting the machine is the only recovery. An instance serving
nothing beats one that SIGKILLs a shared account's processes, so the direction is right,
but the missing signal is an availability cliff and it closes with worker logging.

*Two workers sharing one run uid is unsupported and only partly detected.* The pre-spawn
census narrows the window; it does not close it, because there is no cross-process lock.
Both can census clean in the gap before their spawns.

*What does not change.* Attacks #1, #2 and #3 stay contained; #5 (network exfil) and #6
(container escape) are still not stopped and #4 only reduced. Execution stays behind the
OV-1 key for exactly that reason.

**The review gate earned its keep on this slice, and that is the honest headline.** My
first implementation fixed the escapee that *hangs* a request and completely missed the one
that *silently survives* it — and introduced a cross-run kill of its own. Four independent
lenses plus five adversarial verifiers produced eight blocking findings across two rounds,
every one confirmed by reproduction or mutation before it counted:

1. The sweep only ran when an escapee held the pipes (my own repro: 4ms run, exit 0,
   escapee alive).
2. The sweep outlived its queue slot and killed the next run (25/25).
3. Run-uid dedication was unenforced, and the `spec.uid === process.getuid()` guard is
   structurally unreachable in a deployment — `spawn` with a `uid` option needs CAP_SETUID,
   so the worker is always root.
4. The settle path had zero coverage: deleting the entire mechanism left the suite green.
5. My own "one run per uid" test was a **deterministic false guard** — 10/10 passing with
   the queue removed entirely, because with a plain sleeping leader the group kill succeeds
   and Node reaps the child before the first census yields, so `reapUid` never enters its
   pass loop.
6. The pure unit suites hardcoded `uid: 1001`, which is `ubuntu-latest`'s own runner uid —
   reproduced as **5 failing tests** under uid 1001, i.e. a red `verify` job I would only
   have discovered after pushing.
7. A leader exiting *after* the settle deadline armed a fresh drain timer that `disarm` had
   already run past, launching a sweep inside the next run's slot — the same cross-run kill
   through a different door.
8. A comment claiming this entry existed before it did.

Every new test is mutation-proven: removing the post-run sweep turns two red; making the
sweep fire-and-forget reproduces `signalled`/`killed-limit` on the healthy neighbour;
deleting the settle timer gives `Test timed out in 5000ms`, #78's original symptom exactly;
removing the late-exit guard gives a third sweep where two were expected.

**Consequences for other work, recorded so they are not rediscovered.**
`docs/learning-log/001-inline-execution.md` pre-registers a benchmark for head-of-line
blocking under concurrent submits. That experiment now runs against a jail that serialises
by construction, so it no longer measures what it was written to measure — the blocking is
structural in `runInJail`, and the queue upgrade does not buy the concurrency back. Only a
uid pool or step-3 cgroups do. Whoever runs it must re-register the premise first.

**What would prove this design wrong.** A `/proc` census cost large enough to matter
against a run's own latency, which would argue for caching the process table between the
pre-spawn check and the post-run sweep. Or a survivor that is neither transient nor
permanent — one that outlives the 500ms budget often enough that `unreaped` becomes routine
rather than an alarm, which would argue for widening `MAX_PASSES` first. Or the first real
report of an instance stuck answering `failed-infra`, which moves worker logging and a
health probe reflecting reap state from "eventually" to "next".

---

## 2026-09-09 — The `main` ruleset exists; CLAUDE.md said it did not

**What happened.** Checking `gh api repos/Melvin0070/reprise/rulesets` at the start of the
#78 slice, as CLAUDE.md instructs, returned an active "main protection" ruleset requiring a
pull request plus `verify`, `isolation` and `image` — not the `[]` the instruction predicted.
It was created on 2026-09-08 shortly after the entry that recorded it as blocked, and the
instruction had been stale for a day.

**Why this is worth a commit rather than a shrug.** CLAUDE.md is what the loop reads to
decide how much rigour a merge needs. An instruction that understates the mechanical
protection is the safe direction, but it is still a false statement in the file that governs
every session, and the same staleness in the other direction would be dangerous. The 2026-09-08
entry already noted a review-gate finding built on this exact stale premise — "the gate reads
the repo, so the repo being out of date makes the gate out of date."

**The part worth keeping, and the part I got wrong first.** My initial correction said the
PR-plus-three-checks requirement was now "mechanical rather than a promise". The review gate
caught that as overstated in the dangerous direction — the exact failure this entry warns
about, reproduced one paragraph later. The ruleset carries `bypass_actors` for the Admin role
with `bypass_mode: "always"`, and the loop authenticates as `Melvin0070`, who holds admin:
`current_user_can_bypass: "always"`. The loop's own merges are exempt. Nothing mechanical
stops a session merging past a red CI; only CLAUDE.md does.

It also sets `required_approving_review_count: 0`, which is what allows the loop to merge its
own PRs at all. So green CI proves the three jobs passed and nothing else — it does not prove
the six-lens gate ran. Both the PR requirement and the gate are as strong as CLAUDE.md and no
stronger. #78 is the evidence for why that matters: CI was green on the first implementation
too, and that implementation silently leaked processes and killed concurrent runs. Eight
blocking findings later, none of them came from CI.

**Left for Melvin rather than done.** Removing the Admin bypass would make the ruleset bind
the loop, which is the stronger arrangement. It is a governance write on his repository and
it would also constrain his own direct pushes, so it is his call, not one to make on his
behalf — see the stop conditions.

**A fork, recorded.** CLAUDE.md's docs-only carve-out names `docs/`, `README.md` and the
notebook — not CLAUDE.md itself, so strictly a CLAUDE.md-only diff falls to the full always-on
lenses. Applied the carve-out's *rationale* instead (the Defense rungs interrogate whether code
explains itself, and prose has no mechanism behind it to bite on) and ran `plan-conformance`
alone. If that reading is wrong, the fix is to name CLAUDE.md in the carve-out or to exclude it
explicitly; either way the ambiguity should not survive another session.

---

## 2026-09-09 — The 6PN blast radius: shipped the weaker fix, and said so (#79)

**What the issue left.** #80 had already corrected the false claim in
`docs/threat-model.md` — the blast radius is the Fly organization, not one microVM, because
every app in an org shares a private IPv6 network and a jailed process reaches `[fdaa::3]:53`
→ any `fdaa::/16` peer with no container escape and no kernel bug. Describing the hole is not
closing it. This slice was the closing half.

**The fork, and why it was not mine to take.** Two options, not equivalent:

- **Dedicated Fly network** (`fly apps create --network`). Makes org peers *unreachable*. The
  real fix. Networks are fixed at app creation, so it means destroying and recreating
  `reprise-api` — infrastructure Melvin owns and pays for, which the stop conditions put
  outside the loop.
- **Standing constraint.** Keep the org a population of one, so peers are *absent* rather than
  unreachable. Fully autonomous, and strictly weaker.

Took the second, opened **#88** (`blocked` + `build:melvin`) for the first with the exact four
commands and the cost stated plainly — destroy, recreate, re-set the secret, redeploy; a
stateless demo, so no data loss. A blocked issue that makes the decision easy is worth more
than one that merely records that a decision exists.

**What I built, and the part I want a reader to be suspicious of.** The constraint lives in
`CLAUDE.md` (prose plus a locked-decisions row), in `fly.toml` where a Fly operator actually
works, and in `infra/preflight-org.sh` + `infra/preflight-org-check.mjs`, which read the org's
listings and exit non-zero if anything is there beside the sandbox app. Run before every deploy
as `pnpm preflight:org`.

The suspicion it deserves: **the preflight is advisory.** It fires when someone runs it. A
`fly redis create` typed at a terminal is caught on the *next deploy*, not at the moment of
provisioning — so there is a window in which the org is populated and the guard is silent. It
also does nothing about 6PN itself; the sandbox can still reach `fdaa::/16`, there is just
nothing there. The threat model now says exactly this rather than implying an enforcement it
does not have. A guard whose limits are undocumented is worse than no guard, because it gets
trusted.

**The first draft was that guard, and it was wrong in the direction that matters.** It ran
`fly apps list --json`, counted anything that was not `reprise-api`, and printed "the 6PN blast
radius is one machine". Three defects, all found by the review gate and all confirmed by fresh
agents told to argue them away:

- **`fly apps list` cannot see the resources the constraint names.** flyctl's query is
  `apps(type: "container", ...)`. Upstash Redis is an add-on under a different GraphQL root
  field; Managed Postgres is behind a different API entirely. Neither appears. And both sit on
  6PN — Fly documents Upstash Redis as having "a private IPv6 address restricted to your Fly
  organization" and Managed Postgres as "not accessible over the public internet", with
  `fly mpg proxy` reaching it at an `fdaa::` address. So `fly mpg create` — the path `fly launch`
  steers you to — would have produced a reachable database that the guard certified as clear.
  The check now reads all three listings. Neither add-on listing is JSON on the empty path:
  `fly redis list` has no `--json` at all and prints a table, and `fly mpg list -j` prints an
  English sentence. Both are matched against the exact shapes flyctl 0.4.100 actually emitted
  on 2026-09-09, and anything else refuses.
- **It asserted "alone in the org" from input that never contained the app.** `[]` exited 0. An
  app-scoped Fly deploy token sees exactly one app, which is indistinguishable from an empty
  org — so the moment a deploy job existed, the guard would have reported clear no matter what
  the org held. The check now refuses unless the sandbox app is *present* in the listing, and
  refuses unless `fly orgs list --json` shows the org at all.
- **It was not scoped to an org.** `fly apps list` "includes applications from all the
  organizations the user is a member of". That one is fail-*closed* — an unrelated app in
  another org would have produced a false refusal naming it as a sandbox peer, with advice to
  delete it. Harmless to security, corrosive to the habit: the predictable response is to stop
  running the guard, which is the single failure mode this slice exists to prevent. Every
  listing is `--org` scoped now, and the checker refuses if a foreign org still appears.

The through-line is that all three are the same mistake — **answering a question about 6PN with
a query that is not about 6PN** — and the first draft's own header argued against it in the
abstract while committing it in the concrete. That is the useful thing to have written down.

**The design choice worth defending.** The decision half takes its listings on **stdin** and the
collecting half runs `fly`. That is the CLAUDE.md "I/O at the edges, core pure" rule applied to a
shell tool, and it is what makes fifteen cases testable with no Fly account and no network —
including the ones that matter most, the eleven refusals. Unreadable input exits **2, not 0**: two
of the three listings are human-formatted output rather than a versioned contract, so "flyctl
changed its wording" is a likely event, and it must produce a loud deploy failure rather than a
confident all-clear. The split is also the honest weak point: the collector decides *what to ask
Fly*, and that half has no test — which is precisely where all three defects above lived.

**What is still open, and deliberately.** Tigris storage (`fly ext storage`) is not covered,
because Tigris is reached over public S3 endpoints — a real blind spot, but an egress and
credential question rather than a 6PN reachability one, and lumping it in would have made the
coverage sentence wrong in the other direction. And the guard remains bounded by the credential
it runs under; the threat model now states that an app-scoped deploy token must never be what
runs it.

**Defense — Explain / Justify / Tradeoff / Scale & Failure.**
*Explain:* three org-scoped Fly listings go in, an exit code comes out; anything in the org that
is not `reprise-api` stops the deploy, and so does any input the check cannot interpret.
*Justify:* the mitigation that is supposed to hold here is OV-10, and OV-10 defends against
stolen credentials, not reachability — so the second resource in this org does not weaken it
gradually, it ends it, with nothing appearing to break. That is precisely the failure a standing
constraint has to be loud about. *Tradeoff:* absence instead of unreachability, and an advisory
check instead of an enforced one, bought without touching paid infrastructure; the stronger
version is #88 and is one decision away. *Scale & failure:* it fails closed on malformed JSON, on
a renamed field, on an unrecognised table header, on a missing sandbox app, on an invisible org,
and on `fly` being absent. It fails open in exactly two ways — when nobody runs it, and for
resource types nobody has taught it about, which today means Tigris. Scale is not the pressure
it is under; a Fly org holds tens of resources. The pressure is *authority*, and at any real
scale the answer is not a better preflight but the dedicated network, at which point this script,
its test, its CI step and the constraint in `fly.toml` are deleted together rather than tuned.
