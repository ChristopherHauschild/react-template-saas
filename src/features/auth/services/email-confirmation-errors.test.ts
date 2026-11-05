// @vitest-environment node
import { AuthApiError, AuthRetryableFetchError } from "@supabase/supabase-js";
import { describe, expect, it } from "vitest";

import {
  canRequestNewLink,
  CONFIRMATION_FAILURES,
  CONFIRMATION_QUERY_PARAM,
  confirmationFailurePath,
  describeExchangeError,
  describeRedirectErrorCode,
  parseConfirmationFailure,
} from "./email-confirmation-errors";

describe("describeExchangeError", () => {
  it.each(["flow_state_expired", "otp_expired"])(
    "classifies %s as an expired link",
    (code) => {
      expect(describeExchangeError(new AuthApiError("Expired", 400, code))).toBe(
        CONFIRMATION_FAILURES.expired,
      );
    },
  );

  it.each([
    ["flow_state_not_found", "unknown or already exchanged (reused link)"],
    ["bad_code_verifier", "verifier cookie belongs to another sign-up"],
    ["pkce_code_verifier_not_found", "opened in a different browser/device"],
    ["validation_failed", "malformed code"],
    ["bad_json", "malformed request"],
  ])("classifies %s as an invalid link (%s)", (code) => {
    expect(describeExchangeError(new AuthApiError("Rejected", 400, code))).toBe(
      CONFIRMATION_FAILURES.invalid,
    );
  });

  it("reports a network failure reaching Supabase as unavailable, not as a bad link", () => {
    expect(describeExchangeError(new AuthRetryableFetchError("fetch failed", 0))).toBe(
      CONFIRMATION_FAILURES.unavailable,
    );
  });

  it("falls back to unavailable for anything unrecognised", () => {
    expect(
      describeExchangeError(
        new AuthApiError("Database error", 500, "unexpected_failure"),
      ),
    ).toBe(CONFIRMATION_FAILURES.unavailable);
    expect(
      describeExchangeError(
        new AuthApiError("Too many requests", 429, "over_request_rate_limit"),
      ),
    ).toBe(CONFIRMATION_FAILURES.unavailable);
    expect(describeExchangeError(new Error("boom"))).toBe(
      CONFIRMATION_FAILURES.unavailable,
    );
    expect(describeExchangeError(undefined)).toBe(CONFIRMATION_FAILURES.unavailable);
  });

  it("never yields anything but one of the short, URL-safe reason tokens", () => {
    const raw = "SECRET internal detail from GoTrue";
    const allowed = Object.values(CONFIRMATION_FAILURES);

    for (const code of [
      "flow_state_expired",
      "flow_state_not_found",
      "unexpected_failure",
      undefined,
    ]) {
      const failure = describeExchangeError(new AuthApiError(raw, 400, code));

      expect(allowed).toContain(failure);
      expect(failure).toMatch(/^[a-z]+$/);
    }
  });
});

describe("describeRedirectErrorCode (Supabase rejected the link before issuing a code)", () => {
  it("recognises an expired link", () => {
    expect(describeRedirectErrorCode("otp_expired")).toBe(CONFIRMATION_FAILURES.expired);
  });

  it.each([null, "", "access_denied", "unexpected_failure", "<script>", "otp_expired "])(
    "treats anything else (%s) as an invalid link",
    (code) => {
      expect(describeRedirectErrorCode(code)).toBe(CONFIRMATION_FAILURES.invalid);
    },
  );
});

describe("confirmationFailurePath", () => {
  it("points at the login page with the reason as a query parameter", () => {
    expect(confirmationFailurePath(CONFIRMATION_FAILURES.expired)).toBe(
      `/login?${CONFIRMATION_QUERY_PARAM}=expired`,
    );
    expect(confirmationFailurePath(CONFIRMATION_FAILURES.invalid)).toBe(
      "/login?confirmation=invalid",
    );
    expect(confirmationFailurePath(CONFIRMATION_FAILURES.unavailable)).toBe(
      "/login?confirmation=unavailable",
    );
  });

  it("is a same-origin path (never an absolute URL)", () => {
    for (const failure of Object.values(CONFIRMATION_FAILURES)) {
      expect(confirmationFailurePath(failure)).toMatch(/^\/login\?/);
    }
  });
});

describe("parseConfirmationFailure (reading ?confirmation= back on the login page)", () => {
  it("round-trips every value confirmationFailurePath can produce", () => {
    for (const failure of Object.values(CONFIRMATION_FAILURES)) {
      expect(parseConfirmationFailure(failure)).toBe(failure);
    }
  });

  it.each([
    undefined,
    "",
    "ExPired", // not case-insensitive: only the exact tokens this app emits
    "success", // belongs to a different query parameter (?checkout=)
    "<script>alert(1)</script>",
    ["expired", "expired"], // Next passes a repeated query key as string[]
    ["expired"],
  ])("ignores anything that isn't exactly one known token: %j", (value) => {
    expect(parseConfirmationFailure(value as string | string[] | undefined)).toBeNull();
  });
});

describe("canRequestNewLink", () => {
  it("offers a new link for a dead one (expired/used, invalid)", () => {
    expect(canRequestNewLink(CONFIRMATION_FAILURES.expired)).toBe(true);
    expect(canRequestNewLink(CONFIRMATION_FAILURES.invalid)).toBe(true);
  });

  it("does not for an outage: the link the user has is probably fine", () => {
    expect(canRequestNewLink(CONFIRMATION_FAILURES.unavailable)).toBe(false);
  });
});
