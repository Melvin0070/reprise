import { describe, expect, it } from "vitest";

import { docsUrlFor, ERROR_CODES } from "./envelope.js";

describe("the error code vocabulary", () => {
  it("holds no duplicates", () => {
    expect(new Set(ERROR_CODES).size).toBe(ERROR_CODES.length);
  });

  it("contains no 7A lifecycle state", () => {
    // The V7 separation, asserted rather than assumed. A run RESULT arriving in
    // this list is the exact confusion the split exists to prevent: it would
    // let a `timeout` be returned as an HTTP error, telling a caller their
    // request was malformed when their program merely ran too long.
    const lifecycleStates = [
      "queued",
      "running",
      "succeeded",
      "failed",
      "timeout",
      "killed-limit",
      "failed-infra",
      "canceled",
    ];

    for (const state of lifecycleStates) {
      expect(ERROR_CODES).not.toContain(state);
    }
  });

  it("uses snake_case, matching the wire format it is serialised into", () => {
    for (const code of ERROR_CODES) {
      expect(code).toMatch(/^[a-z]+(?:_[a-z]+)*$/u);
    }
  });
});

describe("docsUrlFor", () => {
  it("gives every code its own destination", () => {
    const urls = ERROR_CODES.map(docsUrlFor);

    expect(new Set(urls).size).toBe(ERROR_CODES.length);
  });

  it("points at a fragment named for the code", () => {
    // The field is only worth carrying if following it lands on the rule that
    // was broken, rather than on the top of a page.
    for (const code of ERROR_CODES) {
      expect(docsUrlFor(code)).toMatch(new RegExp(`#${code}$`, "u"));
    }
  });

  it("produces an absolute URL", () => {
    // A client displaying the envelope has no base to resolve against.
    for (const code of ERROR_CODES) {
      expect(() => new URL(docsUrlFor(code))).not.toThrow();
    }
  });
});
