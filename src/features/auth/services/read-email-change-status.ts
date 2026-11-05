import "server-only";

import { cookies } from "next/headers";

import { signingKeyFor } from "@/infrastructure/auth/signed-cookie";

import {
  EMAIL_CHANGE_FLASH_COOKIE,
  EMAIL_CHANGE_FLASH_KEY_PURPOSE,
  verifyEmailChangeStatus,
} from "./email-change-flash";
import { parseEmailChangeStatus } from "./email-change-status";

/**
 * The email-change status a page may show: `?emailChange=` (untrusted) confirmed
 * by the signed, HttpOnly flash cookie `/auth/callback` set for this browser —
 * see `email-change-flash.ts`. A typed, forwarded or stale URL, or a forged,
 * altered or expired cookie, yields null.
 *
 * `expectedUserId` is the signed-in user on the settings page, and null on the
 * login page (the callback sends a browser there only when it had no session).
 */
export async function readEmailChangeStatus(
  queryValue: string | string[] | undefined,
  { expectedUserId }: { expectedUserId: string | null },
) {
  const cookieStore = await cookies();

  return verifyEmailChangeStatus(
    parseEmailChangeStatus(queryValue),
    cookieStore.get(EMAIL_CHANGE_FLASH_COOKIE)?.value,
    {
      expectedUserId,
      now: Date.now(),
      key: signingKeyFor(EMAIL_CHANGE_FLASH_KEY_PURPOSE),
    },
  );
}
