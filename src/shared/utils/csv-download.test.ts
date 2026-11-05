// @vitest-environment node
import { describe, expect, it } from "vitest";

import {
  CSV_DOWNLOAD_ERROR_CODES,
  CSV_DOWNLOAD_ERROR_HEADER,
  CSV_DOWNLOAD_ERROR_STATUS,
  type CsvDownloadErrorCode,
  csvDownloadResponse,
  INTERNAL_ERROR_DOWNLOAD,
  wantsJsonErrors,
} from "./csv-download";

const BODY = "\uFEFFName,Details\r\nZo\u00EB,\u201Cquoted\u201D\r\n";

describe("csvDownloadResponse – a complete file", () => {
  it("is a 200 attachment with the CSV media type, never cached", () => {
    const response = csvDownloadResponse({
      ok: true,
      fileName: "invoices-2026-03-01.csv",
      body: BODY,
      rowCount: 1,
    });

    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toBe("text/csv; charset=utf-8");
    expect(response.headers.get("content-disposition")).toBe(
      'attachment; filename="invoices-2026-03-01.csv"',
    );
    expect(response.headers.get("cache-control")).toBe("no-store");
    expect(response.headers.get("x-content-type-options")).toBe("nosniff");
    expect(response.headers.get(CSV_DOWNLOAD_ERROR_HEADER)).toBeNull();
  });

  it("carries the whole body with its exact UTF-8 byte length (BOM and non-ASCII included)", async () => {
    const response = csvDownloadResponse({
      ok: true,
      fileName: "a.csv",
      body: BODY,
      rowCount: 1,
    });
    const bytes = new Uint8Array(await response.arrayBuffer());

    expect(Number(response.headers.get("content-length"))).toBe(bytes.byteLength);
    expect(bytes.byteLength).toBeGreaterThan(BODY.length); // multi-byte characters
    expect(Array.from(bytes.slice(0, 3))).toEqual([0xef, 0xbb, 0xbf]); // the BOM survives
    expect(new TextDecoder("utf-8", { ignoreBOM: true }).decode(bytes)).toBe(BODY);
  });

  it.each([
    'a".csv',
    "a\r\nSet-Cookie: x=1.csv",
    "../a.csv",
    "a.txt",
    ".csv",
    "caf\u00E9.csv",
    "",
  ])("refuses to put the unsafe file name %j in a header", (fileName) => {
    expect(() =>
      csvDownloadResponse({ ok: true, fileName, body: "", rowCount: 0 }),
    ).toThrow(/unsafe file name/);
  });
});

describe("csvDownloadResponse – a failed export", () => {
  it.each<[CsvDownloadErrorCode, number]>([
    ["invalid_range", 400],
    ["ambiguous", 409],
    ["too_large", 422],
    ["internal_error", 500],
    ["unavailable", 503],
  ])("%s is %i, plain text, with no file", async (code, status) => {
    const response = csvDownloadResponse({ ok: false, code, message: "It failed." });

    expect(CSV_DOWNLOAD_ERROR_STATUS[code]).toBe(status);
    expect(response.status).toBe(status);
    expect(response.headers.get("content-type")).toBe("text/plain; charset=utf-8");
    expect(response.headers.get("content-disposition")).toBeNull();
    expect(response.headers.get("content-type")).not.toContain("csv");
    expect(response.headers.get(CSV_DOWNLOAD_ERROR_HEADER)).toBe(code);
    expect(response.headers.get("cache-control")).toBe("no-store");
    expect(await response.text()).toBe("It failed.\n");
  });

  it("lists a message per offending field after the summary", async () => {
    const response = csvDownloadResponse({
      ok: false,
      code: "invalid_range",
      message: "Check the dates of your export.",
      fields: {
        from: "Enter a date as YYYY-MM-DD.",
        range: "The start date must be on or before the end date.",
      },
    });

    expect(await response.text()).toBe(
      [
        "Check the dates of your export.",
        "From: Enter a date as YYYY-MM-DD.",
        "Dates: The start date must be on or before the end date.",
        "",
      ].join("\n"),
    );
  });

  it("has a generic message for an unexpected failure", async () => {
    const response = csvDownloadResponse(INTERNAL_ERROR_DOWNLOAD);

    expect(response.status).toBe(500);
    expect(await response.text()).toMatch(
      /^Something went wrong while preparing your export\./,
    );
  });
});

describe("csvDownloadResponse – row count", () => {
  it("states how many records the file holds", () => {
    const response = csvDownloadResponse({
      ok: true,
      fileName: "a.csv",
      body: BODY,
      rowCount: 1,
    });

    expect(response.headers.get("x-export-row-count")).toBe("1");
  });

  it.each([-1, 1.5, Number.NaN])("refuses the row count %s", (rowCount) => {
    expect(() =>
      csvDownloadResponse({ ok: true, fileName: "a.csv", body: BODY, rowCount }),
    ).toThrow(/row count/);
  });
});

describe("csvDownloadResponse – failures as JSON, for the exports page", () => {
  it.each(CSV_DOWNLOAD_ERROR_CODES.filter((c) => c !== "rate_limited"))(
    "%s: same status and code, a JSON body, no file",
    async (code) => {
      const response = csvDownloadResponse(
        { ok: false, code, message: "It failed." },
        { json: true },
      );

      expect(response.status).toBe(CSV_DOWNLOAD_ERROR_STATUS[code]);
      expect(response.headers.get("content-type")).toBe(
        "application/json; charset=utf-8",
      );
      expect(response.headers.get("content-disposition")).toBeNull();
      expect(response.headers.get(CSV_DOWNLOAD_ERROR_HEADER)).toBe(code);
      expect(response.headers.get("cache-control")).toBe("no-store");
      expect(await response.json()).toEqual({ error: { code, message: "It failed." } });
    },
  );

  it("carries the field messages by field name", async () => {
    const response = csvDownloadResponse(
      {
        ok: false,
        code: "invalid_range",
        message: "Check the dates of your export.",
        fields: { from: "Enter a date as YYYY-MM-DD.", to: undefined },
      },
      { json: true },
    );

    expect(await response.json()).toEqual({
      error: {
        code: "invalid_range",
        message: "Check the dates of your export.",
        fields: { from: "Enter a date as YYYY-MM-DD." },
      },
    });
  });

  it("does not change a successful download", () => {
    const response = csvDownloadResponse(
      { ok: true, fileName: "a.csv", body: BODY, rowCount: 1 },
      { json: true },
    );

    expect(response.headers.get("content-type")).toBe("text/csv; charset=utf-8");
  });
});

describe("wantsJsonErrors", () => {
  it.each([
    ["application/json", true],
    ["text/csv, application/json;q=0.9", true],
    ["Application/JSON", true],
    [" application/json ; charset=utf-8", true],
    ["text/html,application/xhtml+xml,*/*;q=0.8", false], // a browser navigation
    ["*/*", false],
    ["application/jsonp", false],
    ["", false],
    [null, false],
  ])("%j → %s", (accept, expected) => {
    expect(wantsJsonErrors(accept)).toBe(expected);
  });
});

describe("csvDownloadResponse – rate limited", () => {
  const limited = {
    ok: false as const,
    code: "rate_limited" as const,
    message: "Please wait a minute before exporting again.",
    retryAfterSeconds: 42,
  };

  it("is a 429 with Retry-After, as text, with no file", async () => {
    const response = csvDownloadResponse(limited);

    expect(response.status).toBe(429);
    expect(response.headers.get("retry-after")).toBe("42");
    expect(response.headers.get(CSV_DOWNLOAD_ERROR_HEADER)).toBe("rate_limited");
    expect(response.headers.get("content-disposition")).toBeNull();
    expect(response.headers.get("content-type")).toBe("text/plain; charset=utf-8");
    expect(await response.text()).toBe("Please wait a minute before exporting again.\n");
  });

  it("carries the wait in the JSON body too, for the exports page", async () => {
    const response = csvDownloadResponse(limited, { json: true });

    expect(response.status).toBe(429);
    expect(response.headers.get("retry-after")).toBe("42");
    expect(await response.json()).toEqual({
      error: {
        code: "rate_limited",
        message: "Please wait a minute before exporting again.",
        retryAfterSeconds: 42,
      },
    });
  });

  it.each([undefined, 0, -5, 1.5, Number.NaN])(
    "refuses to answer a 429 without a usable wait (%s)",
    (retryAfterSeconds) => {
      expect(() => csvDownloadResponse({ ...limited, retryAfterSeconds })).toThrow(
        /retryAfterSeconds/,
      );
    },
  );

  it("sends no Retry-After with any other failure", () => {
    for (const code of CSV_DOWNLOAD_ERROR_CODES.filter((c) => c !== "rate_limited")) {
      const response = csvDownloadResponse({
        ok: false,
        code,
        message: "x",
        retryAfterSeconds: 9,
      });
      expect(response.headers.get("retry-after")).toBeNull();
    }
  });
});
