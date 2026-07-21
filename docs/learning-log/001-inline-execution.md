# 001 — Running submissions inline in the HTTP handler instead of through a queue

- **Task:** T5/T7 · plan step 1 (walking skeleton)
- **Status:** pre-registered — baseline not yet shipped
- **Simple PR:** #3 · **Upgrade PR:** _scheduled before #3 lands (see "Upgrade trigger")_

## The fork

The plan's step 1 (§5A) specifies `submit → queue → worker`: the HTTP handler enqueues a
job, a separate worker process picks it up, and the client polls or streams for the
result. `CLAUDE.md`'s downgrade table overrides it for v0.1 — execution runs **inline**,
in the request handler, and the response is sent when the run finishes.

It isn't obvious which is right at this size. The queue is unambiguously the correct
end state, but at one user and one machine it is three moving parts (Redis, a job
producer, a worker process) standing between a POST and a `print("hello")`. The
interesting question is not "is the queue better" — it is **what specifically breaks
without it**, and whether we can make that breakage visible on demand rather than
discovering it in front of an interviewer.

## Options

| Option | What it costs | What it buys |
|---|---|---|
| **Inline in the handler** (chosen) | No admission control, no durability, no visible wait state. The run's clock starts at spawn, so queueing delay is charged to the run itself. | One process. The walking skeleton is a POST and a function call, and the jail seam gets exercised end-to-end from commit one. |
| **Redis + BullMQ + worker** (plan's prescription) | Redis in the dev loop and in deploy; a second process to run, log, and wake (E16); job lifecycle to reason about before anything executes at all. | Admission control, backpressure, durability across restarts, and a real `queued` state the UI can render. |

## What we chose, and why

The inline version, deliberately. Two reasons it is a reasonable place to start:

1. **The seam survives the upgrade.** `runSubmission()` is a pure-ish module that takes a
   submission and returns a terminal state. The handler calls it today; the BullMQ worker
   will call the same function unchanged. The upgrade replaces the *caller*, not the
   subsystem — which is the guardrail's "swap, not a wall" condition.
2. **There is no database yet.** Inline execution puts untrusted code in the same process
   as whatever credentials that process holds. Today that set is empty. See "Upgrade
   trigger" — this is the constraint that ends the downgrade, and it is not a
   performance one.

## How we'll break it (pre-registered, written BEFORE shipping)

The naive expectation is that inline execution fails by being *slow*. The hypothesis
worth testing is that it fails by being **wrong**, and that is what the experiment is
built to expose.

**The mechanism under test.** `runInJail` enforces `wallClockMs` (10s) with a parent-side
timer that starts when the child is spawned. Inline execution spawns immediately on
request arrival, so a submission that waits for CPU is charged that wait against its own
deadline. `RLIMIT_CPU` (5s) counts consumed CPU time, not wall time, so under contention
a process is starved *below* the CPU limit and dies on the **wall clock** instead.
Prediction: under enough concurrency, a payload that succeeds solo returns terminal state
`timeout` — a wrong answer, caused entirely by other tenants' load.

**Setup.** One API instance on a known machine size. A CPU-bound Python payload with a
fixed iteration count that takes a measured ~300ms solo (fixed work, so any wall-clock
growth is contention, not input variance). Load applied with k6 at concurrency 1, 2, 5,
10, 25, 50.

**What we measure.**

| Metric | Why |
|---|---|
| Terminal-state distribution, especially the `timeout` rate | The correctness signal. This is the primary result. |
| p50 / p95 / p99 end-to-end `POST /submissions` latency | The expected-but-secondary signal. |
| `GET /healthz` latency and status during the load | Whether the execution path starves the control plane. |
| API process RSS | Whether N concurrent jails walk the machine into an OOM. |
| Submissions returning neither a terminal state nor an error after a mid-load restart | Durability. |

**What number means "this failed"** — pre-registered, so we cannot move the goalposts
after seeing the data:

1. **Correctness (primary):** any non-zero rate of `timeout` on a payload that succeeds
   solo. The threshold is **one**. A run result that depends on unrelated concurrent load
   is not a slow product, it is an incorrect one, and Reprise's entire promise is that a
   run reproduces.
2. **Availability:** `/healthz` p99 > 1s, or any non-200, while submissions are running.
3. **Latency:** p95 above 3s for the 300ms payload (10× inflation).
4. **Durability:** any submission lost to a restart mid-load. Threshold is one.

**What the upgrade has to demonstrate** to justify its complexity: at the same
concurrency, the false-`timeout` rate returns to zero and surplus load becomes visible
as time spent in `queued` — waiting the user can see — rather than as wrong terminal
states. The metric to watch shifts from timeout rate to queue depth, which is the point:
the queue does not make the work faster, it makes the waiting **honest**.

## Upgrade trigger (not purely experimental)

Two independent triggers end this downgrade; whichever comes first wins.

- **The experiment above fails its thresholds.**
- **The first database credential.** OV-10 (workers hold no DB or object-store
  credentials) is a one-way door and `CLAUDE.md` forbids downgrading it. Inline execution
  is safe *only* while the API process holds nothing worth stealing. The moment step 2
  introduces Postgres, an inline run puts untrusted code in a process holding DB
  credentials, and a sandbox escape reaches the database directly instead of reaching one
  credential-poor worker. **T11 (worker split) must therefore land before or with the
  first DB credential**, regardless of what the load numbers say.

This second trigger is the more important one, and it is worth being blunt about why:
the performance argument for a queue is negotiable at v0.1 scale, and the security
argument is not.

## Baseline

_Not yet measured — the inline version has not shipped. No numbers here until k6 has
actually run (`CLAUDE.md`: no latency or throughput number reaches the resume until it
has been measured)._

## The failure

_Not yet run._

## The fix

_Pending the failure._

## After

_Pending the fix._

## The delta

_Pending. The one number that buys the queue._

## How I'd catch this earlier next time

The design-time smell to look for: **a deadline whose clock starts before the work is
admitted.** Any timeout that begins ticking at request arrival rather than at
work-start converts resource contention into incorrect results instead of into visible
latency. That pattern is not specific to queues — it shows up in HTTP client timeouts
wrapping connection-pool waits, and in lock acquisition counted against a transaction
budget. Ask of any timeout: *does this clock include time spent waiting for permission
to start?* If yes, load turns correctness into a coin flip.

## Defense answer

- **Explain:** v0.1 executes submissions synchronously inside the `POST /submissions`
  handler. The handler calls the same `runSubmission()` module a BullMQ worker will
  later call; only the caller changes.
- **Justify:** at one machine and no database, a queue adds three moving parts and
  buys nothing measurable. The seam was factored first so the upgrade is a swap.
- **Tradeoff:** we gave up admission control, durability across restarts, and any
  visible `queued` state. The specific cost is that `wallClockMs` starts at spawn, so
  contention is charged to the run's own deadline.
- **Scale & Failure:** it breaks at concurrency where CPU contention pushes a solo-300ms
  payload past its 10s wall clock — turning other tenants' load into a false `timeout`
  on a correct program. It also ends unconditionally at the first DB credential, because
  OV-10 will not survive untrusted code sharing a process with Postgres access.
