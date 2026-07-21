import type { INestApplication } from "@nestjs/common";
import type { NestExpressApplication } from "@nestjs/platform-express";
import { Test } from "@nestjs/testing";
import type { SubmissionRequest, SubmissionResult } from "@reprise/worker/run";
import request from "supertest";
import { afterEach, describe, expect, it } from "vitest";

import { APP_OPTIONS, configureApp } from "../app-setup.js";
import { AppModule } from "../app.module.js";
import { SUBMISSION_RUNNER } from "../submissions/submission-runner.js";
import type { SubmissionRunner } from "../submissions/submission-runner.js";
import { API_KEY } from "./api-key.guard.js";
import { MIN_API_KEY_LENGTH } from "./api-key.js";

/**
 * The OV-1 gate over HTTP.
 *
 * `api-key.test.ts` covers the comparison and the header parse directly. This
 * suite exists to prove the guard is actually INSTALLED — that the rules hold
 * for a real request rather than only for the function that implements them.
 * A correct guard nobody wired up looks identical in unit tests.
 */
const TEST_KEY = `test-key-${"x".repeat(MIN_API_KEY_LENGTH)}`;

const succeeded: SubmissionResult = {
  durationMs: 1,
  exitCode: 0,
  state: "succeeded",
  stderr: "",
  stdout: "hello\n",
  truncated: false,
};

const stubRunner = (): SubmissionRunner & {
  readonly calls: SubmissionRequest[];
} => {
  const calls: SubmissionRequest[] = [];
  return {
    calls,
    run: (submission) => {
      calls.push(submission);
      return Promise.resolve(succeeded);
    },
  };
};

let app: INestApplication | undefined;

const buildApp = async (
  runner: SubmissionRunner
): Promise<INestApplication> => {
  const moduleRef = await Test.createTestingModule({ imports: [AppModule] })
    .overrideProvider(SUBMISSION_RUNNER)
    .useValue(runner)
    .overrideProvider(API_KEY)
    .useValue(TEST_KEY)
    .compile();

  const built =
    moduleRef.createNestApplication<NestExpressApplication>(APP_OPTIONS);
  configureApp(built);
  await built.init();
  app = built;
  return built;
};

const body = { code: 'print("hello")', language: "python" };

afterEach(async () => {
  await app?.close();
  app = undefined;
});

describe("execution is auth-gated (OV-1)", () => {
  it("rejects a request with no Authorization header", async () => {
    const runner = stubRunner();
    const built = await buildApp(runner);

    const response = await request(built.getHttpServer())
      .post("/submissions")
      .send(body);

    expect(response.status).toBe(401);
    expect(response.body.code).toBe("unauthorized");
    // The point of the gate: untrusted code must not run.
    expect(runner.calls).toEqual([]);
  });

  it("rejects a request with the wrong key and never runs the code", async () => {
    const runner = stubRunner();
    const built = await buildApp(runner);

    const response = await request(built.getHttpServer())
      .post("/submissions")
      .set("Authorization", `Bearer ${"w".repeat(MIN_API_KEY_LENGTH)}`)
      .send(body);

    expect(response.status).toBe(401);
    expect(runner.calls).toEqual([]);
  });

  it("accepts a request carrying the configured key", async () => {
    const runner = stubRunner();
    const built = await buildApp(runner);

    const response = await request(built.getHttpServer())
      .post("/submissions")
      .set("Authorization", `Bearer ${TEST_KEY}`)
      .send(body);

    expect(response.status).toBe(200);
    expect(response.body.state).toBe("succeeded");
    expect(runner.calls).toHaveLength(1);
  });

  it("refuses the key supplied as a query parameter", async () => {
    // Query strings reach proxy logs, browser history and access logs. A gate
    // that accepted one would scatter the secret somewhere nobody rotates.
    const runner = stubRunner();
    const built = await buildApp(runner);

    const response = await request(built.getHttpServer())
      .post(`/submissions?api_key=${TEST_KEY}`)
      .send(body);

    expect(response.status).toBe(401);
    expect(runner.calls).toEqual([]);
  });

  it("refuses a key sent under a different scheme", async () => {
    const built = await buildApp(stubRunner());

    const response = await request(built.getHttpServer())
      .post("/submissions")
      .set("Authorization", `Basic ${TEST_KEY}`)
      .send(body);

    expect(response.status).toBe(401);
  });

  it("answers 404 for an unknown path even without a key", async () => {
    // Documents a real limit rather than a wish. Nest matches the route before
    // it runs guards, so an unmatched path never reaches this one and route
    // existence is discoverable unauthenticated. Accepted: closing it needs
    // pre-router middleware that would also gate `/healthz`, and OV-1 requires
    // execution to be gated, which it is. This test exists so the day someone
    // assumes otherwise, the assumption is already written down.
    const built = await buildApp(stubRunner());

    const response = await request(built.getHttpServer()).get("/nope");

    expect(response.status).toBe(404);
    expect(response.body.code).toBe("not_found");
  });

  it("rejects before validating the body, so a bad request leaks no schema", async () => {
    // Ordering matters: if validation ran first, an unauthenticated caller
    // could map the accepted fields and language list by submitting rubbish.
    const built = await buildApp(stubRunner());

    const response = await request(built.getHttpServer())
      .post("/submissions")
      .send({ language: "ruby", nonsense: true });

    expect(response.status).toBe(401);
    expect(response.body.code).toBe("unauthorized");
    expect(JSON.stringify(response.body)).not.toContain("python");
  });

  it("carries the DX7 envelope on the rejection", async () => {
    const built = await buildApp(stubRunner());

    const response = await request(built.getHttpServer())
      .post("/submissions")
      .send(body);

    expect(response.body).toMatchObject({
      code: "unauthorized",
      docs_url: expect.stringContaining("unauthorized"),
      hint: expect.any(String),
      message: expect.any(String),
    });
  });

  it("names the scheme in WWW-Authenticate, as RFC 9110 requires of a 401", async () => {
    // A 401 without this header tells a client it needs credentials but not
    // which kind, leaving the scheme discoverable only by reading our prose.
    // Set for every 401 rather than in the guard, so the day a second thing
    // rejects unauthenticated it cannot forget.
    const built = await buildApp(stubRunner());
    const server = built.getHttpServer();

    const missing = await request(server).post("/submissions").send(body);
    const invalid = await request(server)
      .post("/submissions")
      .set("Authorization", "Bearer wrong-key-wrong-key-wrong-key-xx")
      .send(body);

    expect(missing.headers["www-authenticate"]).toBe("Bearer");
    expect(invalid.headers["www-authenticate"]).toBe("Bearer");
  });

  it("gives the same code for a missing and an invalid key", async () => {
    // Differentiating them in the CODE would let a caller distinguish "this
    // instance has no key configured" from "your key is wrong".
    const built = await buildApp(stubRunner());
    const server = built.getHttpServer();

    const missing = await request(server).post("/submissions").send(body);
    const invalid = await request(server)
      .post("/submissions")
      .set("Authorization", "Bearer wrong-key-wrong-key-wrong-key-xx")
      .send(body);

    expect(missing.body.code).toBe(invalid.body.code);
    expect(missing.body.message).toBe(invalid.body.message);
  });
});
