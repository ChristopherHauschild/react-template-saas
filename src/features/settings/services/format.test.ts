import { describe, expect, it } from "vitest";

import {
  formatDuration,
  formatUtc,
  formatUtcDay,
  formatUtcTime,
  tokenExpiryCaveat,
  utcDayKey,
} from "./format";

describe("formatUtc", () => {
  it("formats deterministically in UTC", () => {
    expect(formatUtc("2026-03-01T10:00:00Z")).toBe("1 Mar 2026, 10:00 UTC");
    expect(formatUtc("2026-03-01T23:30:00-02:00")).toBe("2 Mar 2026, 01:30 UTC");
  });

  it("returns null for missing or unparsable values", () => {
    for (const value of [null, undefined, "", "garbage"])
      expect(formatUtc(value)).toBeNull();
  });
});

describe("formatDuration", () => {
  it.each([
    [3600, "60 minutes"],
    [900, "15 minutes"],
    [7200, "2 hours"],
    [604800, "168 hours"],
    [5400, "90 minutes"],
    [90, "90 seconds"],
    [3601, "61 minutes"],
  ])("%s s → %s", (seconds, words) => {
    expect(formatDuration(seconds)).toBe(words);
  });

  it("is null when unknown or nonsensical", () => {
    for (const value of [null, 0, -5, Number.NaN, Infinity])
      expect(formatDuration(value)).toBeNull();
  });
});

describe("tokenExpiryCaveat", () => {
  it("names the real lifetime", () => {
    expect(tokenExpiryCaveat(3600)).toMatch(
      /until it expires — at most 60 minutes after it was issued/,
    );
  });

  it("still states the caveat without a number when the lifetime is unknown", () => {
    const text = tokenExpiryCaveat(null);

    expect(text).toMatch(/until it expires\.$/);
    expect(text).not.toMatch(/\d/);
  });
});

describe("formatUtcDay / formatUtcTime / utcDayKey", () => {
  it("split a timestamp into the UTC day and the UTC time of day", () => {
    expect(formatUtcDay("2026-03-01T10:05:00Z")).toBe("1 Mar 2026");
    expect(formatUtcTime("2026-03-01T10:05:00Z")).toBe("10:05 UTC");
    expect(utcDayKey("2026-03-01T10:05:00Z")).toBe("2026-03-01");
  });

  it("convert offsets to UTC first (so day and time agree with formatUtc)", () => {
    const iso = "2026-03-01T23:30:00-02:00"; // 01:30 UTC on 2 Mar
    expect(formatUtc(iso)).toBe("2 Mar 2026, 01:30 UTC");
    expect(formatUtcDay(iso)).toBe("2 Mar 2026");
    expect(formatUtcTime(iso)).toBe("01:30 UTC");
    expect(utcDayKey(iso)).toBe("2026-03-02");
  });

  it.each([null, undefined, "", "garbage", "2026-13-45T00:00:00Z"])(
    "return null for a missing or unparsable timestamp (%j)",
    (value) => {
      expect(formatUtcDay(value)).toBeNull();
      expect(formatUtcTime(value)).toBeNull();
      expect(utcDayKey(value)).toBeNull();
    },
  );
});
