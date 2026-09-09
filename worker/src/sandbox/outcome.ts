/** What the kernel reported about a finished child, plus whether we killed it. */
export interface RawExit {
  readonly code: number | null;
  readonly signal: NodeJS.Signals | string | null;
  readonly timedOut: boolean;
}

/**
 * How a run ended.
 *
 * This is the seam the submission state machine (T7) reads, so it names the
 * *reason* rather than the mechanism: a wall-clock kill is a `timeout`, not a
 * SIGKILL, because the SIGKILL was ours.
 */
export type JailOutcome =
  | { readonly kind: "exited"; readonly exitCode: number }
  | { readonly kind: "timeout" }
  | { readonly kind: "signalled"; readonly signal: string }
  /**
   * The post-run census could not show the run uid clean (#78).
   *
   * Most often that is a run which finished perfectly — exit 0, on time, pipes
   * drained — and left a process behind that the sweep could not kill. The
   * settle deadline is one way to arrive here, not the definition of it; so is
   * a sweep that threw, because a census we cannot take is not an empty one.
   *
   * `classifyOutcome` never produces this one: it describes the *reap*, not the
   * exit, so the jail raises it directly. It exists because the alternative is
   * worse — a leader that exited 0 while an escapee of its own survives is not
   * a `succeeded` run, and saying so would invent containment we did not
   * achieve.
   */
  | { readonly kind: "unreaped"; readonly detail: string };

/**
 * Pure classification of a finished child. No I/O, so the whole outcome
 * taxonomy is testable on any platform.
 */
export const classifyOutcome = (raw: RawExit): JailOutcome => {
  // Ours takes precedence: we sent the signal, so the reason is the timeout.
  if (raw.timedOut) {
    return { kind: "timeout" };
  }

  if (raw.signal !== null) {
    return { kind: "signalled", signal: raw.signal };
  }

  if (raw.code !== null) {
    return { exitCode: raw.code, kind: "exited" };
  }

  throw new Error(
    "jail: child reported neither an exit code nor a signal; refusing to invent an outcome"
  );
};
