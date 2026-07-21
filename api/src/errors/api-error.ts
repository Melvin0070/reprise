import type { ErrorCode, ErrorEnvelope } from "@reprise/api-error";
import { docsUrlFor } from "@reprise/api-error";

/**
 * An error we chose to return, carrying the DX7 envelope it will be sent as.
 *
 * A plain `Error` rather than a Nest `HttpException`: the exception filter
 * catches everything anyway, so extending the framework's type would buy
 * nothing and would drag Nest into the validation layer, which is otherwise
 * pure and testable on its own.
 *
 * The distinction it draws is between errors we anticipated and errors we did
 * not. Anything that is not an `ApiError` reaching the filter is by definition
 * a surprise, and gets the deliberately opaque `infra_error` treatment.
 */
export class ApiError extends Error {
  readonly status: number;
  readonly envelope: ErrorEnvelope;

  constructor(status: number, code: ErrorCode, message: string, hint: string) {
    // `message` is duplicated onto Error so a stack trace, if one is ever
    // logged, says the same thing the client was told.
    super(message);
    this.name = "ApiError";
    this.status = status;
    this.envelope = { code, docs_url: docsUrlFor(code), hint, message };
  }
}

export const validationFailed = (message: string, hint: string): ApiError =>
  new ApiError(400, "validation_failed", message, hint);
