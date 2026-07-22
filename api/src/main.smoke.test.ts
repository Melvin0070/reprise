import { spawn } from "node:child_process";
import type { ChildProcess } from "node:child_process";
import { once } from "node:events";
import { existsSync } from "node:fs";
import nodePath from "node:path";
import { setTimeout as delay } from "node:timers/promises";

import { afterAll, beforeAll, describe, expect, it } from "vitest";

/**
 * The compiled artifact, exercised the way the deploy runs it.
 *
 * Every other api test imports TypeScript source. This one spawns
 * `node dist/main.js` — the exact file the Dockerfile ships — and speaks HTTP
 * to it. It is the local proxy for issue #4's "a deployed run works on Fly":
 * it proves the production build boots, wires Nest's dependency injection,
 * installs the OV-1 guard and the DX7 filter, and answers over the network. It
 * asserts nothing about executing code, which needs Linux and root and is
 * covered by the isolation suite.
 *
 * It runs only once `pnpm build` has produced the artifact, mirroring how the
 * Linux isolation tests run only where they can mean something. `pnpm verify`
 * does not build, so this skips on a dev checkout and runs in CI after the
 * build step.
 */
const distMain = nodePath.resolve(import.meta.dirname, "..", "dist", "main.js");
const isBuilt = existsSync(distMain);

const MIN_KEY_LENGTH = 32;
// A key long enough to clear the boot check. Its value never matters here:
// these tests only send a missing or wrong key, never the right one.
const API_KEY = `smoke-${"x".repeat(MIN_KEY_LENGTH)}`;
// A non-root runner identity, present only so the inline runner can be built at
// boot. No submission runs, so the uid is never actually assumed.
const RUNNER_ID = "1001";
const PORT = "34517";
const BASE = `http://127.0.0.1:${PORT}`;

const POLL_INTERVAL_MS = 100;
// 15s worth of polls, matching how long a cold `node` boot can take.
const MAX_POLLS = 150;
const HTTP_NOT_FOUND = 404;
const HTTP_UNAUTHORIZED = 401;

let server: ChildProcess | undefined;
let serverStderr = "";

/**
 * Resolve once the server answers a request, or throw with what it printed.
 *
 * Written as recursion rather than a poll loop on purpose: a `while` that
 * `await`s each attempt is exactly the shape the lint rules (and readers) treat
 * as a smell, and the retry count reads more honestly as a base case.
 */
const waitUntilServing = async (pollsLeft: number): Promise<void> => {
  if (server !== undefined && server.exitCode !== null) {
    throw new Error(
      `production server exited before serving (code ${server.exitCode}):\n${serverStderr}`
    );
  }
  try {
    await fetch(`${BASE}/nope`);
  } catch (error) {
    if (pollsLeft <= 0) {
      throw new Error(
        `production server did not answer in time:\n${serverStderr}`,
        { cause: error }
      );
    }
    await delay(POLL_INTERVAL_MS);
    await waitUntilServing(pollsLeft - 1);
  }
};

const codeOf = async (res: Response): Promise<string | undefined> => {
  const body = (await res.json()) as { code?: string };
  return body.code;
};

describe.skipIf(!isBuilt)("the compiled server serves (issue #4)", () => {
  beforeAll(async () => {
    server = spawn("node", [distMain], {
      env: {
        ...process.env,
        PORT,
        REPRISE_API_KEY: API_KEY,
        REPRISE_RUN_GID: RUNNER_ID,
        REPRISE_RUN_UID: RUNNER_ID,
      },
      stdio: ["ignore", "ignore", "pipe"],
    });
    server.stderr?.on("data", (chunk: Buffer) => {
      serverStderr += chunk.toString();
    });
    await waitUntilServing(MAX_POLLS);
  });

  afterAll(async () => {
    if (server === undefined) {
      return;
    }
    server.kill("SIGKILL");
    await once(server, "exit");
    server = undefined;
  });

  it("carries the DX7 envelope on an unknown route", async () => {
    const res = await fetch(`${BASE}/nope`);
    expect(res.status).toBe(HTTP_NOT_FOUND);
    expect(await codeOf(res)).toBe("not_found");
  });

  it("enforces the OV-1 gate on the compiled build", async () => {
    const res = await fetch(`${BASE}/submissions`, {
      body: JSON.stringify({ code: 'print("hello")', language: "python" }),
      headers: { "Content-Type": "application/json" },
      method: "POST",
    });
    expect(res.status).toBe(HTTP_UNAUTHORIZED);
    expect(res.headers.get("www-authenticate")).toBe("Bearer");
    expect(await codeOf(res)).toBe("unauthorized");
  });
});
