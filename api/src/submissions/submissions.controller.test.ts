import type { INestApplication } from "@nestjs/common";
import type { NestExpressApplication } from "@nestjs/platform-express";
import { Test } from "@nestjs/testing";
import type { SubmissionRequest, SubmissionResult } from "@reprise/worker/run";
import request from "supertest";
import { afterEach, describe, expect, it } from "vitest";

import { APP_OPTIONS, configureApp } from "../app-setup.js";
import { AppModule } from "../app.module.js";
import { SUBMISSION_RUNNER } from "./submission-runner.js";
import type { SubmissionRunner } from "./submission-runner.js";
import { MAX_BODY_BYTES, MAX_CODE_BYTES } from "./submission.schema.js";

/**
 * The controller is tested against a stub runner rather than the real jail.
 *
 * Not for speed: the jail needs Linux and root, so binding these tests to it
 * would mean the HTTP contract went unverified on every developer machine. The
 * jail has its own suite that runs where it can actually be exercised
 * (`run-submission.linux.test.ts`); this suite owns the layer above it, and
 * `submissions.linux.test.ts` joins the two end to end.
 */
const succeeded: SubmissionResult = {
  durationMs: 41,
  exitCode: 0,
  state: "succeeded",
  stderr: "",
  stdout: "hello\n",
  truncated: false,
};

const stubRunner = (
  result: SubmissionResult = succeeded
): SubmissionRunner & { readonly calls: SubmissionRequest[] } => {
  const calls: SubmissionRequest[] = [];
  return {
    calls,
    run: (submission) => {
      calls.push(submission);
      return Promise.resolve(result);
    },
  };
};

let app: INestApplication | undefined;

/**
 * Boots the real AppModule with only the runner swapped.
 *
 * Overriding the provider rather than hand-assembling a controller is what
 * makes these tests worth writing: the global validation pipe and the DX7
 * exception filter are wired inside the module, so a test that bypassed it
 * would assert on envelopes the running server never produces.
 */
const buildApp = async (
  runner: SubmissionRunner
): Promise<INestApplication> => {
  const moduleRef = await Test.createTestingModule({ imports: [AppModule] })
    .overrideProvider(SUBMISSION_RUNNER)
    .useValue(runner)
    .compile();

  const built =
    moduleRef.createNestApplication<NestExpressApplication>(APP_OPTIONS);
  configureApp(built);
  await built.init();
  app = built;
  return built;
};

const post = async (
  body: object | string,
  runner: SubmissionRunner = stubRunner()
) => {
  const built = await buildApp(runner);
  return request(built.getHttpServer()).post("/submissions").send(body);
};

afterEach(async () => {
  await app?.close();
  app = undefined;
});

describe("POST /submissions — a completed run", () => {
  it("answers 200 with the run's terminal state, not 201", async () => {
    // 201 Created would promise a resource that exists and can be fetched.
    // Inline execution mints no such thing: the response IS the whole run. The
    // queue upgrade changes this to 202 + `queued`, which is an API-visible
    // consequence of the downgrade, recorded in the learning log.
    const response = await post({ code: 'print("hello")', language: "python" });

    expect(response.status).toBe(200);
    expect(response.body.state).toBe("succeeded");
  });

  it("renders the result in snake_case with the exit code preserved", async () => {
    const response = await post({ code: 'print("hello")', language: "python" });

    expect(response.body).toEqual({
      duration_ms: 41,
      exit_code: 0,
      state: "succeeded",
      stderr: "",
      stdout: "hello\n",
      truncated: false,
    });
  });

  it("passes the submitted code through to the runner unaltered", async () => {
    // Quotes and newlines survive because the code travels as a body field and
    // then as a file. Anything that mangled it would be invisible in a result
    // assertion, so the runner's own view of it is what gets checked.
    const code = 'x = "a\\nb"\nprint(x)\n';
    const runner = stubRunner();
    await post({ code, language: "python" }, runner);

    expect(runner.calls).toEqual([{ code, language: "python" }]);
  });

  it("reports a non-terminal-success run as 200, not as an HTTP error", async () => {
    // V7 is the rule being pinned here: 7A states are run RESULTS delivered as
    // data. A timeout is something the user's code did, not a fault in the
    // service, and a 4xx/5xx would tell every client the opposite.
    const timedOut: SubmissionResult = {
      durationMs: 10_000,
      exitCode: null,
      state: "timeout",
      stderr: "",
      stdout: "partial",
      truncated: false,
    };
    const response = await post(
      { code: "while True: pass", language: "python" },
      stubRunner(timedOut)
    );

    expect(response.status).toBe(200);
    expect(response.body.state).toBe("timeout");
    expect(response.body.exit_code).toBeNull();
  });

  it("does not leak the infra failure detail to the client", async () => {
    // `infraError` carries our paths and interpreter locations. The state says
    // the run never happened, which is what the caller can act on; the detail
    // is ours. See TODOS — today it has no destination at all.
    const broke: SubmissionResult = {
      durationMs: 3,
      exitCode: null,
      infraError: "ENOENT: /usr/bin/python3",
      state: "failed-infra",
      stderr: "",
      stdout: "",
      truncated: false,
    };
    const response = await post(
      { code: "print(1)", language: "python" },
      stubRunner(broke)
    );

    expect(response.status).toBe(200);
    expect(response.body.state).toBe("failed-infra");
    expect(JSON.stringify(response.body)).not.toContain("python3");
  });
});

/** Every field DX7 promises is present, whichever error produced the body. */
const expectEnvelope = (body: unknown) => {
  expect(body).toMatchObject({
    code: expect.any(String),
    docs_url: expect.any(String),
    hint: expect.any(String),
    message: expect.any(String),
  });
};

describe("POST /submissions — rejected requests", () => {
  it("rejects an unsupported language and names the supported ones", async () => {
    const response = await post({ code: "puts 1", language: "ruby" });

    expect(response.status).toBe(400);
    expect(response.body.code).toBe("validation_failed");
    expectEnvelope(response.body);
    // The hint has to be actionable, which for a closed set means listing it.
    expect(response.body.hint).toContain("python");
  });

  it("rejects a missing code field", async () => {
    const response = await post({ language: "python" });

    expect(response.status).toBe(400);
    expect(response.body.code).toBe("validation_failed");
    expect(response.body.message).toContain("code");
  });

  it("rejects a non-string code field", async () => {
    const response = await post({ code: 42, language: "python" });

    expect(response.status).toBe(400);
    expect(response.body.code).toBe("validation_failed");
  });

  it("rejects code larger than the cap, measured in bytes", async () => {
    // One over the limit, so the test fails if the boundary is off by one in
    // either direction.
    const response = await post({
      code: "a".repeat(MAX_CODE_BYTES + 1),
      language: "python",
    });

    expect(response.status).toBe(400);
    expect(response.body.code).toBe("validation_failed");
  });

  it("accepts code exactly at the cap", async () => {
    const response = await post({
      code: "a".repeat(MAX_CODE_BYTES),
      language: "python",
    });

    expect(response.status).toBe(200);
  });

  it("counts the cap in bytes rather than characters", async () => {
    // A multi-byte character is one JS string unit but four bytes on disk.
    // Measuring length would let a caller write four times the cap.
    const response = await post({
      code: "😀".repeat(MAX_CODE_BYTES / 2),
      language: "python",
    });

    expect(response.status).toBe(400);
  });

  it("accepts an at-cap program whose JSON encoding is many times larger", async () => {
    // The regression that Express's 100 kB default body limit would cause. A
    // control character is one byte in the file and six on the wire, so this
    // legal at-cap submission arrives as a ~390 kB body. Without an explicit
    // limit it is rejected before validation, and the code cap we advertise is
    // one the API does not actually honour.
    const response = await post({
      code: "\u0001".repeat(MAX_CODE_BYTES),
      language: "python",
    });

    expect(response.status).toBe(200);
  });

  it("refuses a body past the buffer ceiling with the envelope", async () => {
    // The ceiling exists because validation cannot run until the whole body is
    // in memory. This asserts the refusal still looks like every other error
    // rather than like whatever the body parser would have said.
    const response = await post({
      code: "a".repeat(MAX_BODY_BYTES + 1),
      language: "python",
    });

    expect(response.status).toBe(413);
    expect(response.body.code).toBe("validation_failed");
    expect(response.body.docs_url).toContain("validation_failed");
  });

  it("rejects an unknown field instead of silently dropping it", async () => {
    // A typo'd field that is quietly ignored is the worst outcome: the caller
    // believes a limit was applied that never was.
    const response = await post({
      cdoe: 'print("hello")',
      code: 'print("hello")',
      language: "python",
    });

    expect(response.status).toBe(400);
    expect(response.body.code).toBe("validation_failed");
    expect(response.body.message).toContain("cdoe");
  });

  it("never reaches the runner when validation fails", async () => {
    const runner = stubRunner();
    await post({ code: "puts 1", language: "ruby" }, runner);

    expect(runner.calls).toEqual([]);
  });
});

describe("the DX7 envelope covers every error, not just handled ones", () => {
  it("wraps an unrouted path in the envelope", async () => {
    // Nest's own NotFoundException goes through the same filter, so the 404 a
    // caller hits by typo looks like every other error rather than like a
    // different API.
    const built = await buildApp(stubRunner());
    const response = await request(built.getHttpServer()).get("/nope");

    expect(response.status).toBe(404);
    expect(response.body.code).toBe("not_found");
    expect(response.body.docs_url).toContain("not_found");
  });

  it("wraps an unexpected runner failure as infra_error without leaking it", async () => {
    // An exception nobody anticipated is the case where a framework default
    // would spill a stack trace. It must still be an envelope, and it must not
    // describe our internals.
    const exploding: SubmissionRunner = {
      run: () => Promise.reject(new Error("connect ECONNREFUSED /var/run/x")),
    };
    const response = await post(
      { code: "print(1)", language: "python" },
      exploding
    );

    expect(response.status).toBe(500);
    expect(response.body.code).toBe("infra_error");
    expect(JSON.stringify(response.body)).not.toContain("ECONNREFUSED");
  });

  it("rejects a malformed JSON body with the envelope", async () => {
    const built = await buildApp(stubRunner());
    const response = await request(built.getHttpServer())
      .post("/submissions")
      .set("Content-Type", "application/json")
      .send("{not json");

    expect(response.status).toBe(400);
    expect(response.body.code).toBe("validation_failed");
  });
});
