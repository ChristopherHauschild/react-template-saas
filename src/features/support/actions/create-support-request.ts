"use server";

import { revalidatePath } from "next/cache";

import { ROUTES } from "@/config/routes";

import {
  createSupportRequest,
  type SupportRequestField,
} from "../services/create-support-request";
import { sessionForPage } from "../services/page-session";
import { PAGE_OWNER_FIELD } from "../services/support-request";
import {
  describeSupportRequestFailure,
  type SupportRequestFailure,
} from "../services/support-request-errors";
import type { SupportRequest } from "../services/support-request-row";

/**
 * Result of a send attempt. Never redirects: the user stays on the support page
 * and sees either their new request or an inline error. Failures are returned
 * rather than thrown, so the page is not replaced by the route's error screen.
 *
 * - `error`: something the user can act on. `field` is set when one input is at
 *   fault, absent for the flood limit, an expired session or an outage.
 *   `reason` says which kind of failure it was, so the form can offer the
 *   matching way out (e.g. signing in again without leaving the page).
 * - `sent`: the request was filed. `request` is the stored row, or `null` when
 *   it was written but could not be read back — the list has been revalidated
 *   either way, so the page will show it.
 *
 * Nothing the user submitted is echoed back: the form keeps its own fields
 * untouched after a failure (it opts out of React's automatic form reset).
 */
export type CreateSupportRequestActionResult =
  | {
      status: "error";
      error: string;
      reason: SupportRequestFailure;
      field?: SupportRequestField;
    }
  | { status: "sent"; request: SupportRequest | null }
  | null;

const text = (formData: FormData, field: string): string => {
  const value = formData.get(field);

  return typeof value === "string" ? value : "";
};

/**
 * Files the support request described by the form for the signed-in user.
 *
 * Outcomes, in order of precedence:
 *
 * 1. No signed-in user → `error` (`sessionExpired`); nothing is read or
 *    written. The page sits behind the `(protected)` guard, but a Server
 *    Action is an HTTP endpoint of its own and must never trust that. Unlike
 *    the settings actions this does NOT redirect to the login page: a
 *    redirect would navigate away from what the user wrote, which for a
 *    support request can be a long message. The form keeps it and offers to
 *    sign in without leaving the page.
 * 1b. Signed in, but as a DIFFERENT account than the page was rendered for
 *    (`pageOwner` field) → `error` (`accountChanged`); nothing is read or
 *    written. Otherwise a request typed for one account would be filed under
 *    another. See `sessionForPage`.
 * 2. Invalid input → `error` naming the offending field, before the database
 *    is contacted.
 * 3. Filed → `sent`, and the support route is revalidated so the list below
 *    the form shows the new request.
 * 4. Flood limit, expired session or any other failure → `error` with a
 *    user-facing message. Raw database messages are never surfaced, and
 *    nothing the user wrote is logged.
 *
 * The action takes only the three fields a user may supply, plus the page's
 * account for the check above. Who the request belongs to comes from the
 * verified session and the database's own `auth.uid()` default, never from
 * the form: `pageOwner` can only make the action refuse, never choose an owner.
 *
 * Compatible with `useActionState`: React calls it with `(prevState, formData)`.
 */
export async function createSupportRequestAction(
  _prevState: CreateSupportRequestActionResult,
  formData: FormData,
): Promise<CreateSupportRequestActionResult> {
  // Same verified lookup as `requireAuth()`, without its redirect, and
  // checked against the page's account (see above).
  const session = await sessionForPage(formData.get(PAGE_OWNER_FIELD));

  if (session.status !== "ok") {
    const reason = session.status === "signedOut" ? "sessionExpired" : "accountChanged";

    return { status: "error", error: describeSupportRequestFailure(reason), reason };
  }

  // Only the three fields a user may supply; the service validates them.
  const result = await createSupportRequest(session.userId, {
    category: text(formData, "category"),
    subject: text(formData, "subject"),
    message: text(formData, "message"),
  });

  if (!result.ok) {
    return {
      status: "error",
      error: result.error ?? describeSupportRequestFailure(result.failure),
      reason: result.failure,
      ...(result.field ? { field: result.field } : {}),
    };
  }

  // The list is rendered by the page; revalidating makes the re-render that
  // follows the action show the request that was just filed (and is the only
  // way the page recovers when the echo could not be read back).
  revalidatePath(ROUTES.support);

  return { status: "sent", request: result.request };
}
