// @vitest-environment node
import {
  AuthApiError,
  AuthRetryableFetchError,
  AuthWeakPasswordError,
} from "@supabase/supabase-js";
import { describe, expect, it } from "vitest";

import {
  describeSignUpError,
  PASSWORD_MAX_LENGTH,
  PASSWORD_MIN_LENGTH,
  SIGN_UP_ERRORS,
} from "./sign-up-errors";

// Shapes as produced by supabase-js for GoTrue responses: (message, status, code).
const RAW = "User already registered";

describe("password policy", () => {
  it("requires at least 8 characters (product requirement, pinned)", () => {
    expect(PASSWORD_MIN_LENGTH).toBe(8);
    expect(SIGN_UP_ERRORS.passwordTooShort).toBe(
      "Password must be at least 8 characters.",
    );
  });

  it("caps at bcrypt's 72-byte limit, which GoTrue enforces", () => {
    expect(PASSWORD_MAX_LENGTH).toBe(72);
    expect(SIGN_UP_ERRORS.passwordTooLong).toBe(
      "Password must be at most 72 characters.",
    );
  });
});

describe("describeSignUpError – duplicate accounts", () => {
  it.each([
    ["user_already_exists", 422],
    ["email_exists", 422],
    // Only reachable when an unconfirmed duplicate is re-sent its confirmation.
    ["over_email_send_rate_limit", 429],
  ])(
    "classifies %s (%i) as an existing account instead of producing a message",
    (code, status) => {
      expect(describeSignUpError(new AuthApiError(RAW, status, code))).toEqual({
        kind: "account_exists",
      });
    },
  );

  it("has no user-facing message that mentions an existing account", () => {
    for (const message of Object.values(SIGN_UP_ERRORS)) {
      expect(message).not.toMatch(/already|exists|registered|taken|in use/i);
    }
  });
});

describe("describeSignUpError – password", () => {
  it("reports a password Supabase deems weak without echoing its reasons", () => {
    const error = new AuthWeakPasswordError(
      "Password should contain at least one character of each: abc, ABC, 123.",
      422,
      ["characters"],
    );

    expect(describeSignUpError(error)).toEqual({
      kind: "message",
      message: SIGN_UP_ERRORS.weakPassword,
    });
  });

  it("also recognises weak_password when it arrives as a plain API error", () => {
    expect(
      describeSignUpError(new AuthApiError("Password is too weak", 422, "weak_password")),
    ).toEqual({ kind: "message", message: SIGN_UP_ERRORS.weakPassword });
  });
});

describe("describeSignUpError – email", () => {
  it("treats a malformed or rejected email as an invalid email", () => {
    expect(
      describeSignUpError(
        new AuthApiError("Unable to validate email", 400, "validation_failed"),
      ),
    ).toEqual({ kind: "message", message: SIGN_UP_ERRORS.invalidEmail });
    expect(
      describeSignUpError(
        new AuthApiError("Email address is invalid", 400, "email_address_invalid"),
      ),
    ).toEqual({ kind: "message", message: SIGN_UP_ERRORS.invalidEmail });
  });
});

describe("describeSignUpError – availability", () => {
  it("reports sign-up being switched off in the project", () => {
    expect(
      describeSignUpError(
        new AuthApiError("Signups not allowed", 422, "signup_disabled"),
      ),
    ).toEqual({ kind: "message", message: SIGN_UP_ERRORS.signUpDisabled });
    expect(
      describeSignUpError(
        new AuthApiError("Email signups are disabled", 422, "email_provider_disabled"),
      ),
    ).toEqual({ kind: "message", message: SIGN_UP_ERRORS.signUpDisabled });
  });

  it("recognises per-IP rate limiting by code or by HTTP 429 (checked before any lookup)", () => {
    expect(
      describeSignUpError(
        new AuthApiError("Request rate limit reached", 429, "over_request_rate_limit"),
      ),
    ).toEqual({ kind: "message", message: SIGN_UP_ERRORS.rateLimited });
    // Older GoTrue versions respond 429 without a code.
    expect(
      describeSignUpError(new AuthApiError("Too many requests", 429, undefined)),
    ).toEqual({ kind: "message", message: SIGN_UP_ERRORS.rateLimited });
  });

  it("reports a network failure reaching Supabase as a temporary problem", () => {
    expect(describeSignUpError(new AuthRetryableFetchError("fetch failed", 0))).toEqual({
      kind: "message",
      message: SIGN_UP_ERRORS.unavailable,
    });
  });

  it("reports an unauthorised recipient (built-in SMTP restriction) as temporary, not as the user's fault", () => {
    expect(
      describeSignUpError(
        new AuthApiError(
          "Email address not authorized",
          403,
          "email_address_not_authorized",
        ),
      ),
    ).toEqual({ kind: "message", message: SIGN_UP_ERRORS.unavailable });
  });

  it("falls back to the temporary-problem message for anything unrecognised", () => {
    expect(
      describeSignUpError(new AuthApiError("Database error", 500, "unexpected_failure")),
    ).toEqual({ kind: "message", message: SIGN_UP_ERRORS.unavailable });
    expect(describeSignUpError(new Error("boom"))).toEqual({
      kind: "message",
      message: SIGN_UP_ERRORS.unavailable,
    });
    expect(describeSignUpError(undefined)).toEqual({
      kind: "message",
      message: SIGN_UP_ERRORS.unavailable,
    });
  });
});

describe("describeSignUpError – never echoes the raw Supabase message", () => {
  it.each([
    "weak_password",
    "validation_failed",
    "signup_disabled",
    "over_request_rate_limit",
    "unexpected_failure",
    undefined,
  ])("for code %s", (code) => {
    const raw = "SECRET internal detail from GoTrue";
    const failure = describeSignUpError(new AuthApiError(raw, 400, code));

    expect(JSON.stringify(failure)).not.toContain("SECRET");
  });
});
