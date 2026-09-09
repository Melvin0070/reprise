import { readdir, readFile } from "node:fs/promises";
import path from "node:path";
import { setTimeout as delay } from "node:timers/promises";

/**
 * Reap every process a run uid owns.
 *
 * The process-group kill in `jail.ts` is necessary but not sufficient: a child
 * that calls `setsid(2)` gets a new session and a new process group, so a kill
 * aimed at the group misses it entirely (#78). What it cannot shed is its uid —
 * an unprivileged process cannot change it — so the uid is the identity the
 * reap can actually rely on.
 *
 * Enumerating `/proc` rather than forking a helper is deliberate. The case this
 * exists for is a fork bomb, which has by definition exhausted the uid's
 * `RLIMIT_NPROC` budget; anything that has to `fork()` or `setuid()` to do the
 * reaping fails with EAGAIN exactly when it is needed. Reading a directory
 * needs no new process.
 */

/** Linux publishes one numeric directory per live process here. */
const PROC_ROOT = "/proc";

/**
 * Kill passes before we stop and report survivors.
 *
 * Two would carry the convergence argument on its own — a SIGKILLed process
 * cannot fork again, so the set only shrinks, and one extra pass covers a
 * process forked between the census and the signal. The rest is patience:
 * `MAX_PASSES * PASS_INTERVAL_MS` is the time a process gets to actually leave
 * `/proc` before this reports it as a survivor, and a survivor is what makes a
 * run `failed-infra`. Sized to stay under `SETTLE_GRACE_MS` in `jail.ts`, which
 * is the deadline this has to finish inside.
 */
const MAX_PASSES = 5;

/** Between passes, so a signalled process is actually gone by the next census. */
const PASS_INTERVAL_MS = 100;

/**
 * How many `/proc/<pid>/status` files to hold open at once.
 *
 * Unbounded `Promise.all` over a large process table opens one descriptor per
 * host process and can hit the worker's own `RLIMIT_NOFILE` — which would make
 * the census fail exactly on the busy host where it matters most.
 */
const READ_CONCURRENCY = 64;

/** A `Z` in `State:` — already dead, waiting only to be reaped by its parent. */
const ZOMBIE = "Z";

const PID_DIR = /^\d+$/u;
/** `Uid:` in /proc/<pid>/status is real, effective, saved, filesystem. */
const UID_LINE = /^Uid:\s+(?<real>\d+)/mu;
const STATE_LINE = /^State:\s+(?<state>\S)/mu;

/** The process is already gone — benign, and the only benign read failure. */
const GONE: ReadonlySet<string> = new Set(["ENOENT", "ESRCH"]);

export interface ProcStatus {
  /** The real uid. See `processesForUid` for why real and not effective. */
  readonly realUid: number;
  /** The single-letter run state: `R`, `S`, `D`, `Z`, `T`… */
  readonly state: string;
}

/**
 * Pull the two fields the reap cares about out of a `/proc/<pid>/status` body.
 * Pure, so the parse is testable on a dev host that has no `/proc` at all.
 */
export const parseProcStatus = (text: string): ProcStatus | null => {
  const real = UID_LINE.exec(text)?.groups?.real;
  const state = STATE_LINE.exec(text)?.groups?.state;

  if (real === undefined || state === undefined) {
    return null;
  }

  return { realUid: Number(real), state };
};

const errorCode = (error: unknown): string | undefined =>
  typeof error === "object" && error !== null && "code" in error
    ? String((error as { code: unknown }).code)
    : undefined;

const readStatus = async (
  procRoot: string,
  pid: number
): Promise<ProcStatus | null> => {
  try {
    return parseProcStatus(
      await readFile(path.join(procRoot, String(pid), "status"), "utf-8")
    );
  } catch (error) {
    if (GONE.has(errorCode(error) ?? "")) {
      // Exited between the readdir and this read. Nothing to reap.
      return null;
    }
    // Anything else — EACCES from a `hidepid=` mount, EMFILE, EIO — means we do
    // not know who owns this process. Reading that as "not ours" would repeat
    // the mistake this whole change exists to fix: treating the error that
    // proves the census failed as proof that it succeeded (#78). Fail loudly.
    throw error;
  }
};

const isOwnedBy = (status: ProcStatus | null, uid: number): boolean => {
  if (status === null || status.realUid !== uid) {
    return false;
  }

  // A zombie holds no descriptors and runs no code, so it is not holding the
  // pipes and is not a containment problem. Decisively, signalling one does
  // nothing: counting them would make the reap loop kill, re-census, see the
  // same set, and never converge — the #78 hang one layer down.
  //
  // The cost is real and worth naming. A zombie still occupies a slot in the
  // kernel's per-uid process count, so a census reading empty is NOT the same
  // as a uid whose `RLIMIT_NPROC` budget is free. Something must reap
  // reparented orphans: on Fly that is `/.fly/init` as PID 1, and the CI
  // isolation image gets the same property from `docker run --init`. Without
  // one, a fork bomb's 64 dead children hold the budget forever and every later
  // run fails to spawn while this census keeps reporting a clean uid.
  return status.state !== ZOMBIE;
};

const readStatuses = async (
  procRoot: string,
  pids: readonly number[]
): Promise<(ProcStatus | null)[]> => {
  const statuses: (ProcStatus | null)[] = [];

  for (let start = 0; start < pids.length; start += READ_CONCURRENCY) {
    const chunk = pids.slice(start, start + READ_CONCURRENCY);
    // Sequential by design — the point is to bound open descriptors.
    // oxlint-disable-next-line no-await-in-loop
    const read = await Promise.all(
      chunk.map((pid) => readStatus(procRoot, pid))
    );
    statuses.push(...read);
  }

  return statuses;
};

/**
 * Every live pid whose **real** uid is `uid`.
 *
 * Real rather than effective: an unprivileged process cannot change its real
 * uid, so nothing spawned by the run can drop out of this set, and no process
 * of ours can wander into it. It is also the identity `RLIMIT_NPROC` counts,
 * which keeps this census and the fork-bomb ceiling talking about the same
 * thing.
 *
 * Rejects rather than under-reporting if `/proc` cannot be read. A caller that
 * cannot get a census cannot claim containment.
 */
export const processesForUid = async (
  uid: number,
  procRoot: string = PROC_ROOT
): Promise<number[]> => {
  const entries = await readdir(procRoot);
  const pids = entries
    .filter((entry) => PID_DIR.test(entry))
    .map(Number)
    // Never a candidate for its own kill list.
    .filter((pid) => pid !== process.pid);

  const statuses = await readStatuses(procRoot, pids);

  return pids.filter((_pid, index) => isOwnedBy(statuses[index] ?? null, uid));
};

export interface ReapOptions {
  readonly procRoot?: string;
  /**
   * Injected so the pass loop can be tested without a hostile process to kill.
   * The default is the real signal.
   */
  readonly kill?: (pid: number) => void;
}

const sigkill = (pid: number): void => {
  try {
    process.kill(pid, "SIGKILL");
  } catch {
    // ESRCH: it died between the census and the signal, which is the outcome we
    // wanted. Unlike the group kill, this inference is safe — the pid was
    // observed alive under this uid moments ago, so it did not "leave".
  }
};

/**
 * SIGKILL everything the uid owns, in bounded passes.
 *
 * Returns the pids still alive afterwards — empty means the run left nothing
 * behind. A non-empty result is not an error to throw: it is the fact the
 * caller has to report rather than hide.
 */
export const reapUid = async (
  uid: number,
  options: ReapOptions = {}
): Promise<number[]> => {
  const procRoot = options.procRoot ?? PROC_ROOT;
  const kill = options.kill ?? sigkill;

  let survivors = await processesForUid(uid, procRoot);

  for (let pass = 0; pass < MAX_PASSES && survivors.length > 0; pass += 1) {
    // Re-confirm ownership immediately before signalling. The census is async
    // over the whole process table — tens of milliseconds on a busy host — and
    // this is a root-privileged SIGKILL. A pid that exits during the census can
    // be recycled by the kernel to an unrelated process, and killing that would
    // be the one genuinely new way this module could hurt the host. A pid we
    // can no longer confirm is left alone and simply shows up as a survivor,
    // which is the fail-closed direction: report it, do not shoot blind.
    // oxlint-disable-next-line no-await-in-loop
    const checked = await Promise.all(
      survivors.map(async (pid) => {
        try {
          const status = await readStatus(procRoot, pid);
          return { pid, stillOurs: status !== null && status.realUid === uid };
        } catch {
          return { pid, stillOurs: false };
        }
      })
    );

    for (const { pid, stillOurs } of checked) {
      if (stillOurs) {
        kill(pid);
      }
    }
    // Sequential by nature: each census has to observe the previous pass.
    // oxlint-disable-next-line no-await-in-loop
    await delay(PASS_INTERVAL_MS);
    // oxlint-disable-next-line no-await-in-loop
    survivors = await processesForUid(uid, procRoot);
  }

  return survivors;
};
