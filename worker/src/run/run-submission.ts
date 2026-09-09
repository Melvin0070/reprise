import { chmod, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import type { TerminalState } from "@reprise/submission-state";

import { runInJail } from "../sandbox/jail.js";
import { DEFAULT_LIMITS } from "../sandbox/limits.js";
import type { JailLimits } from "../sandbox/limits.js";
import { isLanguage, runtimeFor } from "./language.js";
import type { Language } from "./language.js";
import { outcomeToState } from "./outcome-to-state.js";
import type { RunnerIdentity } from "./runner-config.js";

/** Named so the isolation suite can assert no workspace outlives its run. */
const WORKSPACE_PREFIX = "reprise-run-";

export interface SubmissionRequest {
  readonly language: Language;
  readonly code: string;
}

export interface SubmissionOptions {
  readonly runner: RunnerIdentity;
  readonly limits?: JailLimits;
}

export interface SubmissionResult {
  readonly state: TerminalState;
  /** The process's exit code, or null when it never got to exit on its own. */
  readonly exitCode: number | null;
  readonly stdout: string;
  readonly stderr: string;
  readonly durationMs: number;
  readonly truncated: boolean;
  /**
   * Why we cannot stand behind the run, set only alongside `failed-infra`.
   *
   * Usually that means the run never happened at all. It also covers the run
   * that executed and could not be proven contained: an escapee the reap could
   * not clear leaves the leader's exit code true about the leader and false
   * about the run (#78).
   *
   * A separate field rather than text appended to `stderr`: that channel is a
   * faithful record of what the user's program wrote, and putting our own
   * failure in it would be a lie about their output. Whether this reaches the
   * client is the API's call — a self-hoster wants it, a hosted tenant should
   * not see our paths.
   */
  readonly infraError?: string;
}

/**
 * Run one submission to a terminal state.
 *
 * This is the seam. Today the HTTP handler calls it inline; when the queue is
 * earned, the BullMQ worker calls this same function unchanged and only the
 * caller moves. That is what makes the inline downgrade a swap rather than a
 * wall — see `docs/learning-log/001-inline-execution.md`.
 *
 * It returns terminal states rather than throwing them. A run that times out or
 * is killed is a *result* about the user's code, not an error in our service —
 * so it comes back as data (DX7/V7: 7A states are never HTTP errors). The only
 * things it throws are caller mistakes, like a language we cannot run.
 */
export const runSubmission = async (
  request: SubmissionRequest,
  options: SubmissionOptions
): Promise<SubmissionResult> => {
  // Thrown, not returned as `failed`: we have learned nothing about the user's
  // code, so reporting a verdict on it would be an invention.
  if (!isLanguage(request.language)) {
    throw new Error(
      `run: unsupported language ${JSON.stringify(request.language)}`
    );
  }

  const runtime = runtimeFor(request.language);
  const limits = options.limits ?? DEFAULT_LIMITS;
  const startedAt = performance.now();

  let workspace: string | undefined;

  try {
    workspace = await mkdtemp(path.join(tmpdir(), WORKSPACE_PREFIX));
    // mkdtemp creates the directory 0700 owned by *this* process's user. The
    // runner is a different, unprivileged uid and needs to enter it and read
    // the entry file. Step 3 replaces this with a tmpfs inside a mount
    // namespace, at which point the directory stops being shared at all.
    await chmod(workspace, 0o755);

    // The code travels as a file, never as an argv string. Quotes, newlines and
    // payloads larger than ARG_MAX all survive, and there is no command line
    // for the code to break out of.
    await writeFile(path.join(workspace, runtime.entryFile), request.code, {
      mode: 0o644,
    });

    const result = await runInJail({
      args: [...runtime.flags, runtime.entryFile],
      command: runtime.command,
      cwd: workspace,
      gid: options.runner.gid,
      limits,
      uid: options.runner.uid,
    });

    return {
      durationMs: result.durationMs,
      exitCode:
        result.outcome.kind === "exited" ? result.outcome.exitCode : null,
      // A run the jail could not prove reaped is `failed-infra`, and
      // `failed-infra` without a reason is the least useful line in a
      // postmortem — so the jail's own account of it travels with it.
      ...(result.outcome.kind === "unreaped" && {
        infraError: result.outcome.detail,
      }),
      state: outcomeToState(result.outcome),
      stderr: result.stderr,
      stdout: result.stdout,
      truncated: result.truncated,
    };
  } catch (error) {
    // Reaching here means the run never got off the ground — a workspace we
    // could not create, an interpreter that is not in the image, a uid that
    // does not exist on the host. None of that is evidence about the submitted
    // code, so the state says so.
    return {
      durationMs: Math.round(performance.now() - startedAt),
      exitCode: null,
      infraError: error instanceof Error ? error.message : String(error),
      state: "failed-infra" satisfies TerminalState,
      stderr: "",
      stdout: "",
      truncated: false,
    };
  } finally {
    if (workspace !== undefined) {
      try {
        await rm(workspace, { force: true, recursive: true });
      } catch {
        // A workspace we could not delete is a disk leak, but throwing here
        // would destroy the result of a run that already completed — trading a
        // stale temp directory for the user's answer. It becomes a log line
        // when the worker has structured logging; see TODOS.md.
      }
    }
  }
};
