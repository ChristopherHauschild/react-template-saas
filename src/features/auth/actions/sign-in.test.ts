// @vitest-environment node
import { AuthApiError, AuthRetryableFetchError } from "@supabase/supabase-js";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { SIGN_IN_ERRORS } from "../services/sign-in-errors";

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

const supabase = vi.hoisted(() => ({
  signInWithPassword:
    vi.fn<
      (credentials: {
        email: string;
        password: string;
      }) => Promise<{ error: { name: string; code?: string; status?: number } | null }>
    >(),
}));
const infra = vi.hoisted(() => ({
  createClient: vi.fn<() => Promise<unknown>>(),
  sessionCookieFailure: vi.fn<
    () => { kind: "readonly" | "unexpected"; error: unknown; cookies: number } | null
  >(() => null),
}));
vi.mock("@/infrastructure/auth/supabase/server", () => infra);

import { signIn } from "./sign-in";

// ------------------------------------------------------------------------------

const form = (fields: Record<string, string>) => {
  const data = new FormData();
  for (const [name, value] of Object.entries(fields)) data.append(name, value);
  return data;
};

const CREDENTIALS = { email: "jane@example.com", password: "correct-horse" };

const expectRedirect = async (promise: Promise<unknown>) => {
  await expect(promise).rejects.toBeInstanceOf(RedirectSignal);
  return promise.catch((e: RedirectSignal) => e.url);
};

beforeEach(() => {
  vi.clearAllMocks();
  infra.createClient.mockResolvedValue({
    auth: { signInWithPassword: supabase.signInWithPassword },
  });
  supabase.signInWithPassword.mockResolvedValue({ error: null });
  vi.spyOn(console, "error").mockImplementation(() => {});
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe("signIn – success", () => {
  it("sends the user to the dashboard, not the site root", async () => {
    expect(await expectRedirect(signIn(null, form(CREDENTIALS)))).toBe("/dashboard");
    expect(supabase.signInWithPassword).toHaveBeenCalledWith(CREDENTIALS);
  });

  it("trims surrounding whitespace from the email but leaves the password untouched", async () => {
    await expectRedirect(
      signIn(null, form({ email: "  jane@example.com ", password: " pass word " })),
    );

    expect(supabase.signInWithPassword).toHaveBeenCalledWith({
      email: "jane@example.com",
      password: " pass word ",
    });
  });
});

describe("signIn – the session must reach the browser", () => {
  it("does not redirect when the session cookies could not be written; reports the problem and logs it", async () => {
    infra.sessionCookieFailure.mockReturnValueOnce({
      kind: "unexpected",
      error: new TypeError("cookie store is broken"),
      cookies: 1,
    });

    await expect(signIn(null, form(CREDENTIALS))).resolves.toEqual({
      error: SIGN_IN_ERRORS.unavailable,
      email: CREDENTIALS.email,
    });
    expect(console.error).toHaveBeenCalledWith(
      "[auth] sign-in could not persist the session",
      expect.objectContaining({ name: "TypeError" }),
    );
    expect(JSON.stringify(vi.mocked(console.error).mock.calls)).not.toContain("pass");
  });
});

describe("signIn – failures are returned, never thrown", () => {
  it("reports wrong credentials without the raw Supabase message and keeps the email", async () => {
    supabase.signInWithPassword.mockResolvedValue({
      error: new AuthApiError("Invalid login credentials", 400, "invalid_credentials"),
    });

    await expect(signIn(null, form(CREDENTIALS))).resolves.toEqual({
      error: SIGN_IN_ERRORS.invalidCredentials,
      email: "jane@example.com",
    });
    expect(console.error).not.toHaveBeenCalled();
  });

  it("asks the user to confirm their email when Supabase requires it, and flags that a new link can be requested for that address", async () => {
    supabase.signInWithPassword.mockResolvedValue({
      error: new AuthApiError("Email not confirmed", 400, "email_not_confirmed"),
    });

    await expect(signIn(null, form(CREDENTIALS))).resolves.toEqual({
      error: SIGN_IN_ERRORS.emailNotConfirmed,
      email: "jane@example.com",
      needsConfirmation: true,
    });
    expect(console.error).not.toHaveBeenCalled();
  });

  it("keeps the trimmed address in the unconfirmed result (what the resend form will submit)", async () => {
    supabase.signInWithPassword.mockResolvedValue({
      error: new AuthApiError("Email not confirmed", 400, "email_not_confirmed"),
    });

    await expect(
      signIn(null, form({ email: "  jane@example.com ", password: "x" })),
    ).resolves.toMatchObject({ email: "jane@example.com", needsConfirmation: true });
  });

  it.each([
    ["invalid_credentials", 400],
    ["over_request_rate_limit", 429],
    ["unexpected_failure", 500],
  ])(
    "does not offer a confirmation link for other failures (%s)",
    async (code, status) => {
      supabase.signInWithPassword.mockResolvedValue({
        error: new AuthApiError("x", status, code),
      });

      const result = await signIn(null, form(CREDENTIALS));

      expect(result).not.toBeNull();
      expect(result).not.toHaveProperty("needsConfirmation");
    },
  );

  it("reports rate limiting", async () => {
    supabase.signInWithPassword.mockResolvedValue({
      error: new AuthApiError(
        "Request rate limit reached",
        429,
        "over_request_rate_limit",
      ),
    });

    await expect(signIn(null, form(CREDENTIALS))).resolves.toMatchObject({
      error: SIGN_IN_ERRORS.rateLimited,
    });
  });

  it("reports a Supabase outage as temporary and logs it without credentials", async () => {
    supabase.signInWithPassword.mockResolvedValue({
      error: new AuthRetryableFetchError("fetch failed", 0),
    });

    await expect(signIn(null, form(CREDENTIALS))).resolves.toMatchObject({
      error: SIGN_IN_ERRORS.unavailable,
    });

    expect(console.error).toHaveBeenCalledTimes(1);
    const logged = JSON.stringify(vi.mocked(console.error).mock.calls[0]);
    expect(logged).not.toContain(CREDENTIALS.password);
    expect(logged).not.toContain(CREDENTIALS.email);
  });

  it("never includes the password in the returned state", async () => {
    supabase.signInWithPassword.mockResolvedValue({
      error: new AuthApiError("Invalid login credentials", 400, "invalid_credentials"),
    });

    const result = await signIn(null, form(CREDENTIALS));

    expect(JSON.stringify(result)).not.toContain(CREDENTIALS.password);
  });
});

describe("signIn – input validation (before contacting Supabase)", () => {
  it.each([
    ["missing email", { password: "x" }, ""],
    ["missing password", { email: "jane@example.com" }, "jane@example.com"],
    ["empty password", { email: "jane@example.com", password: "" }, "jane@example.com"],
    ["malformed email", { email: "not-an-email", password: "x" }, "not-an-email"],
  ])("rejects %s and keeps what was typed", async (_label, fields, keptEmail) => {
    await expect(signIn(null, form(fields))).resolves.toEqual({
      error: SIGN_IN_ERRORS.invalidInput,
      email: keptEmail,
    });
    expect(supabase.signInWithPassword).not.toHaveBeenCalled();
  });

  it.each([
    "jane@intranet",
    "jane@localhost",
    "o'neil+tag@example.com",
    "jane.doe@sub.example.co.uk",
  ])(
    "accepts every address the browser's type=email accepts, e.g. %s (regression)",
    async (email) => {
      expect(await expectRedirect(signIn(null, form({ email, password: "x" })))).toBe(
        "/dashboard",
      );
      expect(supabase.signInWithPassword).toHaveBeenCalledWith({ email, password: "x" });
    },
  );

  it("ignores the previous state (each submission is judged on its own)", async () => {
    const previous = {
      error: SIGN_IN_ERRORS.invalidCredentials,
      email: "old@example.com",
    };

    expect(await expectRedirect(signIn(previous, form(CREDENTIALS)))).toBe("/dashboard");
  });
});

describe("signIn – unexpected exceptions are contained (regression)", () => {
  const loggedText = () => JSON.stringify(vi.mocked(console.error).mock.calls);

  it("returns the temporary-problem message when creating the Supabase client rejects", async () => {
    infra.createClient.mockRejectedValue(
      new Error("cookies() was called outside a request scope"),
    );

    await expect(signIn(null, form(CREDENTIALS))).resolves.toEqual({
      error: SIGN_IN_ERRORS.unavailable,
      email: "jane@example.com",
    });
    expect(supabase.signInWithPassword).not.toHaveBeenCalled();
    expect(console.error).toHaveBeenCalledTimes(1);
  });

  it("returns the temporary-problem message when signInWithPassword rejects instead of returning an error", async () => {
    // supabase-js only converts *auth* errors into `{ error }`; anything else is rethrown.
    supabase.signInWithPassword.mockRejectedValue(
      new TypeError("Cannot read properties of undefined"),
    );

    await expect(signIn(null, form(CREDENTIALS))).resolves.toEqual({
      error: SIGN_IN_ERRORS.unavailable,
      email: "jane@example.com",
    });
    expect(console.error).toHaveBeenCalledTimes(1);
  });

  it("copes with non-Error values being thrown", async () => {
    supabase.signInWithPassword.mockRejectedValue("lock acquisition timed out");

    await expect(signIn(null, form(CREDENTIALS))).resolves.toMatchObject({
      error: SIGN_IN_ERRORS.unavailable,
    });
    expect(console.error).toHaveBeenCalledWith(expect.any(String), { name: "string" });
  });

  it("logs only the error's name/code/status — never the message, stack, or credentials", async () => {
    // Worst case: the thrown error echoes the request, including the credentials.
    const leaky = new Error(
      `request failed: {"email":"${CREDENTIALS.email}","password":"${CREDENTIALS.password}"}`,
    );
    supabase.signInWithPassword.mockRejectedValue(leaky);

    await signIn(null, form(CREDENTIALS));

    expect(console.error).toHaveBeenCalledWith("[auth] sign-in threw unexpectedly", {
      name: "Error",
    });
    expect(loggedText()).not.toContain(CREDENTIALS.password);
    expect(loggedText()).not.toContain(CREDENTIALS.email);
    expect(loggedText()).not.toContain("request failed");
  });

  it("still keeps the raw message out of the UI when the thrown error is a Supabase AuthError", async () => {
    supabase.signInWithPassword.mockRejectedValue(
      new AuthApiError("Database error querying schema", 500, "unexpected_failure"),
    );

    await expect(signIn(null, form(CREDENTIALS))).resolves.toEqual({
      error: SIGN_IN_ERRORS.unavailable,
      email: "jane@example.com",
    });
    expect(console.error).toHaveBeenCalledWith("[auth] sign-in threw unexpectedly", {
      name: "AuthApiError",
      code: "unexpected_failure",
      status: 500,
    });
  });

  it("does not swallow the redirect, which Next implements by throwing", async () => {
    // Success path: redirect() must still propagate out of the action.
    expect(await expectRedirect(signIn(null, form(CREDENTIALS)))).toBe("/dashboard");
    expect(console.error).not.toHaveBeenCalled();
  });

  it("leaves the action usable for a retry after an exception", async () => {
    supabase.signInWithPassword.mockRejectedValueOnce(new Error("transient"));

    const first = await signIn(null, form(CREDENTIALS));
    expect(first).toMatchObject({ error: SIGN_IN_ERRORS.unavailable });

    expect(await expectRedirect(signIn(first, form(CREDENTIALS)))).toBe("/dashboard");
  });
});
