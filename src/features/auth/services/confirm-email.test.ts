// @vitest-environment node
import { AuthApiError, AuthRetryableFetchError } from "@supabase/supabase-js";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { CONFIRMATION_FAILURES } from "./email-confirmation-errors";

// --- boundaries ---------------------------------------------------------------

type ExchangeResponse = {
  data: { user: { id: string } | null; session: { access_token: string } | null };
  error: { name: string; code?: string; status?: number } | null;
};

const supabase = vi.hoisted(() => ({
  exchangeCodeForSession: vi.fn<(code: string) => Promise<ExchangeResponse>>(),
  verifyOtp:
    vi.fn<(params: { token_hash: string; type: string }) => Promise<ExchangeResponse>>(),
}));
const infra = vi.hoisted(() => ({
  createClient: vi.fn<() => Promise<unknown>>(),
}));
vi.mock("@/infrastructure/auth/supabase/server", () => infra);

// The request's cookie store after the (mocked) client wrote the session. By
// default it holds the session GoTrue issued (`EXCHANGED`), encoded the way
// @supabase/ssr stores it; tests replace it to model a failed or stale write.
const jar = vi.hoisted(() => ({
  cookies: [] as { name: string; value: string }[],
}));
vi.mock("next/headers", () => ({
  cookies: vi.fn(async () => ({
    getAll: () => jar.cookies,
    get: (name: string) => jar.cookies.find((cookie) => cookie.name === name),
  })),
}));
const encodeSession = (session: object) =>
  "base64-" + Buffer.from(JSON.stringify(session)).toString("base64url");

import {
  confirmEmail,
  confirmEmailChangeWithTokenHash,
  confirmEmailWithTokenHash,
  EMAIL_CHANGE_TOKEN_HASH_TYPE,
  isTokenHashType,
  TOKEN_HASH_TYPES,
} from "./confirm-email";

// ------------------------------------------------------------------------------

const CODE = "0b6f1d2e-secret-one-time-code";

const EXCHANGED: ExchangeResponse = {
  data: { user: { id: "user-1" }, session: { access_token: "jwt" } },
  error: null,
};

const failed = (error: ExchangeResponse["error"]): ExchangeResponse => ({
  data: { user: null, session: null },
  error,
});

const loggedText = () =>
  JSON.stringify([
    ...vi.mocked(console.error).mock.calls,
    ...vi.mocked(console.warn).mock.calls,
  ]);

beforeEach(() => {
  vi.clearAllMocks();
  jar.cookies = [
    { name: "sb-project-auth-token", value: encodeSession(EXCHANGED.data.session!) },
  ];
  infra.createClient.mockResolvedValue({
    auth: {
      exchangeCodeForSession: supabase.exchangeCodeForSession,
      verifyOtp: supabase.verifyOtp,
    },
  });
  supabase.exchangeCodeForSession.mockResolvedValue(EXCHANGED);
  supabase.verifyOtp.mockResolvedValue(EXCHANGED);
  vi.spyOn(console, "error").mockImplementation(() => {});
  vi.spyOn(console, "warn").mockImplementation(() => {});
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe("confirmEmail – success", () => {
  it("exchanges the code through the cookie-backed server client and reports ok", async () => {
    await expect(confirmEmail(CODE)).resolves.toEqual({ ok: true });

    expect(infra.createClient).toHaveBeenCalledTimes(1);
    expect(supabase.exchangeCodeForSession).toHaveBeenCalledWith(CODE);
    expect(console.error).not.toHaveBeenCalled();
  });
});

describe("confirmEmail / confirmEmailWithTokenHash – only the ISSUED session in the cookies is a success", () => {
  const expectUnavailable = async () => {
    await expect(confirmEmailWithTokenHash("hash", "signup")).resolves.toEqual({
      ok: false,
      failure: CONFIRMATION_FAILURES.unavailable,
    });
    await expect(confirmEmail(CODE)).resolves.toEqual({
      ok: false,
      failure: CONFIRMATION_FAILURES.unavailable,
    });
    expect(console.error).toHaveBeenCalledWith(
      "[auth] email confirmation verified but the issued session is not in the cookies",
    );
  };

  it("reports unavailable when the store holds no session at all", async () => {
    jar.cookies = [{ name: "other-cookie", value: "x" }];

    await expectUnavailable();
  });

  it("REGRESSION: the PKCE verifier cookie alone does not count as a session", async () => {
    jar.cookies = [{ name: "sb-project-auth-token-code-verifier", value: "verifier" }];

    await expectUnavailable();
  });

  it("REGRESSION: a stale session cookie from an earlier sign-in does not count", async () => {
    // The browser still had an old (possibly long-revoked) session; the new one
    // was never written. Redirecting to the dashboard would bounce the user.
    jar.cookies = [
      {
        name: "sb-project-auth-token",
        value: encodeSession({
          access_token: "jwt-from-last-week",
          refresh_token: "rt-old",
        }),
      },
    ];

    await expectUnavailable();
  });

  it("accepts the issued session when it is stored chunked", async () => {
    const whole = encodeSession(EXCHANGED.data.session!);
    const cut = Math.ceil(whole.length / 2);
    jar.cookies = [
      { name: "sb-project-auth-token.0", value: whole.slice(0, cut) },
      { name: "sb-project-auth-token.1", value: whole.slice(cut) },
    ];

    await expect(confirmEmailWithTokenHash("hash", "signup")).resolves.toEqual({
      ok: true,
    });
  });

  it("accepts the issued session next to a stale one from another project", async () => {
    jar.cookies.push({
      name: "sb-other-auth-token",
      value: encodeSession({ access_token: "jwt-elsewhere" }),
    });

    await expect(confirmEmail(CODE)).resolves.toEqual({ ok: true });
  });

  it("never logs the access token it compares", async () => {
    jar.cookies = [];
    await confirmEmailWithTokenHash("hash", "signup");

    expect(loggedText()).not.toContain("jwt");
  });
});

describe("confirmEmail / confirmEmailWithTokenHash – no session is not a success", () => {
  const NO_SESSION: ExchangeResponse = {
    data: { user: { id: "user-1" }, session: null },
    error: null,
  };

  it("a code exchange that returns no error but no session → unavailable, logged", async () => {
    supabase.exchangeCodeForSession.mockResolvedValue(NO_SESSION);

    await expect(confirmEmail(CODE)).resolves.toEqual({
      ok: false,
      failure: CONFIRMATION_FAILURES.unavailable,
    });
    expect(console.error).toHaveBeenCalledWith(
      "[auth] email confirmation returned no session",
    );
    expect(loggedText()).not.toContain(CODE);
  });

  it("a token_hash verification that returns no session → unavailable, logged", async () => {
    supabase.verifyOtp.mockResolvedValue(NO_SESSION);

    await expect(confirmEmailWithTokenHash("hash", "signup")).resolves.toEqual({
      ok: false,
      failure: CONFIRMATION_FAILURES.unavailable,
    });
    expect(console.error).toHaveBeenCalledTimes(1);
  });

  it("a null data payload is handled the same way", async () => {
    supabase.exchangeCodeForSession.mockResolvedValue({
      data: null as unknown as ExchangeResponse["data"],
      error: null,
    });

    await expect(confirmEmail(CODE)).resolves.toMatchObject({ ok: false });
  });
});

describe("confirmEmail – link problems are classified, not logged", () => {
  it.each([
    ["flow_state_expired", CONFIRMATION_FAILURES.expired],
    ["otp_expired", CONFIRMATION_FAILURES.expired],
    ["flow_state_not_found", CONFIRMATION_FAILURES.invalid],
    ["bad_code_verifier", CONFIRMATION_FAILURES.invalid],
    ["pkce_code_verifier_not_found", CONFIRMATION_FAILURES.invalid],
    ["validation_failed", CONFIRMATION_FAILURES.invalid],
  ])("%s → %s", async (code, failure) => {
    supabase.exchangeCodeForSession.mockResolvedValue(
      failed(new AuthApiError("Link problem", 400, code)),
    );

    await expect(confirmEmail(CODE)).resolves.toEqual({ ok: false, failure });
    expect(console.error).not.toHaveBeenCalled();
    expect(console.warn).not.toHaveBeenCalled();
  });

  it("a reused link (second exchange of the same code) is reported as invalid", async () => {
    supabase.exchangeCodeForSession
      .mockResolvedValueOnce(EXCHANGED)
      .mockResolvedValueOnce(
        failed(
          new AuthApiError(
            "invalid flow state, no valid flow state found",
            404,
            "flow_state_not_found",
          ),
        ),
      );

    await expect(confirmEmail(CODE)).resolves.toEqual({ ok: true });
    await expect(confirmEmail(CODE)).resolves.toEqual({
      ok: false,
      failure: CONFIRMATION_FAILURES.invalid,
    });
  });
});

describe("confirmEmail – unexpected failures are contained and logged safely", () => {
  it("reports a Supabase outage as unavailable and logs it without the code", async () => {
    supabase.exchangeCodeForSession.mockResolvedValue(
      failed(new AuthRetryableFetchError("fetch failed", 0)),
    );

    await expect(confirmEmail(CODE)).resolves.toEqual({
      ok: false,
      failure: CONFIRMATION_FAILURES.unavailable,
    });
    expect(console.error).toHaveBeenCalledWith(
      "[auth] email confirmation failed unexpectedly",
      { name: "AuthRetryableFetchError", code: undefined, status: 0 },
    );
    expect(loggedText()).not.toContain(CODE);
  });

  it("reports an unrecognised auth error as unavailable and logs only name/code/status", async () => {
    supabase.exchangeCodeForSession.mockResolvedValue(
      failed(
        new AuthApiError(`Database error for code ${CODE}`, 500, "unexpected_failure"),
      ),
    );

    await expect(confirmEmail(CODE)).resolves.toEqual({
      ok: false,
      failure: CONFIRMATION_FAILURES.unavailable,
    });
    expect(console.error).toHaveBeenCalledWith(
      "[auth] email confirmation failed unexpectedly",
      { name: "AuthApiError", code: "unexpected_failure", status: 500 },
    );
    expect(loggedText()).not.toContain(CODE);
    expect(loggedText()).not.toContain("Database error");
  });

  it("returns unavailable when creating the Supabase client rejects", async () => {
    infra.createClient.mockRejectedValue(
      new Error("cookies() was called outside a request scope"),
    );

    await expect(confirmEmail(CODE)).resolves.toEqual({
      ok: false,
      failure: CONFIRMATION_FAILURES.unavailable,
    });
    expect(supabase.exchangeCodeForSession).not.toHaveBeenCalled();
    expect(console.error).toHaveBeenCalledWith(
      "[auth] email confirmation threw unexpectedly",
      {
        name: "Error",
      },
    );
  });

  it("returns unavailable when exchangeCodeForSession rejects instead of returning an error", async () => {
    supabase.exchangeCodeForSession.mockRejectedValue(
      new TypeError("Cannot read properties of undefined"),
    );

    await expect(confirmEmail(CODE)).resolves.toEqual({
      ok: false,
      failure: CONFIRMATION_FAILURES.unavailable,
    });
    expect(console.error).toHaveBeenCalledTimes(1);
  });

  it("copes with non-Error values being thrown", async () => {
    supabase.exchangeCodeForSession.mockRejectedValue("lock acquisition timed out");

    await expect(confirmEmail(CODE)).resolves.toEqual({
      ok: false,
      failure: CONFIRMATION_FAILURES.unavailable,
    });
    expect(console.error).toHaveBeenCalledWith(expect.any(String), { name: "string" });
  });

  it("logs only the error's name/code/status — never the message, stack, or the code", async () => {
    const leaky = new Error(
      `request failed: {"auth_code":"${CODE}","code_verifier":"pkce-secret"}`,
    );
    supabase.exchangeCodeForSession.mockRejectedValue(leaky);

    await confirmEmail(CODE);

    expect(console.error).toHaveBeenCalledWith(
      "[auth] email confirmation threw unexpectedly",
      {
        name: "Error",
      },
    );
    expect(loggedText()).not.toContain(CODE);
    expect(loggedText()).not.toContain("pkce-secret");
    expect(loggedText()).not.toContain("request failed");
  });

  it("still classifies a thrown Supabase AuthError as unavailable (thrown ≠ returned)", async () => {
    supabase.exchangeCodeForSession.mockRejectedValue(
      new AuthApiError("Database error querying schema", 500, "unexpected_failure"),
    );

    await expect(confirmEmail(CODE)).resolves.toEqual({
      ok: false,
      failure: CONFIRMATION_FAILURES.unavailable,
    });
    expect(console.error).toHaveBeenCalledWith(
      "[auth] email confirmation threw unexpectedly",
      {
        name: "AuthApiError",
        code: "unexpected_failure",
        status: 500,
      },
    );
  });
});

// --- token_hash links (the email template) --------------------------------------

const TOKEN_HASH = "pbkdf2-secret-token-hash";

describe("confirmEmailWithTokenHash – success", () => {
  it("verifies the hash through the cookie-backed server client and reports ok", async () => {
    await expect(confirmEmailWithTokenHash(TOKEN_HASH, "signup")).resolves.toEqual({
      ok: true,
    });

    expect(infra.createClient).toHaveBeenCalledTimes(1);
    expect(supabase.verifyOtp).toHaveBeenCalledWith({
      token_hash: TOKEN_HASH,
      type: "signup",
    });
    expect(supabase.exchangeCodeForSession).not.toHaveBeenCalled();
    expect(console.error).not.toHaveBeenCalled();
  });

  it("passes the type through (signup from this app's template, email from Supabase's docs)", async () => {
    for (const type of TOKEN_HASH_TYPES) {
      await confirmEmailWithTokenHash(TOKEN_HASH, type);
      expect(supabase.verifyOtp).toHaveBeenLastCalledWith({
        token_hash: TOKEN_HASH,
        type,
      });
    }
  });
});

describe("confirmEmailWithTokenHash – failures", () => {
  it("an expired or already-used link (Supabase cannot tell them apart: otp_expired) → expired", async () => {
    supabase.verifyOtp.mockResolvedValue(
      failed(
        new AuthApiError("Email link is invalid or has expired", 403, "otp_expired"),
      ),
    );

    await expect(confirmEmailWithTokenHash(TOKEN_HASH, "signup")).resolves.toEqual({
      ok: false,
      failure: CONFIRMATION_FAILURES.expired,
    });
    expect(console.error).not.toHaveBeenCalled();
  });

  it("a malformed hash → invalid", async () => {
    supabase.verifyOtp.mockResolvedValue(
      failed(new AuthApiError("bad token_hash", 400, "validation_failed")),
    );

    await expect(confirmEmailWithTokenHash(TOKEN_HASH, "signup")).resolves.toEqual({
      ok: false,
      failure: CONFIRMATION_FAILURES.invalid,
    });
  });

  it("an outage → unavailable, logged without the hash", async () => {
    supabase.verifyOtp.mockResolvedValue(
      failed(new AuthRetryableFetchError("fetch failed", 0)),
    );

    await expect(confirmEmailWithTokenHash(TOKEN_HASH, "signup")).resolves.toEqual({
      ok: false,
      failure: CONFIRMATION_FAILURES.unavailable,
    });
    expect(console.error).toHaveBeenCalledTimes(1);
    expect(loggedText()).not.toContain(TOKEN_HASH);
  });

  it("a thrown error is contained and logged without the hash", async () => {
    supabase.verifyOtp.mockRejectedValue(
      new Error(`request failed: {"token_hash":"${TOKEN_HASH}"}`),
    );

    await expect(confirmEmailWithTokenHash(TOKEN_HASH, "signup")).resolves.toEqual({
      ok: false,
      failure: CONFIRMATION_FAILURES.unavailable,
    });
    expect(console.error).toHaveBeenCalledWith(
      "[auth] email confirmation threw unexpectedly",
      {
        name: "Error",
      },
    );
    expect(loggedText()).not.toContain(TOKEN_HASH);
  });
});

describe("isTokenHashType", () => {
  it("accepts exactly signup and email", () => {
    expect(isTokenHashType("signup")).toBe(true);
    expect(isTokenHashType("email")).toBe(true);
  });

  it.each([
    "recovery",
    "magiclink",
    "email_change",
    "invite",
    "SIGNUP",
    "",
    null,
    undefined,
    1,
  ])("rejects %s (a confirmation link must not verify other token kinds)", (value) => {
    expect(isTokenHashType(value)).toBe(false);
  });
});

describe("confirmEmailChangeWithTokenHash – the two successful shapes", () => {
  const HASH = "pbkdf2-secret-email-change-hash";

  it("verifies the hash as type=email_change through the cookie-backed server client", async () => {
    await confirmEmailChangeWithTokenHash(HASH);

    expect(infra.createClient).toHaveBeenCalledTimes(1);
    expect(supabase.verifyOtp).toHaveBeenCalledWith({
      token_hash: HASH,
      type: EMAIL_CHANGE_TOKEN_HASH_TYPE,
    });
    expect(EMAIL_CHANGE_TOKEN_HASH_TYPE).toBe("email_change");
  });

  it("a session means the change is complete: confirmed, for the account GoTrue returned", async () => {
    await expect(confirmEmailChangeWithTokenHash(HASH)).resolves.toEqual({
      status: "confirmed",
      userId: "user-1",
      email: null,
    });
    expect(console.error).not.toHaveBeenCalled();
  });

  it("reports the account's new address alongside it, for the activity history", async () => {
    supabase.verifyOtp.mockResolvedValue({
      data: {
        user: { id: "user-1", email: "jane.new@example.com" } as never,
        session: { access_token: "jwt" },
      },
      error: null,
    });

    await expect(confirmEmailChangeWithTokenHash(HASH)).resolves.toEqual({
      status: "confirmed",
      userId: "user-1",
      email: "jane.new@example.com",
    });
  });

  it("does not require the new session to be in the cookies: the change is complete server-side regardless", async () => {
    jar.cookies = []; // the write may have failed; the account's email changed anyway

    await expect(confirmEmailChangeWithTokenHash(HASH)).resolves.toMatchObject({
      status: "confirmed",
    });
  });

  it("no session and no error means the OTHER address still has to confirm — never 'confirmed'", async () => {
    // What Supabase answers for the first of two links when double confirmation is on.
    supabase.verifyOtp.mockResolvedValue({
      data: { user: null, session: null },
      error: null,
    });

    await expect(confirmEmailChangeWithTokenHash(HASH)).resolves.toEqual({
      status: "awaiting_other",
      userId: null,
      email: null,
    });
    // Routine, not an anomaly (unlike a session-less sign-up confirmation).
    expect(console.error).not.toHaveBeenCalled();
  });

  it("does not mistake GoTrue's first-link `{ msg }` body (which supabase-js puts where the user goes) for an account", async () => {
    supabase.verifyOtp.mockResolvedValue({
      data: {
        user: {
          msg: "Confirmation link accepted. Please proceed to confirm link sent to the other email",
        } as never,
        session: null,
      },
      error: null,
    });

    await expect(confirmEmailChangeWithTokenHash(HASH)).resolves.toEqual({
      status: "awaiting_other",
      userId: null,
      email: null,
    });
  });

  it("is not a sign-up link: email_change is not among the sign-up token types", () => {
    expect(isTokenHashType(EMAIL_CHANGE_TOKEN_HASH_TYPE)).toBe(false);
  });
});

describe("confirmEmailChangeWithTokenHash – failures", () => {
  const HASH = "pbkdf2-secret-email-change-hash";

  it("reports an expired or consumed link (Supabase's otp_expired covers both)", async () => {
    supabase.verifyOtp.mockResolvedValue(
      failed(
        new AuthApiError("Email link is invalid or has expired", 403, "otp_expired"),
      ),
    );

    await expect(confirmEmailChangeWithTokenHash(HASH)).resolves.toEqual({
      status: "expired",
      userId: null,
      email: null,
    });
    expect(console.error).not.toHaveBeenCalled();
  });

  it("reports a malformed hash as invalid", async () => {
    supabase.verifyOtp.mockResolvedValue(
      failed(new AuthApiError("Verify requires a token hash", 400, "validation_failed")),
    );

    await expect(confirmEmailChangeWithTokenHash(HASH)).resolves.toEqual({
      status: "invalid",
      userId: null,
      email: null,
    });
  });

  it("reports an outage as unavailable and logs it without the hash", async () => {
    supabase.verifyOtp.mockResolvedValue(
      failed(new AuthRetryableFetchError("fetch failed", 0)),
    );

    await expect(confirmEmailChangeWithTokenHash(HASH)).resolves.toEqual({
      status: "unavailable",
      userId: null,
      email: null,
    });
    expect(console.error).toHaveBeenCalledWith(
      "[auth] email change confirmation failed unexpectedly",
      { name: "AuthRetryableFetchError", code: undefined, status: 0 },
    );
    expect(loggedText()).not.toContain(HASH);
  });

  it("contains a thrown error as unavailable", async () => {
    infra.createClient.mockRejectedValue(new TypeError(`cookies broken ${HASH}`));

    await expect(confirmEmailChangeWithTokenHash(HASH)).resolves.toEqual({
      status: "unavailable",
      userId: null,
      email: null,
    });
    expect(console.error).toHaveBeenCalledWith(
      "[auth] email change confirmation threw unexpectedly",
      { name: "TypeError" },
    );
    expect(loggedText()).not.toContain(HASH);
  });
});
