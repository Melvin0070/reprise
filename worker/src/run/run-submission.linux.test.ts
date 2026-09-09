import { readdir } from "node:fs/promises";
import { tmpdir } from "node:os";

import { describe, expect, it } from "vitest";

import { DEFAULT_LIMITS } from "../sandbox/limits.js";
import { processesForUid } from "../sandbox/reap.js";
import { runSubmission } from "./run-submission.js";

/**
 * The end-to-end run suite. Same two preconditions as the isolation suite —
 * Linux, because the rlimits only mean something there, and root, because the
 * run drops to an unprivileged uid and you cannot drop what you do not hold.
 *
 * Skipped is never passed: `pnpm test:linux` runs this in the image CI builds.
 */
const canIsolate = process.platform === "linux" && process.getuid?.() === 0;

const RUN_UID = 1001;
const runner = { gid: 1001, uid: RUN_UID };

/**
 * A wall clock short enough to keep the suite quick needs a CPU ceiling below
 * it — `buildJailArgv` rejects the pair otherwise, because an unreachable
 * RLIMIT_CPU is dead weight.
 */
const SHORT = { ...DEFAULT_LIMITS, maxCpuSeconds: 1 };

const run = (code: string, limits = DEFAULT_LIMITS) =>
  runSubmission({ code, language: "python" }, { limits, runner });

describe.skipIf(!canIsolate)("the walking skeleton", () => {
  it('runs print("hello") to terminal succeeded, exit 0, stdout hello', async () => {
    // This is the contract the whole product is built around. It must hold at
    // every commit from here on.
    const result = await run('print("hello")');

    expect(result.state).toBe("succeeded");
    expect(result.exitCode).toBe(0);
    expect(result.stdout.trim()).toBe("hello");
  });
});

describe.skipIf(!canIsolate)("runSubmission — terminal states", () => {
  it("reports a non-zero exit as failed and keeps the exit code", async () => {
    const result = await run("raise SystemExit(3)");

    expect(result.state).toBe("failed");
    expect(result.exitCode).toBe(3);
  });

  it("reports an uncaught exception as failed with the traceback on stderr", async () => {
    const result = await run('raise ValueError("nope")');

    expect(result.state).toBe("failed");
    expect(result.exitCode).toBe(1);
    expect(result.stderr).toMatch(/ValueError: nope/u);
  });

  it("reports a sleeping process as timeout", async () => {
    const result = await run("import time; time.sleep(60)", {
      ...SHORT,
      wallClockMs: 1500,
    });

    expect(result.state).toBe("timeout");
    expect(result.exitCode).toBeNull();
  }, 20_000);

  it("reports a CPU-bound loop as killed-limit", async () => {
    const result = await run("while True: pass", {
      ...DEFAULT_LIMITS,
      maxCpuSeconds: 1,
      wallClockMs: 15_000,
    });

    // SIGXCPU — the kernel stopped it at a ceiling we set, so this is
    // containment rather than the program being wrong.
    expect(result.state).toBe("killed-limit");
  }, 20_000);
});

describe.skipIf(!canIsolate)("runSubmission — output is not lost", () => {
  it("keeps output printed before a timeout kill", async () => {
    // The -u regression test. Python block-buffers stdout when it is not a
    // tty, so without unbuffered output the SIGKILL at the wall clock would
    // discard "hello" and this run would report a timeout with empty stdout —
    // silently losing output the program had already produced.
    const result = await run('print("hello")\nimport time\ntime.sleep(60)', {
      ...SHORT,
      wallClockMs: 1500,
    });

    expect(result.state).toBe("timeout");
    expect(result.stdout.trim()).toBe("hello");
  }, 20_000);
});

describe.skipIf(!canIsolate)(
  "runSubmission — the code reaches the runner verbatim",
  () => {
    it("runs code containing quotes, newlines and backslashes", async () => {
      // Proof that the code travels as a file rather than as an argv string:
      // none of this would survive a shell, and much of it would not survive -c.
      const code = [
        "message = 'it\\'s \"quoted\" \\\\ backslashed'",
        "print(message)",
        "print(len(message))",
      ].join("\n");

      const result = await run(code);

      expect(result.state).toBe("succeeded");
      expect(result.stdout).toContain('it\'s "quoted" \\ backslashed');
    });

    it("runs a payload far larger than a command line could carry", async () => {
      const lines = Array.from({ length: 20_000 }, (_, i) => `x = ${i}`);
      const result = await run([...lines, "print(x)"].join("\n"));

      expect(result.state).toBe("succeeded");
      expect(result.stdout.trim()).toBe("19999");
    }, 20_000);
  }
);

const workspaces = async (): Promise<string[]> => {
  const entries = await readdir(tmpdir());

  return entries.filter((entry) => entry.startsWith("reprise-run-"));
};

describe.skipIf(!canIsolate)("runSubmission — the workspace", () => {
  it("removes the run workspace afterwards", async () => {
    const before = await workspaces();
    await run('print("hello")');
    const after = await workspaces();

    expect(after).toEqual(before);
  });

  it("removes the run workspace even when the run is killed", async () => {
    // The kill path unwinds through a different branch than a clean exit, so
    // the cleanup gets asserted separately rather than assumed to generalise.
    const before = await workspaces();
    await run("import time; time.sleep(60)", {
      ...SHORT,
      wallClockMs: 1200,
    });
    const after = await workspaces();

    expect(after).toEqual(before);
  }, 20_000);
});

describe.skipIf(!canIsolate)("runSubmission — nothing outlives the run", () => {
  it("reaps a child that left the process group with setsid (#78)", async () => {
    const escape = [
      "import os, sys, time",
      "pid = os.fork()",
      "if pid == 0:",
      // A new session and a new process group. A kill aimed at the group we
      // created misses this child completely, and because it keeps fd 1 and 2
      // the output pipes never drain — so `close` never fires and, before the
      // uid reap, this call never settled at all.
      "    os.setsid()",
      "    time.sleep(120)",
      "    os._exit(0)",
      'sys.stdout.write("escapee=%d" % pid)',
      "sys.stdout.flush()",
      "os._exit(0)",
    ].join("\n");

    const wallClockMs = 2000;
    const result = await run(escape, { ...SHORT, wallClockMs });

    // Terminal, and inside the wall clock: the leader exits immediately, the
    // orphan is reaped on the pipe-drain grace, and the pipes close. The
    // failure this replaces was an unsettled promise and a hung request.
    expect(result.durationMs).toBeLessThan(wallClockMs);
    // `succeeded` is the honest verdict *here*: the program exited 0 and the
    // sweep cleared its escapee, so containment held and the verdict stands.
    // Not a general rule — an escapee the sweep cannot clear downgrades the run
    // to `unreaped`/`failed-infra`, because then the leader's exit code is true
    // about the leader and false about the run.
    expect(result.state).toBe("succeeded");

    const escapee = Number(
      /escapee=(?<pid>\d+)/u.exec(result.stdout)?.groups?.pid ?? -1
    );
    expect(escapee).toBeGreaterThan(0);

    // Asserting on this pid rather than on an empty census: the census is
    // host-wide, so anything else running as this uid would show up in it.
    // (`worker/vitest.config.ts` sets `fileParallelism: false` so the suites
    // cannot be that "anything else" — that setting is load-bearing, not tidy.)
    expect(await processesForUid(RUN_UID)).not.toContain(escapee);
  }, 20_000);
});
