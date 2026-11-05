import { describe, expect, it } from "vitest";

import {
  ACCOUNT_ACTIVITY_EVENT_SCHEMA,
  type AccountActivityEvent,
  type AccountActivityEventType,
} from "@/infrastructure/account-activity/events";

import {
  ACCOUNT_ACTIVITY_PAGE_SIZE,
  describeAccountActivity,
  LOAD_MORE_ACTIVITY_COPY,
} from "./account-activity-copy";

describe("describeAccountActivity", () => {
  it("describes a display-name change with both names", () => {
    expect(
      describeAccountActivity({
        type: "profile.updated",
        details: { changes: { fullName: { from: "Jane", to: "Jane Doe" } } },
      }),
    ).toEqual({ title: "Display name changed", detail: "From “Jane” to “Jane Doe”." });
  });

  it("says the name was set when there was none before", () => {
    expect(
      describeAccountActivity({
        type: "profile.updated",
        details: { changes: { fullName: { from: null, to: "Jane" } } },
      }),
    ).toEqual({ title: "Display name changed", detail: "Set to “Jane”." });
  });

  it("keeps names verbatim inside the quotes (they may contain anything)", () => {
    const { detail } = describeAccountActivity({
      type: "profile.updated",
      details: { changes: { fullName: { from: '"<b>"', to: "O'Neil, Zoë" } } },
    });

    expect(detail).toBe('From “"<b>"” to “O\'Neil, Zoë”.');
  });

  it("describes a password change, saying whether other sessions went with it", () => {
    expect(
      describeAccountActivity({
        type: "password.changed",
        details: { otherSessionsSignedOut: true },
      }),
    ).toEqual({ title: "Password changed", detail: "Other sessions were signed out." });

    expect(
      describeAccountActivity({
        type: "password.changed",
        details: { otherSessionsSignedOut: false },
      }),
    ).toEqual({
      title: "Password changed",
      detail: "Signing out other sessions could not be confirmed.",
    });
  });

  it("REGRESSION: an unconfirmed sign-out of other sessions is not reported as a failure to sign them out", () => {
    // GoTrue may well have ended them (recent versions do on a password change);
    // all that is known is that it did not confirm. The copy must claim neither.
    const { detail } = describeAccountActivity({
      type: "password.changed",
      details: { otherSessionsSignedOut: false },
    });

    expect(detail).not.toMatch(/were not signed out|still signed in|failed/i);
    expect(detail).toMatch(/could not be confirmed/i);
  });

  it("describes an email change REQUEST as not yet in effect, with both addresses", () => {
    expect(
      describeAccountActivity({
        type: "email.change_requested",
        details: { from: "jane@example.com", to: "jane.new@example.com", resend: false },
      }),
    ).toEqual({
      title: "Email change requested",
      detail:
        "From jane@example.com to jane.new@example.com; not in effect until confirmed.",
    });

    expect(
      describeAccountActivity({
        type: "email.change_requested",
        details: { from: null, to: "jane.new@example.com", resend: false },
      }),
    ).toEqual({
      title: "Email change requested",
      detail: "To jane.new@example.com; not in effect until confirmed.",
    });
  });

  it("describes a resend as a resend, not as another change", () => {
    const copy = describeAccountActivity({
      type: "email.change_requested",
      details: { from: "jane@example.com", to: "jane.new@example.com", resend: true },
    });

    expect(copy).toEqual({
      title: "Email change confirmation resent",
      detail: "To jane.new@example.com.",
    });
    expect(copy.title).not.toMatch(/requested|changed/i);
  });

  it("describes a completed email change with the new address, or without one if unknown", () => {
    expect(
      describeAccountActivity({
        type: "email.changed",
        details: { to: "jane.new@example.com" },
      }),
    ).toEqual({ title: "Email address changed", detail: "Now jane.new@example.com." });

    expect(
      describeAccountActivity({ type: "email.changed", details: { to: null } }),
    ).toEqual({
      title: "Email address changed",
      detail: null,
    });
  });

  it("never lets a request read as a completed change, nor the reverse", () => {
    const requested = describeAccountActivity({
      type: "email.change_requested",
      details: { from: "a@x.io", to: "b@x.io", resend: false },
    });
    const changed = describeAccountActivity({
      type: "email.changed",
      details: { to: "b@x.io" },
    });

    expect(requested.title).not.toMatch(/address changed/i);
    expect(changed.title).not.toMatch(/requested|pending|confirm/i);
    expect(changed.detail).not.toMatch(/requested|pending|confirm/i);
  });

  it("describes signing out other sessions without claiming a number", () => {
    const copy = describeAccountActivity({
      type: "sessions.others_signed_out",
      details: {},
    });

    expect(copy.title).toBe("Other sessions signed out");
    expect(copy.detail).toMatch(/every other browser and device/i);
    expect(copy.detail).not.toMatch(/\d/);
  });

  it("has copy for every event type in the catalogue", () => {
    // The switch is exhaustive at compile time; this pins it at run time too,
    // with a valid sample per type (a missing type here is a type error).
    const samples: Record<AccountActivityEventType, AccountActivityEvent> = {
      "profile.updated": {
        type: "profile.updated",
        details: { changes: { fullName: { from: null, to: "x" } } },
      },
      "password.changed": {
        type: "password.changed",
        details: { otherSessionsSignedOut: true },
      },
      "sessions.others_signed_out": { type: "sessions.others_signed_out", details: {} },
      "email.change_requested": {
        type: "email.change_requested",
        details: { from: "a@x.io", to: "b@x.io", resend: false },
      },
      "email.changed": { type: "email.changed", details: { to: "b@x.io" } },
    };

    const catalogued = ACCOUNT_ACTIVITY_EVENT_SCHEMA.options.map(
      (o) => o.shape.type.value,
    );
    expect(Object.keys(samples).sort()).toEqual([...catalogued].sort());

    for (const sample of Object.values(samples)) {
      const copy = describeAccountActivity(ACCOUNT_ACTIVITY_EVENT_SCHEMA.parse(sample));
      expect(copy.title, sample.type).toMatch(/\S/);
    }
  });

  it("uses a page size that fits a settings card", () => {
    expect(ACCOUNT_ACTIVITY_PAGE_SIZE).toBeGreaterThanOrEqual(5);
    expect(ACCOUNT_ACTIVITY_PAGE_SIZE).toBeLessThanOrEqual(25);
  });
});

describe("failure copy", () => {
  it("never claims the account is unchanged: a failed read of the history cannot know that", () => {
    for (const message of Object.values(LOAD_MORE_ACTIVITY_COPY)) {
      expect(message).not.toMatch(/nothing has changed/i);
    }
  });
});
