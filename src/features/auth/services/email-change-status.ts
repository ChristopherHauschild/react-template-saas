import { ROUTES } from "@/config/routes";

/**
 * Outcome of opening an email-change confirmation link, carried from
 * `/auth/callback` to the settings page (or to the login page when the browser
 * that opened the link holds no session) as `?emailChange=<status>`. Short,
 * stable, URL-safe tokens — never Supabase's message text.
 *
 * - `confirmed`: the change is complete; the account's email IS the new address.
 *   This is the ONLY status after which the UI may say the email was changed.
 * - `awaiting_other`: the project requires both addresses to confirm
 *   (`double_confirm_changes`); this link was accepted, the one sent to the other
 *   address still has to be opened. Nothing has changed yet.
 * - `expired`: the link was valid but is past its lifetime; request a new one.
 * - `invalid`: malformed, already used, or not an email-change link at all.
 * - `unavailable`: Supabase could not be reached or failed unexpectedly; the
 *   link itself may still be fine — try again in a moment.
 */
export const EMAIL_CHANGE_STATUSES = {
  confirmed: "confirmed",
  awaitingOther: "awaiting_other",
  expired: "expired",
  invalid: "invalid",
  unavailable: "unavailable",
} as const;

export type EmailChangeStatus =
  (typeof EMAIL_CHANGE_STATUSES)[keyof typeof EMAIL_CHANGE_STATUSES];

/** Query parameter carrying an {@link EmailChangeStatus}. */
export const EMAIL_CHANGE_QUERY_PARAM = "emailChange";

const KNOWN_STATUSES: readonly string[] = Object.values(EMAIL_CHANGE_STATUSES);

/**
 * Relative URL reporting the status. The settings page is the natural landing
 * spot, but it is behind the auth guard: a browser without a session (the link
 * was opened on another device, or the pending change was confirmed from an
 * address whose inbox lives elsewhere) would be bounced to `/login` and lose the
 * message — so such a browser is sent to the login page directly, which shows
 * the same banner.
 */
export function emailChangeStatusPath(
  status: EmailChangeStatus,
  { signedIn }: { signedIn: boolean },
): string {
  const params = new URLSearchParams({ [EMAIL_CHANGE_QUERY_PARAM]: status });

  return `${signedIn ? ROUTES.settings : ROUTES.login}?${params}`;
}

/**
 * Reads `?emailChange=` back into an {@link EmailChangeStatus}. The value is
 * untrusted (anyone can type it) but is only ever compared against the closed
 * set of known statuses, never rendered — an unrecognised or repeated value
 * yields `null`, showing no banner.
 */
export function parseEmailChangeStatus(
  value: string | string[] | undefined,
): EmailChangeStatus | null {
  return typeof value === "string" && KNOWN_STATUSES.includes(value)
    ? (value as EmailChangeStatus)
    : null;
}

/**
 * Reconciles the status carried in the URL with what the server knows, so the
 * page never asserts something the account's record contradicts. The query
 * string is untrusted and can be stale (the tab was left open, the page was
 * reloaded later, the link was opened again) or simply typed:
 *
 * - `confirmed` while a change is still pending → not true (yet): hidden.
 * - `awaiting_other` while nothing is pending → the change completed elsewhere,
 *   or was never requested: hidden.
 * - dead-link and outage statuses are about the *link*, not the account, and
 *   are shown as they are.
 *
 * Only the settings page can do this (it has the session); the login page
 * shows the status as received.
 */
export function reconcileEmailChangeStatus(
  status: EmailChangeStatus | null,
  { changePending }: { changePending: boolean },
): EmailChangeStatus | null {
  if (status === EMAIL_CHANGE_STATUSES.confirmed && changePending) return null;
  if (status === EMAIL_CHANGE_STATUSES.awaitingOther && !changePending) return null;

  return status;
}
