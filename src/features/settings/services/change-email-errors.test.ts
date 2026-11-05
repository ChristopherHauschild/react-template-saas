// @vitest-environment node
import {
  AuthApiError,
  AuthRetryableFetchError,
  AuthSessionMissingError,
} from "@supabase/supabase-js";
import { describe, expect, it } from "vitest";

import { CHANGE_EMAIL_ERRORS, describeChangeEmailError } from "./change-email-errors";

describe("CHANGE_EMAIL_ERRORS", () => {
  it("has distinct messages", () => {
    const messages = Object.values(CHANGE_EMAIL_ERRORS);

    expect(new Set(messages).size).toBe(messages.length);
  });

  it("never claims the address was changed", () => {
    for (const message of Object.values(CHANGE_EMAIL_ERRORS)) {
      expect(message).not.toMatch(/has been changed|was changed|is now/i);
    }
  });
});

describe("describeChangeEmailError", () => {
  it.each(["email_exists", "user_already_exists"])(
    "pins an address another account uses (%s) to the field",
    (code) => {
      expect(describeChangeEmailError(new AuthApiError("x", 422, code))).toEqual({
        message: CHANGE_EMAIL_ERRORS.emailTaken,
        field: "email",
      });
    },
  );

  it.each(["email_address_invalid", "validation_failed"])(
    "pins an address Supabase rejects (%s) to the field",
    (code) => {
      expect(describeChangeEmailError(new AuthApiError("x", 400, code))).toEqual({
        message: CHANGE_EMAIL_ERRORS.invalidEmail,
        field: "email",
      });
    },
  );

  it("tells the per-address send limit apart from general rate limiting", () => {
    expect(
      describeChangeEmailError(new AuthApiError("x", 429, "over_email_send_rate_limit")),
    ).toEqual({ message: CHANGE_EMAIL_ERRORS.tooSoon });
    expect(
      describeChangeEmailError(new AuthApiError("x", 429, "over_request_rate_limit")),
    ).toEqual({ message: CHANGE_EMAIL_ERRORS.rateLimited });
    expect(describeChangeEmailError(new AuthApiError("x", 429, undefined))).toEqual({
      message: CHANGE_EMAIL_ERRORS.rateLimited,
    });
  });

  it.each([
    "session_expired",
    "session_not_found",
    "bad_jwt",
    "user_not_found",
    "user_banned",
  ])("maps %s to 'sign in again'", (code) => {
    expect(describeChangeEmailError(new AuthApiError("x", 401, code))).toEqual({
      message: CHANGE_EMAIL_ERRORS.sessionExpired,
    });
  });

  it("maps a bare 401 and supabase-js's missing-session error to 'sign in again'", () => {
    expect(describeChangeEmailError(new AuthApiError("x", 401, undefined))).toEqual({
      message: CHANGE_EMAIL_ERRORS.sessionExpired,
    });
    expect(describeChangeEmailError(new AuthSessionMissingError())).toEqual({
      message: CHANGE_EMAIL_ERRORS.sessionExpired,
    });
  });

  it.each([
    "email_address_not_authorized",
    "email_provider_disabled",
    "unexpected_failure",
  ])("reports %s as temporary without blaming the address", (code) => {
    expect(describeChangeEmailError(new AuthApiError("x", 500, code))).toEqual({
      message: CHANGE_EMAIL_ERRORS.unavailable,
    });
  });

  it("reports non-auth errors as temporary", () => {
    expect(describeChangeEmailError(new AuthRetryableFetchError("x", 0))).toEqual({
      message: CHANGE_EMAIL_ERRORS.unavailable,
    });
    expect(describeChangeEmailError(new TypeError("x"))).toEqual({
      message: CHANGE_EMAIL_ERRORS.unavailable,
    });
    expect(describeChangeEmailError(undefined)).toEqual({
      message: CHANGE_EMAIL_ERRORS.unavailable,
    });
  });

  it("never surfaces the raw Supabase message", () => {
    const raw = "SECRET jane@example.com detail";

    for (const code of [
      "email_exists",
      "validation_failed",
      "unexpected_failure",
      undefined,
    ]) {
      expect(
        JSON.stringify(describeChangeEmailError(new AuthApiError(raw, 400, code))),
      ).not.toContain("SECRET");
    }
  });
});
