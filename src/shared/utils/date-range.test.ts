// @vitest-environment node
import { describe, expect, it } from "vitest";

import {
  DATE_RANGE_ERRORS,
  dateRangeBounds,
  dateRangeParamsFrom,
  EMPTY_DATE_RANGE,
  isCalendarDay,
  isEmptyDateRange,
  isInDateRange,
  isValidDateRange,
  parseDateRange,
} from "./date-range";

describe("parseDateRange – valid input", () => {
  it.each([
    [{}, { from: null, to: null }],
    [undefined, { from: null, to: null }],
    [
      { from: "", to: "   " },
      { from: null, to: null },
    ],
    [{ from: "2026-03-01" }, { from: "2026-03-01", to: null }],
    [{ to: "2026-03-31" }, { from: null, to: "2026-03-31" }],
    [
      { from: "2026-03-01", to: "2026-03-31" },
      { from: "2026-03-01", to: "2026-03-31" },
    ],
    [
      { from: "2026-03-01", to: "2026-03-01" },
      { from: "2026-03-01", to: "2026-03-01" },
    ], // one day
    [
      { from: " 2026-03-01 ", to: "\t2026-03-31\n" },
      { from: "2026-03-01", to: "2026-03-31" },
    ],
    [{ from: "2024-02-29" }, { from: "2024-02-29", to: null }], // leap day
    [
      { from: "2000-01-01", to: "2100-12-31" },
      { from: "2000-01-01", to: "2100-12-31" },
    ],
    [{ from: ["2026-03-01"] }, { from: "2026-03-01", to: null }], // one value, as an array
    [{ from: ["", "2026-03-01"] }, { from: "2026-03-01", to: null }], // blanks do not count
    [
      { from: "2026-03-01", other: "ignored" },
      { from: "2026-03-01", to: null },
    ],
  ])("%j → %j", (params, range) => {
    expect(parseDateRange(params)).toEqual({ ok: true, range });
  });
});

describe("parseDateRange – invalid input is refused, field by field", () => {
  it.each([
    ["2026-3-1", DATE_RANGE_ERRORS.date],
    ["01/03/2026", DATE_RANGE_ERRORS.date],
    ["2026-03-01T00:00:00Z", DATE_RANGE_ERRORS.date],
    ["20260301", DATE_RANGE_ERRORS.date],
    ["yesterday", DATE_RANGE_ERRORS.date],
    ["2026-03-01; drop table", DATE_RANGE_ERRORS.date],
    ["٢٠٢٦-٠٣-٠١", DATE_RANGE_ERRORS.date], // non-ASCII digits
    ["+2026-03-01", DATE_RANGE_ERRORS.date],
    ["2026-02-29", DATE_RANGE_ERRORS.day], // not a leap year
    ["2026-02-30", DATE_RANGE_ERRORS.day],
    ["2026-04-31", DATE_RANGE_ERRORS.day],
    ["2026-13-01", DATE_RANGE_ERRORS.day],
    ["2026-00-10", DATE_RANGE_ERRORS.day],
    ["2026-03-00", DATE_RANGE_ERRORS.day],
    ["1999-12-31", DATE_RANGE_ERRORS.year],
    ["2101-01-01", DATE_RANGE_ERRORS.year],
    ["0000-01-01", DATE_RANGE_ERRORS.year],
  ])("refuses %j with “%s”", (value, message) => {
    expect(parseDateRange({ from: value })).toEqual({
      ok: false,
      errors: { from: message },
      input: { from: value.trim(), to: "" },
    });
    expect(parseDateRange({ to: value })).toMatchObject({
      ok: false,
      errors: { to: message },
    });
  });

  it("refuses a start after the end, naming the range rather than either field", () => {
    expect(parseDateRange({ from: "2026-03-02", to: "2026-03-01" })).toEqual({
      ok: false,
      errors: { range: DATE_RANGE_ERRORS.range },
      input: { from: "2026-03-02", to: "2026-03-01" },
    });
  });

  it("compares the order across months and years, not as text of unequal length", () => {
    expect(parseDateRange({ from: "2026-12-31", to: "2027-01-01" }).ok).toBe(true);
    expect(parseDateRange({ from: "2027-01-01", to: "2026-12-31" }).ok).toBe(false);
  });

  it("refuses a field given twice rather than guessing which one was meant", () => {
    expect(parseDateRange({ from: ["2026-03-01", "2026-04-01"] })).toEqual({
      ok: false,
      errors: { from: DATE_RANGE_ERRORS.multiple },
      input: { from: "2026-03-01", to: "" },
    });
  });

  it("reports both fields at once when both are wrong", () => {
    expect(parseDateRange({ from: "nope", to: "2026-02-30" })).toMatchObject({
      ok: false,
      errors: { from: DATE_RANGE_ERRORS.date, to: DATE_RANGE_ERRORS.day },
    });
  });

  it("does not check the order of fields that are themselves invalid", () => {
    expect(parseDateRange({ from: "2026-03-05", to: "2026-02-30" })).toEqual({
      ok: false,
      errors: { to: DATE_RANGE_ERRORS.day },
      input: { from: "2026-03-05", to: "2026-02-30" },
    });
  });
});

describe("isCalendarDay / isValidDateRange", () => {
  it.each([null, undefined, 20260301, "", "2026-02-30"])(
    "isCalendarDay(%j) is false",
    (v) => {
      expect(isCalendarDay(v)).toBe(false);
    },
  );

  it.each([
    [{ from: null, to: null }, true],
    [{ from: "2026-03-01", to: null }, true],
    [{ from: "2026-03-01", to: "2026-03-01" }, true],
    [{ from: "2026-03-02", to: "2026-03-01" }, false], // swapped
    [{ from: "2026-02-30", to: null }, false],
    [{ from: "2026-03-01" }, false], // `to` missing, not null
    [{ from: 1, to: null }, false],
    [{ from: "2026-03-01T00:00:00Z", to: null }, false],
    [null, false],
    ["2026-03-01", false],
  ])("isValidDateRange(%j) is %s", (value, expected) => {
    expect(isValidDateRange(value)).toBe(expected);
  });

  it("isEmptyDateRange", () => {
    expect(isEmptyDateRange(EMPTY_DATE_RANGE)).toBe(true);
    expect(isEmptyDateRange({ from: "2026-03-01", to: null })).toBe(false);
  });
});

describe("dateRangeBounds", () => {
  it("starts at midnight UTC of `from` and ends (exclusive) at midnight UTC after `to`", () => {
    expect(dateRangeBounds({ from: "2026-03-01", to: "2026-03-31" })).toEqual({
      start: Date.UTC(2026, 2, 1),
      end: Date.UTC(2026, 3, 1),
    });
  });

  it("crosses month, year and leap-day ends", () => {
    expect(dateRangeBounds({ from: null, to: "2026-12-31" }).end).toBe(
      Date.UTC(2027, 0, 1),
    );
    expect(dateRangeBounds({ from: null, to: "2024-02-28" }).end).toBe(
      Date.UTC(2024, 1, 29),
    );
    expect(dateRangeBounds({ from: null, to: "2024-02-29" }).end).toBe(
      Date.UTC(2024, 2, 1),
    );
  });

  it("is a whole day long for a one-day range, whatever DST does elsewhere", () => {
    const { start, end } = dateRangeBounds({ from: "2026-03-29", to: "2026-03-29" });
    expect(end! - start!).toBe(86_400_000);
  });

  it("leaves open ends open", () => {
    expect(dateRangeBounds(EMPTY_DATE_RANGE)).toEqual({ start: null, end: null });
  });
});

describe("isInDateRange – the edges of the range", () => {
  const MARCH = { from: "2026-03-01", to: "2026-03-31" };

  it.each([
    // Inside, right at the edges:
    ["2026-03-01T00:00:00Z", true],
    ["2026-03-01T00:00:00.000000+00:00", true],
    ["2026-03-31T23:59:59Z", true],
    ["2026-03-31T23:59:59.999Z", true],
    ["2026-03-31T23:59:59.999999+00:00", true], // the last microsecond of the last day
    // Outside, right at the edges:
    ["2026-02-28T23:59:59.999999+00:00", false],
    ["2026-04-01T00:00:00Z", false],
    ["2026-04-01T00:00:00.000001+00:00", false],
    // Other offsets are converted to UTC first:
    ["2026-03-01T00:30:00+01:00", false], // 28 Feb 23:30 UTC
    ["2026-03-31T23:30:00-01:00", false], // 1 Apr 00:30 UTC
    ["2026-04-01T00:30:00+01:00", true], // 31 Mar 23:30 UTC
    ["2026-02-28T23:30:00-01:00", true], // 1 Mar 00:30 UTC
  ])("%s → %s", (timestamp, expected) => {
    expect(isInDateRange(timestamp, MARCH)).toBe(expected);
  });

  it("admits everything when the range is open", () => {
    expect(isInDateRange("2001-01-01T00:00:00Z", EMPTY_DATE_RANGE)).toBe(true);
    expect(isInDateRange("2026-03-01T00:00:00Z", { from: "2026-03-01", to: null })).toBe(
      true,
    );
    expect(isInDateRange("2026-03-01T00:00:00Z", { from: null, to: "2026-02-28" })).toBe(
      false,
    );
  });

  it("answers null for a timestamp it cannot read, rather than in or out", () => {
    expect(isInDateRange("yesterday", MARCH)).toBeNull();
    expect(isInDateRange("", EMPTY_DATE_RANGE)).toBeNull();
  });
});

describe("dateRangeParamsFrom", () => {
  const from = (query: string) => dateRangeParamsFrom(new URLSearchParams(query));

  it("reads the two fields and ignores everything else", () => {
    expect(from("from=2026-03-01&to=2026-03-31&userId=someone&q=x")).toEqual({
      from: "2026-03-01",
      to: "2026-03-31",
    });
    expect(from("")).toEqual({});
  });

  it("keeps a repeated field as a list, so the parser refuses it instead of picking one", () => {
    expect(from("from=2026-03-01&from=2026-01-01")).toEqual({
      from: ["2026-03-01", "2026-01-01"],
    });
    expect(parseDateRange(from("from=2026-03-01&from=2026-01-01"))).toMatchObject({
      ok: false,
      errors: { from: DATE_RANGE_ERRORS.multiple },
    });
  });

  it("decodes the query string as a browser's form would send it", () => {
    expect(parseDateRange(from("from=+2026-03-01+&to=2026%2D03%2D31"))).toEqual({
      ok: true,
      range: { from: "2026-03-01", to: "2026-03-31" },
    });
  });
});
