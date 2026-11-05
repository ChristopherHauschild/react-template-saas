// @vitest-environment node
import { AuthApiError, AuthRetryableFetchError } from "@supabase/supabase-js";
import { describe, expect, it } from "vitest";

import { PROFILE_NAME_MAX_LENGTH } from "./profile";
import {
  describeUpdateProfileError,
  UPDATE_PROFILE_ERRORS,
} from "./update-profile-errors";

describe("UPDATE_PROFILE_ERRORS", () => {
  it("states the real length limit in the too-long message", () => {
    expect(UPDATE_PROFILE_ERRORS.nameTooLong).toContain(String(PROFILE_NAME_MAX_LENGTH));
  });

  it("has distinct messages, so a test or a user can tell the failures apart", () => {
    const messages = Object.values(UPDATE_PROFILE_ERRORS);

    expect(new Set(messages).size).toBe(messages.length);
  });
});

describe("describeUpdateProfileError", () => {
  it.each([
    "session_expired",
    "session_not_found",
    "refresh_token_not_found",
    "refresh_token_already_used",
    "bad_jwt",
    "user_not_found",
    "user_banned",
  ])("maps %s to 'sign in again'", (code) => {
    expect(describeUpdateProfileError(new AuthApiError("x", 400, code))).toBe(
      UPDATE_PROFILE_ERRORS.sessionExpired,
    );
  });

  it("maps a 401 without a known code to 'sign in again'", () => {
    expect(describeUpdateProfileError(new AuthApiError("x", 401, undefined))).toBe(
      UPDATE_PROFILE_ERRORS.sessionExpired,
    );
  });

  it("recognises supabase-js's own 'no session' error by name (it has no code)", () => {
    const error = Object.assign(new Error("Auth session missing!"), {
      __isAuthError: true,
      name: "AuthSessionMissingError",
      status: 400,
      code: undefined,
    });

    expect(describeUpdateProfileError(error)).toBe(UPDATE_PROFILE_ERRORS.sessionExpired);
  });

  it("maps rate limiting by code or by status", () => {
    expect(
      describeUpdateProfileError(new AuthApiError("x", 429, "over_request_rate_limit")),
    ).toBe(UPDATE_PROFILE_ERRORS.rateLimited);
    expect(describeUpdateProfileError(new AuthApiError("x", 429, undefined))).toBe(
      UPDATE_PROFILE_ERRORS.rateLimited,
    );
  });

  it("reports anything unrecognised as temporary", () => {
    expect(
      describeUpdateProfileError(new AuthApiError("x", 500, "unexpected_failure")),
    ).toBe(UPDATE_PROFILE_ERRORS.unavailable);
    expect(
      describeUpdateProfileError(new AuthRetryableFetchError("fetch failed", 0)),
    ).toBe(UPDATE_PROFILE_ERRORS.unavailable);
  });

  it("reports non-auth errors and non-errors as temporary", () => {
    expect(describeUpdateProfileError(new TypeError("fetch failed"))).toBe(
      UPDATE_PROFILE_ERRORS.unavailable,
    );
    expect(describeUpdateProfileError("nope")).toBe(UPDATE_PROFILE_ERRORS.unavailable);
    expect(describeUpdateProfileError(undefined)).toBe(UPDATE_PROFILE_ERRORS.unavailable);
  });

  it("never surfaces the raw Supabase message", () => {
    const raw = "SECRET internal detail";

    for (const code of [
      "session_expired",
      "over_request_rate_limit",
      "unexpected_failure",
    ]) {
      expect(describeUpdateProfileError(new AuthApiError(raw, 400, code))).not.toContain(
        "SECRET",
      );
    }
  });
});
