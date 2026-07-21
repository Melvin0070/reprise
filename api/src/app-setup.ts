import type { NestApplicationOptions } from "@nestjs/common";
import type { NestExpressApplication } from "@nestjs/platform-express";

import { MAX_BODY_BYTES } from "./submissions/submission.schema.js";

/**
 * Setup that cannot be expressed inside the module, shared by the server and
 * by the tests.
 *
 * Both paths call these rather than each configuring its own application,
 * because the body limit is a thing tests assert about. If `main.ts` set it
 * alone, the suite would be measuring a default the real server does not use —
 * a green test proving nothing about what ships.
 */

/**
 * Nest's built-in parser is disabled so ours can replace it outright. Layering
 * a second parser on top would leave the default 100 kB ceiling in front,
 * rejecting valid at-cap submissions before our limit was ever consulted.
 */
export const APP_OPTIONS: NestApplicationOptions = { bodyParser: false };

export const configureApp = (app: NestExpressApplication): void => {
  app.useBodyParser("json", { limit: MAX_BODY_BYTES });
};
