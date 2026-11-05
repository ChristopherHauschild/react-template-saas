// @vitest-environment node
import { describe, expect, it } from "vitest";

import {
  type AccountMenuSource,
  ANONYMOUS_ACCOUNT_LABEL,
  initialsOf,
  toAccountMenuUser,
} from "./account-menu-user";

const source = (email: string | undefined, user_metadata: Record<string, unknown> = {}) =>
  ({ email, user_metadata }) as AccountMenuSource;

describe("toAccountMenuUser – name resolution", () => {
  it("prefers full_name, then name, then display_name", () => {
    expect(
      toAccountMenuUser(
        source("jane@example.com", {
          full_name: "Jane Doe",
          name: "JD",
          display_name: "jd",
        }),
      ).name,
    ).toBe("Jane Doe");
    expect(
      toAccountMenuUser(
        source("jane@example.com", { name: "Jane D.", display_name: "jd" }),
      ).name,
    ).toBe("Jane D.");
    expect(
      toAccountMenuUser(source("jane@example.com", { display_name: "jd" })).name,
    ).toBe("jd");
  });

  it("falls back to the email when there is no usable name, and then shows no separate email line", () => {
    expect(toAccountMenuUser(source("jane@example.com"))).toEqual({
      name: "jane@example.com",
      email: null,
      initials: "J",
    });
  });

  it("shows the email under the name only when it adds information", () => {
    expect(
      toAccountMenuUser(source("jane@example.com", { full_name: "Jane Doe" })).email,
    ).toBe("jane@example.com");
    // Name that *is* the email: no duplicate line.
    expect(
      toAccountMenuUser(source("jane@example.com", { full_name: "jane@example.com" }))
        .email,
    ).toBeNull();
  });

  it("never renders the hard-coded demo placeholders", () => {
    const result = toAccountMenuUser(
      source("jane@example.com", { full_name: "Jane Doe" }),
    );

    expect(JSON.stringify(result)).not.toMatch(/Demo User|"DU"/);
  });
});

describe("toAccountMenuUser – missing or malformed profile data", () => {
  it.each([
    ["null user", null],
    ["undefined user", undefined],
    ["no email, no metadata", source(undefined)],
    ["empty email, empty metadata", source("", {})],
    ["whitespace-only values", source("   ", { full_name: " \t " })],
  ])("uses a neutral label for %s", (_label, user) => {
    expect(toAccountMenuUser(user)).toEqual({
      name: ANONYMOUS_ACCOUNT_LABEL,
      email: null,
      initials: "A",
    });
  });

  it("ignores non-string metadata values", () => {
    expect(
      toAccountMenuUser(
        source("jane@example.com", {
          full_name: 42,
          name: { first: "Jane" },
          display_name: ["Jane"],
        }),
      ),
    ).toEqual({ name: "jane@example.com", email: null, initials: "J" });
  });

  it("trims surrounding whitespace", () => {
    expect(
      toAccountMenuUser(source("  jane@example.com ", { full_name: "  Jane Doe  " })),
    ).toEqual({
      name: "Jane Doe",
      email: "jane@example.com",
      initials: "JD",
    });
  });

  it("copes with user_metadata being absent", () => {
    expect(
      toAccountMenuUser({ email: "jane@example.com" } as unknown as AccountMenuSource),
    ).toMatchObject({ name: "jane@example.com" });
  });
});

describe("initialsOf", () => {
  it.each([
    ["Jane Doe", "JD"],
    ["Mary Jane Watson", "MW"],
    ["Prince", "P"],
    ["  jane   doe ", "JD"],
    ["jane.doe@example.com", "JD"],
    ["jane_doe+work@example.com", "JD"],
    ["jane+work@example.com", "J"],
    ["jane@example.com", "J"],
    ["Éva Ørsted", "ÉØ"],
    ["李 小龙", "李小"],
    ["😀 Smiley", "😀S"],
    ["Account", "A"],
    ["", ""],
    ["   ", ""],
  ])("initialsOf(%j) → %j", (label, expected) => {
    expect(initialsOf(label)).toBe(expected);
  });

  it("never produces more than two characters (code points)", () => {
    expect(Array.from(initialsOf("a b c d e f g")).length).toBeLessThanOrEqual(2);
  });
});
