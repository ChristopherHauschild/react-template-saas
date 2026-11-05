// @vitest-environment node
import { AuthApiError, AuthRetryableFetchError } from "@supabase/supabase-js";
import { describe, expect, it } from "vitest";

import {
  describeResendConfirmationError,
  RESEND_CONFIRMATION_ERRORS,
} from "./resend-confirmation-errors";

const NEUTRAL = { kind: "neutral" };

describe("describeResendConfirmationError – answers that must not become an oracle", () => {
  it.each([
    [
      "over_email_send_rate_limit",
      429,
      "per-address max_frequency (checked after the lookup)",
    ],
    ["over_request_rate_limit", 429, "per-IP request limit"],
    ["user_not_found", 404, "unknown address"],
    ["email_exists", 422, "account state"],
    ["user_already_exists", 422, "account state"],
    ["email_not_confirmed", 400, "account state"],
    [
      "email_address_not_authorized",
      403,
      "built-in SMTP restriction (only reached for a real account)",
    ],
  ])("%s (%i) → neutral: %s", (code, status) => {
    expect(describeResendConfirmationError(new AuthApiError("x", status, code))).toEqual(
      NEUTRAL,
    );
  });

  it("treats any HTTP 429 without a code as neutral too (older GoTrue)", () => {
    expect(
      describeResendConfirmationError(
        new AuthApiError("Too many requests", 429, undefined),
      ),
    ).toEqual(NEUTRAL);
  });
});

describe("describeResendConfirmationError – problems identical for every address", () => {
  it("reports a malformed email", () => {
    for (const code of ["validation_failed", "email_address_invalid"]) {
      expect(describeResendConfirmationError(new AuthApiError("x", 400, code))).toEqual({
        kind: "message",
        message: RESEND_CONFIRMATION_ERRORS.invalidEmail,
      });
    }
  });

  it("reports sign-up/email being disabled in the project as unavailable", () => {
    for (const code of ["email_provider_disabled", "signup_disabled"]) {
      expect(describeResendConfirmationError(new AuthApiError("x", 422, code))).toEqual({
        kind: "message",
        message: RESEND_CONFIRMATION_ERRORS.unavailable,
      });
    }
  });

  it("reports a network failure as unavailable, so the user retries instead of waiting for an email", () => {
    expect(
      describeResendConfirmationError(new AuthRetryableFetchError("fetch failed", 0)),
    ).toEqual({ kind: "message", message: RESEND_CONFIRMATION_ERRORS.unavailable });
  });

  it("falls back to unavailable for anything unrecognised", () => {
    expect(
      describeResendConfirmationError(
        new AuthApiError("Database error", 500, "unexpected_failure"),
      ),
    ).toEqual({ kind: "message", message: RESEND_CONFIRMATION_ERRORS.unavailable });
    expect(describeResendConfirmationError(new Error("boom"))).toEqual({
      kind: "message",
      message: RESEND_CONFIRMATION_ERRORS.unavailable,
    });
    expect(describeResendConfirmationError(undefined)).toEqual({
      kind: "message",
      message: RESEND_CONFIRMATION_ERRORS.unavailable,
    });
  });
});

describe("RESEND_CONFIRMATION_ERRORS", () => {
  it("has no message that mentions an account's existence or state", () => {
    for (const message of Object.values(RESEND_CONFIRMATION_ERRORS)) {
      expect(message).not.toMatch(
        /already|exists|registered|confirmed|not found|no account/i,
      );
    }
  });

  it("never echoes the raw Supabase message", () => {
    const raw = "SECRET internal detail from GoTrue";
    for (const code of [
      "validation_failed",
      "unexpected_failure",
      "over_email_send_rate_limit",
      undefined,
    ]) {
      expect(
        JSON.stringify(describeResendConfirmationError(new AuthApiError(raw, 400, code))),
      ).not.toContain("SECRET");
    }
  });
});
