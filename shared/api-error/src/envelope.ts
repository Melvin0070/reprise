/**
 * The API error envelope (DX7, corrected by V7).
 *
 * Every 4xx and 5xx carries the same four fields: what went wrong, what caused
 * it, how to fix it, and where to read more. An API that answers only the first
 * of those makes the caller guess the other three.
 *
 * It lives in `shared/` rather than in `api/` because DX7 requires UI copy and
 * API errors to derive from the same enum. The web client is the second
 * consumer; putting the contract here means it imports the vocabulary rather
 * than restating it.
 *
 * Field names are snake_case because this interface IS the wire format — it is
 * serialised to the client verbatim, so it follows the API's convention rather
 * than TypeScript's. Everything that is not the wire stays camelCase.
 */

/**
 * Why a request failed, as its own vocabulary.
 *
 * V7 separated this list from the 7A lifecycle deliberately, and the split is
 * the load-bearing part: a `timeout` is a run RESULT delivered as data at 200,
 * never an HTTP error. If the two lists were one, every consumer would have to
 * know which half of the enum meant "your code did something" and which meant
 * "your request did something". So the rule is total — a code in this list
 * means the run never happened.
 *
 * DX7 also names `budget_exceeded` and `quota_exhausted`. They are deliberately
 * absent: their semantics only become real with step-2 budgets, and a code
 * defined ahead of the thing it describes is a guess that consumers would then
 * switch on. This differs from 7A's `canceled` — that state had settled
 * semantics and only lacked a trigger.
 */
export const ERROR_CODES = [
  /**
   * The request carried no usable credential (OV-1).
   *
   * Deliberately one code for "no key" and "wrong key". The hint distinguishes
   * them because the caller already knows which they sent, but the code does
   * not, so nothing about key validity is discoverable by an enum switch.
   */
  "unauthorized",
  /** The request body did not describe a runnable submission. */
  "validation_failed",
  /** No such route or resource. */
  "not_found",
  /** We failed before reaching the user's code. Never a verdict on it. */
  "infra_error",
] as const;

export type ErrorCode = (typeof ERROR_CODES)[number];

export interface ErrorEnvelope {
  readonly code: ErrorCode;
  /** What went wrong, in the terms the caller used. */
  readonly message: string;
  /** What to do about it. Concrete — a value, a limit, a supported list. */
  readonly hint: string;
  /** Where the rule behind this error is written down. */
  readonly docs_url: string;
}

const DOCS_BASE = "https://github.com/Melvin0070/reprise/blob/main/docs/api.md";

/**
 * Build the `docs_url` for a code.
 *
 * Derived rather than passed at each throw site: a hand-written URL per error
 * is a link that rots silently, and the whole point of the field is that it
 * still works when someone follows it.
 */
export const docsUrlFor = (code: ErrorCode): string => `${DOCS_BASE}#${code}`;
