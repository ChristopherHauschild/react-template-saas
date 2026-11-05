import { describe, expect, it } from "vitest";

import { PROFILE_NAME_KEY, PROFILE_NAME_MAX_LENGTH, toProfile } from "./profile";

describe("toProfile", () => {
  it("reads the display name from full_name and the email", () => {
    expect(
      toProfile({ email: "jane@example.com", user_metadata: { full_name: "Jane Doe" } }),
    ).toEqual({
      fullName: "Jane Doe",
      email: "jane@example.com",
      pendingEmail: null,
      pendingEmailSentAt: null,
    });
  });

  it("writes and reads the same metadata key", () => {
    // The action writes `PROFILE_NAME_KEY`; what it wrote must be what the form
    // shows next time.
    expect(
      toProfile({
        email: null as unknown as string,
        user_metadata: { [PROFILE_NAME_KEY]: "Jane" },
      }).fullName,
    ).toBe("Jane");
  });

  it("prefers full_name, then name, then display_name (same order as the account menu)", () => {
    const metadata = { full_name: "Full", name: "Name", display_name: "Display" };

    expect(toProfile({ email: "x@y.z", user_metadata: metadata }).fullName).toBe("Full");
    expect(
      toProfile({
        email: "x@y.z",
        user_metadata: { name: "Name", display_name: "Display" },
      }).fullName,
    ).toBe("Name");
    expect(
      toProfile({ email: "x@y.z", user_metadata: { display_name: "Display" } }).fullName,
    ).toBe("Display");
  });

  it("yields an empty name when none is set, so the field starts blank", () => {
    expect(toProfile({ email: "x@y.z", user_metadata: {} }).fullName).toBe("");
    expect(
      toProfile({ email: "x@y.z", user_metadata: undefined as never }).fullName,
    ).toBe("");
  });

  it("ignores blank and non-string metadata values", () => {
    expect(
      toProfile({
        email: "x@y.z",
        user_metadata: { full_name: "   ", name: 42, display_name: { first: "J" } },
      }).fullName,
    ).toBe("");
    expect(
      toProfile({ email: "x@y.z", user_metadata: { full_name: "", name: "Fallback" } })
        .fullName,
    ).toBe("Fallback");
  });

  it("trims the name it reads", () => {
    expect(
      toProfile({ email: "x@y.z", user_metadata: { full_name: "  Jane Doe \n" } })
        .fullName,
    ).toBe("Jane Doe");
  });

  it("reports a missing or blank email as null", () => {
    expect(toProfile({ email: undefined, user_metadata: {} }).email).toBeNull();
    expect(toProfile({ email: "  ", user_metadata: {} }).email).toBeNull();
    expect(toProfile({ email: " jane@example.com ", user_metadata: {} }).email).toBe(
      "jane@example.com",
    );
  });

  it("exposes only display values (the object reaches a client component)", () => {
    const profile = toProfile({
      email: "jane@example.com",
      user_metadata: { full_name: "Jane", avatar_url: "https://cdn/x.png", sub: "uid" },
    });

    expect(Object.keys(profile).sort()).toEqual([
      "email",
      "fullName",
      "pendingEmail",
      "pendingEmailSentAt",
    ]);
  });

  describe("pending email change (Supabase's new_email)", () => {
    const base = { email: "jane@example.com", user_metadata: {} };

    it("reports a requested, unconfirmed address with the time it was sent", () => {
      expect(
        toProfile({
          ...base,
          new_email: "jane.new@example.com",
          email_change_sent_at: "2026-03-01T10:00:00Z",
        }),
      ).toMatchObject({
        email: "jane@example.com", // still the sign-in address
        pendingEmail: "jane.new@example.com",
        pendingEmailSentAt: "2026-03-01T10:00:00Z",
      });
    });

    it("reports nothing pending when new_email is absent, empty or blank", () => {
      for (const new_email of [undefined, "", "   "]) {
        expect(toProfile({ ...base, new_email })).toMatchObject({
          pendingEmail: null,
          pendingEmailSentAt: null,
        });
      }
    });

    it("ignores a new_email equal to the current address (nothing would change)", () => {
      expect(
        toProfile({
          ...base,
          new_email: "Jane@Example.com",
          email_change_sent_at: "2026-03-01T10:00:00Z",
        }),
      ).toMatchObject({ pendingEmail: null, pendingEmailSentAt: null });
    });

    it("copes with a pending change whose timestamp is missing", () => {
      expect(toProfile({ ...base, new_email: "x@y.z" })).toMatchObject({
        pendingEmail: "x@y.z",
        pendingEmailSentAt: null,
      });
    });
  });

  it("has a sane maximum name length", () => {
    expect(PROFILE_NAME_MAX_LENGTH).toBeGreaterThanOrEqual(50);
    expect(PROFILE_NAME_MAX_LENGTH).toBeLessThanOrEqual(255);
  });
});
