// @vitest-environment node
import {
  AuthApiError,
  AuthRetryableFetchError,
  AuthWeakPasswordError,
} from "@supabase/supabase-js";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  PASSWORD_MAX_LENGTH,
  PASSWORD_MIN_LENGTH,
  SIGN_UP_ERRORS,
} from "../services/sign-up-errors";

// --- boundaries ---------------------------------------------------------------

/** Next's redirect() throws; model that so tests can assert the destination. */
class RedirectSignal extends Error {
  constructor(public readonly url: string) {
    super(`NEXT_REDIRECT ${url}`);
  }
}

vi.mock("next/navigation", () => ({
  redirect: vi.fn((url: string) => {
    throw new RedirectSignal(url);
  }),
}));

vi.mock("@/config/env.client", () => ({
  clientEnv: {
    NEXT_PUBLIC_APP_URL: "https://app.example.com",
    NEXT_PUBLIC_SUPABASE_URL: "https://project.supabase.co",
    NEXT_PUBLIC_SUPABASE_ANON_KEY: "anon-key",
  },
}));

type SignUpArgs = {
  email: string;
  password: string;
  options?: { emailRedirectTo?: string };
};

/** The subset of supabase-js's AuthResponse the action reads. */
type SignUpResponse = {
  data: {
    user: { id: string; email?: string; identities?: unknown[] } | null;
    session: { access_token: string } | null;
  };
  error: { name: string; code?: string; status?: number } | null;
};

const supabase = vi.hoisted(() => ({
  signUp: vi.fn<(credentials: SignUpArgs) => Promise<SignUpResponse>>(),
}));
const infra = vi.hoisted(() => ({
  createClient: vi.fn<() => Promise<unknown>>(),
  sessionCookieFailure: vi.fn<
    () => { kind: "readonly" | "unexpected"; error: unknown; cookies: number } | null
  >(() => null),
}));
vi.mock("@/infrastructure/auth/supabase/server", () => infra);

import { signUp } from "./sign-up";

// ------------------------------------------------------------------------------

const form = (fields: Record<string, string | Blob>) => {
  const data = new FormData();
  for (const [name, value] of Object.entries(fields)) data.append(name, value);
  return data;
};

const EMAIL = "jane@example.com";
const PASSWORD = "correct-horse-battery";
const VALID = { email: EMAIL, password: PASSWORD, confirmPassword: PASSWORD };

/** What supabase-js returns when confirmations are disabled: a live session. */
const SIGNED_IN: SignUpResponse = {
  data: {
    user: { id: "user-1", email: EMAIL, identities: [{ provider: "email" }] },
    session: { access_token: "jwt" },
  },
  error: null,
};

/** Confirmations enabled, new address: user created, email sent, no session yet. */
const CONFIRMATION_SENT: SignUpResponse = {
  data: {
    user: { id: "user-1", email: EMAIL, identities: [{ provider: "email" }] },
    session: null,
  },
  error: null,
};

/**
 * Confirmations enabled, address already registered: GoTrue answers with a
 * placeholder user that has no identities and no session, and NO error, so the
 * response is indistinguishable (to a client) from a fresh sign-up.
 */
const OBFUSCATED_DUPLICATE: SignUpResponse = {
  data: {
    user: { id: "placeholder", email: EMAIL, identities: [] },
    session: null,
  },
  error: null,
};

const expectRedirect = async (promise: Promise<unknown>) => {
  await expect(promise).rejects.toBeInstanceOf(RedirectSignal);
  return promise.catch((e: RedirectSignal) => e.url);
};

const loggedText = () =>
  JSON.stringify([
    ...vi.mocked(console.error).mock.calls,
    ...vi.mocked(console.warn).mock.calls,
    ...vi.mocked(console.info).mock.calls,
    ...vi.mocked(console.log).mock.calls,
  ]);

beforeEach(() => {
  vi.clearAllMocks();
  infra.createClient.mockResolvedValue({ auth: { signUp: supabase.signUp } });
  supabase.signUp.mockResolvedValue(SIGNED_IN);
  vi.spyOn(console, "error").mockImplementation(() => {});
  vi.spyOn(console, "warn").mockImplementation(() => {});
  vi.spyOn(console, "info").mockImplementation(() => {});
  vi.spyOn(console, "log").mockImplementation(() => {});
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe("signUp – immediate session (email confirmations disabled)", () => {
  it("does not redirect when the session cookies could not be written; the account exists, so says sign-in is unavailable", async () => {
    infra.sessionCookieFailure.mockReturnValueOnce({
      kind: "unexpected",
      error: new TypeError("cookie store is broken"),
      cookies: 1,
    });

    await expect(signUp(null, form(VALID))).resolves.toEqual({
      status: "error",
      error: SIGN_UP_ERRORS.unavailable,
      email: EMAIL,
    });
    expect(console.error).toHaveBeenCalledWith(
      "[auth] sign-up could not persist the session",
      expect.objectContaining({ name: "TypeError" }),
    );
  });

  it("sends the new user to the dashboard", async () => {
    expect(await expectRedirect(signUp(null, form(VALID)))).toBe("/dashboard");
    expect(console.error).not.toHaveBeenCalled();
  });

  it("submits only email and password to Supabase, never the confirmation field", async () => {
    await expectRedirect(signUp(null, form(VALID)));

    expect(supabase.signUp).toHaveBeenCalledTimes(1);
    const [args] = supabase.signUp.mock.calls[0];
    expect(args.email).toBe(EMAIL);
    expect(args.password).toBe(PASSWORD);
    expect(args).not.toHaveProperty("confirmPassword");
    expect(JSON.stringify(args)).not.toContain("confirmPassword");
  });

  it("points the confirmation email at this app's auth callback (absolute URL)", async () => {
    await expectRedirect(signUp(null, form(VALID)));

    expect(supabase.signUp.mock.calls[0][0].options).toEqual({
      emailRedirectTo: "https://app.example.com/auth/callback",
    });
  });

  it("trims surrounding whitespace from the email but leaves the password untouched", async () => {
    await expectRedirect(
      signUp(
        null,
        form({
          email: `  ${EMAIL} `,
          password: " pass word 1 ",
          confirmPassword: " pass word 1 ",
        }),
      ),
    );

    expect(supabase.signUp.mock.calls[0][0]).toMatchObject({
      email: EMAIL,
      password: " pass word 1 ",
    });
  });

  it("does not swallow the redirect, which Next implements by throwing", async () => {
    expect(await expectRedirect(signUp(null, form(VALID)))).toBe("/dashboard");
    expect(console.error).not.toHaveBeenCalled();
  });
});

describe("signUp – confirmation required (email confirmations enabled)", () => {
  it("asks the user to check their inbox and keeps the email, without redirecting", async () => {
    supabase.signUp.mockResolvedValue(CONFIRMATION_SENT);

    await expect(signUp(null, form(VALID))).resolves.toEqual({
      status: "confirmation_required",
      email: EMAIL,
    });
    expect(console.error).not.toHaveBeenCalled();
  });

  it("decides on the session alone: a user object without a session is not signed in", async () => {
    supabase.signUp.mockResolvedValue({
      data: { user: { id: "user-1", email: EMAIL }, session: null },
      error: null,
    });

    await expect(signUp(null, form(VALID))).resolves.toMatchObject({
      status: "confirmation_required",
    });
  });
});

describe("signUp – an existing account is never revealed", () => {
  it("treats Supabase's obfuscated duplicate response exactly like a fresh sign-up", async () => {
    supabase.signUp.mockResolvedValue(OBFUSCATED_DUPLICATE);

    await expect(signUp(null, form(VALID))).resolves.toEqual({
      status: "confirmation_required",
      email: EMAIL,
    });
  });

  it.each(["user_already_exists", "email_exists"])(
    "folds a %s error (confirmations disabled) into the same confirmation-required result",
    async (code) => {
      supabase.signUp.mockResolvedValue({
        data: { user: null, session: null },
        error: new AuthApiError("User already registered", 422, code),
      });

      await expect(signUp(null, form(VALID))).resolves.toEqual({
        status: "confirmation_required",
        email: EMAIL,
      });
    },
  );

  it("folds the per-address email rate limit into the same result (it only fires for a registered, unconfirmed address)", async () => {
    supabase.signUp.mockResolvedValue({
      data: { user: null, session: null },
      error: new AuthApiError(
        "For security purposes, you can only request this after 47 seconds.",
        429,
        "over_email_send_rate_limit",
      ),
    });

    await expect(signUp(null, form(VALID))).resolves.toEqual({
      status: "confirmation_required",
      email: EMAIL,
    });
    expect(console.error).not.toHaveBeenCalled();
  });

  it("produces a result structurally identical for a new and an existing address", async () => {
    supabase.signUp.mockResolvedValueOnce(CONFIRMATION_SENT);
    const fresh = await signUp(null, form(VALID));

    supabase.signUp.mockResolvedValueOnce(OBFUSCATED_DUPLICATE);
    const obfuscated = await signUp(null, form(VALID));

    supabase.signUp.mockResolvedValueOnce({
      data: { user: null, session: null },
      error: new AuthApiError("User already registered", 422, "user_already_exists"),
    });
    const rejected = await signUp(null, form(VALID));

    expect(obfuscated).toEqual(fresh);
    expect(rejected).toEqual(fresh);
  });

  it("does not log the duplicate attempt (the only detail would be the email)", async () => {
    supabase.signUp.mockResolvedValue({
      data: { user: null, session: null },
      error: new AuthApiError("User already registered", 422, "user_already_exists"),
    });

    await signUp(null, form(VALID));

    expect(console.error).not.toHaveBeenCalled();
    expect(console.warn).not.toHaveBeenCalled();
    expect(loggedText()).not.toContain(EMAIL);
  });
});

describe("signUp – failures are returned, never thrown", () => {
  it("reports a weak password without Supabase's wording or reasons", async () => {
    supabase.signUp.mockResolvedValue({
      data: { user: null, session: null },
      error: new AuthWeakPasswordError(
        "Password should contain at least one character of each: abc, ABC, 123.",
        422,
        ["characters"],
      ),
    });

    const result = await signUp(null, form(VALID));

    expect(result).toEqual({
      status: "error",
      error: SIGN_UP_ERRORS.weakPassword,
      email: EMAIL,
    });
    expect(JSON.stringify(result)).not.toContain("abc, ABC, 123");
    expect(console.error).not.toHaveBeenCalled();
  });

  it("reports an email Supabase rejects as invalid", async () => {
    supabase.signUp.mockResolvedValue({
      data: { user: null, session: null },
      error: new AuthApiError("Email address is invalid", 400, "email_address_invalid"),
    });

    await expect(signUp(null, form(VALID))).resolves.toEqual({
      status: "error",
      error: SIGN_UP_ERRORS.invalidEmail,
      email: EMAIL,
    });
  });

  it("reports sign-up being disabled in the project", async () => {
    supabase.signUp.mockResolvedValue({
      data: { user: null, session: null },
      error: new AuthApiError(
        "Signups not allowed for this instance",
        422,
        "signup_disabled",
      ),
    });

    await expect(signUp(null, form(VALID))).resolves.toMatchObject({
      status: "error",
      error: SIGN_UP_ERRORS.signUpDisabled,
    });
  });

  it.each([
    ["over_request_rate_limit", 429],
    [undefined, 429],
  ])("reports per-IP rate limiting (code %s, status %s)", async (code, status) => {
    supabase.signUp.mockResolvedValue({
      data: { user: null, session: null },
      error: new AuthApiError("Rate limit exceeded", status, code),
    });

    await expect(signUp(null, form(VALID))).resolves.toMatchObject({
      status: "error",
      error: SIGN_UP_ERRORS.rateLimited,
    });
  });

  it("reports a Supabase outage as temporary and logs it without credentials", async () => {
    supabase.signUp.mockResolvedValue({
      data: { user: null, session: null },
      error: new AuthRetryableFetchError("fetch failed", 0),
    });

    await expect(signUp(null, form(VALID))).resolves.toEqual({
      status: "error",
      error: SIGN_UP_ERRORS.unavailable,
      email: EMAIL,
    });

    expect(console.error).toHaveBeenCalledTimes(1);
    expect(console.error).toHaveBeenCalledWith("[auth] sign-up failed unexpectedly", {
      name: "AuthRetryableFetchError",
      code: undefined,
      status: 0,
    });
    expect(loggedText()).not.toContain(PASSWORD);
    expect(loggedText()).not.toContain(EMAIL);
  });

  it("reports an unrecognised auth error as temporary and logs only its name/code/status", async () => {
    supabase.signUp.mockResolvedValue({
      data: { user: null, session: null },
      error: new AuthApiError(
        `Database error saving new user ${EMAIL}`,
        500,
        "unexpected_failure",
      ),
    });

    await expect(signUp(null, form(VALID))).resolves.toMatchObject({
      status: "error",
      error: SIGN_UP_ERRORS.unavailable,
    });
    expect(console.error).toHaveBeenCalledWith("[auth] sign-up failed unexpectedly", {
      name: "AuthApiError",
      code: "unexpected_failure",
      status: 500,
    });
    expect(loggedText()).not.toContain(EMAIL);
    expect(loggedText()).not.toContain("Database error");
  });

  it("never includes either password in the returned state", async () => {
    supabase.signUp.mockResolvedValue({
      data: { user: null, session: null },
      error: new AuthApiError("Password is too weak", 422, "weak_password"),
    });

    const result = await signUp(null, form(VALID));

    expect(JSON.stringify(result)).not.toContain(PASSWORD);
  });

  it("never echoes the raw Supabase message for any error", async () => {
    const raw = "SECRET internal detail from GoTrue";
    for (const code of [
      "weak_password",
      "validation_failed",
      "signup_disabled",
      "over_request_rate_limit",
      "unexpected_failure",
      undefined,
    ]) {
      supabase.signUp.mockResolvedValueOnce({
        data: { user: null, session: null },
        error: new AuthApiError(raw, 400, code),
      });

      expect(JSON.stringify(await signUp(null, form(VALID)))).not.toContain("SECRET");
    }
    expect(loggedText()).not.toContain("SECRET");
  });
});

describe("signUp – input validation (before contacting Supabase)", () => {
  const ok = (overrides: Partial<typeof VALID>) => ({ ...VALID, ...overrides });
  const LONG = "x".repeat(PASSWORD_MAX_LENGTH + 1);
  const JUST_SHORT = "x".repeat(PASSWORD_MIN_LENGTH - 1);

  it.each([
    [
      "missing email",
      { password: PASSWORD, confirmPassword: PASSWORD },
      "email",
      SIGN_UP_ERRORS.invalidEmail,
      "",
    ],
    ["empty email", ok({ email: "" }), "email", SIGN_UP_ERRORS.invalidEmail, ""],
    [
      "whitespace-only email",
      ok({ email: "   " }),
      "email",
      SIGN_UP_ERRORS.invalidEmail,
      "",
    ],
    [
      "malformed email",
      ok({ email: "not-an-email" }),
      "email",
      SIGN_UP_ERRORS.invalidEmail,
      "not-an-email",
    ],
    [
      "missing password",
      { email: EMAIL, confirmPassword: PASSWORD },
      "password",
      SIGN_UP_ERRORS.passwordTooShort,
      EMAIL,
    ],
    [
      "empty password",
      ok({ password: "", confirmPassword: "" }),
      "password",
      SIGN_UP_ERRORS.passwordTooShort,
      EMAIL,
    ],
    [
      `password of ${PASSWORD_MIN_LENGTH - 1} characters`,
      ok({ password: JUST_SHORT, confirmPassword: JUST_SHORT }),
      "password",
      SIGN_UP_ERRORS.passwordTooShort,
      EMAIL,
    ],
    [
      `password of ${PASSWORD_MAX_LENGTH + 1} characters`,
      ok({ password: LONG, confirmPassword: LONG }),
      "password",
      SIGN_UP_ERRORS.passwordTooLong,
      EMAIL,
    ],
    [
      "missing confirmation",
      { email: EMAIL, password: PASSWORD },
      "confirmPassword",
      SIGN_UP_ERRORS.passwordMismatch,
      EMAIL,
    ],
    [
      "empty confirmation",
      ok({ confirmPassword: "" }),
      "confirmPassword",
      SIGN_UP_ERRORS.passwordMismatch,
      EMAIL,
    ],
    [
      "mismatched confirmation",
      ok({ confirmPassword: `${PASSWORD}!` }),
      "confirmPassword",
      SIGN_UP_ERRORS.passwordMismatch,
      EMAIL,
    ],
    [
      "confirmation differing only in case",
      ok({ confirmPassword: PASSWORD.toUpperCase() }),
      "confirmPassword",
      SIGN_UP_ERRORS.passwordMismatch,
      EMAIL,
    ],
    [
      "confirmation differing only in whitespace",
      ok({ confirmPassword: `${PASSWORD} ` }),
      "confirmPassword",
      SIGN_UP_ERRORS.passwordMismatch,
      EMAIL,
    ],
  ])(
    "rejects %s, names the field and keeps the email",
    async (_label, fields, field, message, keptEmail) => {
      await expect(signUp(null, form(fields))).resolves.toEqual({
        status: "error",
        error: message,
        field,
        email: keptEmail,
      });
      expect(supabase.signUp).not.toHaveBeenCalled();
      expect(infra.createClient).not.toHaveBeenCalled();
    },
  );

  it("rejects a 7-character password and accepts an 8-character one (policy pinned literally)", async () => {
    await expect(
      signUp(
        null,
        form({ email: EMAIL, password: "abcdefg", confirmPassword: "abcdefg" }),
      ),
    ).resolves.toMatchObject({ status: "error", field: "password" });
    expect(supabase.signUp).not.toHaveBeenCalled();

    expect(
      await expectRedirect(
        signUp(
          null,
          form({ email: EMAIL, password: "abcdefgh", confirmPassword: "abcdefgh" }),
        ),
      ),
    ).toBe("/dashboard");
  });

  it("accepts a password of exactly the minimum and maximum length", async () => {
    for (const length of [PASSWORD_MIN_LENGTH, PASSWORD_MAX_LENGTH]) {
      const password = "p".repeat(length);

      expect(
        await expectRedirect(
          signUp(null, form({ email: EMAIL, password, confirmPassword: password })),
        ),
      ).toBe("/dashboard");
    }
  });

  it("reports one problem at a time, email first, so the user fixes fields in order", async () => {
    await expect(
      signUp(null, form({ email: "nope", password: "short", confirmPassword: "other" })),
    ).resolves.toMatchObject({ field: "email", error: SIGN_UP_ERRORS.invalidEmail });

    await expect(
      signUp(null, form({ email: EMAIL, password: "short", confirmPassword: "other" })),
    ).resolves.toMatchObject({
      field: "password",
      error: SIGN_UP_ERRORS.passwordTooShort,
    });
  });

  it("does not apply the mismatch check until the password itself is valid", async () => {
    await expect(
      signUp(null, form({ email: EMAIL, password: "short", confirmPassword: "short" })),
    ).resolves.toMatchObject({ field: "password" });
  });

  it("rejects non-text form values (e.g. a file) without contacting Supabase", async () => {
    const blob = new Blob(["x"], { type: "text/plain" });

    await expect(
      signUp(null, form({ email: blob, password: PASSWORD, confirmPassword: PASSWORD })),
    ).resolves.toMatchObject({ status: "error", field: "email", email: "" });
    await expect(
      signUp(null, form({ email: EMAIL, password: blob, confirmPassword: PASSWORD })),
    ).resolves.toMatchObject({ status: "error", field: "password" });
    await expect(
      signUp(null, form({ email: EMAIL, password: PASSWORD, confirmPassword: blob })),
    ).resolves.toMatchObject({ status: "error", field: "confirmPassword" });
    expect(supabase.signUp).not.toHaveBeenCalled();
  });

  it.each([
    "jane@intranet",
    "jane@localhost",
    "o'neil+tag@example.com",
    "jane.doe@sub.example.co.uk",
  ])("accepts every address the browser's type=email accepts, e.g. %s", async (email) => {
    expect(
      await expectRedirect(
        signUp(null, form({ email, password: PASSWORD, confirmPassword: PASSWORD })),
      ),
    ).toBe("/dashboard");
    expect(supabase.signUp.mock.calls[0][0]).toMatchObject({ email });
  });

  it("never includes either password in a validation error", async () => {
    const result = await signUp(
      null,
      form({ email: "nope", password: PASSWORD, confirmPassword: `${PASSWORD}2` }),
    );

    expect(JSON.stringify(result)).not.toContain(PASSWORD);
  });

  it("ignores the previous state (each submission is judged on its own)", async () => {
    const previous = {
      status: "error" as const,
      error: SIGN_UP_ERRORS.weakPassword,
      email: "old@example.com",
    };

    expect(await expectRedirect(signUp(previous, form(VALID)))).toBe("/dashboard");

    supabase.signUp.mockResolvedValue(CONFIRMATION_SENT);
    await expect(
      signUp({ status: "confirmation_required", email: "old@example.com" }, form(VALID)),
    ).resolves.toEqual({ status: "confirmation_required", email: EMAIL });
  });
});

describe("signUp – unexpected exceptions are contained (regression)", () => {
  it("returns the temporary-problem message when creating the Supabase client rejects", async () => {
    infra.createClient.mockRejectedValue(
      new Error("cookies() was called outside a request scope"),
    );

    await expect(signUp(null, form(VALID))).resolves.toEqual({
      status: "error",
      error: SIGN_UP_ERRORS.unavailable,
      email: EMAIL,
    });
    expect(supabase.signUp).not.toHaveBeenCalled();
    expect(console.error).toHaveBeenCalledTimes(1);
  });

  it("returns the temporary-problem message when signUp rejects instead of returning an error", async () => {
    // supabase-js only converts *auth* errors into `{ error }`; anything else is rethrown.
    supabase.signUp.mockRejectedValue(
      new TypeError("Cannot read properties of undefined"),
    );

    await expect(signUp(null, form(VALID))).resolves.toEqual({
      status: "error",
      error: SIGN_UP_ERRORS.unavailable,
      email: EMAIL,
    });
    expect(console.error).toHaveBeenCalledTimes(1);
  });

  it("copes with non-Error values being thrown", async () => {
    supabase.signUp.mockRejectedValue("lock acquisition timed out");

    await expect(signUp(null, form(VALID))).resolves.toMatchObject({
      status: "error",
      error: SIGN_UP_ERRORS.unavailable,
    });
    expect(console.error).toHaveBeenCalledWith(expect.any(String), { name: "string" });
  });

  it("logs only the error's name/code/status — never the message, stack, or credentials", async () => {
    // Worst case: the thrown error echoes the request, including the credentials.
    const leaky = new Error(
      `request failed: {"email":"${EMAIL}","password":"${PASSWORD}"}`,
    );
    supabase.signUp.mockRejectedValue(leaky);

    await signUp(null, form(VALID));

    expect(console.error).toHaveBeenCalledWith("[auth] sign-up threw unexpectedly", {
      name: "Error",
    });
    expect(loggedText()).not.toContain(PASSWORD);
    expect(loggedText()).not.toContain(EMAIL);
    expect(loggedText()).not.toContain("request failed");
  });

  it("still keeps the raw message out of the UI when the thrown error is a Supabase AuthError", async () => {
    supabase.signUp.mockRejectedValue(
      new AuthApiError("Database error querying schema", 500, "unexpected_failure"),
    );

    await expect(signUp(null, form(VALID))).resolves.toEqual({
      status: "error",
      error: SIGN_UP_ERRORS.unavailable,
      email: EMAIL,
    });
    expect(console.error).toHaveBeenCalledWith("[auth] sign-up threw unexpectedly", {
      name: "AuthApiError",
      code: "unexpected_failure",
      status: 500,
    });
  });

  it("does not let a thrown user_already_exists reveal the account either", async () => {
    // Thrown (not returned) errors take the generic path: still no enumeration.
    supabase.signUp.mockRejectedValue(
      new AuthApiError("User already registered", 422, "user_already_exists"),
    );

    const result = await signUp(null, form(VALID));

    expect(JSON.stringify(result)).not.toMatch(/already|exists|registered/i);
    expect(loggedText()).not.toContain(EMAIL);
  });
});
