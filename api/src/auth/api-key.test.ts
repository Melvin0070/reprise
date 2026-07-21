import { describe, expect, it } from "vitest";

import {
  bearerTokenFrom,
  keysMatch,
  loadApiKey,
  MIN_API_KEY_LENGTH,
} from "./api-key.js";

const validKey = "k".repeat(MIN_API_KEY_LENGTH);

describe("keysMatch", () => {
  it("accepts an identical key", () => {
    expect(keysMatch(validKey, validKey)).toBe(true);
  });

  it("rejects a key differing in one character", () => {
    expect(keysMatch(`${"k".repeat(MIN_API_KEY_LENGTH - 1)}x`, validKey)).toBe(
      false
    );
  });

  it("rejects a shorter key without throwing", () => {
    // The naive fixed-width comparison throws on length mismatch, and the
    // naive guard against that leaks the expected length. Both failure modes
    // show up here as either an exception or a pass.
    expect(() => keysMatch("k", validKey)).not.toThrow();
    expect(keysMatch("k", validKey)).toBe(false);
  });

  it("rejects a longer key that starts with the real one", () => {
    expect(keysMatch(`${validKey}extra`, validKey)).toBe(false);
  });

  it("rejects an empty key", () => {
    expect(keysMatch("", validKey)).toBe(false);
  });
});

describe("bearerTokenFrom", () => {
  it("reads the token from a well-formed header", () => {
    expect(bearerTokenFrom(`Bearer ${validKey}`)).toBe(validKey);
  });

  it("accepts the scheme in any case, per RFC 9110", () => {
    expect(bearerTokenFrom(`bearer ${validKey}`)).toBe(validKey);
    expect(bearerTokenFrom(`BEARER ${validKey}`)).toBe(validKey);
  });

  it("preserves the token's own case", () => {
    expect(bearerTokenFrom("Bearer AbCdEf")).toBe("AbCdEf");
  });

  it("returns nothing when the header is absent", () => {
    // Shaped like the guard's own call site: an absent header is a missing
    // property, not a value someone passed deliberately.
    const headers: { authorization?: string } = {};

    expect(bearerTokenFrom(headers.authorization)).toBeUndefined();
  });

  it("refuses a bare token with no scheme", () => {
    expect(bearerTokenFrom(validKey)).toBeUndefined();
  });

  it("refuses another auth scheme", () => {
    expect(bearerTokenFrom(`Basic ${validKey}`)).toBeUndefined();
  });

  it("refuses a header with trailing junk after the token", () => {
    // Otherwise `Bearer <key> ignored` would authenticate, which makes the
    // header's meaning depend on what a proxy did or did not append.
    expect(bearerTokenFrom(`Bearer ${validKey} extra`)).toBeUndefined();
  });

  it("refuses an empty header", () => {
    expect(bearerTokenFrom("")).toBeUndefined();
    expect(bearerTokenFrom("   ")).toBeUndefined();
  });

  it("refuses a scheme with no token", () => {
    expect(bearerTokenFrom("Bearer")).toBeUndefined();
    expect(bearerTokenFrom("Bearer ")).toBeUndefined();
  });
});

describe("loadApiKey", () => {
  it("returns a configured key of sufficient length", () => {
    expect(loadApiKey({ REPRISE_API_KEY: validKey })).toBe(validKey);
  });

  it("refuses to start when the key is unset", () => {
    // Fail closed. An unconfigured gate that let requests through would be an
    // anonymous code-execution endpoint.
    expect(() => loadApiKey({})).toThrow(/REPRISE_API_KEY is not set/u);
  });

  it("refuses to start when the key is empty", () => {
    expect(() => loadApiKey({ REPRISE_API_KEY: "" })).toThrow(
      /REPRISE_API_KEY is not set/u
    );
  });

  it("refuses a key below the minimum length", () => {
    expect(() => loadApiKey({ REPRISE_API_KEY: "test" })).toThrow(
      /at least 32 characters/u
    );
  });

  it("does not put the key in the error it throws", () => {
    // Startup errors are logged, and logs travel further than secrets should.
    const secret = "short-but-secret";
    expect(() => loadApiKey({ REPRISE_API_KEY: secret })).toThrow();
    try {
      loadApiKey({ REPRISE_API_KEY: secret });
    } catch (error) {
      expect((error as Error).message).not.toContain(secret);
    }
  });
});
