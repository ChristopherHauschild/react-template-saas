import { z } from "zod";

/**
 * Data contract of `public.support_requests`
 * (`supabase/migrations/*_support_requests.sql`).
 *
 * The database is the authority: a signed-in user inserts their own requests
 * directly with their session token, so every rule below is also a CHECK
 * constraint or trigger there, and the same token used through the REST API
 * gets the same answer. These constants let the application validate first
 * and show useful messages instead of a constraint violation. A unit test ties
 * them to the migration, and the integration test checks that the input schema
 * accepts exactly what the database accepts.
 *
 * Who may do what (enforced by privileges + RLS, see the migration):
 * - create: signed-in users, for themselves, only `category`/`subject`/`message`;
 * - read:   signed-in users, their own requests only;
 * - update/delete: nobody; anonymous: nothing.
 */

export const SUPPORT_REQUESTS_TABLE = "support_requests";

export const SUPPORT_REQUEST_CATEGORIES = [
  "account",
  "billing",
  "technical",
  "other",
] as const;
export type SupportRequestCategory = (typeof SUPPORT_REQUEST_CATEGORIES)[number];

export const SUPPORT_REQUEST_STATUSES = ["open", "closed"] as const;
export type SupportRequestStatus = (typeof SUPPORT_REQUEST_STATUSES)[number];

/** Limits in characters (Unicode code points, like PostgreSQL's `char_length`). */
export const SUPPORT_REQUEST_SUBJECT_MAX_LENGTH = 150;
export const SUPPORT_REQUEST_MESSAGE_MAX_LENGTH = 5000;

/** Flood limit enforced by the `support_requests_rate_limit` trigger. */
export const SUPPORT_REQUEST_RATE_LIMIT = { requests: 5, windowMinutes: 60 } as const;
/** SQLSTATE raised by the trigger (PostgREST answers HTTP 429). */
export const SUPPORT_REQUEST_RATE_LIMITED_CODE = "PT429";

/**
 * Name of the form field that carries the account a page was rendered for to
 * the send action (checked by `sessionForPage`; never used to pick an owner).
 */
export const PAGE_OWNER_FIELD = "pageOwner";

/** The columns a user may supply; everything else comes from database defaults. */
export const SUPPORT_REQUEST_INSERTABLE_COLUMNS = [
  "category",
  "subject",
  "message",
] as const;

const codePoints = (value: string) => [...value].length;

/**
 * CRLF and lone CR → LF. A browser counts a textarea's line break as ONE
 * character (`maxLength`, `value.length`) but sends it as CRLF when the form
 * is encoded for submission (the HTML spec's newline normalisation; Server
 * Actions post multipart). Without this, a message the browser allowed at the
 * limit arrives longer than the limit and is refused, and stored text carries
 * CRs. Found in a real browser — jsdom does not encode form data this way.
 */
export function normalizeLineBreaks(value: string): string {
  return value.replace(/\r\n?/g, "\n");
}

/**
 * Characters that make a subject more than one line: C0 controls, DEL, C1
 * controls and the Unicode line/paragraph separators. Same ranges as the
 * `support_requests_subject_format` check (plus NUL, which `text` cannot hold).
 */
const SUBJECT_FORBIDDEN = /[\u0000-\u001f\u007f-\u009f\u2028\u2029]/;

/**
 * What the form says about each invalid field. The database rejects the same
 * inputs, but with messages written for developers; these are the ones users
 * see. Failures that are not about a field (rate limit, session, outage) are in
 * `support-request-errors.ts`.
 */
export const SUPPORT_REQUEST_FIELD_ERRORS = {
  categoryInvalid: "Choose what your request is about.",
  subjectRequired: "Enter a subject.",
  subjectTooLong: `Subject must be at most ${SUPPORT_REQUEST_SUBJECT_MAX_LENGTH} characters.`,
  subjectInvalid: "Subject must be a single line, without control characters.",
  messageRequired: "Describe what you need help with.",
  messageTooLong: `Message must be at most ${SUPPORT_REQUEST_MESSAGE_MAX_LENGTH} characters.`,
  messageInvalid: "Message contains a character we can't store.",
} as const;

export type SupportRequestFieldError =
  (typeof SUPPORT_REQUEST_FIELD_ERRORS)[keyof typeof SUPPORT_REQUEST_FIELD_ERRORS];

/**
 * Input for a new request, trimmed. What it accepts is a subset of what the
 * database accepts (it trims first, the database only rejects blanks), so a
 * value that passes here is never rejected by a CHECK constraint — the
 * integration test pins that agreement.
 *
 * Messages are attached per rule and trimming happens before the length check,
 * so a subject of spaces is "required", not "too long". The first failing
 * issue is the one the form reports.
 */
export const NEW_SUPPORT_REQUEST_SCHEMA = z.object({
  category: z.enum(SUPPORT_REQUEST_CATEGORIES, {
    error: SUPPORT_REQUEST_FIELD_ERRORS.categoryInvalid,
  }),
  subject: z
    .string({ error: SUPPORT_REQUEST_FIELD_ERRORS.subjectRequired })
    .trim()
    .min(1, SUPPORT_REQUEST_FIELD_ERRORS.subjectRequired)
    .refine((value) => codePoints(value) <= SUPPORT_REQUEST_SUBJECT_MAX_LENGTH, {
      message: SUPPORT_REQUEST_FIELD_ERRORS.subjectTooLong,
    })
    .refine((value) => !SUBJECT_FORBIDDEN.test(value), {
      message: SUPPORT_REQUEST_FIELD_ERRORS.subjectInvalid,
    }),
  message: z
    .string({ error: SUPPORT_REQUEST_FIELD_ERRORS.messageRequired })
    // Line breaks first: everything below counts and stores LF-only text.
    .transform(normalizeLineBreaks)
    .pipe(
      z
        .string()
        .trim()
        .min(1, SUPPORT_REQUEST_FIELD_ERRORS.messageRequired)
        .refine((value) => codePoints(value) <= SUPPORT_REQUEST_MESSAGE_MAX_LENGTH, {
          message: SUPPORT_REQUEST_FIELD_ERRORS.messageTooLong,
        })
        // PostgreSQL `text` cannot store NUL; reject it here rather than as a driver error.
        .refine((value) => !value.includes("\u0000"), {
          message: SUPPORT_REQUEST_FIELD_ERRORS.messageInvalid,
        }),
    ),
});

export type NewSupportRequest = z.infer<typeof NEW_SUPPORT_REQUEST_SCHEMA>;
