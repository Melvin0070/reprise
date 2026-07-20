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
  | { readonly kind: "signalled"; readonly signal: string };

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
