import { spawn } from "node:child_process";
import type { Readable } from "node:stream";

import { buildJailArgv } from "./argv.js";
import type { JailLimits } from "./limits.js";
import { classifyOutcome } from "./outcome.js";
import type { JailOutcome } from "./outcome.js";
import { processesForUid, reapUid } from "./reap.js";

/**
 * `prlimit` applies the rlimits and execs the runner in place — see
 * `buildJailArgv` for why a shell is deliberately not involved.
 */
const PRLIMIT = "/usr/bin/prlimit";

/**
 * How long the runner's children may keep the output pipes open after the
 * leader itself has exited. A fork bomb's children outlive their parent and
 * would otherwise hold the pipes — and this call — open indefinitely.
 */
const PIPE_DRAIN_GRACE_MS = 200;

/**
 * How long after a reap we still wait for `close` before settling anyway.
 *
 * `close` fires only once the pipes drain, so a process we could not kill would
 * hold this call open forever — the hang in #78. A run that cannot be reaped is
 * an infrastructure failure to report, not a request to abandon, so the
 * deadline is hard. Comfortably above the reap's sleep budget (`MAX_PASSES *
 * PASS_INTERVAL_MS` in `reap.ts`, 500ms) so a sweep usually finishes first —
 * loosely, not as a guarantee: that budget does not count the censuses between
 * passes, and nothing asserts the relation across the two files. Nothing breaks
 * if it inverts, because `runOnce` re-decides on its own census afterwards.
 */
const SETTLE_GRACE_MS = 1000;

/** Enough pids to diagnose with; the full list belongs in a log, not a message. */
const MAX_REPORTED_PIDS = 8;

/**
 * Accumulate a stream up to a byte ceiling, discarding the remainder. Counting
 * bytes rather than string length keeps the cap honest for multi-byte output.
 */
const capture = (stream: Readable | null, maxBytes: number) => {
  const chunks: Buffer[] = [];
  let bytes = 0;
  let overflowed = false;

  stream?.on("data", (chunk: Buffer) => {
    const room = maxBytes - bytes;
    if (room <= 0) {
      overflowed = true;
      return;
    }
    if (chunk.length > room) {
      chunks.push(chunk.subarray(0, room));
      bytes = maxBytes;
      overflowed = true;
      return;
    }
    chunks.push(chunk);
    bytes += chunk.length;
  });

  return {
    text: () => Buffer.concat(chunks).toString("utf-8"),
    truncated: () => overflowed,
  };
};

export interface JailSpec {
  readonly command: string;
  readonly args: readonly string[];
  readonly cwd: string;
  readonly limits: JailLimits;
  /** Required, not optional: a caller cannot forget to drop privileges. */
  readonly uid: number;
  readonly gid: number;
}

const assertUnprivileged = (spec: JailSpec): void => {
  if (spec.uid === 0 || spec.gid === 0) {
    throw new Error(
      "jail: refusing to run as root; the crude tier's only filesystem boundary is the unprivileged uid"
    );
  }

  // Defence in depth, and NOT the dedication check — `uid !== our uid` is
  // strictly weaker than "this uid owns nothing else", which is what
  // `assertUidIsClean` enforces.
  //
  // It cannot fire in a shipped *deployment*: `spawn` with a `uid` option needs
  // CAP_SETUID, so the worker is always root and the check above has already
  // thrown. It does fire wherever the process runs unprivileged with a run uid
  // matching its own — GitHub's `ubuntu-latest` runner is uid 1001, which is
  // why the unit suites derive a run uid instead of hardcoding one.
  if (spec.uid === process.getuid?.()) {
    throw new Error(
      `jail: refusing to run submitted code as the worker's own uid (${spec.uid}); the run uid must be dedicated, because the reap kills by uid`
    );
  }
};

export interface JailResult {
  readonly outcome: JailOutcome;
  readonly stdout: string;
  readonly stderr: string;
  readonly durationMs: number;
  /** True when output hit `maxOutputBytes` and the rest was discarded. */
  readonly truncated: boolean;
}

/** Wait for a promise to finish without adopting its failure. */
const settled = async (promise: Promise<unknown>): Promise<void> => {
  try {
    await promise;
  } catch {
    // The caller that owns this promise handles its error. This is only here to
    // sequence work behind it.
  }
};

const describe = (error: unknown): string =>
  error instanceof Error ? error.message : String(error);

/**
 * Sequences the uid sweeps belonging to ONE run.
 *
 * Two callers need it at different moments and they must not interleave their
 * kill passes: the timer path, which fires while the run is still open to
 * unblock pipes an escapee is holding, and the final path, which the queue
 * waits on. Sweeps run one after another; `finish` resolves only once every
 * sweep this run started has completed.
 */
interface Reaper {
  /** Fire a sweep and forget it. Only safe because `finish` waits for it. */
  readonly start: () => void;
  /** Await every sweep started so far, then take a final one. */
  readonly finish: () => Promise<number[]>;
}

const sweepAfter = async (
  previous: Promise<unknown> | undefined,
  uid: number
): Promise<number[]> => {
  if (previous !== undefined) {
    await settled(previous);
  }

  return await reapUid(uid);
};

const createReaper = (uid: number): Reaper => {
  let last: Promise<number[]> | undefined;

  const sweep = (): Promise<number[]> => {
    const mine = sweepAfter(last, uid);
    last = mine;
    return mine;
  };

  return {
    finish: async () => await sweep(),
    start: () => {
      void settled(sweep());
    },
  };
};

const spawnJailed = async (
  spec: JailSpec,
  argv: string[],
  reaper: Reaper
): Promise<JailResult> => {
  const startedAt = performance.now();

  // A child process reports completion through events, not a promise, so the
  // constructor is the only way to bridge it. There is no library promise here
  // to return instead.
  // oxlint-disable-next-line promise/avoid-new
  return await new Promise<JailResult>((resolve, reject) => {
    const child = spawn(PRLIMIT, argv, {
      cwd: spec.cwd,
      // New process group, so one kill reaches every child the runner spawned.
      // Without this a fork bomb's children would survive the timeout.
      detached: true,
      // Empty, not inherited. The host environment can hold credentials, and
      // none of it is any of the runner's business.
      env: {},
      gid: spec.gid,
      // stdin is closed rather than inherited: the runner reads EOF instead of
      // blocking on a terminal that will never produce input.
      stdio: ["ignore", "pipe", "pipe"],
      uid: spec.uid,
    });

    const stdout = capture(child.stdout, spec.limits.maxOutputBytes);
    const stderr = capture(child.stderr, spec.limits.maxOutputBytes);

    let timedOut = false;
    let exit: { code: number | null; signal: string | null } | null = null;
    let settledAlready = false;

    // One record rather than three bindings: every handler below has to be able
    // to disarm all of them, and they are armed at three different moments.
    const timers: {
      wallClock?: NodeJS.Timeout;
      drain?: NodeJS.Timeout;
      settle?: NodeJS.Timeout;
    } = {};

    const disarm = () => {
      clearTimeout(timers.wallClock);
      clearTimeout(timers.drain);
      clearTimeout(timers.settle);
    };

    const finish = (outcome: JailOutcome) => {
      if (settledAlready) {
        return;
      }
      settledAlready = true;
      disarm();

      // Load-bearing only on the deadline path, where the pipes are still open:
      // the streams and the child handle would otherwise hold the worker's
      // event loop up for as long as the process we failed to kill lives.
      child.stdout?.destroy();
      child.stderr?.destroy();
      child.unref();

      resolve({
        durationMs: Math.round(performance.now() - startedAt),
        outcome,
        stderr: stderr.text(),
        stdout: stdout.text(),
        truncated: stdout.truncated() || stderr.truncated(),
      });
    };

    const fail = (error: Error) => {
      if (settledAlready) {
        return;
      }
      settledAlready = true;
      disarm();
      reject(error);
    };

    const killGroup = () => {
      if (child.pid === undefined) {
        return;
      }
      try {
        // Negative pid targets the whole process group. SIGKILL rather than
        // SIGTERM because hostile code can install a handler for SIGTERM.
        process.kill(-child.pid, "SIGKILL");
      } catch {
        // ESRCH means the group is empty, which is NOT the same as the run
        // being over: a child that called setsid(2) left for a session and
        // group of its own, and an empty group is exactly what that leaves
        // behind (#78). The uid sweep is what settles the question.
      }
    };

    /**
     * Stop waiting on pipes that are still held. What the run is finally
     * reported as is not decided here — `runOnce` takes a census after this and
     * downgrades the verdict to `unreaped` if anything is still alive.
     */
    const settleOnDeadline = () => {
      const record = exit;

      if (timedOut) {
        finish({ kind: "timeout" });
        return;
      }
      if (record !== null) {
        finish(
          classifyOutcome({
            code: record.code,
            signal: record.signal,
            timedOut: false,
          })
        );
        return;
      }
      // Unreachable: the deadline is armed only from `reap`, which runs on the
      // wall clock or on the leader's exit. Reported rather than thrown,
      // because a throw from a timer callback takes the worker down.
      finish({
        detail: "jail: the settle deadline expired with no exit record",
        kind: "unreaped",
      });
    };

    /**
     * Kill the process group, then sweep the uid for anything that left it. The
     * group kill is the immediate, portable path; the uid sweep is the one that
     * makes containment true.
     */
    const reap = () => {
      killGroup();
      // Armed on the first reap rather than on `close`: from here the run is
      // either dead or unreapable, and either way it has to settle.
      timers.settle ??= setTimeout(settleOnDeadline, SETTLE_GRACE_MS);
      reaper.start();
    };

    timers.wallClock = setTimeout(() => {
      timedOut = true;
      reap();
    }, spec.limits.wallClockMs);

    child.on("error", (error) => {
      fail(error);
    });

    child.on("exit", (code, signal) => {
      exit = { code, signal };
      // Nothing may be armed after the promise has settled. A leader that dies
      // AFTER the settle deadline — D-state on wedged I/O, or just a ≥1s event
      // loop stall between the group kill and libuv delivering this callback —
      // would otherwise arm a fresh drain timer that `disarm` never sees, and
      // the sweep it starts would run inside the NEXT run's slot and SIGKILL a
      // healthy program. Reproduced: a third sweep landing 250ms into run B.
      // Nothing is lost by returning: `runOnce`'s final sweep is still ahead of
      // us, still awaited, and it is what reaps this leader and its orphans.
      if (settledAlready) {
        return;
      }
      // The leader is gone; anything still holding the pipes is an orphan.
      timers.drain = setTimeout(reap, PIPE_DRAIN_GRACE_MS);
    });

    // `close` rather than `exit`: it fires once the pipes are drained, so no
    // output written just before death is lost.
    child.on("close", () => {
      finish(
        classifyOutcome({
          code: exit?.code ?? null,
          signal: exit?.signal ?? null,
          timedOut,
        })
      );
    });
  });
};

/**
 * Refuse to run unless the run uid owns nothing.
 *
 * The reap SIGKILLs every process this uid owns, so the uid has to be an
 * account dedicated to one run at a time. That requirement was previously
 * stated in three comments and enforced nowhere — and `argv.ts` says exactly
 * what an unchecked claim in a comment is worth. It is what stands between a
 * misconfigured `REPRISE_RUN_UID=www-data` on a root VPS and a submission that
 * SIGKILLs every nginx worker on the host.
 *
 * Census only — never a reap. "Clean it up first, then check" would perform
 * that host-wide kill itself, on the first run, before any submitted code has
 * executed. And a census that cannot be taken is a refusal, not a pass: a
 * caller that cannot enumerate the uid cannot claim containment.
 *
 * **This gate fails closed, permanently, and that is deliberate.** A process
 * the reap genuinely cannot clear — wedged in uninterruptible `D` state on
 * stalled I/O, say — is still there for the next run's census, and every run
 * after that. The instance then returns `failed-infra` for every submission
 * until the machine is restarted, and it does so quietly: `infraError` is
 * stripped at the API boundary because it names our paths, the worker has no
 * structured logging yet, and there is no health probe reflecting reap state.
 * An instance that serves nothing beats one that SIGKILLs a shared account's
 * processes, so the trade is right — but the missing signal on it is a real
 * gap, and it closes with worker logging rather than by loosening this.
 */
const assertUidIsClean = async (uid: number): Promise<void> => {
  let owned: number[];

  try {
    owned = await processesForUid(uid);
  } catch (error) {
    throw new Error(
      `jail: refusing to run; uid ${uid} could not be enumerated, so it cannot be confirmed dedicated: ${describe(error)}`,
      { cause: error }
    );
  }

  if (owned.length > 0) {
    const sample = owned.slice(0, MAX_REPORTED_PIDS).join(", ");
    throw new Error(
      `jail: refusing to run; uid ${uid} already owns ${owned.length} process(es) (${sample}). The reap SIGKILLs everything this uid owns, so it must be dedicated to one run at a time — either a previous run leaked, or REPRISE_RUN_UID names a shared account.`
    );
  }
};

const unreapedAfter = (
  uid: number,
  survivors: readonly number[]
): JailOutcome => ({
  detail: `jail: ${survivors.length} process(es) still owned by uid ${uid} after the reap (${survivors.slice(0, MAX_REPORTED_PIDS).join(", ")})`,
  kind: "unreaped",
});

const runOnce = async (spec: JailSpec, argv: string[]): Promise<JailResult> => {
  await assertUidIsClean(spec.uid);

  const reaper = createReaper(spec.uid);

  let result: JailResult;
  try {
    result = await spawnJailed(spec, argv, reaper);
  } catch (error) {
    // The spawn itself failed, so there is nothing of ours to reap — but a
    // sweep may already be in flight, and no sweep may outlive the slot. The
    // abstraction should not lean on "that path is unreachable".
    await settled(reaper.finish());
    throw error;
  }

  // Unconditional, and awaited before the queue slot is released.
  //
  // Unconditional because the sweep during the run only happens when something
  // holds the pipes open. An escapee that calls setsid(2) AND closes its stdio
  // holds nothing: `close` fires on time, the drain timer is disarmed, no sweep
  // ever runs, and the run reports `exited 0` while the process is still alive.
  // Measured before this line existed: a 4ms run reporting exit 0 with the
  // escapee still in the census.
  //
  // Awaited because a sweep that outlives its slot kills the NEXT run — the
  // queue's unit is the run plus its reap, not the run.
  //
  // What it costs, measured in the isolation image rather than guessed: a
  // census is one readdir plus one status read per host process, chunked at 64.
  // p50 0.34ms / p95 1.34ms at 6 processes, p50 9.05ms / p95 21.8ms at 306. A
  // run pays two of them (this one and the pre-spawn check), so ~0.7ms on a Fly
  // machine and ~18ms on a busy VPS — against a 10s wall clock, and inside the
  // serialised slot where it delays the next run rather than this one.

  let survivors: number[];
  try {
    survivors = await reaper.finish();
  } catch (error) {
    return {
      ...result,
      outcome: {
        detail: `jail: uid ${spec.uid} could not be swept, so the run cannot be confirmed contained: ${describe(error)}`,
        kind: "unreaped",
      },
    };
  }

  if (survivors.length === 0) {
    return result;
  }

  // The leader's own verdict is true about the leader and false about the run.
  return { ...result, outcome: unreapedAfter(spec.uid, survivors) };
};

/**
 * One in-flight run per uid.
 *
 * The reap kills by uid, because the uid is the only identity a hostile child
 * cannot shed: it can leave its process group with `setsid`, and it leaves its
 * parent behind simply by outliving it. The cost of that is bluntness — a sweep
 * cannot tell two concurrent runs under one uid apart, so without this queue a
 * timing-out run would SIGKILL a healthy neighbour's process and that run would
 * be reported `killed-limit`, blamed for a ceiling it never approached.
 *
 * The crude tier already needed this and only asked for it politely:
 * `RLIMIT_NPROC` is enforced per-uid, so concurrent runs sharing a uid already
 * shared the fork-bomb ceiling (threat model #1). Serialising is what makes
 * both limits mean what they say.
 *
 * **What it costs, stated rather than implied.** Throughput collapses to one
 * run per worker process. The queue has no depth cap and no per-entry timeout,
 * so N concurrent submissions make the last one wait N × the worst-case slot —
 * and the slot is not just `wallClockMs`: it is `wallClockMs` +
 * `SETTLE_GRACE_MS` + up to two chained reap budgets, ~12s with the defaults.
 * With Fly's `hard_limit = 25`, twenty-five sleeping submissions hold every
 * connection for roughly 300s and the machine stops serving. That is accepted here rather than bounded because
 * execution is OV-1 key-gated and `hard_limit` is already the backpressure
 * control, and because the alternative — rejecting over a depth cap — invents
 * an error contract the API does not yet have. It is a real regression against
 * the previous concurrent behaviour and it is recorded in `docs/notebook.md`
 * with the number, not filed as a detail.
 *
 * The form that buys the concurrency back is a uid *pool*: one dedicated
 * account per concurrent slot, which also turns `RLIMIT_NPROC` into a true
 * per-run ceiling. Step-3 cgroups make the question moot, because `pids.max`
 * and a cgroup-scoped kill are per-run by construction.
 */
const inFlight = new Map<number, Promise<unknown>>();

const afterPrevious = async <T>(
  previous: Promise<unknown> | undefined,
  work: () => Promise<T>
): Promise<T> => {
  if (previous !== undefined) {
    await settled(previous);
  }

  return await work();
};

const serializePerUid = async <T>(
  uid: number,
  work: () => Promise<T>
): Promise<T> => {
  const previous = inFlight.get(uid);
  // The slot is claimed synchronously, before the first await: two callers in
  // the same tick must not both see an empty queue.
  const mine = afterPrevious(previous, work);
  // Stored in already-handled form, so a rejected run cannot become an
  // unhandled rejection merely by being the next run's predecessor.
  inFlight.set(uid, settled(mine));

  return await mine;
};

/**
 * Run one program under the crude jail: unprivileged uid, rlimits, wall-clock
 * timeout, and a SIGKILL of everything the run owns.
 *
 * This is the I/O edge. The decisions it makes — the limit argv, the outcome
 * taxonomy, the reap — live in pure modules beside it so they are testable
 * without spawning anything.
 *
 * Contains threat-model attacks #1 (fork bomb), #2 (OOM) and #3 (infinite
 * loop). It does NOT contain #5 (network exfil) or #6 (container escape), and
 * only reduces #4 (filesystem escape) — which is why execution stays behind the
 * OV-1 key while this is the active tier.
 */
export const runInJail = async (spec: JailSpec): Promise<JailResult> => {
  // Both validations run before the queue: a spec we would refuse should be
  // refused now, not after waiting behind someone else's run.
  assertUnprivileged(spec);
  const argv = buildJailArgv(spec.limits, spec.command, spec.args);

  return await serializePerUid(spec.uid, () => runOnce(spec, argv));
};
