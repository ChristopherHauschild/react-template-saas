// @vitest-environment node
import { AuthApiError, AuthRetryableFetchError } from "@supabase/supabase-js";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { RESEND_CONFIRMATION_ERRORS } from "../services/resend-confirmation-errors";

// --- boundaries ---------------------------------------------------------------

vi.mock("@/config/env.client", () => ({
  clientEnv: {
    NEXT_PUBLIC_APP_URL: "https://app.example.com",
    NEXT_PUBLIC_SUPABASE_URL: "https://project.supabase.co",
    NEXT_PUBLIC_SUPABASE_ANON_KEY: "anon-key",
  },
}));

type ResendArgs = {
  type: string;
  email: string;
  options?: { emailRedirectTo?: string };
};
type ResendResponse = {
  data: { user: null; session: null };
  error: { name: string; code?: string; status?: number } | null;
};

const supabase = vi.hoisted(() => ({
  resend: vi.fn<(args: ResendArgs) => Promise<ResendResponse>>(),
}));
const infra = vi.hoisted(() => ({
  createClient: vi.fn<() => Promise<unknown>>(),
}));
vi.mock("@/infrastructure/auth/supabase/server", () => infra);

import { resendConfirmation } from "./resend-confirmation";

// ------------------------------------------------------------------------------

const form = (fields: Record<string, string | Blob>) => {
  const data = new FormData();
  for (const [name, value] of Object.entries(fields)) data.append(name, value);
  return data;
};

const EMAIL = "jane@example.com";
const ACCEPTED: ResendResponse = { data: { user: null, session: null }, error: null };
const failed = (error: ResendResponse["error"]): ResendResponse => ({
  data: { user: null, session: null },
  error,
});
const SENT = { status: "sent", email: EMAIL };

const loggedText = () =>
  JSON.stringify([
    ...vi.mocked(console.error).mock.calls,
    ...vi.mocked(console.warn).mock.calls,
  ]);

beforeEach(() => {
  vi.clearAllMocks();
  infra.createClient.mockResolvedValue({ auth: { resend: supabase.resend } });
  supabase.resend.mockResolvedValue(ACCEPTED);
  vi.spyOn(console, "error").mockImplementation(() => {});
  vi.spyOn(console, "warn").mockImplementation(() => {});
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe("resendConfirmation – request", () => {
  it("asks Supabase for a sign-up confirmation, pointing the link at this app's callback", async () => {
    await expect(resendConfirmation(null, form({ email: EMAIL }))).resolves.toEqual(SENT);

    expect(supabase.resend).toHaveBeenCalledWith({
      type: "signup",
      email: EMAIL,
      options: { emailRedirectTo: "https://app.example.com/auth/callback" },
    });
  });

  it("trims the email", async () => {
    await resendConfirmation(null, form({ email: `  ${EMAIL} ` }));

    expect(supabase.resend.mock.calls[0][0].email).toBe(EMAIL);
  });

  it("never redirects: the result is always returned", async () => {
    await expect(resendConfirmation(null, form({ email: EMAIL }))).resolves.toEqual(SENT);
  });
});

describe("resendConfirmation – one answer regardless of account state", () => {
  it.each([
    ["accepted (unconfirmed account, email queued)", ACCEPTED],
    ["unknown address (Supabase answers 200)", ACCEPTED],
    ["already confirmed (Supabase answers 200)", ACCEPTED],
    [
      "per-address rate limit — only reachable for a real, unconfirmed account",
      failed(
        new AuthApiError(
          "For security purposes, you can only request this after 52 seconds.",
          429,
          "over_email_send_rate_limit",
        ),
      ),
    ],
    [
      "per-IP rate limit",
      failed(new AuthApiError("Rate limit", 429, "over_request_rate_limit")),
    ],
    ["429 without a code", failed(new AuthApiError("Too many requests", 429, undefined))],
    [
      "user_not_found (defensive)",
      failed(new AuthApiError("User not found", 404, "user_not_found")),
    ],
    [
      "email_exists (defensive)",
      failed(new AuthApiError("Email exists", 422, "email_exists")),
    ],
    [
      "email_not_confirmed (defensive)",
      failed(new AuthApiError("Not confirmed", 400, "email_not_confirmed")),
    ],
    [
      "recipient not authorised by built-in SMTP (only reachable for a real account)",
      failed(
        new AuthApiError(
          "Email address not authorized",
          403,
          "email_address_not_authorized",
        ),
      ),
    ],
  ])("%s → identical `sent` result", async (_label, response) => {
    supabase.resend.mockResolvedValue(response);

    await expect(resendConfirmation(null, form({ email: EMAIL }))).resolves.toEqual(SENT);
    expect(console.error).not.toHaveBeenCalled();
  });

  it("does not log rate limiting or account-state answers (the only detail would be the email)", async () => {
    for (const code of ["over_email_send_rate_limit", "user_not_found", "email_exists"]) {
      supabase.resend.mockResolvedValue(failed(new AuthApiError("x", 429, code)));

      await resendConfirmation(null, form({ email: EMAIL }));
    }

    expect(console.error).not.toHaveBeenCalled();
    expect(console.warn).not.toHaveBeenCalled();
  });

  it("warns operators about the SMTP restriction without logging the address", async () => {
    supabase.resend.mockResolvedValue(
      failed(
        new AuthApiError(
          `Email address "${EMAIL}" not authorized`,
          403,
          "email_address_not_authorized",
        ),
      ),
    );

    await resendConfirmation(null, form({ email: EMAIL }));

    expect(console.warn).toHaveBeenCalledTimes(1);
    expect(loggedText()).toContain("configure SMTP");
    expect(loggedText()).not.toContain(EMAIL);
    expect(loggedText()).not.toContain("not authorized");
  });
});

describe("resendConfirmation – problems identical for every address", () => {
  it.each([
    ["missing email", {}, ""],
    ["empty email", { email: "" }, ""],
    ["malformed email", { email: "not-an-email" }, "not-an-email"],
  ])(
    "rejects %s before contacting Supabase and keeps what was typed",
    async (_label, fields, kept) => {
      await expect(resendConfirmation(null, form(fields))).resolves.toEqual({
        status: "error",
        error: RESEND_CONFIRMATION_ERRORS.invalidEmail,
        email: kept,
      });
      expect(supabase.resend).not.toHaveBeenCalled();
      expect(infra.createClient).not.toHaveBeenCalled();
    },
  );

  it("rejects a non-text form value (e.g. a file)", async () => {
    await expect(
      resendConfirmation(null, form({ email: new Blob(["x"]) })),
    ).resolves.toMatchObject({ status: "error", email: "" });
    expect(supabase.resend).not.toHaveBeenCalled();
  });

  it("reports an email Supabase rejects as invalid", async () => {
    supabase.resend.mockResolvedValue(
      failed(new AuthApiError("Unable to validate email", 400, "validation_failed")),
    );

    await expect(resendConfirmation(null, form({ email: EMAIL }))).resolves.toEqual({
      status: "error",
      error: RESEND_CONFIRMATION_ERRORS.invalidEmail,
      email: EMAIL,
    });
  });

  it("reports a network failure as unavailable (not as sent) and logs it without the address", async () => {
    supabase.resend.mockResolvedValue(
      failed(new AuthRetryableFetchError("fetch failed", 0)),
    );

    await expect(resendConfirmation(null, form({ email: EMAIL }))).resolves.toEqual({
      status: "error",
      error: RESEND_CONFIRMATION_ERRORS.unavailable,
      email: EMAIL,
    });
    expect(console.error).toHaveBeenCalledWith(
      "[auth] resend confirmation failed unexpectedly",
      {
        name: "AuthRetryableFetchError",
        code: undefined,
        status: 0,
      },
    );
    expect(loggedText()).not.toContain(EMAIL);
  });

  it("reports an unrecognised auth error as unavailable and logs only name/code/status", async () => {
    supabase.resend.mockResolvedValue(
      failed(
        new AuthApiError(
          `Error sending confirmation mail to ${EMAIL}`,
          500,
          "unexpected_failure",
        ),
      ),
    );

    await expect(resendConfirmation(null, form({ email: EMAIL }))).resolves.toMatchObject(
      {
        status: "error",
        error: RESEND_CONFIRMATION_ERRORS.unavailable,
      },
    );
    expect(console.error).toHaveBeenCalledWith(
      "[auth] resend confirmation failed unexpectedly",
      {
        name: "AuthApiError",
        code: "unexpected_failure",
        status: 500,
      },
    );
    expect(loggedText()).not.toContain(EMAIL);
  });
});

describe("resendConfirmation – unexpected exceptions are contained", () => {
  it("returns unavailable when creating the Supabase client rejects", async () => {
    infra.createClient.mockRejectedValue(
      new Error("cookies() was called outside a request scope"),
    );

    await expect(resendConfirmation(null, form({ email: EMAIL }))).resolves.toEqual({
      status: "error",
      error: RESEND_CONFIRMATION_ERRORS.unavailable,
      email: EMAIL,
    });
    expect(supabase.resend).not.toHaveBeenCalled();
    expect(console.error).toHaveBeenCalledWith(
      "[auth] resend confirmation threw unexpectedly",
      {
        name: "Error",
      },
    );
  });

  it("returns unavailable when resend rejects instead of returning an error", async () => {
    supabase.resend.mockRejectedValue(
      new TypeError("Cannot read properties of undefined"),
    );

    await expect(resendConfirmation(null, form({ email: EMAIL }))).resolves.toMatchObject(
      {
        status: "error",
        error: RESEND_CONFIRMATION_ERRORS.unavailable,
      },
    );
    expect(console.error).toHaveBeenCalledTimes(1);
  });

  it("copes with non-Error values being thrown", async () => {
    supabase.resend.mockRejectedValue("lock acquisition timed out");

    await expect(resendConfirmation(null, form({ email: EMAIL }))).resolves.toMatchObject(
      {
        status: "error",
      },
    );
    expect(console.error).toHaveBeenCalledWith(expect.any(String), { name: "string" });
  });

  it("logs only the error's name — never its message or the address", async () => {
    supabase.resend.mockRejectedValue(new Error(`request failed: {"email":"${EMAIL}"}`));

    await resendConfirmation(null, form({ email: EMAIL }));

    expect(loggedText()).not.toContain(EMAIL);
    expect(loggedText()).not.toContain("request failed");
  });

  it("ignores the previous state (each submission is judged on its own)", async () => {
    await expect(
      resendConfirmation(
        { status: "sent", email: "old@example.com" },
        form({ email: EMAIL }),
      ),
    ).resolves.toEqual(SENT);
    await expect(
      resendConfirmation(
        { status: "error", error: "x", email: "old@example.com" },
        form({ email: EMAIL }),
      ),
    ).resolves.toEqual(SENT);
  });
});
