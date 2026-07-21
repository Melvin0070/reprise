/**
 * The unprivileged identity submitted code runs as.
 *
 * Taken from the environment rather than hardcoded, because the account has to
 * exist on the host: the uid baked into the local test image is not necessarily
 * the uid on the Fly machine, and a wrong one fails at spawn time with an
 * EPERM that explains nothing.
 *
 * `env` is a parameter rather than a reach into `process.env` so this stays
 * pure and testable, and so the process boundary is visible at the call site.
 */

/** uid_t and gid_t are 32-bit unsigned on Linux. */
const MAX_ID = 4_294_967_295;

export interface RunnerIdentity {
  readonly uid: number;
  readonly gid: number;
}

const readId = (env: NodeJS.ProcessEnv, name: string): number => {
  const raw = env[name];
  if (raw === undefined || raw === "") {
    throw new Error(
      `runner: ${name} is not set; submitted code has no unprivileged identity to run as`
    );
  }

  // An unguarded Number() would accept "1e3", " 12 " and "0x10". A uid is a
  // decimal integer and nothing else, so the parse is as narrow as the thing it
  // parses — and past this guard, Number() is exact.
  if (!/^\d+$/u.test(raw)) {
    throw new Error(
      `runner: ${name} must be a decimal integer, received ${JSON.stringify(raw)}`
    );
  }

  const id = Number(raw);
  // Digits alone still permit a number no account can have. Refusing it here
  // costs one comparison and replaces an "options.uid must be an int32" from
  // deep inside spawn with a message that names the setting.
  if (id > MAX_ID) {
    throw new RangeError(
      `runner: ${name} must be at most ${MAX_ID}, received ${raw}`
    );
  }

  return id;
};

/**
 * Read and validate the runner identity.
 *
 * Refusing root here duplicates the jail's own refusal, deliberately: this one
 * fires at startup with a legible message, so a misconfigured host is caught
 * before it accepts a single submission rather than on the first run.
 */
export const loadRunnerIdentity = (env: NodeJS.ProcessEnv): RunnerIdentity => {
  const uid = readId(env, "REPRISE_RUN_UID");
  const gid = readId(env, "REPRISE_RUN_GID");

  if (uid === 0 || gid === 0) {
    throw new Error(
      "runner: refusing to run submitted code as root; the crude tier's only filesystem boundary is the unprivileged uid"
    );
  }

  return { gid, uid };
};
