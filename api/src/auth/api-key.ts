import { createHash, timingSafeEqual } from "node:crypto";

/**
 * The day-one API key gate (OV-1).
 *
 * A public endpoint that runs untrusted code is an abuse magnet, so execution
 * is auth-gated from the first deploy. `CLAUDE.md` classes this as a one-way
 * door: there is no budgeted-downgrade path here, and every decision in this
 * module is made the strict way on purpose.
 *
 * The logic is kept here, free of Nest, so it can be tested as what it is —
 * a comparison and a parse — rather than through an HTTP round trip.
 */

/**
 * Shortest key we will accept, in characters.
 *
 * The gate is only as strong as the secret behind it, and the realistic failure
 * is not cryptanalysis — it is somebody deploying with `REPRISE_API_KEY=test`.
 * 32 characters is long enough that a hand-typed value cannot pass, which is
 * the actual threat.
 */
export const MIN_API_KEY_LENGTH = 32;

const BEARER_SCHEME = "bearer";

/**
 * Compare two keys without leaking their contents through timing.
 *
 * The digest is not for secrecy — both values are already in memory. It is to
 * make the comparison fixed-width: `timingSafeEqual` throws on length-mismatched
 * buffers, and the obvious guard against that (`if (a.length !== b.length)`)
 * would itself reveal the key's length to a caller measuring responses. Hashing
 * first makes every comparison 32 bytes regardless of what was presented.
 */
const digest = (value: string): Buffer =>
  createHash("sha256").update(value, "utf-8").digest();

export const keysMatch = (presented: string, expected: string): boolean =>
  timingSafeEqual(digest(presented), digest(expected));

/**
 * Pull the credential out of an `Authorization` header.
 *
 * Returns `undefined` for anything that is not exactly a bearer token, rather
 * than trying to be accommodating. A gate that guesses at what the caller
 * probably meant is a gate with an undocumented second way in.
 *
 * The key is never read from a query string. Query strings are recorded by
 * proxies, browser history and access logs, so accepting one would scatter the
 * secret across places nobody thinks to rotate.
 */
export const bearerTokenFrom = (
  header: string | undefined
): string | undefined => {
  if (header === undefined) {
    return undefined;
  }

  // Exactly two parts: a scheme with a token, and no room for a second one.
  const parts = header.trim().split(/\s+/u);
  const [scheme, token, ...rest] = parts;
  if (rest.length > 0 || scheme === undefined || token === undefined) {
    return undefined;
  }

  // RFC 9110 makes the scheme case-insensitive; the token is not.
  return scheme.toLowerCase() === BEARER_SCHEME ? token : undefined;
};

/**
 * Read the configured key, or refuse to start.
 *
 * Throwing here is the whole point. A gate that silently disables itself when
 * unconfigured fails OPEN, and on this endpoint that means anonymous code
 * execution. Failing at boot turns a misconfigured deploy into a deploy that
 * does not happen, which is the outcome we want.
 */
export const loadApiKey = (env: NodeJS.ProcessEnv): string => {
  const key = env.REPRISE_API_KEY;

  if (key === undefined || key === "") {
    throw new Error(
      "auth: REPRISE_API_KEY is not set; refusing to start an unauthenticated code-execution endpoint (OV-1)"
    );
  }

  if (key.length < MIN_API_KEY_LENGTH) {
    // The length is named but the key is not, so the message stays safe to log.
    throw new Error(
      `auth: REPRISE_API_KEY must be at least ${MIN_API_KEY_LENGTH} characters, received ${key.length}`
    );
  }

  return key;
};
