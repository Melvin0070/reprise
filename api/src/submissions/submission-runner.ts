import { runSubmission } from "@reprise/worker/run";
import type { SubmissionRequest, SubmissionResult } from "@reprise/worker/run";
import { loadRunnerIdentity } from "@reprise/worker/runner-config";

/**
 * How the API gets a submission run — and the seam the queue will replace.
 *
 * The controller depends on this interface rather than importing
 * `runSubmission` directly, and that indirection is the entire reason inline
 * execution is a budgeted downgrade rather than a mistake. Today the provider
 * runs the code in-process; when head-of-line blocking earns the queue, the
 * provider becomes a BullMQ publisher and the controller does not change. The
 * upgrade swaps a module, exactly as the guardrail requires
 * (`docs/learning-log/001-inline-execution.md`).
 *
 * It doubles as the reason the HTTP contract is testable off Linux: the jail
 * needs root on Linux, this interface needs neither.
 */
export interface SubmissionRunner {
  readonly run: (request: SubmissionRequest) => Promise<SubmissionResult>;
}

/**
 * A symbol, not a string. Nest cannot inject by interface — interfaces are
 * gone at runtime — so the token is explicit, and a symbol cannot collide with
 * a token some other module happened to name the same thing.
 */
export const SUBMISSION_RUNNER = Symbol("SUBMISSION_RUNNER");

/**
 * The v0.1 runner: execution inline, in the API process.
 *
 * The runner identity is read once here rather than per request, so a host
 * missing `REPRISE_RUN_UID` fails at boot with the message
 * `loadRunnerIdentity` wrote for exactly this moment — instead of accepting
 * traffic and failing every run.
 */
export const createInlineRunner = (): SubmissionRunner => {
  const runner = loadRunnerIdentity(process.env);
  return { run: (request) => runSubmission(request, { runner }) };
};
