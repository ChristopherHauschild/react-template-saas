import { describe, expect, it } from "vitest";

import {
  EMAIL_CHANGE_QUERY_PARAM,
  EMAIL_CHANGE_STATUSES,
  emailChangeStatusPath,
  parseEmailChangeStatus,
  reconcileEmailChangeStatus,
} from "./email-change-status";

describe("emailChangeStatusPath", () => {
  it("sends a signed-in browser to the settings page with the status", () => {
    expect(emailChangeStatusPath("confirmed", { signedIn: true })).toBe(
      "/settings?emailChange=confirmed",
    );
  });

  it("sends a browser without a session to the login page (the guard would lose the message)", () => {
    expect(emailChangeStatusPath("awaiting_other", { signedIn: false })).toBe(
      "/login?emailChange=awaiting_other",
    );
  });

  it("produces relative, same-origin paths only", () => {
    for (const status of Object.values(EMAIL_CHANGE_STATUSES)) {
      for (const signedIn of [true, false]) {
        const path = emailChangeStatusPath(status, { signedIn });
        expect(path.startsWith("/")).toBe(true);
        expect(path.startsWith("//")).toBe(false);
      }
    }
  });
});

describe("parseEmailChangeStatus", () => {
  it("round-trips every status", () => {
    for (const status of Object.values(EMAIL_CHANGE_STATUSES)) {
      const path = emailChangeStatusPath(status, { signedIn: true });
      const value = new URL(path, "http://x").searchParams.get(EMAIL_CHANGE_QUERY_PARAM)!;

      expect(parseEmailChangeStatus(value)).toBe(status);
    }
  });

  it("rejects unknown, differently-cased, repeated and missing values", () => {
    expect(parseEmailChangeStatus("changed")).toBeNull();
    expect(parseEmailChangeStatus("Confirmed")).toBeNull();
    expect(parseEmailChangeStatus(["confirmed", "expired"])).toBeNull();
    expect(parseEmailChangeStatus(undefined)).toBeNull();
    expect(parseEmailChangeStatus("")).toBeNull();
  });

  it("uses stable, URL-safe tokens", () => {
    for (const status of Object.values(EMAIL_CHANGE_STATUSES)) {
      expect(status).toMatch(/^[a-z_]+$/);
    }
  });
});

describe("reconcileEmailChangeStatus (the URL never overrides the account's record)", () => {
  it("hides 'confirmed' while a change is still pending — typed, stale or replayed, it is not true", () => {
    expect(reconcileEmailChangeStatus("confirmed", { changePending: true })).toBeNull();
    expect(reconcileEmailChangeStatus("confirmed", { changePending: false })).toBe(
      "confirmed",
    );
  });

  it("hides 'one more to go' when nothing is pending (completed elsewhere, or never requested)", () => {
    expect(
      reconcileEmailChangeStatus("awaiting_other", { changePending: false }),
    ).toBeNull();
    expect(reconcileEmailChangeStatus("awaiting_other", { changePending: true })).toBe(
      "awaiting_other",
    );
  });

  it("shows link problems regardless (they are about the link, not the account)", () => {
    for (const status of ["expired", "invalid", "unavailable"] as const) {
      expect(reconcileEmailChangeStatus(status, { changePending: true })).toBe(status);
      expect(reconcileEmailChangeStatus(status, { changePending: false })).toBe(status);
    }
  });

  it("passes null through", () => {
    expect(reconcileEmailChangeStatus(null, { changePending: true })).toBeNull();
  });
});
