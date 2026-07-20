import { describe, expect, it } from "vitest";

import { runInJail } from "./jail.js";
import { DEFAULT_LIMITS } from "./limits.js";

/**
 * Guards that reject a bad spec before anything is spawned, so they hold on
 * every platform — including the macOS dev host, where the isolation suite
 * itself cannot say anything meaningful.
 */
describe("runInJail — refuses an unsafe spec", () => {
  const base = {
    args: [],
    command: "/usr/bin/python3",
    cwd: "/tmp",
    gid: 1001,
    limits: DEFAULT_LIMITS,
    uid: 1001,
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

  it("refuses a wall clock that would disarm the timeout", async () => {
    await expect(
      runInJail({ ...base, limits: { ...DEFAULT_LIMITS, wallClockMs: 0 } })
    ).rejects.toThrow(/wallClockMs/u);
  });
});
