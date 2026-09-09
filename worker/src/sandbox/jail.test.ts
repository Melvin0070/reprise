import { describe, expect, it } from "vitest";

import { runInJail } from "./jail.js";
import { DEFAULT_LIMITS } from "./limits.js";

/**
 * Guards that reject a bad spec before anything is spawned, so they hold on
 * every platform — including the macOS dev host, where the isolation suite
 * itself cannot say anything meaningful.
 */
/**
 * A run uid that is provably not this process's own.
 *
 * The jail refuses a run uid equal to the worker's (#78), and GitHub's
 * `ubuntu-latest` runner is itself uid 1001 — so a hardcoded 1001 passes on a
 * macOS dev host (uid 501) and in the root isolation container (uid 0), and
 * turns this whole file red in the one place it actually runs unprivileged.
 */
const RUN_UID = process.getuid?.() === 1001 ? 1002 : 1001;

describe("runInJail — refuses an unsafe spec", () => {
  const base = {
    args: [],
    command: "/usr/bin/python3",
    cwd: "/tmp",
    gid: RUN_UID,
    limits: DEFAULT_LIMITS,
    uid: RUN_UID,
  };

  it("refuses to run as root", async () => {
    // Non-root is the crude tier's only filesystem boundary (threat model #4).
    // A caller that forgets it would silently lose that boundary, so this is a
    // hard refusal rather than a default.
    await expect(runInJail({ ...base, uid: 0 })).rejects.toThrow(/root/u);
  });

  it("refuses to run in the root group", async () => {
    await expect(runInJail({ ...base, gid: 0 })).rejects.toThrow(/root/u);
  });

  it("refuses a run uid shared with the worker's own", async () => {
    // The reap kills by uid (#78), so a shared uid would put the worker on its
    // own kill list. The crude tier already needs the run uid to be dedicated —
    // RLIMIT_NPROC is per-uid — so this enforces what it was assuming.
    const own = process.getuid?.() ?? 0;

    await expect(runInJail({ ...base, uid: own })).rejects.toThrow(
      /dedicated|root/u
    );
  });

  it("refuses a wall clock that would disarm the timeout", async () => {
    await expect(
      runInJail({ ...base, limits: { ...DEFAULT_LIMITS, wallClockMs: 0 } })
    ).rejects.toThrow(/wallClockMs/u);
  });
});
