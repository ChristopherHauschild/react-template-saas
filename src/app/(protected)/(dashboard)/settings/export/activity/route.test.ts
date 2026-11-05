// @vitest-environment node
/**
 * The account activity download, end to end through the route: the real
 * guard, range parsing, collector, CSV builder and response. Only the
 * boundaries are stand-ins — the session lookup, and the user's Supabase
 * client, backed by an in-memory `account_activity` table that honours the
 * user filter, the date range and keyset paging like PostgREST.
 */
import { NextRequest } from "next/server";

import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

class RedirectSignal extends Error {
  constructor(public readonly url: string) {
    super(`NEXT_REDIRECT ${url}`);
  }
}

vi.mock("next/navigation", () => ({
  redirect: vi.fn((url: string) => {
    throw new RedirectSignal(url);
  }),
}));

const auth = vi.hoisted(() => ({
  getCurrentUser: vi.fn<() => Promise<{ id: string; email?: string | null } | null>>(),
}));
vi.mock("@/infrastructure/auth/session/get-current-user", () => auth);

const supabase = vi.hoisted(() => ({ createClient: vi.fn<() => Promise<unknown>>() }));
vi.mock("@/infrastructure/auth/supabase/server", () => supabase);

// Must never be touched: the export reads as the user, never as the service role.
vi.mock("@/infrastructure/supabase/admin", () => ({
  createAdminClient: vi.fn(() => {
    throw new Error("the activity export must not use the service role");
  }),
}));

import { ACCOUNT_ACTIVITY_DOWNLOAD_PATH } from "@/features/settings/services/account-activity-download";
import { activityTable, type StoredRow } from "@/shared/test/account-activity";
import { parseCsv } from "@/shared/test/csv";
import { createFakeSupabase, OK_RESPONSE } from "@/shared/test/supabase";
import { CSV_UTF8_BOM } from "@/shared/utils/csv";
import { DATE_RANGE_ERRORS } from "@/shared/utils/date-range";

import { GET } from "./route";

const USER = { id: "11111111-1111-4111-8111-111111111111", email: "jane@example.com" };
const OTHER = "22222222-2222-4222-8222-222222222222";
const NOW = new Date("2026-04-05T12:00:00Z");

/** `count` display-name changes for `user`, one hour apart from `start`, ids from `firstId`. */
const hourly = (start: string, count: number, user = USER.id, firstId = 1): StoredRow[] =>
  Array.from({ length: count }, (_, i) => ({
    id: firstId + i,
    user_id: user,
    event_type: "profile.updated",
    details: { changes: { fullName: { from: `Name ${i}`, to: `Name ${i + 1}` } } },
    occurred_at: new Date(Date.parse(start) + i * 3_600_000)
      .toISOString()
      .replace("Z", "+00:00"),
  }));

let table: ReturnType<typeof createFakeSupabase>;

/** Serves `rows` as the signed-in user's `account_activity`. */
const holding = (rows: StoredRow[], respond = activityTable(rows)) => {
  table = createFakeSupabase(respond);
  supabase.createClient.mockResolvedValue(table.client);
};

const download = (query = "") =>
  GET(
    new NextRequest(`https://app.example.com${ACCOUNT_ACTIVITY_DOWNLOAD_PATH}${query}`),
  );

/** The response body as a spreadsheet would read it: BOM checked and stripped, then parsed. */
const csvOf = async (response: Response) => {
  const text = new TextDecoder("utf-8", { ignoreBOM: true }).decode(
    await response.arrayBuffer(),
  );
  expect(text.startsWith(CSV_UTF8_BOM)).toBe(true);
  return parseCsv(text.slice(CSV_UTF8_BOM.length));
};

/** A failed download: no file of any kind, just the message. */
const expectNoFile = async (response: Response, status: number, code: string) => {
  expect(response.status).toBe(status);
  expect(response.headers.get("x-export-error")).toBe(code);
  expect(response.headers.get("content-disposition")).toBeNull();
  expect(response.headers.get("content-type")).toBe("text/plain; charset=utf-8");
  expect(response.headers.get("cache-control")).toBe("no-store");
  const body = await response.text();
  expect(body).not.toContain(CSV_UTF8_BOM);
  expect(body).not.toContain("Time (UTC)");
  expect(body).not.toContain("Display name changed");
  return body;
};

beforeEach(() => {
  vi.clearAllMocks();
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(NOW);
  vi.spyOn(console, "error").mockImplementation(() => {});
  vi.spyOn(console, "warn").mockImplementation(() => {});
  auth.getCurrentUser.mockResolvedValue(USER);
  holding(hourly("2026-03-01T00:00:00Z", 3));
});

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

it("is served at ACCOUNT_ACTIVITY_DOWNLOAD_PATH", () => {
  // This file's directory under src/app, route groups removed, is the URL.
  const segments = __dirname.split(path.sep);
  const url = segments
    .slice(segments.lastIndexOf("app") + 1)
    .filter((segment) => !/^\(.+\)$/.test(segment))
    .join("/");

  expect(`/${url}`).toBe(ACCOUNT_ACTIVITY_DOWNLOAD_PATH);
});

describe("GET /settings/export/activity – who", () => {
  it("sends a visitor without a session to /login before reading anything", async () => {
    auth.getCurrentUser.mockResolvedValue(null);

    await expect(download("?from=2026-03-01")).rejects.toMatchObject({ url: "/login" });
    expect(supabase.createClient).not.toHaveBeenCalled();
  });

  it("reads only the session user's rows, with the user's own client", async () => {
    holding([
      ...hourly("2026-03-01T00:00:00Z", 150, USER.id, 1),
      ...hourly("2026-03-01T00:30:00Z", 150, OTHER, 1_000),
    ]);

    const response = await download();

    expect((await csvOf(response)).slice(1)).toHaveLength(150);
    expect(table.queries.length).toBeGreaterThan(1);
    for (const query of table.queries) {
      expect(table.argsOf(query, "eq")).toEqual(["user_id", USER.id]);
    }
  });

  it("ignores any user named in the query string", async () => {
    holding(hourly("2026-03-01T00:00:00Z", 5, OTHER));

    const response = await download(`?userId=${OTHER}&user_id=${OTHER}`);

    expect((await csvOf(response)).slice(1)).toEqual([]);
    expect(table.argsOf(table.queries[0], "eq")).toEqual(["user_id", USER.id]);
  });
});

describe("GET /settings/export/activity – a complete file", () => {
  it("answers the whole history as a CSV attachment, never cached", async () => {
    holding(hourly("2026-01-01T00:00:00Z", 250));

    const response = await download();

    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toBe("text/csv; charset=utf-8");
    expect(response.headers.get("content-disposition")).toBe(
      'attachment; filename="account-activity-2026-04-05.csv"',
    );
    expect(response.headers.get("cache-control")).toBe("no-store");

    const rows = await csvOf(response);
    expect(rows[0]).toEqual(["Time (UTC)", "Activity", "Details", "Event type"]);
    expect(rows).toHaveLength(251);
    expect(rows[1]).toEqual([
      "2026-01-11T09:00:00Z", // the newest of 250 hourly rows from 1 January
      "Display name changed",
      "From \u201CName 249\u201D to \u201CName 250\u201D.",
      "profile.updated",
    ]);
    expect(table.queries).toHaveLength(3);
  });

  it("states the exact byte length, non-ASCII text included", async () => {
    holding(
      hourly("2026-03-01T00:00:00Z", 1).map((row) => ({
        ...row,
        details: { changes: { fullName: { from: "Zo\u00EB", to: "\u674E\u96F7" } } },
      })),
    );

    const response = await download();
    const bytes = await response.arrayBuffer();

    expect(Number(response.headers.get("content-length"))).toBe(bytes.byteLength);
  });

  it("lists entries this version cannot describe instead of leaving gaps", async () => {
    holding(
      hourly("2026-03-01T00:00:00Z", 3).map((row) =>
        row.id === 2 ? { ...row, event_type: "future.event", details: { x: 1 } } : row,
      ),
    );

    const rows = (await csvOf(await download())).slice(1);

    expect(rows.map((row) => row[3])).toEqual([
      "profile.updated",
      "future.event",
      "profile.updated",
    ]);
    expect(rows[1][1]).toBe("Unrecognised activity");
  });

  it("answers an empty history as a header-only file", async () => {
    holding([]);

    const response = await download();

    expect(response.status).toBe(200);
    expect(await csvOf(response)).toEqual([
      ["Time (UTC)", "Activity", "Details", "Event type"],
    ]);
  });
});

describe("GET /settings/export/activity – date range, applied on the server", () => {
  beforeEach(() => {
    holding([
      ...hourly("2026-02-28T20:00:00Z", 4, USER.id, 1), // 28 Feb 20:00–23:00: out
      ...hourly("2026-03-01T00:00:00Z", 744, USER.id, 5), // all of March: in
      ...hourly("2026-04-01T00:00:00Z", 5, USER.id, 749), // 1 Apr: out
    ]);
  });

  it("exports exactly the days asked for, and says so in the file name", async () => {
    const response = await download("?from=2026-03-01&to=2026-03-31");

    expect(response.status).toBe(200);
    expect(response.headers.get("content-disposition")).toBe(
      'attachment; filename="account-activity-2026-03-01-to-2026-03-31.csv"',
    );
    const rows = (await csvOf(response)).slice(1);
    expect(rows).toHaveLength(744);
    expect(rows[0][0]).toBe("2026-03-31T23:00:00Z");
    expect(rows.at(-1)![0]).toBe("2026-03-01T00:00:00Z");

    for (const query of table.queries) {
      expect(table.argsOf(query, "gte")).toEqual([
        "occurred_at",
        "2026-03-01T00:00:00.000Z",
      ]);
      expect(table.argsOf(query, "lt")).toEqual([
        "occurred_at",
        "2026-04-01T00:00:00.000Z",
      ]);
    }
  });

  it.each([
    ["?from=2026-04-01", "account-activity-from-2026-04-01.csv", 5],
    ["?to=2026-02-28", "account-activity-to-2026-02-28.csv", 4],
    ["?from=&to=", "account-activity-2026-04-05.csv", 753],
    [
      "?from=2026-03-15&to=2026-03-15",
      "account-activity-2026-03-15-to-2026-03-15.csv",
      24,
    ],
  ])("%s → %s with %i rows", async (query, fileName, count) => {
    const response = await download(query);

    expect(response.headers.get("content-disposition")).toBe(
      `attachment; filename="${fileName}"`,
    );
    expect((await csvOf(response)).slice(1)).toHaveLength(count);
  });

  it("answers a range with nothing in it as a header-only file", async () => {
    const response = await download("?from=2025-01-01&to=2025-12-31");

    expect(response.status).toBe(200);
    expect(await csvOf(response)).toHaveLength(1);
  });
});

describe("GET /settings/export/activity – an invalid range reads nothing", () => {
  it.each([
    ["?from=2026-02-30", { From: DATE_RANGE_ERRORS.day }],
    ["?to=31/03/2026", { To: DATE_RANGE_ERRORS.date }],
    ["?from=1999-12-31", { From: DATE_RANGE_ERRORS.year }],
    ["?from=2026-04-01&to=2026-03-01", { Dates: DATE_RANGE_ERRORS.range }],
    ["?from=2026-03-01&from=2026-01-01", { From: DATE_RANGE_ERRORS.multiple }],
    ["?from=2026-03-01T00:00:00Z", { From: DATE_RANGE_ERRORS.date }],
    [
      `?from=${encodeURIComponent('2026-03-01",occurred_at.gt."1970-01-01')}`,
      { From: DATE_RANGE_ERRORS.date },
    ],
  ])("%s", async (query, fields) => {
    const response = await download(query);

    const body = await expectNoFile(response, 400, "invalid_range");
    expect(body).toBe(
      [
        "Check the dates of your export.",
        ...Object.entries(fields).map(([label, message]) => `${label}: ${message}`),
        "",
      ].join("\n"),
    );
    expect(supabase.createClient).not.toHaveBeenCalled();
  });
});

describe("GET /settings/export/activity – a failed export answers no file, never part of one", () => {
  it("when a later page cannot be read", async () => {
    const rows = hourly("2026-01-01T00:00:00Z", 250);
    const respond = activityTable(rows);
    let reads = 0;
    holding(rows, (query) =>
      ++reads === 2
        ? {
            ...OK_RESPONSE,
            status: 500,
            data: null,
            error: { message: "timeout", code: "57014" },
          }
        : respond(query),
    );

    const body = await expectNoFile(await download(), 503, "unavailable");

    expect(body).toMatch(/^We couldn't export your account activity right now\./);
    expect(reads).toBe(2);
  });

  it("when a row cannot be read", async () => {
    const rows = hourly("2026-01-01T00:00:00Z", 20);
    const respond = activityTable(rows);
    holding(rows, (query) => {
      const response = respond(query);
      return {
        ...response,
        data: (response.data as StoredRow[]).map((r) =>
          r.id === 7 ? { ...r, id: "7" } : r,
        ),
      };
    });

    await expectNoFile(await download(), 503, "unavailable");
  });

  it("when the user's client cannot be built", async () => {
    supabase.createClient.mockRejectedValue(new Error("cookies unavailable"));

    await expectNoFile(await download(), 503, "unavailable");
  });

  it("when a range is given and a later page fails", async () => {
    const rows = hourly("2026-03-01T00:00:00Z", 300);
    const respond = activityTable(rows);
    let reads = 0;
    holding(rows, (query) => {
      if (++reads === 3) throw new Error("socket hang up");
      return respond(query);
    });

    await expectNoFile(
      await download("?from=2026-03-01&to=2026-03-31"),
      503,
      "unavailable",
    );
  });
});
