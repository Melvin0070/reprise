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
