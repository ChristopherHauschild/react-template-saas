// @vitest-environment node
import { describe, expect, it } from "vitest";

import {
  decodeSupportRequestCursor,
  encodeSupportRequestCursor,
  isSupportRequestId,
  isSupportRequestTimestamp,
  SUPPORT_REQUEST_CURSOR_MAX_LENGTH,
  type SupportRequestCursor,
} from "./support-request-cursor";

const POSITION: SupportRequestCursor = {
  createdAt: "2026-03-01T10:00:00.123456+00:00",
  id: "3f2504e0-4f89-41d3-9a0c-0305e82c3301",
};

describe("support request cursors", () => {
  it("round-trips a position", () => {
    expect(decodeSupportRequestCursor(encodeSupportRequestCursor(POSITION))).toEqual(
      POSITION,
    );
  });

  it("is an opaque base64url token, short enough to travel in a form", () => {
    const token = encodeSupportRequestCursor(POSITION);

    expect(token).toMatch(/^[A-Za-z0-9_-]+$/);
    expect(token.length).toBeLessThanOrEqual(SUPPORT_REQUEST_CURSOR_MAX_LENGTH);
    // Opaque, not secret: it is merely encoded, and the server re-validates it.
    expect(token).not.toContain(POSITION.id);
  });

  it.each([
    ["not a string", 42],
    ["null", null],
    ["undefined", undefined],
    ["empty", ""],
    ["not base64url", "abc$%^"],
    ["not base64 at all", "!!!!"],
    ["longer than the maximum", "a".repeat(SUPPORT_REQUEST_CURSOR_MAX_LENGTH + 1)],
    ["valid base64url of nonsense", btoa("nonsense").replace(/=+$/, "")],
    ["base64url of a JSON array", btoa('["x",1]').replace(/=+$/, "")],
    ["base64url of JSON null", btoa("null").replace(/=+$/, "")],
  ])("refuses a token that is %s", (_label, token) => {
    expect(decodeSupportRequestCursor(token)).toBeNull();
  });

  it.each([
    ["a malformed timestamp", { t: "yesterday", i: POSITION.id }],
    ["a timestamp without a zone", { t: "2026-03-01T10:00:00", i: POSITION.id }],
    [
      "an impossible date (Date.parse would roll it over)",
      { t: "2026-02-30T10:00:00Z", i: POSITION.id },
    ],
    ["a day 00", { t: "2026-03-00T10:00:00Z", i: POSITION.id }],
    ["a month 00", { t: "2026-00-01T10:00:00Z", i: POSITION.id }],
    ["an impossible hour", { t: "2026-03-01T29:00:00Z", i: POSITION.id }],
    ["a missing id", { t: POSITION.createdAt }],
    ["a numeric id", { t: POSITION.createdAt, i: 42 }],
    ["an id that is not a uuid", { t: POSITION.createdAt, i: "../../etc" }],
    ["an uppercase uuid", { t: POSITION.createdAt, i: POSITION.id.toUpperCase() }],
    [
      "a uuid with a PostgREST filter appended",
      { t: POSITION.createdAt, i: `${POSITION.id},user_id.neq.x` },
    ],
  ])("refuses a token carrying %s", (_label, payload) => {
    const token = btoa(JSON.stringify(payload)).replace(/=+$/, "");

    expect(decodeSupportRequestCursor(token)).toBeNull();
  });

  it("accepts only the canonical encoding of a position", () => {
    // Same data, different JSON: re-encoding would not produce this token.
    const reordered = btoa(JSON.stringify({ i: POSITION.id, t: POSITION.createdAt }))
      .replace(/\+/g, "-")
      .replace(/\//g, "_")
      .replace(/=+$/, "");

    expect(decodeSupportRequestCursor(reordered)).toBeNull();

    // Padding is stripped by the encoder, so a padded token is not ours either.
    const padded = `${encodeSupportRequestCursor(POSITION)}=`;
    expect(decodeSupportRequestCursor(padded)).toBeNull();
  });

  it("accepts 29 February in a leap year", () => {
    expect(isSupportRequestTimestamp("2028-02-29T10:00:00+00:00")).toBe(true);
    expect(isSupportRequestTimestamp("2026-02-29T10:00:00+00:00")).toBe(false);
  });

  it("accepts the timestamp formats PostgREST produces", () => {
    for (const createdAt of [
      "2026-03-01T10:00:00Z",
      "2026-03-01T10:00:00+00:00",
      "2026-03-01T10:00:00.1+02:00",
      "2026-03-01T10:00:00.123456-05:30",
    ]) {
      expect(isSupportRequestTimestamp(createdAt)).toBe(true);
      expect(
        decodeSupportRequestCursor(
          encodeSupportRequestCursor({ ...POSITION, createdAt }),
        ),
      ).toEqual({ ...POSITION, createdAt });
    }
  });

  it("recognises canonical lowercase uuids only", () => {
    expect(isSupportRequestId(POSITION.id)).toBe(true);
    expect(isSupportRequestId(POSITION.id.toUpperCase())).toBe(false);
    expect(isSupportRequestId(POSITION.id.replace(/-/g, ""))).toBe(false);
    expect(isSupportRequestId(null)).toBe(false);
  });
});
