import type { ArgumentsHost, ExceptionFilter } from "@nestjs/common";
import { Catch, HttpException } from "@nestjs/common";
import type { ErrorCode, ErrorEnvelope } from "@reprise/api-error";
import { docsUrlFor } from "@reprise/api-error";
import type { Request, Response } from "express";

import { ApiError } from "./api-error.js";

/**
 * The one exception filter (DX7).
 *
 * `@Catch()` with no argument is the load-bearing part: DX7 requires that
 * EVERY 4xx and 5xx carries the envelope, and a filter narrowed to our own
 * error type would leave the framework's defaults to answer for 404s, malformed
 * JSON and anything unforeseen — three shapes of error body from one API.
 *
 * Messages for errors we did not raise ourselves are written here rather than
 * forwarded. A framework describes failures in terms of its own internals, and
 * forwarding that text is how library versions and paths reach a client.
 */

const HTTP_BAD_REQUEST = 400;
const HTTP_NOT_FOUND = 404;
const HTTP_PAYLOAD_TOO_LARGE = 413;
const HTTP_INTERNAL_ERROR = 500;
const HTTP_CLIENT_ERRORS_END = 500;

/**
 * Recover an HTTP status from an unknown exception.
 *
 * Nest wraps body-parser failures in its own `HttpException` subclasses, so
 * `getStatus()` covers the cases we see today. The structural check behind it
 * is for anything thrown by a layer Nest does not wrap: such errors carry a
 * numeric `status` and would otherwise be reported as our fault rather than as
 * the bad request they are.
 */
const statusOf = (exception: unknown): number => {
  if (exception instanceof HttpException) {
    return exception.getStatus();
  }
  if (typeof exception === "object" && exception !== null) {
    const { status } = exception as { status?: unknown };
    if (typeof status === "number") {
      return status;
    }
  }
  return HTTP_INTERNAL_ERROR;
};

const envelope = (
  code: ErrorCode,
  message: string,
  hint: string
): ErrorEnvelope => ({ code, docs_url: docsUrlFor(code), hint, message });

const forStatus = (status: number, request: Request): ErrorEnvelope => {
  if (status === HTTP_NOT_FOUND) {
    return envelope(
      "not_found",
      // Built from the caller's own request line, so it repeats back only what
      // they already sent us.
      `No route matches ${request.method} ${request.path}.`,
      "Check the method and path against the API documentation."
    );
  }

  if (status === HTTP_PAYLOAD_TOO_LARGE) {
    return envelope(
      "validation_failed",
      "The request body is too large to accept.",
      "Submissions are a single file; see the documented code size limit."
    );
  }

  if (status === HTTP_BAD_REQUEST) {
    // Our own validation never lands here — it throws `ApiError` with a message
    // naming the offending field. The only 400 Nest raises on this API is a
    // body it could not parse, so that is what this says.
    return envelope(
      "validation_failed",
      "The request body could not be parsed as JSON.",
      "Send a JSON object with Content-Type: application/json."
    );
  }

  if (status < HTTP_CLIENT_ERRORS_END) {
    return envelope(
      "validation_failed",
      "The request could not be processed as sent.",
      "Check the method, headers and body against the API documentation."
    );
  }

  // Anything else is a surprise. The envelope stays deliberately uninformative
  // about the cause: we do not know what it was, so any detail volunteered here
  // would be our internals rather than an explanation.
  return envelope(
    "infra_error",
    "The request failed before it could be completed.",
    "This is a fault on our side, not in your submission. Retrying is safe."
  );
};

@Catch()
export class ApiErrorFilter implements ExceptionFilter {
  catch(exception: unknown, host: ArgumentsHost): void {
    const http = host.switchToHttp();
    const response = http.getResponse<Response>();

    if (exception instanceof ApiError) {
      response.status(exception.status).json(exception.envelope);
      return;
    }

    // A status we recognise still gets OUR envelope, never the framework's
    // default body — that equivalence is what DX7 is asking for.
    const status = statusOf(exception);
    const body = forStatus(status, http.getRequest<Request>());
    const reported = body.code === "infra_error" ? HTTP_INTERNAL_ERROR : status;

    response.status(reported).json(body);
  }
}
