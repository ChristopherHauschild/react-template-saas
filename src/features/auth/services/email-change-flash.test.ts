// @vitest-environment node
import { readFileSync } from "node:fs";
import path from "node:path";
import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@/config/env.server", () => ({
  serverEnv: {
    NODE_ENV: "test",
    SUPABASE_SERVICE_ROLE_KEY: "service-role-key-for-tests",
    APP_SECRET: undefined,
  },
}));

import {
  resetSigningKeysForTests,
  signCookieValue,
  signingKeyFor,
} from "@/infrastructure/auth/signed-cookie";

import {
  EMAIL_CHANGE_FLASH_KEY_PURPOSE,
  EMAIL_CHANGE_FLASH_MAX_AGE_SECONDS,
  emailChangeFlashCookieOptions,
  parseEmailChangeFlash,
  serializeEmailChangeFlash,
  verifyEmailChangeStatus,
} from "./email-change-flash";
import { EMAIL_CHANGE_STATUSES } from "./email-change-status";

const USER = "11111111-1111-4111-8111-111111111111";
const OTHER_USER = "22222222-2222-4222-8222-222222222222";
const NOW = Date.UTC(2026, 2, 1, 10, 0, 0);
const NOW_S = NOW / 1000;

/** The server's key, as the callback and the pages derive it. */
const key = () => signingKeyFor(EMAIL_CHANGE_FLASH_KEY_PURPOSE);
/** Someone else's key: a forger guessing, or another deployment's secret. */
const ATTACKER_KEY = Buffer.alloc(32, 0x42);

const flash = (
  status: string,
  userId: string | null = USER,
  issuedAt = NOW_S,
  k = key(),
) => serializeEmailChangeFlash({ status: status as "confirmed", userId, issuedAt }, k);

const verify = (
  query: string | null,
  value: string | undefined,
  expectedUserId: string | null = USER,
  now = NOW,
) =>
  verifyEmailChangeStatus(query as "confirmed" | null, value, {
    expectedUserId,
    now,
    key: key(),
  });

beforeEach(() => resetSigningKeysForTests());

describe("serialize / parse (signed)", () => {
  it("round-trips every status, bound and unbound, with the server's key", () => {
    for (const status of Object.values(EMAIL_CHANGE_STATUSES)) {
      for (const userId of [USER, null]) {
        expect(parseEmailChangeFlash(flash(status, userId), key())).toEqual({
          status,
          userId,
          issuedAt: NOW_S,
        });
      }
    }
  });

  it("carries no address or token — only status, account id and time, plus the tag", () => {
    const value = flash("confirmed");
    const [encoded] = value.split(".");

    expect(Buffer.from(encoded, "base64url").toString()).toBe(
      `v2|confirmed|${USER}|${NOW_S}`,
    );
    expect(value.split(".")).toHaveLength(2);
  });

  it("uses a key of its own (a signature for another cookie kind could not be replayed)", () => {
    expect(
      signingKeyFor(EMAIL_CHANGE_FLASH_KEY_PURPOSE).equals(signingKeyFor("other")),
    ).toBe(false);
  });
});

describe("forged cookies never show a status", () => {
  it("an unsigned value in the old or any plain format", () => {
    for (const value of [
      `v1.confirmed.${USER}.${NOW_S}`,
      `v2|confirmed|${USER}|${NOW_S}`,
      Buffer.from(`v2|confirmed|${USER}|${NOW_S}`).toString("base64url"),
      `${Buffer.from(`v2|confirmed|${USER}|${NOW_S}`).toString("base64url")}.`,
      "confirmed",
    ]) {
      expect(verify("confirmed", value)).toBeNull();
    }
  });

  it("a value signed with a key the server does not hold", () => {
    expect(verify("confirmed", flash("confirmed", USER, NOW_S, ATTACKER_KEY))).toBeNull();
  });

  it("a genuine cookie with its status edited to 'confirmed'", () => {
    const genuine = flash("expired"); // what a failed link leaves behind
    const [, tag] = genuine.split(".");
    const edited = `${Buffer.from(`v2|confirmed|${USER}|${NOW_S}`).toString("base64url")}.${tag}`;

    expect(verify("confirmed", edited)).toBeNull();
  });

  it("a genuine cookie re-bound to another account", () => {
    const [, tag] = flash("confirmed", OTHER_USER).split(".");
    const rebound = `${Buffer.from(`v2|confirmed|${USER}|${NOW_S}`).toString("base64url")}.${tag}`;

    expect(verify("confirmed", rebound)).toBeNull();
  });

  it("a genuine cookie with its issue time moved forward to look fresh", () => {
    const [, tag] = flash("confirmed", USER, NOW_S - 86_400).split(".");
    const refreshed = `${Buffer.from(`v2|confirmed|${USER}|${NOW_S}`).toString("base64url")}.${tag}`;

    expect(verify("confirmed", refreshed)).toBeNull();
  });

  it("a correctly signed payload that is nonetheless malformed", () => {
    for (const payload of [
      `v1|confirmed|${USER}|${NOW_S}`,
      `v2|changed|${USER}|${NOW_S}`,
      `v2|confirmed|${USER}`,
      `v2|confirmed|${USER}|${NOW_S}|extra`,
      `v2|confirmed|${USER}|soon`,
      `v2|confirmed|<script>|${NOW_S}`,
    ]) {
      expect(verify("confirmed", signCookieValue(payload, key()))).toBeNull();
    }
  });
});

describe("expired cookies never show a status", () => {
  it("goes stale after the max age, even if the browser kept the cookie", () => {
    const edge = NOW + EMAIL_CHANGE_FLASH_MAX_AGE_SECONDS * 1000;

    expect(verify("confirmed", flash("confirmed"), USER, edge)).toBe("confirmed");
    expect(verify("confirmed", flash("confirmed"), USER, edge + 1000)).toBeNull();
  });

  it("a cookie from yesterday is rejected regardless of its valid signature", () => {
    expect(verify("confirmed", flash("confirmed", USER, NOW_S - 86_400))).toBeNull();
  });

  it("tolerates small clock skew but not an issue time far in the future", () => {
    expect(verify("confirmed", flash("confirmed", USER, NOW_S + 20))).toBe("confirmed");
    expect(verify("confirmed", flash("confirmed", USER, NOW_S + 3600))).toBeNull();
  });
});

describe("the real flow still works", () => {
  it("the callback's cookie for this user confirms the URL's status", () => {
    for (const status of Object.values(EMAIL_CHANGE_STATUSES)) {
      expect(verify(status, flash(status))).toBe(status);
    }
  });

  it("without a session: an unbound cookie confirms the login page's status", () => {
    expect(verify("awaiting_other", flash("awaiting_other", null), null)).toBe(
      "awaiting_other",
    );
  });

  it("a status cookie only vouches for its own status, account and placement", () => {
    expect(verify("confirmed", flash("expired"))).toBeNull();
    expect(verify("confirmed", flash("confirmed", OTHER_USER))).toBeNull();
    expect(verify("confirmed", flash("confirmed", null), USER)).toBeNull();
    expect(verify("confirmed", flash("confirmed", USER), null)).toBeNull();
  });

  it("shows nothing without a URL status, whatever the cookie says", () => {
    expect(verify(null, flash("confirmed"))).toBeNull();
  });
});

describe("emailChangeFlashCookieOptions", () => {
  it("is HttpOnly, Lax, site-wide and short-lived; Secure on https", () => {
    expect(emailChangeFlashCookieOptions("http://127.0.0.1:3000")).toEqual({
      httpOnly: true,
      sameSite: "lax",
      secure: false,
      path: "/",
      maxAge: EMAIL_CHANGE_FLASH_MAX_AGE_SECONDS,
    });
    expect(emailChangeFlashCookieOptions("https://app.example.com").secure).toBe(true);
    expect(EMAIL_CHANGE_FLASH_MAX_AGE_SECONDS).toBeLessThanOrEqual(600);
  });
});

describe("the flash cookie influences display only", () => {
  const SRC = path.resolve(__dirname, "../../..");
  const read = (file: string) => readFileSync(path.join(SRC, file), "utf8");

  it("no action that requests, resends or verifies an email change reads it", () => {
    for (const file of [
      "features/settings/actions/change-email.ts",
      "features/auth/services/confirm-email.ts",
      "app/auth/callback/route.ts",
    ]) {
      const source = read(file);
      expect(source, file).not.toMatch(
        /readEmailChangeStatus|parseEmailChangeFlash|verifyEmailChangeStatus/,
      );
      expect(source, file).not.toMatch(/cookies\(\)\.get|cookieStore\.get\(/);
    }
  });

  it("it is read in exactly one place, which only returns a status to render", () => {
    const readers = [
      "features/auth/services/read-email-change-status.ts",
      "app/(protected)/(dashboard)/settings/page.tsx",
      "app/(auth)/login/page.tsx",
    ];
    expect(read(readers[0])).toMatch(/verifyEmailChangeStatus/);
    for (const page of readers.slice(1)) {
      expect(read(page)).toMatch(/readEmailChangeStatus\(/);
      // Pages render; they never call the email-change action or verification.
      expect(read(page)).not.toMatch(/updateUser|changeEmail\(|confirmEmailChange/);
    }
  });
});
