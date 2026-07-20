import { chmod, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { runInJail } from "./jail.js";
import { DEFAULT_LIMITS } from "./limits.js";

/**
 * The isolation suite.
 *
 * Two preconditions, and both are real rather than defensive:
 *
 * 1. Linux. macOS does not enforce RLIMIT_AS, so a memory-bomb assertion there
 *    would pass while the limit silently did nothing.
 * 2. Root. The jail's first move is to drop to an unprivileged uid, and you
 *    cannot drop a privilege you do not hold — an unprivileged caller gets
 *    EPERM from spawn. This is why the suite cannot ride the ordinary CI job,
 *    which runs as `runner`, and why it gets its own container job instead.
 *
 * Skipped is never passed: `pnpm test:linux` runs this locally in the same
 * image the CI isolation job builds.
 */
const canIsolate = process.platform === "linux" && process.getuid?.() === 0;

const PYTHON = "/usr/bin/python3";
const RUN_UID = 1001;
const RUN_GID = 1001;

let scratch: string;

beforeAll(async () => {
  if (!canIsolate) {
    return;
  }
  scratch = await mkdtemp(path.join(tmpdir(), "reprise-jail-"));
  // The runner is an unprivileged uid, so it needs to be able to enter its own
  // working directory. Step 3 replaces this with a tmpfs inside a mount ns.
  await chmod(scratch, 0o777);
});

afterAll(async () => {
  if (scratch) {
    await rm(scratch, { force: true, recursive: true });
  }
});

const spec = (args: string[], limits = DEFAULT_LIMITS) => ({
  args,
  command: PYTHON,
  cwd: scratch,
  gid: RUN_GID,
  limits,
  uid: RUN_UID,
});

describe.skipIf(!canIsolate)("runInJail — the run actually works", () => {
  it("runs a program and returns its stdout and exit code", async () => {
    const result = await runInJail(spec(["-c", 'print("hello")']));

    expect(result.outcome).toEqual({ exitCode: 0, kind: "exited" });
    expect(result.stdout.trim()).toBe("hello");
  });

  it("separates stderr from stdout", async () => {
    const result = await runInJail(
      spec(["-c", 'import sys; sys.stderr.write("boom"); print("ok")'])
    );

    expect(result.stdout.trim()).toBe("ok");
    expect(result.stderr.trim()).toBe("boom");
  });

  it("reports a crashing program as a normal non-zero exit, not as containment", async () => {
    const result = await runInJail(spec(["-c", "raise SystemExit(3)"]));

    expect(result.outcome).toEqual({ exitCode: 3, kind: "exited" });
  });
});

describe.skipIf(!canIsolate)("runInJail — privilege", () => {
  it("runs as the unprivileged uid, never as root (threat model #4)", async () => {
    const result = await runInJail(
      spec(["-c", "import os; print(os.getuid())"])
    );

    expect(result.stdout.trim()).toBe(String(RUN_UID));
    expect(result.stdout.trim()).not.toBe("0");
  });
});

describe.skipIf(!canIsolate)("runInJail — containment", () => {
  it("stops an infinite loop by CPU limit before the wall clock (threat model #3)", async () => {
    const result = await runInJail(
      spec(["-c", "while True: pass"], {
        ...DEFAULT_LIMITS,
        maxCpuSeconds: 1,
        wallClockMs: 15_000,
      })
    );

    // The kernel stopped it, not our timer — that is the point of RLIMIT_CPU
    // being set below the wall clock.
    expect(result.outcome.kind).toBe("signalled");
    expect(result.durationMs).toBeLessThan(10_000);
  }, 20_000);

  it("stops a sleeping process by wall clock, which burns no CPU (threat model #3)", async () => {
    const result = await runInJail(
      spec(["-c", "import time; time.sleep(60)"], {
        ...DEFAULT_LIMITS,
        wallClockMs: 1500,
      })
    );

    expect(result.outcome).toEqual({ kind: "timeout" });
    expect(result.durationMs).toBeGreaterThanOrEqual(1400);
    expect(result.durationMs).toBeLessThan(8000);
  }, 20_000);

  it("bounds a fork bomb at the process limit (threat model #1)", async () => {
    const maxProcesses = 16;
    const forkBomb = [
      "import os, sys, time",
      "n = 0",
      "try:",
      "    while True:",
      "        if os.fork() == 0:",
      // child holds its slot
      "            time.sleep(30)",
      "            os._exit(0)",
      "        n += 1",
      "except OSError:",
      "    pass",
      'sys.stdout.write("forks=%d" % n)',
      "sys.stdout.flush()",
      "os._exit(0)",
    ].join("\n");

    const result = await runInJail(
      spec(["-c", forkBomb], {
        ...DEFAULT_LIMITS,
        maxProcesses,
        wallClockMs: 4000,
      })
    );

    const forks = Number(
      /forks=(?<count>\d+)/u.exec(result.stdout)?.groups?.count ?? -1
    );
    // The bomb hit EAGAIN instead of multiplying without bound. The exact
    // number varies with what else the uid owns; the property under test is
    // that it is bounded by the limit at all.
    expect(forks).toBeGreaterThanOrEqual(0);
    expect(forks).toBeLessThanOrEqual(maxProcesses);
  }, 25_000);

  it("stops a memory bomb at the address-space limit (threat model #2)", async () => {
    const result = await runInJail(
      spec(["-c", "x = bytearray(1024 * 1024 * 1024)"], {
        ...DEFAULT_LIMITS,
        maxAddressSpaceBytes: 256 * 1024 * 1024,
        wallClockMs: 10_000,
      })
    );

    // The allocation fails inside the process rather than the host being
    // driven into OOM. Containment here looks like a normal crash.
    expect(result.outcome.kind).toBe("exited");
    expect(result.stderr).toMatch(/MemoryError/u);
  }, 20_000);
});

describe.skipIf(!canIsolate)("runInJail — output flooding", () => {
  it("truncates a print flood instead of buffering it without bound", async () => {
    const result = await runInJail(
      spec(["-c", 'import sys\nwhile True: sys.stdout.write("x" * 4096)'], {
        ...DEFAULT_LIMITS,
        wallClockMs: 3000,
      })
    );

    expect(result.truncated).toBe(true);
    expect(result.stdout.length).toBeLessThanOrEqual(64 * 1024);
  }, 20_000);
});
