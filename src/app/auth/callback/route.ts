import { type NextRequest, NextResponse } from "next/server";

import { clientEnv } from "@/config/env.client";
import { ROUTES } from "@/config/routes";
import { summarizeAuthErrorForLog } from "@/features/auth/services/auth-error-log";
import {
  confirmEmail,
  confirmEmailChangeWithTokenHash,
  confirmEmailWithTokenHash,
  EMAIL_CHANGE_TOKEN_HASH_TYPE,
  isTokenHashType,
} from "@/features/auth/services/confirm-email";
import {
  EMAIL_CHANGE_FLASH_COOKIE,
  EMAIL_CHANGE_FLASH_KEY_PURPOSE,
  emailChangeFlashCookieOptions,
  serializeEmailChangeFlash,
} from "@/features/auth/services/email-change-flash";
import {
  EMAIL_CHANGE_STATUSES,
  emailChangeStatusPath,
} from "@/features/auth/services/email-change-status";
import {
  CONFIRMATION_FAILURES,
  confirmationFailurePath,
  describeRedirectErrorCode,
} from "@/features/auth/services/email-confirmation-errors";
import { recordAccountActivity } from "@/infrastructure/account-activity/record-account-activity";
import { getCurrentUser } from "@/infrastructure/auth/session/get-current-user";
import { signingKeyFor } from "@/infrastructure/auth/signed-cookie";
import { resolveSafeRedirectPath } from "@/shared/utils/safe-redirect-path";

/**
 * Landing point of the confirmation link in sign-up emails (`ROUTES.authCallback`).
 *
 * Two link shapes are accepted; either way the server client writes the session
 * cookies while verifying, Next attaches them to the redirect below, and the
 * user lands on the dashboard, signed in:
 *
 * - `?token_hash=…&type=signup` — produced by this project's confirmation email
 *   template (`supabase/templates/confirmation.html`). Verified directly, so it
 *   works from any browser and for resent emails. Preferred.
 * - `?code=…` — the PKCE flow, produced by Supabase's default template: it
 *   verifies the link itself and redirects here with a one-time code, which only
 *   the browser that signed up can exchange. Kept as a fallback.
 *
 * Every other outcome ends on the login page with `?confirmation=<reason>` so it
 * can explain what happened and offer a new link:
 * - neither parameter: the link was tampered with, or Supabase rejected it before
 *   issuing a code and came back with `?error_code=…` instead (expired link);
 * - verification failed: expired, already used, opened in another browser (code
 *   only), or Supabase unavailable (see `describeExchangeError`).
 *
 * `?next=` optionally overrides the success destination. It is honoured only when
 * it is a same-origin path (`resolveSafeRedirectPath`), never on failure, and is
 * not something the sign-up action sets today; it exists for flows such as
 * invitations that want to land somewhere specific.
 *
 * Email-change links (`?token_hash=…&type=email_change`, from
 * `supabase/templates/email_change.html`) take a separate path: every outcome —
 * completed, first of two confirmations, expired, invalid, unavailable — ends on
 * the settings page as `?emailChange=<status>` (see `handleEmailChange`).
 */
export async function GET(request: NextRequest) {
  const { searchParams } = request.nextUrl;
  const tokenHash = searchParams.get("token_hash");
  const type = searchParams.get("type");
  const code = searchParams.get("code");
  const next = resolveSafeRedirectPath(searchParams.get("next"), ROUTES.dashboard);

  if (tokenHash && type === EMAIL_CHANGE_TOKEN_HASH_TYPE) {
    return handleEmailChange(tokenHash);
  }

  let verify: (() => ReturnType<typeof confirmEmail>) | null = null;

  if (tokenHash) {
    // A token_hash with an unexpected type is a malformed link, not a PKCE one.
    verify = isTokenHashType(type)
      ? () => confirmEmailWithTokenHash(tokenHash, type)
      : null;
  } else if (code) {
    verify = () => confirmEmail(code);
  } else {
    return redirectTo(
      confirmationFailurePath(describeRedirectErrorCode(searchParams.get("error_code"))),
    );
  }

  if (!verify) {
    return redirectTo(confirmationFailurePath(CONFIRMATION_FAILURES.invalid));
  }

  let result: Awaited<ReturnType<typeof confirmEmail>>;

  try {
    result = await verify();
  } catch (thrown) {
    // `confirmEmail` contains its own failures; this is the last line of defence
    // so a regression there strands the user on the login page, not on a 500.
    console.error(
      "[auth] email confirmation route threw unexpectedly",
      summarizeAuthErrorForLog(thrown),
    );

    return redirectTo(confirmationFailurePath(CONFIRMATION_FAILURES.unavailable));
  }

  return redirectTo(result.ok ? next : confirmationFailurePath(result.failure));
}

/**
 * Email-change links never carry `?next=`: the user always returns to the
 * settings page, where the Email card shows the resulting state and offers a
 * new link if this one was dead. The status is shown there only if the browser
 * holds a session — the one it had (the usual case: the link was opened where the
 * change was requested) or the one the completed confirmation just created;
 * otherwise the login page shows it, so the message is never lost to the guard.
 *
 * A completed change is the one moment the account's address actually changes,
 * so it is recorded in that account's activity history here — and only here:
 * the request was recorded when it was made, the first of two confirmations
 * (`awaiting_other`) changes nothing, and failures change nothing. Recorded
 * for the account GoTrue returned, whatever session the browser holds, and
 * best effort: the change is complete server-side at this point, so a
 * failure to record it is logged and does not alter where the user is sent.
 */
async function handleEmailChange(tokenHash: string): Promise<NextResponse> {
  let status: Awaited<ReturnType<typeof confirmEmailChangeWithTokenHash>>["status"];
  let confirmedFor: string | null = null;
  let newEmail: string | null = null;

  try {
    ({
      status,
      userId: confirmedFor,
      email: newEmail,
    } = await confirmEmailChangeWithTokenHash(tokenHash));
  } catch (thrown) {
    console.error(
      "[auth] email change confirmation route threw unexpectedly",
      summarizeAuthErrorForLog(thrown),
    );

    status = EMAIL_CHANGE_STATUSES.unavailable;
  }

  if (status === EMAIL_CHANGE_STATUSES.confirmed && confirmedFor !== null) {
    try {
      // The writer never throws by contract and logs its own failures; the
      // guard keeps a regression there from turning a completed change into a 500.
      await recordAccountActivity(confirmedFor, {
        type: "email.changed",
        details: { to: newEmail },
      });
    } catch (thrown) {
      console.error("[auth] email change could not be recorded in the activity history", {
        error: { name: thrown instanceof Error ? thrown.name : typeof thrown },
      });
    }
  }

  let signedInAs: string | null = null;

  try {
    signedInAs = (await getCurrentUser())?.id ?? null;
  } catch (thrown) {
    // Cannot tell: the login page shows the status either way, and a signed-in
    // user is sent on to the dashboard from there.
    console.error(
      "[auth] could not read the session after an email change link",
      summarizeAuthErrorForLog(thrown),
    );
  }

  // Who the outcome is addressed to. Normally the signed-in user: the completing
  // link just wrote that account's new session, and the other statuses concern
  // whoever is using this browser. But a completed change is about ONE account;
  // if the browser turns out to be signed in as someone else (a stale session of
  // another account, and the new one could not be written), the status must
  // not be bound to — or shown to — that other user. It then goes to the login
  // page unbound, where a signed-in user is simply sent on.
  const audience =
    confirmedFor !== null && signedInAs !== confirmedFor ? null : signedInAs;

  const response = redirectTo(
    emailChangeStatusPath(status, { signedIn: audience !== null }),
  );

  // The URL's `?emailChange=` is forgeable; this signed, HttpOnly cookie is what
  // lets the destination page believe it (see email-change-flash.ts). Bound to
  // the account it is addressed to, so it cannot vouch for anyone else.
  response.cookies.set(
    EMAIL_CHANGE_FLASH_COOKIE,
    serializeEmailChangeFlash(
      { status, userId: audience, issuedAt: Math.floor(Date.now() / 1000) },
      signingKeyFor(EMAIL_CHANGE_FLASH_KEY_PURPOSE),
    ),
    emailChangeFlashCookieOptions(clientEnv.NEXT_PUBLIC_APP_URL),
  );

  return response;
}

/**
 * Redirect to a same-origin path.
 *
 * The `Location` is deliberately relative, resolved by the browser against the
 * URL it is on (RFC 9110 §10.2.2). An absolute URL built from `request.nextUrl`
 * would not do: Next canonicalises loopback hosts to `localhost`, so a local
 * sign-up on `http://127.0.0.1:3000` (the configured app URL) would be sent to
 * `http://localhost:3000/dashboard` — a different cookie host, where the session
 * cookies just written by the exchange are not sent — and bounce back to login.
 * Relative also means no host is ever taken from the request, so a forged `Host`
 * header cannot steer the redirect.
 *
 * 303 so that the browser always follows with a GET, and `no-store` so that a
 * response that carries fresh session cookies (or consumes a one-time code) is
 * never served from a cache. Session cookies set through `cookies()` during the
 * exchange are merged into this response by Next.
 */
function redirectTo(path: string): NextResponse {
  return new NextResponse(null, {
    status: 303,
    headers: { Location: path, "Cache-Control": "no-store" },
  });
}
