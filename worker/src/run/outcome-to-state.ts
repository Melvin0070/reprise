import type { TerminalState } from "@reprise/submission-state";

import type { JailOutcome } from "../sandbox/outcome.js";

/**
 * Translate how a jailed process died into what we tell the user about their
 * run.
 *
 * This mapping lives in the worker rather than in `@reprise/submission-state`
 * on purpose: knowing that SIGXCPU means a CPU ceiling is jail knowledge, and
 * hosting it in the shared package would make every consumer of the state
 * vocabulary — the API, later the web client — depend transitively on the
 * sandbox.
 *
 * The distinction it draws is product-visible. `failed` is an evaluated result
 * and gets a contract verdict; `killed-limit` and `failed-infra` render "not
 * verified" instead. So calling a segfault a limit kill would cost an honest
 * run its verdict, and calling a limit kill a failure would blame the user for
 * a ceiling we imposed.
 */

/** Signals that mean a ceiling we set was reached. */
const LIMIT_SIGNALS: ReadonlySet<string> = new Set([
  // RLIMIT_CPU.
  "SIGXCPU",
  // RLIMIT_FSIZE — not set at the crude tier, listed so step 3 does not have
  // to remember to come back here.
  "SIGXFSZ",
  // Our own group kill, or the kernel OOM killer. Both are ceilings.
  "SIGKILL",
]);

/** Signals that mean the program came apart on its own. */
const CRASH_SIGNALS: ReadonlySet<string> = new Set([
  "SIGSEGV",
  "SIGABRT",
  "SIGBUS",
  "SIGFPE",
  "SIGILL",
]);

export const outcomeToState = (outcome: JailOutcome): TerminalState => {
  switch (outcome.kind) {
    case "exited": {
      return outcome.exitCode === 0 ? "succeeded" : "failed";
    }

    case "timeout": {
      return "timeout";
    }

    case "unreaped": {
      // Not `killed-limit`: that claims we stopped the run at a ceiling we set,
      // and the whole meaning of this outcome is that we could not stop it.
      return "failed-infra";
    }

    case "signalled": {
      if (LIMIT_SIGNALS.has(outcome.signal)) {
        return "killed-limit";
      }
      if (CRASH_SIGNALS.has(outcome.signal)) {
        return "failed";
      }
      // Neither claim is supported by the evidence: we do not know that the
      // program was wrong, and we do not know that we stopped it. The jail
      // refuses to invent an outcome; this refuses to invent a verdict.
      return "failed-infra";
    }

    default: {
      // Adding a JailOutcome kind without handling it here is a type error.
      const unhandled: never = outcome;
      return unhandled;
    }
  }
};
