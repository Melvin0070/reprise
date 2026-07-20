import type { JailLimits } from "./limits.js";

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
