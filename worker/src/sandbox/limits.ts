/**
 * The resource ceilings the crude jail applies to one run.
 *
 * Each field maps to a specific attack in `docs/threat-model.md`. Step-3
 * hardening adds cgroups v2 equivalents alongside these; the rlimits stay as
 * the DEGRADED tier, so this shape outlives the crude jail.
 */
export interface JailLimits {
  /** RLIMIT_NPROC — caps the fork bomb (threat model #1). Enforced per-uid. */
  readonly maxProcesses: number;
  /** RLIMIT_AS — caps memory exhaustion (threat model #2). Virtual, not resident. */
  readonly maxAddressSpaceBytes: number;
  /** RLIMIT_CPU — kernel-side backstop for a CPU-bound loop (threat model #3). */
  readonly maxCpuSeconds: number;
  /** Parent-side wall clock. Catches a sleeping process, which burns no CPU. */
  readonly wallClockMs: number;
  /**
   * Cap on captured stdout/stderr. Not one of the six threat-model attacks —
   * this one targets the *worker*: a print flood would otherwise be buffered
   * without bound in the parent's heap. T13 revisits it with batched writes.
   */
  readonly maxOutputBytes: number;
}

/**
 * Defaults for a v0.1 run.
 *
 * `maxCpuSeconds` is deliberately below `wallClockMs` so a CPU-bound loop is
 * stopped by the kernel (SIGXCPU) rather than waiting out the parent's timer.
 * The wall clock then only has to catch the case rlimits cannot see: a process
 * that consumes no CPU at all, such as one blocked in sleep.
 */
export const DEFAULT_LIMITS: JailLimits = {
  maxAddressSpaceBytes: 256 * 1024 * 1024,
  maxCpuSeconds: 5,
  maxOutputBytes: 64 * 1024,
  maxProcesses: 64,
  wallClockMs: 10_000,
};
