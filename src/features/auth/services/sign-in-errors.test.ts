// @vitest-environment node
import { AuthApiError, AuthRetryableFetchError } from "@supabase/supabase-js";
import { describe, expect, it } from "vitest";

import { describeSignInError, SIGN_IN_ERRORS } from "./sign-in-errors";

// Shapes as produced by supabase-js for GoTrue responses: (message, status, code).
const RAW = "Invalid login credentials";

describe("describeSignInError", () => {
  it("maps a wrong email/password to one neutral message (no account enumeration)", () => {
    const message = describeSignInError(
      new AuthApiError(RAW, 400, "invalid_credentials"),
    );

    expect(message).toBe(SIGN_IN_ERRORS.invalidCredentials);
    expect(message).not.toContain(RAW);
  });

  it("treats a malformed email the same as wrong credentials", () => {
    expect(
      describeSignInError(
        new AuthApiError("Unable to validate email", 400, "validation_failed"),
      ),
    ).toBe(SIGN_IN_ERRORS.invalidCredentials);
    expect(
      describeSignInError(
        new AuthApiError("Email invalid", 400, "email_address_invalid"),
      ),
    ).toBe(SIGN_IN_ERRORS.invalidCredentials);
  });

  it("tells the user to confirm their email when Supabase requires it", () => {
    expect(
      describeSignInError(
        new AuthApiError("Email not confirmed", 400, "email_not_confirmed"),
      ),
    ).toBe(SIGN_IN_ERRORS.emailNotConfirmed);
  });

  it("recognises rate limiting by code or by HTTP 429", () => {
    expect(
      describeSignInError(
        new AuthApiError("Request rate limit reached", 429, "over_request_rate_limit"),
      ),
    ).toBe(SIGN_IN_ERRORS.rateLimited);
    // Older GoTrue versions respond 429 without a code.
    expect(
      describeSignInError(new AuthApiError("Too many requests", 429, undefined)),
    ).toBe(SIGN_IN_ERRORS.rateLimited);
  });

  it("reports a network failure reaching Supabase as a temporary problem", () => {
    expect(describeSignInError(new AuthRetryableFetchError("fetch failed", 0))).toBe(
      SIGN_IN_ERRORS.unavailable,
    );
  });

  it("falls back to the temporary-problem message for anything unrecognised", () => {
    expect(
      describeSignInError(new AuthApiError("Database error", 500, "unexpected_failure")),
    ).toBe(SIGN_IN_ERRORS.unavailable);
    expect(describeSignInError(new Error("boom"))).toBe(SIGN_IN_ERRORS.unavailable);
    expect(describeSignInError(undefined)).toBe(SIGN_IN_ERRORS.unavailable);
  });

  it("never echoes the raw Supabase message", () => {
    const raw = "SECRET internal detail from GoTrue";
    for (const code of [
      "invalid_credentials",
      "email_not_confirmed",
      "weak_password",
      undefined,
    ]) {
      expect(describeSignInError(new AuthApiError(raw, 400, code))).not.toContain(
        "SECRET",
      );
    }
  });
});
