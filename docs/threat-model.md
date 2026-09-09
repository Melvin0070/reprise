# Threat model — the execution sandbox

Reprise runs untrusted code that strangers wrote. This document is the spine of the
sandbox: the attacks it must survive, the mitigation for each, and — just as important —
an honest statement of what the currently-shipped tier does **not** yet stop.

It is written before the hardening it describes exists, so it distinguishes throughout
between what is **live today** and what lands in step 3. A threat model that claims
mitigations it hasn't built is worse than none, because it invites you to trust the gaps.

## Scope and attacker model

- **Asset under threat:** the host running a submission, other tenants' data, and the
  network the host can reach.
- **Attacker:** an authenticated user (execution is auth-gated — OV-1) who submits
  hostile code as the payload. They control the program fully: its syscalls, its
  allocations, its child processes, its network calls. They do **not** control the host
  OS, the worker binary, or the kernel — those are our trusted computing base.
- **Out of scope here:** application-layer abuse (ReDoS in contract regexes, share-link
  leaks) is covered by its own mitigations (RE2 at snapshot-save; env redaction on share).
  This document is about the code-execution boundary only.

## The two isolation tiers

The worker runs one of two isolation profiles. Same jail module, hardened in place —
each step-3 layer is added to the crude tier, not built alongside it.

| Tier | What it is | Where it runs | Status |
|---|---|---|---|
| **Crude / DEGRADED** | non-root uid + rlimits + wall-clock timeout + SIGKILL | any host, incl. a container that refuses privileges | **live** |
| **Full / STRICT** | crude tier **+** mount namespace + network namespace + cgroups v2 + seccomp-bpf | a host granting the needed kernel privileges | step 3 |

The crude tier is deliberately labeled **unsafe for strangers**. It is gated behind the
OV-1 API key and is never exposed to anonymous traffic while it is the active tier. The
one authorized anonymous path (OV-6 guest-run on seeded postmortems) waits for the full
tier.

## The six attacks

| # | Attack | Crude tier | Full tier (step 3) |
|---|--------|-----------|--------------------|
| 1 | Fork bomb | **contained** — `RLIMIT_NPROC` | +cgroups `pids.max` |
| 2 | Memory exhaustion (OOM) | **contained** — `RLIMIT_AS` | +cgroups `memory.max` |
| 3 | Infinite loop / CPU hog | **contained** — wall-clock timeout → SIGKILL, `RLIMIT_CPU` | +cgroups `cpu.max` |
| 4 | Filesystem escape | *reduced* — non-root perms + scratch dir | **contained** — mount ns + pivot_root, ro binds |
| 5 | Network exfil | *not stopped* | **contained** — network ns, no egress |
| 6 | Container / host escape | *not stopped* | *mitigated, residual risk accepted* — seccomp + userns, drop caps |

The crude tier contains **three** of the six (1–3), reduces one (4), and does not stop two
(5–6). This is why it is stranger-unsafe and key-gated. Each row below says how, and why
the crude tier is or isn't enough.

### 1. Fork bomb — CONTAINED (crude)

`:(){ :|:& };:` spawns processes until the host's PID space or scheduler is exhausted,
denying service to everything else on the box.

- **Crude:** `RLIMIT_NPROC` caps the number of processes the runner's uid may own. The
  bomb hits the cap and its `fork()` calls fail with `EAGAIN` instead of multiplying.
  Because `RLIMIT_NPROC` is enforced **per-uid**, each run must use a low-privilege uid
  that isn't shared with a concurrent run — otherwise one run's bomb starves another's
  budget. Since #78 the reap is per-uid too, which makes a shared uid worse than unfair:
  one run's reap SIGKILLs everything that uid owns. Three things follow, and all three
  are enforced rather than requested:
  - `runInJail` **serialises runs per uid** within a worker process. Without it a
    timing-out run kills a healthy neighbour's interpreter, and that run is reported
    `killed-limit` — blamed for a ceiling it never approached. Measured at 25/25 before
    the sweep was brought inside the queue slot.
  - `runInJail` **refuses to spawn unless the uid owns nothing** (a census, never a
    reap — "clean it up first" would perform the host-wide kill itself). This is what
    stops `REPRISE_RUN_UID=www-data` on a root VPS turning one submission into a SIGKILL
    of every nginx worker.
  - Two worker processes must never be given the same run uid. The pre-spawn census
    narrows that window — the second worker usually sees the first's live run and refuses
    — but it does not close it: both can census clean in the gap between the census and
    the spawn that follows, after which one's sweep can still kill the other's run. The
    instruction stands; the check is a safety net, not a substitute for it.

  A per-run uid **pool** — one dedicated account per concurrent slot — is the clean
  form and buys back the concurrency the queue costs. Step-3 cgroups make it moot,
  because `pids.max` and a cgroup-scoped kill are per-run by construction.
- **Full:** cgroups v2 `pids.max` caps process count per-cgroup rather than per-uid,
  removing the shared-uid caveat entirely.

### 2. Memory exhaustion (OOM) — CONTAINED (crude)

Allocate until the kernel OOM-killer fires, which can kill *other* processes on the host,
not just the offender.

- **Crude:** `RLIMIT_AS` caps the process's virtual address space; oversized allocations
  fail at `mmap`/`brk` before the host is starved. Caveat: `RLIMIT_AS` limits *virtual*,
  not resident, memory — allocators that over-reserve virtual space can trip it early, and
  it doesn't bound page-cache pressure. Good enough to stop the DoS; not a precise memory
  budget.
- **Full:** cgroups v2 `memory.max` bounds *actual* memory use and OOM-kills only inside
  the run's own cgroup, never a neighbour.
- **Testing note:** macOS does **not** enforce `RLIMIT_AS`. A memory-bomb test on a macOS
  host would pass while the limit silently does nothing — false confidence on the single
  most important assertion. The isolation suite therefore runs on Linux only.

### 3. Infinite loop / CPU hog — CONTAINED (crude)

`while True: pass` never returns, holding the worker forever.

- **Crude:** the parent arms a wall-clock timeout and, on expiry, sends `SIGKILL` to the
  runner's **process group** (not just the leader) so any children die with it — this is
  what ties the timeout back to attack #1. The group kill alone is not enough: a child
  that calls `setsid(2)` gets a session and process group of its own and the negative-pid
  kill misses it (#78). So the group kill is followed by a sweep of `/proc` for every live
  process whose **real uid** is the run uid — the one identity an unprivileged child
  cannot shed, since it can leave its group with a syscall and leave its parent behind
  simply by outliving it. That sweep runs **after every run**, not only when something is
  still holding the output pipes: an escapee that also closes its stdio lets `close` fire
  on schedule, and a sweep armed off the pipes would never look for it. Measured: a 4ms
  run reporting exit 0 with the escapee still alive. `RLIMIT_CPU` is a secondary backstop
  on consumed CPU-seconds, and `buildJailArgv` now rejects a CPU ceiling a single-threaded
  loop could never reach before the wall clock. `SIGKILL`, not `SIGTERM`, because hostile
  code can trap or ignore `SIGTERM`. A run the sweep cannot finish settles on a hard
  deadline rather than hanging on pipes that will never drain, and is reported
  `failed-infra` — never as the leader's own exit code, which would be true about the
  leader and false about the run.

  **Known blind spot.** The census deliberately ignores zombies, because signalling one
  does nothing and counting them would stop the reap converging. A zombie still holds a
  slot in the per-uid `RLIMIT_NPROC` budget, so something must reap reparented orphans —
  `/.fly/init` in production, `docker run --init` for the isolation image. Without one,
  a fork bomb's dead children hold the budget forever while the census reports a clean
  uid, and every later submission fails to spawn with EAGAIN.

  The production image does **not** supply an init of its own, so this is only handled on
  targets that provide one. Fly does (`/.fly/init` is PID 1). A self-hosted `docker run`
  of the production image makes Node PID 1, which does not reap unrelated orphans — such
  a deployment must pass `--init` (or an equivalent) or it inherits this failure. Note
  the CI isolation job now passes `--init`, which means CI can no longer surface the
  problem; that is a deliberate trade to keep the suite honest about the production
  target, and it is why this paragraph exists.
- **Full:** cgroups v2 `cpu.max` throttles CPU share so one run can't monopolise a core
  even within its time budget.

### 4. Filesystem escape — REDUCED (crude), CONTAINED (full)

Read secrets or other tenants' data (`/etc/passwd`, another run's scratch dir), or write
where it shouldn't (host paths, the worker binary).

- **Crude (reduced, not contained):** the runner is a non-root uid working in a
  per-run scratch directory, so ordinary file permissions block *writes* to host paths and
  other uids' files. But non-root does nothing about world-readable files — `/etc/passwd`,
  package manifests, and anything mode `0644` on the host are still readable. **This is a
  real residual gap in the crude tier**, and part of why it is stranger-unsafe.
- **Full:** a mount namespace with `pivot_root` into a minimal, mostly read-only rootfs
  and a tmpfs scratch means the process simply cannot name host paths — the escape target
  isn't in its filesystem view at all.

### 5. Network exfil — NOT STOPPED (crude), CONTAINED (full)

Steal captured env values, phone home, or use the worker as an open proxy.

- **Crude (not stopped):** non-root does not prevent opening sockets. The crude tier has
  **no network containment.** This is the sharpest reason it is key-gated and never public.
- **Full:** the runner is placed in a network namespace with no interface beyond loopback
  (default-deny egress). It has nowhere to send data.

### 6. Container / host escape — NOT STOPPED (crude); MITIGATED with residual risk (full)

Break the isolation boundary and reach the host kernel via a privileged syscall or a
kernel bug.

- **Crude (not stopped):** the crude tier shares the host kernel with no syscall
  filtering. A kernel-level escape is not defended.
- **Full (mitigated, residual accepted):** a seccomp-bpf allowlist removes the syscalls an
  escape would need; unprivileged user namespaces + dropped capabilities shrink what a
  successful call could do. A kernel 0-day is still *possible* — this is the one attack we
  cannot fully close, so we bound its consequences instead of pretending we prevent it (see
  blast radius).

## Blast radius — the residual-risk answer

Because attack #6 can never be driven to zero, the design bounds what a successful escape
reaches rather than betting it can't happen:

- **Credential-poor workers (OV-10):** workers hold **no** database or object-store
  credentials. A process that escapes the sandbox lands on a worker that cannot reach
  Postgres or object storage — it must go back through the narrow control-plane API like
  any other caller. The blast radius is at most one worker's local state, never the data
  layer. This is a one-way-door decision and is never downgraded.
- **Deployment shapes the rest**, and the honest answer differs by target:
  - **Fly.io Machines:** each worker is a hardware-virtualized microVM, so even a full
    container escape is contained *inside that microVM* — **but the microVM is not the
    blast radius.** Fly puts every app in an organization on a shared private IPv6
    network (6PN). A jailed process resolves `_apps.internal` against Fly's resolver at
    `[fdaa::3]:53` and opens TCP to any `fdaa::/16` peer it gets back. That needs no
    escape at all: attack #5, which this document already lists as *not stopped*, is
    sufficient. **Blast radius ≈ every Machine in the Fly organization.**

    Today that org holds one app, so the practical radius is one machine — confirmed
    against the live org on 2026-09-09, not assumed. The danger is forward-looking: this
    silently weakens OV-10. Credential-poor workers defend against stolen credentials, not
    against network reachability — the day a Fly Postgres or Redis is provisioned in this
    org it is reachable from inside the sandbox with no code change and no new finding.

    **What is actually in place (#79):** the weaker of the two options — a standing
    constraint that nothing else is provisioned in this org while the tier is crude, in
    `CLAUDE.md`, in `fly.toml`, and checked by `pnpm preflight:org`.

    What the check covers, precisely, because a guard trusted past its evidence is worse
    than none: container apps (`fly apps list --org`), Upstash Redis (`fly redis list`) and
    Managed Postgres (`fly mpg list`), all scoped to one org. The add-ons are listed
    separately for a reason — `fly apps list` queries `apps(type: "container")`, so neither
    appears in it, while both sit on 6PN: Fly gives Upstash Redis "a private IPv6 address
    restricted to your Fly organization", and says Managed Postgres "is not accessible over
    the public internet". An apps-only check would have certified an org holding a
    reachable database as clear. It refuses (exit 2) rather than passing when it cannot see
    the org, when the sandbox app is absent from the listing, or when flyctl's output is not
    a shape it recognises. Tigris storage is out of scope on purpose: it is reached over
    public S3 endpoints, making it an egress and credential concern rather than a 6PN one.

    Be equally clear about what it does not buy. It defends against *the org growing*, and
    not at all against 6PN itself — the sandbox can still reach `fdaa::/16`; there is simply
    nothing there to reach. It is advisory: it fires only when someone runs it before `fly
    deploy`, so a `fly redis create` typed at a terminal is caught on the next deploy, not
    at the moment of provisioning. And it can only see as far as the credential running it,
    which is why an app-scoped deploy token must never be what runs it — that token's view
    of the org is a single app, which is indistinguishable from an empty org unless the
    guard refuses first.

    **What would actually close it:** a dedicated Fly network (`fly apps create --network`),
    which makes org peers unreachable rather than absent. It requires destroying and
    recreating `reprise-api`, so it is Melvin's call and is tracked in issue #88 as blocked.
    Until that lands, this section's honest claim is *blast radius ≈ the Fly organization,
    currently a population of one, by convention and a preflight rather than by the network*.
  - **Single-host privileged compose (self-host):** workers share the host kernel. An
    escape reaches the host. Blast radius ≈ the host.

  Self-host deployments must therefore surface a **REDUCED ISOLATION** label rather than
  imply containment they don't have. Per-deployment blast-radius scoping and the
  deployment-aware `demo:attacks` line are tracked in T59.

## Current status

The **crude / DEGRADED** tier is what ships first (built in issue #2). As of that slice:

- Attacks 1–3 are contained and covered by the isolation suite (Linux runner only). The
  `setsid(2)` escape that made the group kill insufficient was fixed in #78: the reap is
  now group kill + `/proc` sweep by real uid, and a run that cannot be reaped settles as
  `failed-infra` instead of hanging. The isolation suite runs the escape as a test.
- **The reap's precondition is a dedicated run uid**, and it is now checked before every
  run rather than assumed. See attack #1 for what that enforces and why a census must
  never be a reap.
- **An unreapable process takes the instance out of service, on purpose.** The pre-spawn
  census refuses every later run while a survivor is present, so one process the reap
  cannot clear turns the instance into a permanent `failed-infra` responder until the
  machine restarts. That is the correct direction to fail — an instance that serves
  nothing beats one that SIGKILLs a shared account's processes — but it is currently
  **silent**: `infraError` is stripped at the API boundary, the worker has no structured
  logging, and no health probe reflects reap state. The trade is accepted; the missing
  signal is an open item that closes with worker logging, not by loosening the gate.
- **Serialising runs is a throughput regression, stated rather than buried.** One run per
  worker process, with no queue depth cap: with the default 10s wall clock and Fly's
  `hard_limit = 25`, twenty-five concurrent sleeping submissions hold every connection for
  ~300s — the slot is `wallClockMs` plus the settle deadline plus up to two reap budgets,
  ~12s with the defaults, not the 10s wall clock alone. That is accepted at this tier
  because execution is OV-1 key-gated and `hard_limit` is already the backpressure
  control — but the one-run-per-session lock (T2)
  that would bound it above is **not yet shipped**, so today nothing but the API key does.
- Attack 4 is reduced, not contained; attacks 5–6 are not stopped.
- Execution is OV-1 key-gated and the tier is labeled unsafe-for-strangers.
- The step-3 hardening (rows marked "full") lands in place, each layer its own commit, and
  this document is updated as each mitigation moves from "step 3" to "live".
