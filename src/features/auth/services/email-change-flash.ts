import {
  readSignedCookieValue,
  signCookieValue,
} from "@/infrastructure/auth/signed-cookie";

import { EMAIL_CHANGE_STATUSES, type EmailChangeStatus } from "./email-change-status";

/**
 * Proof that THIS browser just came through `/auth/callback` with an
 * email-change link — the part of the outcome a URL cannot carry.
 *
 * `?emailChange=<status>` alone is untrusted: anyone can type
 * `/settings?emailChange=confirmed`, or send it as a link. The absence of a
 * pending change does not prove a change was just confirmed either. So the
 * callback also sets this cookie, and a status is shown only when the URL and
 * the cookie agree:
 *
 * - Signed (HMAC-SHA256 with a key only this server holds — see
 *   `infrastructure/auth/signed-cookie.ts`): a value not produced by this
 *   server, or altered in any way, is rejected before it is parsed. Typing one,
 *   editing one in DevTools, or planting one from a sibling subdomain all fail.
 * - HttpOnly: page scripts cannot read or write it; a URL cannot set it.
 * - Bound to the account the callback saw signed in (or to "no session", for the
 *   login page), so it cannot speak for a different user of the same browser.
 * - Short-lived: `Max-Age` in the browser, and the embedded issue time is checked
 *   on the server as well — a kept or copied cookie goes stale.
 *
 * The cookie influences DISPLAY only. No action reads it: requesting, resending
 * or confirming an email change never depends on it.
 */
export const EMAIL_CHANGE_FLASH_COOKIE = "app-email-change";

/** HKDF purpose label: this cookie's key is shared with nothing else. */
export const EMAIL_CHANGE_FLASH_KEY_PURPOSE = "email-change-flash/v2";

/** Long enough to survive the redirect and a reload or two; short enough to go stale quickly. */
export const EMAIL_CHANGE_FLASH_MAX_AGE_SECONDS = 300;

/** Tolerated clock difference for an issue time slightly in the future. */
const CLOCK_SKEW_SECONDS = 30;

const VERSION = "v2";
const NO_SESSION = "-";

const KNOWN_STATUSES: readonly string[] = Object.values(EMAIL_CHANGE_STATUSES);

export type EmailChangeFlash = {
  status: EmailChangeStatus;
  /** Account the callback saw signed in; null when the browser had no session. */
  userId: string | null;
  /** Unix seconds. */
  issuedAt: number;
};

/**
 * Cookie value: the payload `v2|<status>|<userId or ->|<issuedAt>` signed with
 * `key` (see `signCookieValue`). Contains no email address or token.
 */
export function serializeEmailChangeFlash(
  flash: EmailChangeFlash,
  key: Uint8Array,
): string {
  const payload = [
    VERSION,
    flash.status,
    flash.userId ?? NO_SESSION,
    flash.issuedAt,
  ].join("|");

  return signCookieValue(payload, key);
}

/**
 * The inverse of {@link serializeEmailChangeFlash}: null unless the signature
 * verifies with `key` AND the payload is well-formed.
 */
export function parseEmailChangeFlash(
  value: string | undefined,
  key: Uint8Array,
): EmailChangeFlash | null {
  const payload = readSignedCookieValue(value, key);
  if (payload === null) return null;

  const parts = payload.split("|");
  if (parts.length !== 4) return null;

  const [version, status, user, issued] = parts;
  if (version !== VERSION || !KNOWN_STATUSES.includes(status)) return null;
  if (!/^\d{1,12}$/.test(issued)) return null;
  if (user !== NO_SESSION && !/^[A-Za-z0-9_-]{1,64}$/.test(user)) return null;

  return {
    status: status as EmailChangeStatus,
    userId: user === NO_SESSION ? null : user,
    issuedAt: Number(issued),
  };
}

/** Cookie attributes. `Secure` follows the app's own scheme (plain http locally). */
export function emailChangeFlashCookieOptions(appUrl: string) {
  return {
    httpOnly: true,
    sameSite: "lax" as const,
    secure: new URL(appUrl).protocol === "https:",
    path: "/",
    maxAge: EMAIL_CHANGE_FLASH_MAX_AGE_SECONDS,
  };
}

/**
 * The status to show, or null. Shown only when ALL hold:
 * - the URL carries a known status;
 * - the flash cookie is present, its signature verifies, it is well-formed and
 *   reports the SAME status;
 * - it was issued for the expected account (`expectedUserId`: the signed-in
 *   user on the settings page; null — no session — on the login page);
 * - it is fresh.
 */
export function verifyEmailChangeStatus(
  queryStatus: EmailChangeStatus | null,
  flashValue: string | undefined,
  {
    expectedUserId,
    now,
    key,
  }: { expectedUserId: string | null; now: number; key: Uint8Array },
): EmailChangeStatus | null {
  if (queryStatus === null) return null;

  const flash = parseEmailChangeFlash(flashValue, key);
  if (flash === null) return null;
  if (flash.status !== queryStatus) return null;
  if (flash.userId !== expectedUserId) return null;

  const nowSeconds = Math.floor(now / 1000);
  const age = nowSeconds - flash.issuedAt;
  if (age > EMAIL_CHANGE_FLASH_MAX_AGE_SECONDS || age < -CLOCK_SKEW_SECONDS) return null;

  return queryStatus;
}
