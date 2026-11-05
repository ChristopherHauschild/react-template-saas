import {
  SUPPORT_REQUEST_RATE_LIMIT,
  SUPPORT_REQUEST_RATE_LIMITED_CODE,
} from "./support-request";

/**
 * Failures that are not about a single field. Field messages live with the
 * input schema (`SUPPORT_REQUEST_FIELD_ERRORS`).
 */
export type SupportRequestFailure =
  /** The database refused the values (it validates too); the form should be corrected. */
  | "invalid"
  /** The per-user flood limit was hit. */
  | "rateLimited"
  /** The session ended between the guard and the write/read. */
  | "sessionExpired"
  /**
   * The session now belongs to a different account than the page was
   * rendered for (see `sessionForPage`). Nothing was read or written.
   */
  | "accountChanged"
  /** Anything else: outage, network, a bug. Retrying may work. */
  | "unavailable";

/**
 * Messages shown on the support page. Raw PostgREST/PostgreSQL messages are
 * never surfaced: they are written for developers, may quote the failing row,
 * and their wording is not a contract.
 */
export const SUPPORT_REQUEST_ERRORS = {
  invalid: "Please check your request and try again.",
  rateLimited: `You've sent the maximum of ${SUPPORT_REQUEST_RATE_LIMIT.requests} requests in the last hour. Please wait a little before sending another.`,
  sessionExpired:
    "Your session has expired. Sign in again, then send your request — what you wrote is still here.",
  unavailable: "We couldn't send your request right now. Please try again in a moment.",
  listUnavailable: "We couldn't load your requests right now. Please try again.",
  listRestart: "Your list of requests is out of date. Reload the page to see it.",
  accountChanged:
    "You're now signed in to a different account (perhaps in another tab), so nothing was sent — this request was started in your previous account. Sign back in to that account, then send it; what you wrote is still here. To use the other account instead, reload this page; this unsent request won't be kept.",
  listAccountChanged:
    "You're now signed in to a different account (perhaps in another tab), so these requests can't be loaded here — this list belongs to your previous account. Sign back in to that account, then try again, or reload this page to see the other account's requests.",
  listSessionExpired:
    "Your session has expired. Sign in again, then try again — anything you've typed above is kept.",
} as const;

export type SupportRequestErrorMessage =
  (typeof SUPPORT_REQUEST_ERRORS)[keyof typeof SUPPORT_REQUEST_ERRORS];

/** The message to show for a failure when sending a request. */
export function describeSupportRequestFailure(
  failure: SupportRequestFailure,
): SupportRequestErrorMessage {
  return SUPPORT_REQUEST_ERRORS[failure];
}

/**
 * SQLSTATEs the database answers with, mapped to what the user is told.
 *
 * - `PT429` — the flood-limit trigger (PostgREST turns it into HTTP 429).
 * - `23514` — a CHECK constraint. The application validates first, so this
 *   means the two disagree (a bug, or an older deployment); the user is asked
 *   to correct the request rather than shown an outage.
 * - `42501` — insufficient privilege or a row level security refusal. Both mean
 *   the request arrived without a usable session (PostgREST fell back to the
 *   anonymous role, or `auth.uid()` was null), since nothing else the user can
 *   do produces it.
 * - `23503`/`23502` — the owner does not exist or could not be derived: the
 *   account was deleted, or again no session.
 * - `PGRST301`/`PGRST302` — PostgREST's own "JWT expired"/"not authenticated".
 */
const FAILURE_BY_CODE: Record<string, SupportRequestFailure> = {
  [SUPPORT_REQUEST_RATE_LIMITED_CODE]: "rateLimited",
  "23514": "invalid",
  "42501": "sessionExpired",
  "23503": "sessionExpired",
  "23502": "sessionExpired",
  PGRST301: "sessionExpired",
  PGRST302: "sessionExpired",
};

/**
 * Maps a failure from PostgREST to a `SupportRequestFailure`.
 *
 * Decided on the stable SQLSTATE `code`, never on the message text. Anything
 * unrecognised — including network failures and thrown exceptions — is
 * reported as a temporary problem, which is the safe default: it invites a
 * retry and claims nothing about the cause.
 */
export function toSupportRequestFailure(error: unknown): SupportRequestFailure {
  if (error === null || typeof error !== "object") return "unavailable";

  const code = (error as { code?: unknown }).code;

  if (typeof code !== "string") return "unavailable";

  return FAILURE_BY_CODE[code] ?? "unavailable";
}

/**
 * What to log for a PostgREST failure: the SQLSTATE and nothing else from the
 * response. `details`/`hint`/`message` can quote the row — here, what the user
 * wrote — so they never reach the logs.
 */
export function summarizeSupportRequestError(error: unknown): { code: string } {
  const code = (error as { code?: unknown } | null)?.code;

  return { code: typeof code === "string" ? code : "unknown" };
}
