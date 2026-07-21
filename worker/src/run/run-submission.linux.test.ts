import { readdir } from "node:fs/promises";
import { tmpdir } from "node:os";

import { describe, expect, it } from "vitest";

import { DEFAULT_LIMITS } from "../sandbox/limits.js";
import { runSubmission } from "./run-submission.js";

/**
 * The end-to-end run suite. Same two preconditions as the isolation suite —
 * Linux, because the rlimits only mean something there, and root, because the
 * run drops to an unprivileged uid and you cannot drop what you do not hold.
 *
 * Skipped is never passed: `pnpm test:linux` runs this in the image CI builds.
 */
const canIsolate = process.platform === "linux" && process.getuid?.() === 0;

const runner = { gid: 1001, uid: 1001 };

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
      ...DEFAULT_LIMITS,
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
      ...DEFAULT_LIMITS,
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
      ...DEFAULT_LIMITS,
      wallClockMs: 1200,
    });
    const after = await workspaces();

    expect(after).toEqual(before);
  }, 20_000);
});
