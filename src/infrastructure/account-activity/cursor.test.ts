// @vitest-environment node
import { describe, expect, it } from "vitest";

import {
  ACCOUNT_ACTIVITY_CURSOR_MAX_LENGTH,
  decodeAccountActivityCursor,
  encodeAccountActivityCursor,
  isAccountActivityTimestamp,
} from "./cursor";

const CURSOR = { occurredAt: "2026-03-01T10:00:00.123456+00:00", id: 42 };

describe("account activity cursor", () => {
  it("round-trips through an opaque, URL-safe token", () => {
    const token = encodeAccountActivityCursor(CURSOR);

    expect(token).toMatch(/^[A-Za-z0-9_-]+$/);
    expect(token.length).toBeLessThanOrEqual(ACCOUNT_ACTIVITY_CURSOR_MAX_LENGTH);
    expect(decodeAccountActivityCursor(token)).toEqual(CURSOR);
  });

  it.each([
    ["2026-03-01T10:00:00+00:00", "no fraction, offset"],
    ["2026-03-01T10:00:00.5Z", "one fractional digit, Z"],
    ["2026-03-01T10:00:00.123456-05:00", "microseconds, negative offset"],
  ])("accepts the timestamp forms PostgREST emits (%s: %s)", (occurredAt) => {
    const cursor = { occurredAt, id: 1 };
    expect(decodeAccountActivityCursor(encodeAccountActivityCursor(cursor))).toEqual(
      cursor,
    );
  });

  it.each([
    [undefined],
    [null],
    [42],
    [""],
    ["not base64url!"],
    ["a".repeat(ACCOUNT_ACTIVITY_CURSOR_MAX_LENGTH + 1)],
    [btoa("garbage")],
    [btoa("null")],
    [btoa("[]")],
    [btoa(JSON.stringify({ t: "2026-03-01T10:00:00+00:00" }))], // no id
    [btoa(JSON.stringify({ i: 1 }))], // no timestamp
    [btoa(JSON.stringify({ t: "2026-03-01T10:00:00+00:00", i: 0 }))],
    [btoa(JSON.stringify({ t: "2026-03-01T10:00:00+00:00", i: -1 }))],
    [btoa(JSON.stringify({ t: "2026-03-01T10:00:00+00:00", i: 1.5 }))],
    [btoa(JSON.stringify({ t: "2026-03-01T10:00:00+00:00", i: "1" }))],
    [btoa(JSON.stringify({ t: "2026-03-01 10:00:00+00", i: 1 }))], // not ISO
    [btoa(JSON.stringify({ t: "2026-13-01T10:00:00+00:00", i: 1 }))], // no such month
    [btoa(JSON.stringify({ t: '2026-03-01T10:00:00+00:00",x.eq.1', i: 1 }))], // filter injection
  ])("rejects anything that is not one of our tokens (%j)", (token) => {
    expect(decodeAccountActivityCursor(token)).toBeNull();
  });

  it("rejects a token that decodes correctly but is not in canonical form", () => {
    // Same content, different key order / whitespace: not what we emit.
    const padded = btoa(JSON.stringify({ i: 42, t: CURSOR.occurredAt })).replace(
      /=+$/,
      "",
    );

    expect(decodeAccountActivityCursor(padded)).toBeNull();
    expect(
      decodeAccountActivityCursor(`${encodeAccountActivityCursor(CURSOR)}A`),
    ).toBeNull();
  });

  it("only ever yields a timestamp safe to embed in a filter expression", () => {
    for (const value of [
      "2026-03-01T10:00:00+00:00",
      "2026-03-01T10:00:00.1Z",
      "x",
      "2026-03-01T10:00:00+00:00,id.gt.0",
      '2026-03-01T10:00:00+00:00"',
      1,
      null,
    ]) {
      if (isAccountActivityTimestamp(value)) {
        expect(value).not.toMatch(/[",()]/);
      }
    }
    expect(isAccountActivityTimestamp("2026-03-01T10:00:00+00:00")).toBe(true);
    expect(isAccountActivityTimestamp("2026-03-01T10:00:00+00:00,id.gt.0")).toBe(false);
  });
});
