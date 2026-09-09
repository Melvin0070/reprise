import type { JailLimits } from "./limits.js";

const MS_PER_SECOND = 1000;

const assertPositiveInteger = (value: number, field: string): void => {
  if (!Number.isInteger(value) || value <= 0) {
    throw new Error(
      `jail: ${field} must be a positive integer, received ${String(value)}`
    );
  }
};

/**
 * Build the argument vector for `prlimit`, which applies the rlimits and then
 * execs the runner in place.
 *
 * Why prlimit rather than a shell `ulimit` prologue: no shell sits between us
 * and the runner, so there is no quoting or word-splitting surface for hostile
 * code to reach. Because prlimit execs rather than forks, the runner also
 * inherits the process group we created — which is what makes a group-wide
 * SIGKILL reach a fork bomb's children.
 */
export const buildJailArgv = (
  limits: JailLimits,
  command: string,
  args: readonly string[]
): string[] => {
  assertPositiveInteger(limits.maxProcesses, "maxProcesses");
  assertPositiveInteger(limits.maxAddressSpaceBytes, "maxAddressSpaceBytes");
  assertPositiveInteger(limits.maxCpuSeconds, "maxCpuSeconds");
  // A zero or negative wall clock would silently disarm the only defence
  // against a process that consumes no CPU, so it is a hard error.
  assertPositiveInteger(limits.wallClockMs, "wallClockMs");

  // The CPU ceiling has to be reachable before the wall clock, or RLIMIT_CPU is
  // dead weight for the case v1.0 actually runs: a single-threaded CPU-bound
  // loop would always be stopped by the parent's timer and reported as a
  // `timeout` rather than as the limit kill it is, costing an honest run its
  // verdict. Not a universal law — RLIMIT_CPU counts CPU aggregated across the
  // thread group, so a four-thread program reaches a 10s ceiling in ~2.5s of
  // wall clock — but the check only ever tightens, so the weaker case is the
  // one worth enforcing. `DEFAULT_LIMITS` claimed this ordering in a comment,
  // and an unchecked claim in a comment is exactly how jail.ts came to read
  // ESRCH as proof the reap worked (#78).
  //
  // Consequence worth knowing: `maxCpuSeconds` is a positive integer, so any
  // `wallClockMs` at or below 1000 is now unconfigurable and throws here.
  if (limits.maxCpuSeconds * MS_PER_SECOND >= limits.wallClockMs) {
    throw new Error(
      `jail: maxCpuSeconds (${limits.maxCpuSeconds}s) must be reachable before wallClockMs (${limits.wallClockMs}ms), or the CPU ceiling can never fire`
    );
  }

  return [
    `--nproc=${limits.maxProcesses}`,
    `--as=${limits.maxAddressSpaceBytes}`,
    `--cpu=${limits.maxCpuSeconds}`,
    // Everything after `--` is the command and its arguments. Without this,
    // a payload argument shaped like `--nproc=99999` would be read by prlimit
    // as a limit of its own and raise the ceiling we just set.
    "--",
    command,
    ...args,
  ];
};
