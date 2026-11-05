// @vitest-environment node
import { NextRequest } from "next/server";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { ConfirmEmailResult } from "@/features/auth/services/confirm-email";
import { CONFIRMATION_FAILURES } from "@/features/auth/services/email-confirmation-errors";

// --- boundaries ---------------------------------------------------------------

// The real service module is partially kept (for `isTokenHashType`); its import of
// the server client reads the public env at load time.
vi.mock("@/config/env.client", () => ({
  clientEnv: {
    NEXT_PUBLIC_APP_URL: "http://127.0.0.1:3000",
    NEXT_PUBLIC_SUPABASE_URL: "https://project.supabase.co",
    NEXT_PUBLIC_SUPABASE_ANON_KEY: "anon-key",
  },
}));
// Key material for the signed flash cookie.
vi.mock("@/config/env.server", () => ({
  serverEnv: {
    NODE_ENV: "test",
    SUPABASE_SERVICE_ROLE_KEY: "service-role-key-for-tests",
    APP_SECRET: undefined,
  },
}));

const service = vi.hoisted(() => ({
  confirmEmail: vi.fn<(code: string) => Promise<ConfirmEmailResult>>(),
  confirmEmailWithTokenHash:
    vi.fn<(tokenHash: string, type: string) => Promise<ConfirmEmailResult>>(),
  confirmEmailChangeWithTokenHash:
    vi.fn<
      (
        tokenHash: string,
      ) => Promise<
        import("@/features/auth/services/confirm-email").EmailChangeConfirmation
      >
    >(),
}));
// Decides whether an email-change outcome is shown on /settings or on /login.
const session = vi.hoisted(() => ({ getCurrentUser: vi.fn() }));
vi.mock("@/infrastructure/auth/session/get-current-user", () => session);
// The activity history writer (service role): a completed email change is
// recorded for the account it belongs to. Its own behaviour is covered by
// record-account-activity.test.ts; here only WHEN and WITH WHAT it is called.
const activity = vi.hoisted(() => ({
  recordAccountActivity: vi.fn<() => Promise<{ ok: true; id: number } | { ok: false }>>(),
}));
vi.mock("@/infrastructure/account-activity/record-account-activity", () => activity);
vi.mock("@/features/auth/services/confirm-email", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/features/auth/services/confirm-email")>()),
  ...service,
}));

import {
  EMAIL_CHANGE_FLASH_KEY_PURPOSE,
  parseEmailChangeFlash,
} from "@/features/auth/services/email-change-flash";
import { signingKeyFor } from "@/infrastructure/auth/signed-cookie";

import { GET } from "./route";

// ------------------------------------------------------------------------------

const ORIGIN = "http://127.0.0.1:3000";
const CODE = "0b6f1d2e-secret-one-time-code";

const get = (query: string) =>
  GET(new NextRequest(`${ORIGIN}/auth/callback${query}`, { method: "GET" }));

/**
 * Asserts a redirect and returns where the browser would go: the Location is a
 * relative path, resolved against the page the user is on (the real origin —
 * which is NOT `request.nextUrl.origin`: Next rewrites loopback hosts such as
 * 127.0.0.1 to `localhost`, which is why the handler never builds an absolute URL).
 */
const expectRedirect = (response: Response, requestedFrom = ORIGIN) => {
  expect(response.status).toBe(303);
  const location = response.headers.get("location");
  expect(location).not.toBeNull();
  expect(location!.startsWith("/")).toBe(true);
  expect(location!.startsWith("//")).toBe(false);
  return new URL(location!, requestedFrom);
};

const loggedText = () =>
  JSON.stringify([
    ...vi.mocked(console.error).mock.calls,
    ...vi.mocked(console.warn).mock.calls,
  ]);

const TOKEN_HASH = "pbkdf2-secret-token-hash";
const NEW_EMAIL = "jane.new@example.com";

beforeEach(() => {
  vi.clearAllMocks();
  service.confirmEmail.mockResolvedValue({ ok: true });
  service.confirmEmailWithTokenHash.mockResolvedValue({ ok: true });
  service.confirmEmailChangeWithTokenHash.mockResolvedValue({
    status: "confirmed",
    userId: "user-1",
    email: NEW_EMAIL,
  });
  session.getCurrentUser.mockResolvedValue({ id: "user-1" });
  activity.recordAccountActivity.mockResolvedValue({ ok: true, id: 1 });
  vi.spyOn(console, "error").mockImplementation(() => {});
  vi.spyOn(console, "warn").mockImplementation(() => {});
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe("GET /auth/callback – successful confirmation", () => {
  it("exchanges the code and sends the user to the dashboard", async () => {
    const location = expectRedirect(await get(`?code=${CODE}`));

    expect(location.origin).toBe(ORIGIN);
    expect(location.pathname).toBe("/dashboard");
    expect(location.search).toBe("");
    expect(service.confirmEmail).toHaveBeenCalledWith(CODE);
  });

  it("redirects with 303 (always followed with a GET) and forbids caching", async () => {
    const response = await get(`?code=${CODE}`);

    expect(response.status).toBe(303);
    expect(response.headers.get("cache-control")).toBe("no-store");
  });

  it("does not echo the code into the destination", async () => {
    const location = expectRedirect(await get(`?code=${CODE}`));

    expect(location.href).not.toContain(CODE);
  });

  it("honours a same-origin ?next= path", async () => {
    const location = expectRedirect(
      await get(`?code=${CODE}&next=${encodeURIComponent("/pricing?checkout=success")}`),
    );

    expect(location.origin).toBe(ORIGIN);
    expect(location.pathname).toBe("/pricing");
    expect(location.search).toBe("?checkout=success");
  });

  it("uses a relative Location, so the browser stays on the exact host it is on (127.0.0.1 stays 127.0.0.1)", async () => {
    // Next's NextURL canonicalises 127.0.0.1 to localhost; an absolute redirect
    // built from it would move the user to a host where the session cookies are
    // not sent. Pin that the handler never does that.
    const response = await get(`?code=${CODE}`);

    expect(response.headers.get("location")).toBe("/dashboard");
    expect(expectRedirect(response, "http://127.0.0.1:3000").host).toBe("127.0.0.1:3000");
    expect(expectRedirect(response, "https://app.example.com").host).toBe(
      "app.example.com",
    );
  });

  it("never takes the destination host from the request (a forged Host header cannot steer it)", async () => {
    const response = await GET(
      new NextRequest(`https://evil.example/auth/callback?code=${CODE}`, {
        headers: { host: "evil.example" },
      }),
    );

    expect(response.headers.get("location")).toBe("/dashboard");
  });
});

describe("GET /auth/callback – open redirects are refused", () => {
  it.each([
    ["absolute URL", "https://evil.example/phish"],
    ["scheme-relative", "//evil.example"],
    ["backslash", "/\\evil.example"],
    ["dot-segments to scheme-relative", "/..//evil.example"],
    ["javascript:", "javascript:alert(1)"],
    ["relative reference", "dashboard"],
    ["empty", ""],
  ])("falls back to the dashboard for next=%s", async (_label, next) => {
    const location = expectRedirect(
      await get(`?code=${CODE}&next=${encodeURIComponent(next)}`),
    );

    expect(location.origin).toBe(ORIGIN);
    expect(location.pathname).toBe("/dashboard");
  });

  it("ignores ?next= entirely on failure (the user goes to the login page)", async () => {
    service.confirmEmail.mockResolvedValue({
      ok: false,
      failure: CONFIRMATION_FAILURES.expired,
    });

    const location = expectRedirect(
      await get(`?code=${CODE}&next=${encodeURIComponent("/pricing")}`),
    );

    expect(location.pathname).toBe("/login");
    expect(location.searchParams.get("confirmation")).toBe("expired");
  });
});

describe("GET /auth/callback – failed confirmation", () => {
  it.each([
    CONFIRMATION_FAILURES.expired,
    CONFIRMATION_FAILURES.invalid,
    CONFIRMATION_FAILURES.unavailable,
  ])("sends the user to the login page with ?confirmation=%s", async (failure) => {
    service.confirmEmail.mockResolvedValue({ ok: false, failure });

    const location = expectRedirect(await get(`?code=${CODE}`));

    expect(location.origin).toBe(ORIGIN);
    expect(location.pathname).toBe("/login");
    expect(location.searchParams.get("confirmation")).toBe(failure);
    expect(location.href).not.toContain(CODE);
  });

  it("does not expose anything but the reason token in the destination", async () => {
    service.confirmEmail.mockResolvedValue({
      ok: false,
      failure: CONFIRMATION_FAILURES.invalid,
    });

    const location = expectRedirect(await get(`?code=${CODE}`));

    expect([...location.searchParams.keys()]).toEqual(["confirmation"]);
  });
});

describe("GET /auth/callback – no code", () => {
  it("treats a bare request as an invalid link without contacting Supabase", async () => {
    const location = expectRedirect(await get(""));

    expect(location.pathname).toBe("/login");
    expect(location.searchParams.get("confirmation")).toBe("invalid");
    expect(service.confirmEmail).not.toHaveBeenCalled();
  });

  it("treats an empty code as missing", async () => {
    const location = expectRedirect(await get("?code="));

    expect(location.searchParams.get("confirmation")).toBe("invalid");
    expect(service.confirmEmail).not.toHaveBeenCalled();
  });

  it("recognises Supabase reporting an expired link instead of issuing a code", async () => {
    // GoTrue's redirect when the verify step fails.
    const location = expectRedirect(
      await get(
        "?error=access_denied&error_code=otp_expired&error_description=Email+link+is+invalid+or+has+expired",
      ),
    );

    expect(location.pathname).toBe("/login");
    expect(location.searchParams.get("confirmation")).toBe("expired");
    expect(service.confirmEmail).not.toHaveBeenCalled();
  });

  it("treats any other Supabase-reported error as an invalid link", async () => {
    const location = expectRedirect(
      await get("?error=access_denied&error_code=unexpected_failure&error_description=x"),
    );

    expect(location.searchParams.get("confirmation")).toBe("invalid");
  });

  it("never forwards Supabase's error_description (untrusted input) to the login page", async () => {
    const description = encodeURIComponent("<img src=x onerror=alert(1)> SECRET");
    const location = expectRedirect(
      await get(
        `?error=access_denied&error_code=otp_expired&error_description=${description}`,
      ),
    );

    expect(location.href).not.toContain("SECRET");
    expect(location.href).not.toContain("onerror");
    expect([...location.searchParams.keys()]).toEqual(["confirmation"]);
    expect(loggedText()).not.toContain("SECRET");
  });

  it("still refuses an open redirect when there is no code", async () => {
    const location = expectRedirect(
      await get(`?next=${encodeURIComponent("https://evil.example")}`),
    );

    expect(location.origin).toBe(ORIGIN);
    expect(location.pathname).toBe("/login");
  });
});

describe("GET /auth/callback – unexpected failures (last line of defence)", () => {
  it("lands on the login page as unavailable when confirmEmail itself rejects", async () => {
    // confirmEmail contains its own failures; this guards the route should that ever regress.
    service.confirmEmail.mockRejectedValue(new Error(`request failed for ${CODE}`));

    const location = expectRedirect(await get(`?code=${CODE}`));

    expect(location.pathname).toBe("/login");
    expect(location.searchParams.get("confirmation")).toBe("unavailable");
    expect(location.href).not.toContain(CODE);
  });

  it("logs only the error's name — never its message or the code", async () => {
    service.confirmEmail.mockRejectedValue(new Error(`request failed for ${CODE}`));

    await get(`?code=${CODE}`);

    expect(console.error).toHaveBeenCalledWith(
      "[auth] email confirmation route threw unexpectedly",
      { name: "Error" },
    );
    expect(loggedText()).not.toContain(CODE);
    expect(loggedText()).not.toContain("request failed");
  });

  it("copes with non-Error values being thrown", async () => {
    service.confirmEmail.mockRejectedValue("lock acquisition timed out");

    const location = expectRedirect(await get(`?code=${CODE}`));

    expect(location.searchParams.get("confirmation")).toBe("unavailable");
    expect(console.error).toHaveBeenCalledWith(expect.any(String), { name: "string" });
  });
});

describe("GET /auth/callback – token_hash links (the email template; also resent emails)", () => {
  it("verifies the hash and sends the user to the dashboard", async () => {
    const location = expectRedirect(await get(`?token_hash=${TOKEN_HASH}&type=signup`));

    expect(location.pathname).toBe("/dashboard");
    expect(service.confirmEmailWithTokenHash).toHaveBeenCalledWith(TOKEN_HASH, "signup");
    expect(service.confirmEmail).not.toHaveBeenCalled();
  });

  it("accepts Supabase's documented type=email as well", async () => {
    expectRedirect(await get(`?token_hash=${TOKEN_HASH}&type=email`));

    expect(service.confirmEmailWithTokenHash).toHaveBeenCalledWith(TOKEN_HASH, "email");
  });

  it.each(["recovery", "magiclink", "invite", "", undefined])(
    "refuses any other type (%s) as an invalid link without contacting Supabase",
    async (type) => {
      const query =
        type === undefined
          ? `?token_hash=${TOKEN_HASH}`
          : `?token_hash=${TOKEN_HASH}&type=${type}`;
      const location = expectRedirect(await get(query));

      expect(location.pathname).toBe("/login");
      expect(location.searchParams.get("confirmation")).toBe("invalid");
      expect(service.confirmEmailWithTokenHash).not.toHaveBeenCalled();
      expect(service.confirmEmail).not.toHaveBeenCalled();
    },
  );

  it("prefers token_hash when both it and a code are present", async () => {
    expectRedirect(await get(`?token_hash=${TOKEN_HASH}&type=signup&code=${CODE}`));

    expect(service.confirmEmailWithTokenHash).toHaveBeenCalledTimes(1);
    expect(service.confirmEmail).not.toHaveBeenCalled();
  });

  it("does not echo the hash into the destination, on success or failure", async () => {
    expect(
      expectRedirect(await get(`?token_hash=${TOKEN_HASH}&type=signup`)).href,
    ).not.toContain(TOKEN_HASH);

    service.confirmEmailWithTokenHash.mockResolvedValue({
      ok: false,
      failure: CONFIRMATION_FAILURES.expired,
    });
    const location = expectRedirect(await get(`?token_hash=${TOKEN_HASH}&type=signup`));
    expect(location.href).not.toContain(TOKEN_HASH);
    expect(location.pathname).toBe("/login");
    expect(location.searchParams.get("confirmation")).toBe("expired");
  });

  it("honours a same-origin ?next= and refuses an open redirect, same as for codes", async () => {
    expect(
      expectRedirect(
        await get(
          `?token_hash=${TOKEN_HASH}&type=signup&next=${encodeURIComponent("/pricing")}`,
        ),
      ).pathname,
    ).toBe("/pricing");
    expect(
      expectRedirect(
        await get(
          `?token_hash=${TOKEN_HASH}&type=signup&next=${encodeURIComponent("https://evil.example")}`,
        ),
      ).pathname,
    ).toBe("/dashboard");
  });

  it("still lands on the login page as unavailable when verification itself throws", async () => {
    service.confirmEmailWithTokenHash.mockRejectedValue(new Error(`boom ${TOKEN_HASH}`));

    const location = expectRedirect(await get(`?token_hash=${TOKEN_HASH}&type=signup`));

    expect(location.searchParams.get("confirmation")).toBe("unavailable");
    expect(loggedText()).not.toContain(TOKEN_HASH);
  });
});

describe("GET /auth/callback – email-change links (type=email_change)", () => {
  const link = `?token_hash=${TOKEN_HASH}&type=email_change`;

  it("verifies through the email-change service, not the sign-up one", async () => {
    await get(link);

    expect(service.confirmEmailChangeWithTokenHash).toHaveBeenCalledWith(TOKEN_HASH);
    expect(service.confirmEmailWithTokenHash).not.toHaveBeenCalled();
    expect(service.confirmEmail).not.toHaveBeenCalled();
  });

  it.each(["confirmed", "awaiting_other", "expired", "invalid", "unavailable"] as const)(
    "sends a signed-in browser to /settings?emailChange=%s",
    async (status) => {
      service.confirmEmailChangeWithTokenHash.mockResolvedValue({
        status,
        userId: status === "confirmed" ? "user-1" : null,
        email: status === "confirmed" ? NEW_EMAIL : null,
      });

      const location = expectRedirect(await get(link));

      expect(location.pathname).toBe("/settings");
      expect(location.searchParams.get("emailChange")).toBe(status);
      expect([...location.searchParams.keys()]).toEqual(["emailChange"]);
    },
  );

  it("sends a browser without a session to /login with the same status, so the message survives the guard", async () => {
    session.getCurrentUser.mockResolvedValue(null);
    service.confirmEmailChangeWithTokenHash.mockResolvedValue({
      status: "awaiting_other",
      userId: null,
      email: null,
    });

    const location = expectRedirect(await get(link));

    expect(location.pathname).toBe("/login");
    expect(location.searchParams.get("emailChange")).toBe("awaiting_other");
  });

  it("checks the session AFTER verifying, so a completed change (which signs the browser in) lands on /settings", async () => {
    const order: string[] = [];
    service.confirmEmailChangeWithTokenHash.mockImplementation(async () => {
      order.push("verify");
      return { status: "confirmed", userId: "user-1", email: NEW_EMAIL };
    });
    session.getCurrentUser.mockImplementation(async () => {
      order.push("session");
      return { id: "user-1" };
    });

    expectRedirect(await get(link));

    expect(order).toEqual(["verify", "session"]);
  });

  it("REGRESSION: a completed change is addressed to the account it belongs to, not to another account's stale session", async () => {
    // Shared browser: user-2's still-valid session cookie is present, user-1's
    // link completes but the new session could not be written. The status must
    // not be bound to user-2 — they would see "your email has been changed".
    service.confirmEmailChangeWithTokenHash.mockResolvedValue({
      status: "confirmed",
      userId: "user-1",
      email: NEW_EMAIL,
    });
    session.getCurrentUser.mockResolvedValue({ id: "user-2" });

    const response = await get(link);
    const location = expectRedirect(response);

    expect(location.pathname).toBe("/login"); // not user-2's /settings
    expect(location.searchParams.get("emailChange")).toBe("confirmed");
    expect(
      parseEmailChangeFlash(
        response.cookies.get("app-email-change")!.value,
        signingKeyFor(EMAIL_CHANGE_FLASH_KEY_PURPOSE),
      ),
    ).toMatchObject({ status: "confirmed", userId: null }); // unbound, never user-2
  });

  it("a completed change for the signed-in account itself is shown to them on /settings", async () => {
    service.confirmEmailChangeWithTokenHash.mockResolvedValue({
      status: "confirmed",
      userId: "user-1",
      email: NEW_EMAIL,
    });
    session.getCurrentUser.mockResolvedValue({ id: "user-1" });

    const location = expectRedirect(await get(link));

    expect(location.pathname).toBe("/settings");
  });

  it("never honours ?next= for email-change links (the user always returns to settings)", async () => {
    const location = expectRedirect(
      await get(`${link}&next=${encodeURIComponent("https://evil.example")}`),
    );

    expect(location.origin).toBe(ORIGIN);
    expect(location.pathname).toBe("/settings");
  });

  it("does not echo the hash into the destination", async () => {
    for (const status of ["confirmed", "expired"] as const) {
      service.confirmEmailChangeWithTokenHash.mockResolvedValue({
        status,
        userId: status === "confirmed" ? "user-1" : null,
        email: status === "confirmed" ? NEW_EMAIL : null,
      });

      expect(expectRedirect(await get(link)).href).not.toContain(TOKEN_HASH);
    }
  });

  it("lands as unavailable (on settings) when the service itself rejects, logging only the error's name", async () => {
    service.confirmEmailChangeWithTokenHash.mockRejectedValue(
      new TypeError(`broken ${TOKEN_HASH}`),
    );

    const location = expectRedirect(await get(link));

    expect(location.pathname).toBe("/settings");
    expect(location.searchParams.get("emailChange")).toBe("unavailable");
    expect(console.error).toHaveBeenCalledWith(
      "[auth] email change confirmation route threw unexpectedly",
      { name: "TypeError" },
    );
    expect(loggedText()).not.toContain(TOKEN_HASH);
  });

  it("sets the HttpOnly flash cookie that lets the destination believe the status, bound to the signed-in user", async () => {
    session.getCurrentUser.mockResolvedValue({ id: "user-1" });
    service.confirmEmailChangeWithTokenHash.mockResolvedValue({
      status: "confirmed",
      userId: "user-1",
      email: NEW_EMAIL,
    });
    const before = Math.floor(Date.now() / 1000);

    const response = await get(link);

    const cookie = response.cookies.get("app-email-change");
    expect(cookie).toBeDefined();
    // Signed: it verifies with the server's key and carries status + account + time.
    const flash = parseEmailChangeFlash(
      cookie!.value,
      signingKeyFor(EMAIL_CHANGE_FLASH_KEY_PURPOSE),
    );
    expect(flash).toMatchObject({ status: "confirmed", userId: "user-1" });
    expect(flash!.issuedAt).toBeGreaterThanOrEqual(before);
    // …and with no other key.
    expect(parseEmailChangeFlash(cookie!.value, Buffer.alloc(32, 1))).toBeNull();

    const header = response.headers.get("set-cookie")!;
    expect(header).toMatch(/app-email-change=/);
    expect(header).toMatch(/HttpOnly/i);
    expect(header).toMatch(/SameSite=lax/i);
    expect(header).toMatch(/Path=\//);
    expect(header).toMatch(/Max-Age=300/);
    expect(header).not.toMatch(/Secure/i); // the app URL here is plain http
    expect(header).not.toContain(TOKEN_HASH);
  });

  it("binds the flash cookie to 'no session' when the browser is sent to the login page", async () => {
    session.getCurrentUser.mockResolvedValue(null);
    service.confirmEmailChangeWithTokenHash.mockResolvedValue({
      status: "awaiting_other",
      userId: null,
      email: null,
    });

    const response = await get(link);

    expect(
      parseEmailChangeFlash(
        response.cookies.get("app-email-change")!.value,
        signingKeyFor(EMAIL_CHANGE_FLASH_KEY_PURPOSE),
      ),
    ).toMatchObject({ status: "awaiting_other", userId: null });
  });

  it.each(["expired", "invalid", "unavailable"] as const)(
    "sets a matching flash for the %s outcome too",
    async (status) => {
      service.confirmEmailChangeWithTokenHash.mockResolvedValue({
        status,
        userId: null,
        email: null,
      });

      const response = await get(link);

      expect(
        parseEmailChangeFlash(
          response.cookies.get("app-email-change")!.value,
          signingKeyFor(EMAIL_CHANGE_FLASH_KEY_PURPOSE),
        ),
      ).toMatchObject({ status, userId: "user-1" });
    },
  );

  it("sets no flash cookie for sign-up links (they have their own banner)", async () => {
    const response = await get(`?token_hash=${TOKEN_HASH}&type=signup`);

    expect(response.cookies.get("app-email-change")).toBeUndefined();
  });

  it("falls back to the login page when the session cannot be read", async () => {
    session.getCurrentUser.mockRejectedValue(new Error("cookies unavailable"));

    const location = expectRedirect(await get(link));

    expect(location.pathname).toBe("/login");
    expect(location.searchParams.get("emailChange")).toBe("confirmed");
  });

  it("treats an email-change type without a hash as a plain invalid link", async () => {
    const location = expectRedirect(await get("?type=email_change"));

    expect(location.pathname).toBe("/login");
    expect(location.searchParams.get("confirmation")).toBe("invalid");
    expect(service.confirmEmailChangeWithTokenHash).not.toHaveBeenCalled();
  });
});

describe("GET /auth/callback – email-change links record the change in the activity history", () => {
  const link = `?token_hash=${TOKEN_HASH}&type=email_change`;

  it("records email.changed for the account GoTrue returned, with its new address, once the change is complete", async () => {
    const location = expectRedirect(await get(link));

    expect(location.pathname).toBe("/settings");
    expect(activity.recordAccountActivity).toHaveBeenCalledTimes(1);
    expect(activity.recordAccountActivity).toHaveBeenCalledWith("user-1", {
      type: "email.changed",
      details: { to: NEW_EMAIL },
    });
  });

  it("records after verifying (never on the strength of the link alone)", async () => {
    const order: string[] = [];
    service.confirmEmailChangeWithTokenHash.mockImplementation(async () => {
      order.push("verify");
      return { status: "confirmed", userId: "user-1", email: NEW_EMAIL };
    });
    activity.recordAccountActivity.mockImplementation(async () => {
      order.push("record");
      return { ok: true, id: 1 };
    });

    await get(link);

    expect(order).toEqual(["verify", "record"]);
  });

  it("records for the account the change belongs to, even when the browser is signed in as someone else", async () => {
    session.getCurrentUser.mockResolvedValue({ id: "user-2" });

    await get(link);

    expect(activity.recordAccountActivity).toHaveBeenCalledWith(
      "user-1",
      expect.objectContaining({ type: "email.changed" }),
    );
  });

  it("records even when the new address could not be read from GoTrue's answer (the change still happened)", async () => {
    service.confirmEmailChangeWithTokenHash.mockResolvedValue({
      status: "confirmed",
      userId: "user-1",
      email: null,
    });

    await get(link);

    expect(activity.recordAccountActivity).toHaveBeenCalledWith("user-1", {
      type: "email.changed",
      details: { to: null },
    });
  });

  describe("REGRESSION: nothing is recorded unless the address actually changed", () => {
    it.each(["awaiting_other", "expired", "invalid", "unavailable"] as const)(
      "%s",
      async (status) => {
        service.confirmEmailChangeWithTokenHash.mockResolvedValue({
          status,
          userId: null,
          email: null,
        });

        await get(link);

        expect(activity.recordAccountActivity).not.toHaveBeenCalled();
      },
    );

    it("the first of two confirmations (double_confirm_changes) is not the change", async () => {
      service.confirmEmailChangeWithTokenHash.mockResolvedValue({
        status: "awaiting_other",
        userId: null,
        email: null,
      });

      const location = expectRedirect(await get(link));

      expect(location.searchParams.get("emailChange")).toBe("awaiting_other");
      expect(activity.recordAccountActivity).not.toHaveBeenCalled();
    });

    it("the service throwing", async () => {
      service.confirmEmailChangeWithTokenHash.mockRejectedValue(new Error("boom"));

      await get(link);

      expect(activity.recordAccountActivity).not.toHaveBeenCalled();
    });

    it("a confirmed status without an account to attribute it to", async () => {
      service.confirmEmailChangeWithTokenHash.mockResolvedValue({
        status: "confirmed",
        userId: null,
        email: NEW_EMAIL,
      });

      await get(link);

      expect(activity.recordAccountActivity).not.toHaveBeenCalled();
    });
  });

  describe("REGRESSION: a failure to record does not affect the completed change or where the user goes", () => {
    it("when the recorder reports a failure", async () => {
      activity.recordAccountActivity.mockResolvedValue({ ok: false });

      const response = await get(link);
      const location = expectRedirect(response);

      expect(location.pathname).toBe("/settings");
      expect(location.searchParams.get("emailChange")).toBe("confirmed");
      expect(
        parseEmailChangeFlash(
          response.cookies.get("app-email-change")!.value,
          signingKeyFor(EMAIL_CHANGE_FLASH_KEY_PURPOSE),
        ),
      ).toMatchObject({ status: "confirmed", userId: "user-1" });
      expect(console.error).not.toHaveBeenCalled(); // the recorder logs; the route adds nothing
    });

    it("when the recorder throws", async () => {
      activity.recordAccountActivity.mockRejectedValue(
        new Error(`activity store down for ${NEW_EMAIL}`),
      );

      const response = await get(link);
      const location = expectRedirect(response);

      expect(location.pathname).toBe("/settings");
      expect(location.searchParams.get("emailChange")).toBe("confirmed");
      expect(response.cookies.get("app-email-change")).toBeDefined();
      expect(console.error).toHaveBeenCalledWith(
        "[auth] email change could not be recorded in the activity history",
        { error: { name: "Error" } },
      );
      expect(loggedText()).not.toContain(NEW_EMAIL);
      expect(loggedText()).not.toContain(TOKEN_HASH);
    });
  });
});
