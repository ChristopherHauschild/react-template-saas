// @vitest-environment node
import {
  AuthApiError,
  AuthRetryableFetchError,
  AuthSessionMissingError,
  AuthWeakPasswordError,
} from "@supabase/supabase-js";
import { describe, expect, it } from "vitest";

import { PASSWORD_MAX_LENGTH, PASSWORD_MIN_LENGTH } from "@/config/passwordPolicy";

import {
  CHANGE_PASSWORD_ERRORS,
  describeCurrentPasswordError,
  describeUpdatePasswordError,
} from "./change-password-errors";

describe("CHANGE_PASSWORD_ERRORS", () => {
  it("states the real length limits", () => {
    expect(CHANGE_PASSWORD_ERRORS.passwordTooShort).toContain(
      String(PASSWORD_MIN_LENGTH),
    );
    expect(CHANGE_PASSWORD_ERRORS.passwordTooLong).toContain(String(PASSWORD_MAX_LENGTH));
  });

  it("has distinct messages, so a test or a user can tell the failures apart", () => {
    const messages = Object.values(CHANGE_PASSWORD_ERRORS);

    expect(new Set(messages).size).toBe(messages.length);
  });
});

describe("describeCurrentPasswordError (the sign-in check)", () => {
  it.each(["invalid_credentials", "validation_failed"])(
    "pins %s to the current-password field",
    (code) => {
      expect(describeCurrentPasswordError(new AuthApiError("x", 400, code))).toEqual({
        message: CHANGE_PASSWORD_ERRORS.currentPasswordIncorrect,
        field: "currentPassword",
      });
    },
  );

  it("maps rate limiting by code or by status", () => {
    expect(
      describeCurrentPasswordError(new AuthApiError("x", 429, "over_request_rate_limit")),
    ).toEqual({ message: CHANGE_PASSWORD_ERRORS.rateLimited });
    expect(describeCurrentPasswordError(new AuthApiError("x", 429, undefined))).toEqual({
      message: CHANGE_PASSWORD_ERRORS.rateLimited,
    });
  });

  it("sends a banned user back to sign-in", () => {
    expect(
      describeCurrentPasswordError(new AuthApiError("x", 403, "user_banned")),
    ).toEqual({ message: CHANGE_PASSWORD_ERRORS.sessionExpired });
  });

  it.each([
    "email_not_confirmed",
    "email_provider_disabled",
    "unexpected_failure",
    undefined,
  ])(
    "reports %s as temporary (the user is signed in, so it is not about the input)",
    (code) => {
      expect(describeCurrentPasswordError(new AuthApiError("x", 400, code))).toEqual({
        message: CHANGE_PASSWORD_ERRORS.unavailable,
      });
    },
  );

  it("reports non-auth errors as temporary", () => {
    expect(describeCurrentPasswordError(new AuthRetryableFetchError("x", 0))).toEqual({
      message: CHANGE_PASSWORD_ERRORS.unavailable,
    });
    expect(describeCurrentPasswordError(new TypeError("fetch failed"))).toEqual({
      message: CHANGE_PASSWORD_ERRORS.unavailable,
    });
    expect(describeCurrentPasswordError(undefined)).toEqual({
      message: CHANGE_PASSWORD_ERRORS.unavailable,
    });
  });
});

describe("describeUpdatePasswordError (the password write)", () => {
  describe("weak passwords", () => {
    it("calls out a breached password specifically", () => {
      expect(
        describeUpdatePasswordError(
          new AuthWeakPasswordError("Password is known to be weak", 422, ["pwned"]),
        ),
      ).toEqual({
        message: CHANGE_PASSWORD_ERRORS.weakPasswordBreached,
        field: "newPassword",
      });
    });

    it("prefers the breach explanation when several reasons are given", () => {
      expect(
        describeUpdatePasswordError(
          new AuthWeakPasswordError("x", 422, ["characters", "pwned", "length"]),
        ).message,
      ).toBe(CHANGE_PASSWORD_ERRORS.weakPasswordBreached);
    });

    it("names the kinds of characters to try for a complexity failure", () => {
      expect(
        describeUpdatePasswordError(
          new AuthWeakPasswordError(
            "Password should contain at least one character of each: abcdefghijklmnopqrstuvwxyz, ABCDEFGHIJKLMNOPQRSTUVWXYZ, 0123456789.",
            422,
            ["characters"],
          ),
        ),
      ).toEqual({
        message: CHANGE_PASSWORD_ERRORS.weakPasswordCharacters,
        field: "newPassword",
      });
    });

    it("falls back to a generic message for a length reason or no reasons at all", () => {
      expect(
        describeUpdatePasswordError(new AuthWeakPasswordError("x", 422, ["length"])),
      ).toEqual({ message: CHANGE_PASSWORD_ERRORS.weakPassword, field: "newPassword" });
      expect(
        describeUpdatePasswordError(new AuthApiError("x", 422, "weak_password")),
      ).toEqual({ message: CHANGE_PASSWORD_ERRORS.weakPassword, field: "newPassword" });
    });

    it("treats GoTrue's own validation failure as being about the new password", () => {
      expect(
        describeUpdatePasswordError(
          new AuthApiError(
            "Password cannot be longer than 72 characters",
            422,
            "validation_failed",
          ),
        ),
      ).toEqual({ message: CHANGE_PASSWORD_ERRORS.weakPassword, field: "newPassword" });
    });
  });

  it("pins an unchanged password to the new-password field", () => {
    expect(
      describeUpdatePasswordError(new AuthApiError("x", 422, "same_password")),
    ).toEqual({
      message: CHANGE_PASSWORD_ERRORS.passwordUnchanged,
      field: "newPassword",
    });
  });

  it.each(["reauthentication_needed", "reauthentication_not_valid"])(
    "asks for a fresh sign-in when the project requires recent authentication (%s)",
    (code) => {
      expect(describeUpdatePasswordError(new AuthApiError("x", 400, code))).toEqual({
        message: CHANGE_PASSWORD_ERRORS.reauthenticationRequired,
      });
    },
  );

  it.each([
    "session_expired",
    "session_not_found",
    "refresh_token_not_found",
    "refresh_token_already_used",
    "bad_jwt",
    "user_not_found",
    "user_banned",
  ])("maps %s to 'sign in again'", (code) => {
    expect(describeUpdatePasswordError(new AuthApiError("x", 401, code))).toEqual({
      message: CHANGE_PASSWORD_ERRORS.sessionExpired,
    });
  });

  it("maps a 401 without a known code, and supabase-js's missing-session error, to 'sign in again'", () => {
    expect(describeUpdatePasswordError(new AuthApiError("x", 401, undefined))).toEqual({
      message: CHANGE_PASSWORD_ERRORS.sessionExpired,
    });
    expect(describeUpdatePasswordError(new AuthSessionMissingError())).toEqual({
      message: CHANGE_PASSWORD_ERRORS.sessionExpired,
    });
  });

  it("maps rate limiting by code or by status", () => {
    expect(
      describeUpdatePasswordError(new AuthApiError("x", 429, "over_request_rate_limit")),
    ).toEqual({ message: CHANGE_PASSWORD_ERRORS.rateLimited });
    expect(describeUpdatePasswordError(new AuthApiError("x", 429, undefined))).toEqual({
      message: CHANGE_PASSWORD_ERRORS.rateLimited,
    });
  });

  it("reports anything unrecognised as temporary", () => {
    expect(
      describeUpdatePasswordError(new AuthApiError("x", 500, "unexpected_failure")),
    ).toEqual({ message: CHANGE_PASSWORD_ERRORS.unavailable });
    expect(describeUpdatePasswordError(new AuthRetryableFetchError("x", 0))).toEqual({
      message: CHANGE_PASSWORD_ERRORS.unavailable,
    });
    expect(describeUpdatePasswordError("nope")).toEqual({
      message: CHANGE_PASSWORD_ERRORS.unavailable,
    });
  });

  it("never surfaces the raw Supabase message", () => {
    const raw = "SECRET hunter2 detail";

    for (const error of [
      new AuthWeakPasswordError(raw, 422, ["pwned"]),
      new AuthWeakPasswordError(raw, 422, ["characters"]),
      new AuthApiError(raw, 422, "same_password"),
      new AuthApiError(raw, 401, "session_expired"),
      new AuthApiError(raw, 500, "unexpected_failure"),
    ]) {
      expect(JSON.stringify(describeUpdatePasswordError(error))).not.toContain("SECRET");
      expect(JSON.stringify(describeUpdatePasswordError(error))).not.toContain("hunter2");
    }
  });
});
