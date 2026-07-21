import { Module } from "@nestjs/common";
import { APP_FILTER, APP_GUARD } from "@nestjs/core";

import { API_KEY, ApiKeyGuard } from "./auth/api-key.guard.js";
import { loadApiKey } from "./auth/api-key.js";
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
 * The OV-1 guard is registered the same way and for a stronger version of the
 * same reason: a gate installed in the entry point is a gate that is absent
 * from every test, so the suite would prove an unauthenticated API safe and the
 * deployed one would be something else entirely.
 *
 * There is one module and no `SubmissionsModule` beneath it. Splitting now
 * would be a directory structure standing in for a boundary — the whole graph
 * is one controller and two providers, and it gets split when a second feature
 * gives the split something to separate.
 */
@Module({
  controllers: [SubmissionsController],
  providers: [
    { provide: APP_FILTER, useClass: ApiErrorFilter },
    { provide: APP_GUARD, useClass: ApiKeyGuard },
    // Read once at startup, so a missing or weak key stops the boot rather
    // than the first request.
    { provide: API_KEY, useFactory: () => loadApiKey(process.env) },
    { provide: SUBMISSION_RUNNER, useFactory: createInlineRunner },
  ],
})
export class AppModule {}
