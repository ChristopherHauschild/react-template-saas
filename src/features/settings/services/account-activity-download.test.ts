// @vitest-environment node
import { beforeEach, describe, expect, it, vi } from "vitest";

const collector = vi.hoisted(() => ({
  collectAccountActivityForExport: vi.fn(),
  ACCOUNT_ACTIVITY_EXPORT_MAX_ENTRIES: 10_000,
}));
vi.mock("./collect-account-activity-export", () => collector);

import { parseCsv } from "@/shared/test/csv";
import { CSV_UTF8_BOM } from "@/shared/utils/csv";
import { DATE_RANGE_ERRORS } from "@/shared/utils/date-range";

import {
  ACCOUNT_ACTIVITY_DOWNLOAD_COPY,
  prepareAccountActivityDownload,
} from "./account-activity-download";
import type { AccountActivityExportCollection } from "./collect-account-activity-export";

const USER = "11111111-1111-4111-8111-111111111111";
const NOW = new Date("2026-04-05T12:00:00Z");

const prepare = (query = "") =>
  prepareAccountActivityDownload(USER, new URLSearchParams(query), { now: NOW });

beforeEach(() => {
  vi.clearAllMocks();
  collector.collectAccountActivityForExport.mockResolvedValue({
    ok: true,
    entries: [],
    unrecognised: 0,
  } satisfies AccountActivityExportCollection);
});

describe("prepareAccountActivityDownload", () => {
  it("hands the collector the session user and the PARSED range", async () => {
    await prepare("from=%202026-03-01%20&to=2026-03-31&userId=someone");

    expect(collector.collectAccountActivityForExport).toHaveBeenCalledWith(USER, {
      range: { from: "2026-03-01", to: "2026-03-31" },
    });
  });

  it("turns a complete collection into the file, named after the range", async () => {
    collector.collectAccountActivityForExport.mockResolvedValue({
      ok: true,
      unrecognised: 1,
      entries: [
        {
          id: 2,
          occurredAt: "2026-03-02T10:00:00+00:00",
          event: { type: "sessions.others_signed_out", details: {} },
        },
        {
          unrecognised: true,
          id: 1,
          occurredAt: "2026-03-01T10:00:00+00:00",
          eventType: "x.y",
        },
      ],
    });

    const download = await prepare("from=2026-03-01&to=2026-03-31");

    if (!download.ok) throw new Error("expected a file");
    expect(download.fileName).toBe("account-activity-2026-03-01-to-2026-03-31.csv");
    expect(download.body.startsWith(CSV_UTF8_BOM)).toBe(true);
    expect(parseCsv(download.body.slice(1)).map((row) => row[3])).toEqual([
      "Event type",
      "sessions.others_signed_out",
      "x.y",
    ]);
  });

  it("names a download without a range by the day it was made", async () => {
    expect(await prepare()).toMatchObject({
      ok: true,
      fileName: "account-activity-2026-04-05.csv",
    });
  });

  it("refuses an invalid range with the field messages, without collecting anything", async () => {
    expect(await prepare("from=2026-02-30&to=2026-01-01")).toEqual({
      ok: false,
      code: "invalid_range",
      message: ACCOUNT_ACTIVITY_DOWNLOAD_COPY.invalidRange,
      fields: { from: DATE_RANGE_ERRORS.day },
    });
    expect(collector.collectAccountActivityForExport).not.toHaveBeenCalled();
  });

  it.each<
    [Extract<AccountActivityExportCollection, { ok: false }>["reason"], string, string]
  >([
    ["invalid_range", "invalid_range", ACCOUNT_ACTIVITY_DOWNLOAD_COPY.invalidRange],
    ["too_large", "too_large", ACCOUNT_ACTIVITY_DOWNLOAD_COPY.tooLarge],
    ["read_failed", "unavailable", ACCOUNT_ACTIVITY_DOWNLOAD_COPY.unavailable],
    ["malformed_row", "unavailable", ACCOUNT_ACTIVITY_DOWNLOAD_COPY.unavailable],
    ["unpageable", "unavailable", ACCOUNT_ACTIVITY_DOWNLOAD_COPY.unavailable],
    ["inconsistent_paging", "unavailable", ACCOUNT_ACTIVITY_DOWNLOAD_COPY.unavailable],
  ])(
    "a collection that failed with %s is %s, with no file",
    async (reason, code, message) => {
      collector.collectAccountActivityForExport.mockResolvedValue({ ok: false, reason });

      const download = await prepare("from=2026-03-01");

      expect(download).toEqual({ ok: false, code, message });
      expect(download).not.toHaveProperty("body");
    },
  );

  it("tells the user the size limit and what to do about it", () => {
    expect(ACCOUNT_ACTIVITY_DOWNLOAD_COPY.tooLarge).toBe(
      "Your account activity in this period has more than 10,000 entries, too many for one file. Choose a shorter date range and try again.",
    );
  });
});
