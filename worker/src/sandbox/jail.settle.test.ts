import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { DEFAULT_LIMITS } from "./limits.js";

/**
 * The hard settle deadline — the half of #78 a real process cannot exercise.
 *
 * Reaching this branch for real needs a process that holds fd 1 and 2 AND
 * survives SIGKILL for longer than the deadline: an uninterruptible D-state on
 * a wedged filesystem, or a fork bomb outrunning the reap's passes. The first
 * is not constructible in the test container and the second is a race, so it
 * would be a flake pretending to be a guard.
 *
 * Mocking the two module boundaries instead — `spawn` and the reap — reaches it
 * deterministically on any platform, and keeps test-only injection seams off a
 * security-critical path. Deleting the settle timer from `jail.ts` turns this
 * test into `Error: Test timed out`, which is #78's original symptom: a promise
 * that never settles because `close` never fires.
 */

const SURVIVOR_PID = 4242;

/**
 * A run uid that is provably not this process's own.
 *
 * The jail refuses a run uid equal to the worker's (#78), and GitHub's
 * `ubuntu-latest` runner is itself uid 1001 — so a hardcoded 1001 passes on a
 * macOS dev host (uid 501) and in the root isolation container (uid 0), and
 * turns this whole file red in the one place it actually runs unprivileged.
 */
const RUN_UID = process.getuid?.() === 1001 ? 1002 : 1001;

const spawnMock = vi.hoisted(() => vi.fn());
const reapUidMock = vi.hoisted(() => vi.fn());
const processesForUidMock = vi.hoisted(() => vi.fn());

vi.mock("node:child_process", () => ({ spawn: spawnMock }));
vi.mock("./reap.js", () => ({
  processesForUid: processesForUidMock,
  reapUid: reapUidMock,
}));

/** A child that starts and then never exits — its pipes are never closed. */
const makeStuckChild = () => {
  // A ChildProcess is an EventEmitter and the code under test uses `.on`, so
  // the browser-portable EventTarget the rule prefers would not stand in for it.
  // oxlint-disable-next-line unicorn/prefer-event-target
  const child = Object.assign(new EventEmitter(), {
    pid: 31_337,
    stderr: new PassThrough(),
    stdout: new PassThrough(),
    unref: vi.fn(),
  });

  return child;
};

let killSpy: ReturnType<typeof vi.spyOn>;
let child: ReturnType<typeof makeStuckChild>;

beforeEach(() => {
  // Reset call history too: these are module-level mocks shared across tests,
  // and one of the assertions below is that spawn was never reached.
  spawnMock.mockReset();
  reapUidMock.mockReset();
  processesForUidMock.mockReset();
  vi.useFakeTimers();
  // The group kill must never reach a real process group during a unit test.
  killSpy = vi.spyOn(process, "kill").mockReturnValue(true);
  // The pre-spawn dedication census: the uid starts clean.
  processesForUidMock.mockResolvedValue([]);
  child = makeStuckChild();
  spawnMock.mockReturnValue(child);
});

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
  vi.resetModules();
});

const runStuck = async () => {
  const { runInJail } = await import("./jail.js");

  const pending = runInJail({
    args: ["-c", "irrelevant"],
    command: "/usr/bin/python3",
    cwd: "/tmp",
    gid: RUN_UID,
    limits: { ...DEFAULT_LIMITS, maxCpuSeconds: 1, wallClockMs: 2000 },
    uid: RUN_UID,
  });

  // Past the wall clock, which arms the reap and the settle deadline, then past
  // the deadline itself. `close` never fires: nothing drains the pipes.
  await vi.advanceTimersByTimeAsync(2000);
  await vi.advanceTimersByTimeAsync(1000);
  await vi.advanceTimersByTimeAsync(1000);

  return await pending;
};

describe("runInJail — a run that cannot be reaped still terminates", () => {
  it("settles as unreaped instead of waiting on pipes that never drain", async () => {
    // The reap runs and reports a process it could not kill.
    reapUidMock.mockResolvedValue([SURVIVOR_PID]);

    const result = await runStuck();

    expect(result.outcome.kind).toBe("unreaped");
    // The census travels with the outcome: `failed-infra` with no reason is the
    // least useful line in a postmortem.
    expect(
      result.outcome.kind === "unreaped" ? result.outcome.detail : ""
    ).toContain(String(SURVIVOR_PID));
    // The group kill was still attempted first — it is the immediate path, and
    // the sweep is what covers what it misses.
    expect(killSpy).toHaveBeenCalledWith(-31_337, "SIGKILL");
  });

  it("keeps the timeout verdict when the reap does clear the survivors", async () => {
    // The deadline fired, so the pipes were held at that moment — but the sweep
    // got there in the end. Reporting `failed-infra` anyway would invent a
    // containment failure that did not happen.
    reapUidMock.mockResolvedValue([]);

    const result = await runStuck();

    expect(result.outcome).toEqual({ kind: "timeout" });
  });

  it("reports unreaped when the uid cannot be swept at all", async () => {
    // A census we cannot take is not a clean uid. Reading the failure as
    // "nothing to reap" is the exact mistake #78 was about.
    reapUidMock.mockRejectedValue(new Error("EACCES: /proc unreadable"));

    const result = await runStuck();

    expect(result.outcome.kind).toBe("unreaped");
    expect(
      result.outcome.kind === "unreaped" ? result.outcome.detail : ""
    ).toMatch(/could not be swept/u);
  });
});

describe("runInJail — nothing is armed after the run has settled", () => {
  it("ignores a leader that exits after the settle deadline", async () => {
    // The leader can die long after we gave up on it: D-state on wedged I/O, or
    // simply a second of event-loop stall between the group kill and libuv
    // delivering the exit callback. Before this was guarded, that late `exit`
    // armed a fresh pipe-drain timer which `disarm` had already run past, and
    // the sweep it started ran inside the NEXT run's queue slot — SIGKILLing a
    // healthy program and reporting it `killed-limit`. Reproduced as a third
    // sweep landing 250ms into the following run.
    reapUidMock.mockResolvedValue([]);

    await runStuck();
    const sweepsAtSettle = reapUidMock.mock.calls.length;

    // The leader finally dies, well after the promise resolved.
    child.emit("exit", 0, null);
    await vi.advanceTimersByTimeAsync(5000);

    expect(reapUidMock.mock.calls.length).toBe(sweepsAtSettle);
  });
});

describe("runInJail — the run uid must be dedicated", () => {
  it("refuses to spawn when the uid already owns a process", async () => {
    processesForUidMock.mockResolvedValue([SURVIVOR_PID]);
    const { runInJail } = await import("./jail.js");

    await expect(
      runInJail({
        args: [],
        command: "/usr/bin/python3",
        cwd: "/tmp",
        gid: RUN_UID,
        limits: DEFAULT_LIMITS,
        uid: RUN_UID,
      })
    ).rejects.toThrow(/already owns/u);

    // Refused before anything was spawned, not cleaned up afterwards: a
    // reap-then-check would SIGKILL those processes, which on a shared uid is
    // the host-wide kill this guard exists to prevent.
    expect(spawnMock).not.toHaveBeenCalled();
    expect(reapUidMock).not.toHaveBeenCalled();
  });
});
