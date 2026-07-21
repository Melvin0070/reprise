import { describe, expect, it } from "vitest";

import { runSubmission } from "./run-submission.js";

/**
 * Guards that reject a bad request before anything is spawned, so they hold on
 * the macOS dev host too. The behaviour of an actual run lives in
 * `run-submission.linux.test.ts`.
 */
describe("runSubmission — rejects before it spawns", () => {
  const runner = { gid: 1001, uid: 1001 };

  it("throws on an unsupported language instead of returning a run result", async () => {
    // A language we cannot run is a caller error, not a verdict about the
    // user's code. Returning `failed` here would assert the program was wrong.
    await expect(
      runSubmission(
        { code: 'print("hello")', language: "cobol" as "python" },
        { runner }
      )
    ).rejects.toThrow(/cobol/u);
  });
});
