import { Module } from "@nestjs/common";
import { APP_FILTER } from "@nestjs/core";

import { ApiErrorFilter } from "./errors/api-error.filter.js";
import {
  createInlineRunner,
  SUBMISSION_RUNNER,
} from "./submissions/submission-runner.js";
import { SubmissionsController } from "./submissions/submissions.controller.js";

/**
 * The application graph.
 *
 * The filter is registered as `APP_FILTER` inside the module rather than with
 * `app.useGlobalFilters` in the entry point, so that a test which boots this
 * module gets the same error handling the server has. A filter wired only in
 * `main.ts` is a filter no test can prove is installed.
 *
 * There is one module and no `SubmissionsModule` beneath it. Splitting now
 * would be a directory structure standing in for a boundary — the whole graph
 * is one controller and one provider, and it gets split when a second feature
 * gives the split something to separate.
 */
@Module({
  controllers: [SubmissionsController],
  providers: [
    { provide: APP_FILTER, useClass: ApiErrorFilter },
    { provide: SUBMISSION_RUNNER, useFactory: createInlineRunner },
  ],
})
export class AppModule {}
