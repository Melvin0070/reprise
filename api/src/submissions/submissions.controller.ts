import { Body, Controller, HttpCode, Inject, Post } from "@nestjs/common";
import type { TerminalState } from "@reprise/submission-state";
import type { SubmissionResult } from "@reprise/worker/run";

import { SUBMISSION_RUNNER } from "./submission-runner.js";
import type { SubmissionRunner } from "./submission-runner.js";
import { parseSubmissionRequest } from "./submission.schema.js";

/**
 * The wire shape of a completed run.
 *
 * snake_case because this is the published contract rather than internal code;
 * the mapping from the worker's camelCase result happens here, at the boundary,
 * so neither side has to adopt the other's convention.
 *
 * `infraError` is deliberately absent. It names interpreter paths and
 * filesystem locations, which are ours and not the caller's business — the
 * `failed-infra` state already tells them the thing they can act on, which is
 * that the run never happened and their code is not what failed.
 */
interface SubmissionResponse {
  readonly state: TerminalState;
  readonly exit_code: number | null;
  readonly stdout: string;
  readonly stderr: string;
  readonly duration_ms: number;
  readonly truncated: boolean;
}

const toResponse = (result: SubmissionResult): SubmissionResponse => ({
  duration_ms: result.durationMs,
  exit_code: result.exitCode,
  state: result.state,
  stderr: result.stderr,
  stdout: result.stdout,
  truncated: result.truncated,
});

/** 200, not 201: inline execution creates no resource to point a caller at. */
const HTTP_OK = 200;

@Controller("submissions")
export class SubmissionsController {
  private readonly runner: SubmissionRunner;

  constructor(@Inject(SUBMISSION_RUNNER) runner: SubmissionRunner) {
    this.runner = runner;
  }

  /**
   * Run a submission and answer with its terminal state.
   *
   * The response is 200 for every state this returns, including `timeout` and
   * `failed-infra`. That is V7: 7A lifecycle states are run RESULTS delivered
   * as data, never HTTP errors. A 4xx here would tell a client their REQUEST
   * was wrong when in fact it was handled perfectly and their program looped.
   *
   * The body is typed `unknown` on the way in. Nest would happily hand over an
   * object typed as validated that nothing had validated; taking it untyped
   * makes the parse the only way to get a usable value.
   */
  @Post()
  @HttpCode(HTTP_OK)
  async create(@Body() body: unknown): Promise<SubmissionResponse> {
    const request = parseSubmissionRequest(body);
    return toResponse(await this.runner.run(request));
  }
}
