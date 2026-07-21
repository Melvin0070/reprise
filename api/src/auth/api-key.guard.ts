import type { CanActivate, ExecutionContext } from "@nestjs/common";
import { Inject, Injectable } from "@nestjs/common";
import type { Request } from "express";

import { ApiError } from "../errors/api-error.js";
import { bearerTokenFrom, keysMatch } from "./api-key.js";

/** The configured key, resolved once at startup. */
export const API_KEY = Symbol("API_KEY");

const HTTP_UNAUTHORIZED = 401;

const unauthorized = (hint: string): ApiError =>
  new ApiError(
    HTTP_UNAUTHORIZED,
    "unauthorized",
    "This endpoint requires an API key.",
    hint
  );

/**
 * The OV-1 gate.
 *
 * Registered globally rather than on the submissions controller, so the default
 * for anything added later is protected. Requiring each new route to remember
 * to opt IN to auth on a service that executes untrusted code gets the default
 * backwards; when `/healthz` needs to be public (DX8) it opts out explicitly
 * and that opt-out is visible in review.
 *
 * A limit worth stating precisely, because it is easy to assume otherwise:
 * Nest runs guards only for MATCHED routes, so a request to a path that does
 * not exist is answered 404 before this guard is consulted. Route existence is
 * therefore discoverable without a key.
 *
 * Left as-is deliberately. Closing it means auth middleware ahead of the
 * router, which would also gate `/healthz` — a probe that must answer without
 * credentials — so the fix trades a real operational requirement for hiding
 * the shape of an API whose routes are published in the OpenAPI spec anyway.
 * What OV-1 requires is that EXECUTION is gated, and it is: the guard runs on
 * every matched route, before the body is even validated.
 */
@Injectable()
export class ApiKeyGuard implements CanActivate {
  private readonly expected: string;

  constructor(@Inject(API_KEY) expected: string) {
    this.expected = expected;
  }

  canActivate(context: ExecutionContext): boolean {
    const request = context.switchToHttp().getRequest<Request>();
    const presented = bearerTokenFrom(request.headers.authorization);

    if (presented === undefined) {
      throw unauthorized(
        "Send the key as: Authorization: Bearer <your-api-key>."
      );
    }

    if (!keysMatch(presented, this.expected)) {
      // Deliberately the same code and message as a missing key. Only the hint
      // differs, and it tells the caller nothing they did not already know
      // about what they sent.
      throw unauthorized(
        "The key presented was not accepted. Check it against the value configured for this instance."
      );
    }

    return true;
  }
}
