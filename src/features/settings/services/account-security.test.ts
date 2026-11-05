import { describe, expect, it } from "vitest";

import { toAccountSecurity } from "./account-security";

const USER = {
  email: "jane@example.com",
  email_confirmed_at: "2026-01-01T09:00:00Z",
  last_sign_in_at: "2026-03-01T10:00:00Z",
  created_at: "2026-01-01T08:00:00Z",
  app_metadata: { provider: "email", providers: ["email", "google"] },
  new_email: undefined,
};

describe("toAccountSecurity", () => {
  it("summarises the sign-in facts with readable method names", () => {
    expect(toAccountSecurity(USER)).toEqual({
      email: "jane@example.com",
      emailConfirmedAt: "2026-01-01T09:00:00Z",
      lastSignInAt: "2026-03-01T10:00:00Z",
      createdAt: "2026-01-01T08:00:00Z",
      signInMethods: ["Email and password", "Google"],
      pendingEmail: null,
    });
  });

  it("falls back to the single provider, de-duplicates, and labels unknown ones", () => {
    expect(
      toAccountSecurity({ ...USER, app_metadata: { provider: "github" } }).signInMethods,
    ).toEqual(["GitHub"]);
    expect(
      toAccountSecurity({
        ...USER,
        app_metadata: {
          providers: ["email", "email", "keycloak", 7 as unknown as string],
        },
      }).signInMethods,
    ).toEqual(["Email and password", "Keycloak"]);
    expect(toAccountSecurity({ ...USER, app_metadata: {} }).signInMethods).toEqual([]);
  });

  it("reports a pending email change, but not one equal to the current address", () => {
    expect(
      toAccountSecurity({ ...USER, new_email: "jane.new@example.com" }).pendingEmail,
    ).toBe("jane.new@example.com");
    expect(
      toAccountSecurity({ ...USER, new_email: "JANE@example.com" }).pendingEmail,
    ).toBeNull();
  });

  it("copes with missing values", () => {
    expect(
      toAccountSecurity({
        email: undefined,
        email_confirmed_at: undefined,
        last_sign_in_at: undefined,
        created_at: "",
        app_metadata: undefined as never,
        new_email: undefined,
      }),
    ).toEqual({
      email: null,
      emailConfirmedAt: null,
      lastSignInAt: null,
      createdAt: null,
      signInMethods: [],
      pendingEmail: null,
    });
  });

  it("exposes display values only (crosses into a client component)", () => {
    const withSecrets = {
      ...USER,
      id: "11111111-1111-4111-8111-111111111111",
      app_metadata: { ...USER.app_metadata, role: "admin", secret: "s" },
      factors: [{ id: "f1", secret: "totp" }],
    };

    const serialized = JSON.stringify(toAccountSecurity(withSecrets));
    expect(serialized).not.toMatch(/11111111|admin|totp|"secret"/);
  });
});
