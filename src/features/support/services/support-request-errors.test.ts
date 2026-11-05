// @vitest-environment node
import { describe, expect, it } from "vitest";

import {
  SUPPORT_REQUEST_RATE_LIMIT,
  SUPPORT_REQUEST_RATE_LIMITED_CODE,
} from "./support-request";
import {
  describeSupportRequestFailure,
  summarizeSupportRequestError,
  SUPPORT_REQUEST_ERRORS,
  toSupportRequestFailure,
} from "./support-request-errors";

describe("toSupportRequestFailure", () => {
  it.each([
    [SUPPORT_REQUEST_RATE_LIMITED_CODE, "rateLimited"],
    ["23514", "invalid"],
    ["42501", "sessionExpired"],
    ["23503", "sessionExpired"],
    ["23502", "sessionExpired"],
    ["PGRST301", "sessionExpired"],
    ["PGRST302", "sessionExpired"],
  ])("maps SQLSTATE %s to %s", (code, failure) => {
    expect(toSupportRequestFailure({ message: "…", code })).toBe(failure);
  });

  it.each([
    ["an unknown code", { code: "42P01" }],
    ["no code", { message: "network error" }],
    ["a non-string code", { code: 500 }],
    ["a thrown Error", new Error("fetch failed")],
    ["null", null],
    ["a string", "boom"],
    ["undefined", undefined],
  ])("falls back to unavailable for %s", (_label, error) => {
    expect(toSupportRequestFailure(error)).toBe("unavailable");
  });

  it("never decides on the message text", () => {
    // A message mentioning a limit, but a code that does not: the code wins.
    expect(
      toSupportRequestFailure({ message: "Too many support requests", code: "42P01" }),
    ).toBe("unavailable");
  });
});

describe("describeSupportRequestFailure", () => {
  it.each([
    "invalid",
    "rateLimited",
    "sessionExpired",
    "accountChanged",
    "unavailable",
  ] as const)("has a message for %s", (failure) => {
    const message = describeSupportRequestFailure(failure);

    expect(message).toBe(SUPPORT_REQUEST_ERRORS[failure]);
    expect(message.length).toBeGreaterThan(0);
  });

  it("tells the user what the flood limit is", () => {
    expect(describeSupportRequestFailure("rateLimited")).toContain(
      String(SUPPORT_REQUEST_RATE_LIMIT.requests),
    );
  });

  it("never exposes database wording", () => {
    for (const message of Object.values(SUPPORT_REQUEST_ERRORS)) {
      expect(message).not.toMatch(/SQLSTATE|constraint|violat|row-level|PostgREST|null/i);
    }
  });
});

describe("account-change wording", () => {
  it("tells the user nothing was sent/loaded, why, and both ways forward — without naming any account", () => {
    for (const message of [
      SUPPORT_REQUEST_ERRORS.accountChanged,
      SUPPORT_REQUEST_ERRORS.listAccountChanged,
    ]) {
      expect(message).toMatch(/different account/);
      expect(message).toMatch(/Sign back in/);
      expect(message).toMatch(/reload this page/);
      expect(message).not.toMatch(/@/);
    }
    expect(SUPPORT_REQUEST_ERRORS.accountChanged).toMatch(/nothing was sent/);
    expect(SUPPORT_REQUEST_ERRORS.accountChanged).toMatch(/won't be kept/);
  });

  it("is never confused with an ended session", () => {
    expect(SUPPORT_REQUEST_ERRORS.accountChanged).not.toBe(
      SUPPORT_REQUEST_ERRORS.sessionExpired,
    );
    expect(SUPPORT_REQUEST_ERRORS.listAccountChanged).not.toBe(
      SUPPORT_REQUEST_ERRORS.listSessionExpired,
    );
  });
});

describe("summarizeSupportRequestError", () => {
  it("keeps the SQLSTATE and nothing else", () => {
    expect(
      summarizeSupportRequestError({
        code: "23514",
        message: 'new row for relation "support_requests" violates check constraint',
        details: "Failing row contains (…, 'my password is hunter2')",
        hint: "…",
      }),
    ).toEqual({ code: "23514" });
  });

  it.each([
    ["a thrown Error", new Error("boom")],
    ["null", null],
    ["undefined", undefined],
  ])("reports an unknown code for %s", (_label, error) => {
    expect(summarizeSupportRequestError(error)).toEqual({ code: "unknown" });
  });
});
