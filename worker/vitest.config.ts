import { defineConfig } from "vitest/config";

/**
 * Test files run one at a time.
 *
 * The isolation suite runs real submissions as the shared run uid, and the jail
 * reaps by uid: two test files running submissions at once are two OS processes
 * sharing a run uid, which is the configuration the crude tier does not support
 * (see `serializePerUid` in `src/sandbox/jail.ts`). In parallel they SIGKILL
 * each other's runs and the failures look like flakes.
 *
 * The queue inside `runInJail` covers concurrency *within* a process, which is
 * what the deployed worker is. It cannot reach across processes, and pretending
 * otherwise in the tests would be testing a deployment we do not support.
 *
 * Applied package-wide rather than to the two `*.linux.test.ts` files alone.
 * The pure suites pay for a constraint only those two have, which costs a few
 * hundred milliseconds; a projects split that carved them out would put the
 * safety property in a second config file where a new Linux test could be added
 * without it. The cheap, blunt version is the one that cannot be got wrong.
 */
export default defineConfig({
  test: {
    fileParallelism: false,
  },
});
