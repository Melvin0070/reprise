import { describe, expect, it } from "vitest";

import { buildJailArgv } from "./argv.js";
import type { JailLimits } from "./limits.js";

const LIMITS: JailLimits = {
  maxAddressSpaceBytes: 256 * 1024 * 1024,
  maxCpuSeconds: 5,
  maxOutputBytes: 64 * 1024,
  maxProcesses: 64,
  wallClockMs: 10_000,
};

describe("buildJailArgv", () => {
  it("translates limits into prlimit flags and execs the command after --", () => {
    const argv = buildJailArgv(LIMITS, "/usr/bin/python3", ["-c", "print(1)"]);

    expect(argv).toEqual([
      "--nproc=64",
      "--as=268435456",
      "--cpu=5",
      "--",
      "/usr/bin/python3",
      "-c",
      "print(1)",
    ]);
  });

  it("keeps user arguments after -- so they can never be read as prlimit flags", () => {
    // A payload argument that looks like a flag is the injection case worth
    // pinning: prlimit must treat it as an argument to the runner, not as a
    // limit of its own.
    const argv = buildJailArgv(LIMITS, "/usr/bin/python3", ["--nproc=99999"]);

    expect(argv.indexOf("--nproc=99999")).toBeGreaterThan(argv.indexOf("--"));
    expect(argv.find((a) => a.startsWith("--nproc="))).toBe("--nproc=64");
  });

  it("rejects a non-positive wall clock, which would disarm the timeout", () => {
    expect(() =>
      buildJailArgv({ ...LIMITS, wallClockMs: 0 }, "/usr/bin/python3", [])
    ).toThrow(/wallClockMs/u);
  });

  it("rejects a CPU ceiling the wall clock would always beat", () => {
    // With maxCpuSeconds at or above the wall clock, RLIMIT_CPU can never fire:
    // every CPU-bound loop comes back as `timeout` instead of `killed-limit`,
    // and the run loses the verdict it earned. DEFAULT_LIMITS only claimed this
    // ordering in a comment until #78.
    expect(() =>
      buildJailArgv(
        { ...LIMITS, maxCpuSeconds: 10, wallClockMs: 10_000 },
        "/usr/bin/python3",
        []
      )
    ).toThrow(/maxCpuSeconds/u);
  });

  it("accepts a CPU ceiling strictly below the wall clock", () => {
    expect(() =>
      buildJailArgv(
        { ...LIMITS, maxCpuSeconds: 9, wallClockMs: 10_000 },
        "/usr/bin/python3",
        []
      )
    ).not.toThrow();
  });

  it("rejects limits that are not finite integers", () => {
    expect(() =>
      buildJailArgv(
        { ...LIMITS, maxAddressSpaceBytes: Number.NaN },
        "/usr/bin/python3",
        []
      )
    ).toThrow(/maxAddressSpaceBytes/u);
  });
});
