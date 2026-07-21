import type { NestExpressApplication } from "@nestjs/platform-express";
import { Test } from "@nestjs/testing";
import { DEFAULT_LIMITS } from "@reprise/worker/limits";
import request from "supertest";
import { afterEach, describe, expect, it } from "vitest";

import { APP_OPTIONS, configureApp } from "../app-setup.js";
import { AppModule } from "../app.module.js";
import { MIN_API_KEY_LENGTH } from "../auth/api-key.js";

/**
 * The walking skeleton, end to end, with nothing stubbed.
 *
 * Everything else in this package tests the HTTP layer against a stub runner.
 * This suite is the one that proves the layers are actually connected — a
 * request arriving over a socket, code reaching the jail, and a real terminal
 * state coming back. Without it, every green suite would be compatible with a
 * controller wired to nothing.
 *
 * Same preconditions as the jail's own suites: Linux, because the rlimits mean
 * nothing elsewhere, and root, because the run drops to an unprivileged uid and
 * you cannot drop what you do not hold. Skipped is never passed — `pnpm
 * test:linux` runs this in the image CI builds.
 */
const canIsolate = process.platform === "linux" && process.getuid?.() === 0;

/** Matches the account the test image creates. */
const RUNNER_UID = "1001";

/**
 * A real key, set in the environment rather than injected, so this suite
 * exercises the same startup path a deploy does: the gate reads its key from
 * the process environment and the request has to carry it.
 */
const TEST_KEY = `linux-test-key-${"x".repeat(MIN_API_KEY_LENGTH)}`;

/**
 * Read from the jail's own limits rather than restated, so raising the wall
 * clock cannot leave this test failing for a reason that has nothing to do
 * with the behaviour it checks.
 */
const JAIL_WALL_CLOCK_MS = DEFAULT_LIMITS.wallClockMs;
const TIMEOUT_HEADROOM_MS = 5000;

let app: NestExpressApplication | undefined;

const buildApp = async (): Promise<NestExpressApplication> => {
  // Set before the module is compiled: the inline runner reads the identity
  // once, when its provider is constructed.
  process.env.REPRISE_RUN_UID = RUNNER_UID;
  process.env.REPRISE_RUN_GID = RUNNER_UID;
  process.env.REPRISE_API_KEY = TEST_KEY;

  const moduleRef = await Test.createTestingModule({
    imports: [AppModule],
  }).compile();

  const built =
    moduleRef.createNestApplication<NestExpressApplication>(APP_OPTIONS);
  configureApp(built);
  await built.init();
  app = built;
  return built;
};

const post = async (body: object | string) => {
  const built = await buildApp();
  return request(built.getHttpServer())
    .post("/submissions")
    .set("Authorization", `Bearer ${TEST_KEY}`)
    .send(body);
};

afterEach(async () => {
  await app?.close();
  app = undefined;
});

describe.skipIf(!canIsolate)("the walking skeleton over HTTP", () => {
  it('POST /submissions with print("hello") succeeds with exit 0 and stdout hello', async () => {
    // The contract the whole product is built around, now reachable the way a
    // client actually reaches it. It must hold at every commit from here on.
    const response = await post({ code: 'print("hello")', language: "python" });

    expect(response.status).toBe(200);
    expect(response.body.state).toBe("succeeded");
    expect(response.body.exit_code).toBe(0);
    expect(response.body.stdout.trim()).toBe("hello");
    expect(response.body.stderr).toBe("");
  });

  it("reports a raised exception as failed with the traceback on stderr", async () => {
    // Proves stderr survives the whole path, not just stdout — a postmortem
    // product that lost the traceback would be losing the interesting half.
    const response = await post({
      code: 'raise ValueError("boom")',
      language: "python",
    });

    expect(response.status).toBe(200);
    expect(response.body.state).toBe("failed");
    expect(response.body.exit_code).toBe(1);
    expect(response.body.stderr).toContain("ValueError: boom");
  });

  it("does not run submitted code as root", async () => {
    // The crude tier's only filesystem boundary is the unprivileged uid, so
    // this asserts the boundary exists rather than trusting that it does.
    const response = await post({
      code: "import os; print(os.getuid())",
      language: "python",
    });

    expect(response.body.state).toBe("succeeded");
    expect(response.body.stdout.trim()).toBe(RUNNER_UID);
  });

  it(
    "returns a terminal timeout as 200 rather than hanging or erroring",
    async () => {
      const response = await post({
        code: "import time; time.sleep(30)",
        language: "python",
      });

      expect(response.status).toBe(200);
      expect(response.body.state).toBe("timeout");
      expect(response.body.exit_code).toBeNull();
    },
    // Must exceed the jail's own wall clock, or the runner gives up first and
    // reports a test timeout for a product that behaved correctly — a red
    // result that says nothing about the code under test.
    JAIL_WALL_CLOCK_MS + TIMEOUT_HEADROOM_MS
  );

  it("preserves code containing quotes and newlines exactly", async () => {
    // The code travels as a file rather than an argv string precisely so this
    // works; asserting it here keeps that property from silently regressing.
    const response = await post({
      code: 'print("""a "quoted" line\nand a second""")',
      language: "python",
    });

    expect(response.body.state).toBe("succeeded");
    expect(response.body.stdout).toBe('a "quoted" line\nand a second\n');
  });
});
