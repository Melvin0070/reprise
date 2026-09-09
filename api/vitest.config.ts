import { defineConfig } from "vitest/config";

/**
 * Test files run one at a time, for the same reason as `worker/vitest.config.ts`.
 *
 * `src/submissions/submissions.linux.test.ts` drives the real jail as the shared
 * run uid, and the jail reaps by uid: two files running submissions at once are
 * two OS processes sharing that uid, which the crude tier does not support.
 *
 * Cross-package the property currently holds by accident — pnpm runs this
 * package's tests after `@reprise/worker`'s because it depends on it, so the two
 * jail-driving suites never overlap. Depending on a dependency edge to enforce a
 * containment property is not something to leave implicit, and this file at
 * least keeps the intra-package half explicit.
 */
export default defineConfig({
  test: {
    fileParallelism: false,
  },
});
