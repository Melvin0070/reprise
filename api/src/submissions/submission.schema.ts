import { LANGUAGES } from "@reprise/worker/language";
import { z } from "zod";

import { validationFailed } from "../errors/api-error.js";

/**
 * The shape of a submission request, and the only place it is described.
 *
 * The schema is the source of truth and the TypeScript type is derived from it,
 * not declared alongside it. Two hand-maintained descriptions of one wire
 * format drift, and the direction they drift in is always the dangerous one:
 * the type says a field is checked when the validator no longer checks it.
 */

/**
 * The largest program we accept, in bytes.
 *
 * v1.0 submissions are single-file and standard-library-only (OV-2), so this is
 * generous for anything the product is actually for while bounding what an
 * anonymous request can make us write to disk. Bytes rather than characters
 * because bytes are what the filesystem counts.
 */
export const MAX_CODE_BYTES = 64 * 1024;

/**
 * The largest request body we will buffer.
 *
 * This is NOT cosmetic: validation cannot run until the whole body is in
 * memory, so without an explicit ceiling the code cap above is enforced only
 * after we have already accepted whatever was sent.
 *
 * The multiplier covers JSON escaping. A control character costs one byte in
 * the file and six on the wire (`\u0001`), so a program exactly at the code cap
 * can legitimately arrive as a ~6x larger body. Rounding to 8x leaves room for
 * the rest of the envelope. Express's 100 kB default is BELOW that worst case
 * and would have rejected valid submissions.
 */
export const MAX_BODY_BYTES = MAX_CODE_BYTES * 8;

const withinByteCap = (code: string): boolean =>
  Buffer.byteLength(code, "utf-8") <= MAX_CODE_BYTES;

export const submissionRequestSchema = z.strictObject({
  code: z
    .string()
    .refine(withinByteCap, `code must be at most ${MAX_CODE_BYTES} bytes`),
  language: z.enum(LANGUAGES),
});

export type SubmissionRequestBody = z.infer<typeof submissionRequestSchema>;

type Issue = z.ZodError["issues"][number];

const describeIssue = (issue: Issue): string => {
  if (issue.code === "unrecognized_keys") {
    const keys = issue.keys.map((key) => `"${key}"`).join(", ");
    return `unrecognized field${issue.keys.length > 1 ? "s" : ""} ${keys}`;
  }
  const path = issue.path.join(".");
  return path ? `${path}: ${issue.message}` : issue.message;
};

/**
 * Turn a validation failure into advice.
 *
 * DX7's `hint` field only earns its place if it says something the `message`
 * did not. "language: invalid value" states the problem; naming the supported
 * languages is what lets the caller fix it without opening the docs.
 */
const hintFor = (issues: readonly Issue[]): string => {
  if (issues.some((issue) => issue.code === "unrecognized_keys")) {
    return 'The body accepts exactly two fields: "language" and "code".';
  }
  if (issues.some((issue) => issue.path[0] === "language")) {
    return `Supported languages: ${LANGUAGES.join(", ")}.`;
  }
  if (issues.some((issue) => issue.path[0] === "code")) {
    return `"code" is the program to run, as a string of at most ${MAX_CODE_BYTES} bytes.`;
  }
  return 'The body must be a JSON object: {"language": "python", "code": "..."}.';
};

/**
 * Parse a request body, or throw the envelope explaining why not.
 *
 * Every issue is reported, not just the first. A caller fixing a body one
 * rejection at a time is a round trip per mistake, which is the DX the envelope
 * exists to avoid.
 */
export const parseSubmissionRequest = (
  body: unknown
): SubmissionRequestBody => {
  const result = submissionRequestSchema.safeParse(body);
  if (result.success) {
    return result.data;
  }

  const message = result.error.issues.map(describeIssue).join("; ");
  throw validationFailed(message, hintFor(result.error.issues));
};
