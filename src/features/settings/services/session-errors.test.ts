// @vitest-environment node
import {
  AuthApiError,
  AuthRetryableFetchError,
  AuthSessionMissingError,
} from "@supabase/supabase-js";
import { describe, expect, it } from "vitest";

import { describeSessionRevocationError, SESSION_ERRORS } from "./session-errors";

describe("describeSessionRevocationError", () => {
  it("maps a missing or dead current session to 'sign in again'", () => {
    for (const error of [
      new AuthSessionMissingError(),
      new AuthApiError("x", 403, "session_not_found"),
      new AuthApiError("x", 401, "bad_jwt"),
      new AuthApiError("x", 400, "refresh_token_not_found"),
      new AuthApiError("x", 401, undefined),
      new AuthApiError("x", 403, undefined),
    ]) {
      expect(describeSessionRevocationError(error)).toBe(SESSION_ERRORS.sessionExpired);
    }
  });

  it("maps rate limiting", () => {
    expect(describeSessionRevocationError(new AuthApiError("x", 429, undefined))).toBe(
      SESSION_ERRORS.rateLimited,
    );
    expect(
      describeSessionRevocationError(
        new AuthApiError("x", 429, "over_request_rate_limit"),
      ),
    ).toBe(SESSION_ERRORS.rateLimited);
  });

  it("reports anything else as temporary", () => {
    for (const error of [
      new AuthApiError("x", 500, "unexpected_failure"),
      new AuthRetryableFetchError("x", 0),
      new TypeError("x"),
      undefined,
    ]) {
      expect(describeSessionRevocationError(error)).toBe(SESSION_ERRORS.unavailable);
    }
  });

  it("never claims that anything was signed out", () => {
    for (const message of Object.values(SESSION_ERRORS)) {
      expect(message).not.toMatch(/were signed out|have been signed out/);
    }
  });
});
