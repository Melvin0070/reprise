/**
 * The submission lifecycle (7A).
 *
 * Enumerated once, here, because states invented ad hoc at each call site is
 * exactly the failure this contract exists to prevent. The API enum, the
 * `event_log` lifecycle kinds, the UI copy, and the contract verdict all derive
 * from this vocabulary rather than restating it.
 *
 * This module is deliberately dependency-free. It names *what* a submission's
 * state can be; deciding which one a given run earned is the job of whoever
 * owns the mechanism — the jail's outcome taxonomy belongs to the worker, not
 * here, so the dependency arrow stays `worker → shared` and never inverts.
 */

/** States a submission can leave. */
export const NON_TERMINAL_STATES = ["queued", "running"] as const;

/**
 * States a submission cannot leave — the run has an answer.
 *
 * Five of these map to distinct UI copy and a contract verdict: `succeeded` and
 * `failed` are evaluated, while `timeout`, `killed-limit` and `failed-infra`
 * render "not verified" rather than a false check. `canceled` is the sixth,
 * arriving with the one-run lock (2A); it is unreachable in v0.1 and named here
 * anyway, because widening a lifecycle enum later is how consumers drift.
 */
export const TERMINAL_STATES = [
  "succeeded",
  "failed",
  "timeout",
  "killed-limit",
  "failed-infra",
  "canceled",
] as const;

export type NonTerminalState = (typeof NON_TERMINAL_STATES)[number];
export type TerminalState = (typeof TERMINAL_STATES)[number];
export type SubmissionState = NonTerminalState | TerminalState;

// Widened to string so the lookup accepts any state; the predicate below is
// what re-narrows the result for callers.
const TERMINAL: ReadonlySet<string> = new Set(TERMINAL_STATES);

export const isTerminal = (state: SubmissionState): state is TerminalState =>
  TERMINAL.has(state);

/**
 * The edges of the 7A diagram, as data.
 *
 * `Record` over the full union rather than an index signature: adding a state
 * to either list above without giving it a row here is a type error, so the
 * table cannot silently fall behind the vocabulary.
 *
 * Every terminal state has an empty row. That is the load-bearing invariant —
 * once a run has an answer, nothing may overwrite it, so a late worker or a
 * duplicate delivery cannot turn a reported `timeout` into a `succeeded`.
 */
const TRANSITIONS: Readonly<
  Record<SubmissionState, readonly SubmissionState[]>
> = {
  canceled: [],
  failed: [],
  "failed-infra": [],
  "killed-limit": [],
  // A submission nothing ever picks up still owes the caller an answer, so
  // `failed-infra` is reachable without ever having run.
  queued: ["running", "canceled", "failed-infra"],
  running: [
    "succeeded",
    "failed",
    "timeout",
    "killed-limit",
    "failed-infra",
    "canceled",
  ],
  succeeded: [],
  timeout: [],
};

export const canTransition = (
  from: SubmissionState,
  to: SubmissionState
): boolean => TRANSITIONS[from].includes(to);
