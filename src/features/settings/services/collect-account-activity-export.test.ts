// @vitest-environment node
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { activityTable, micros, type StoredRow } from "@/shared/test/account-activity";
import { parseCsv } from "@/shared/test/csv";
import { createFakeSupabase, OK_RESPONSE } from "@/shared/test/supabase";
import { CSV_UTF8_BOM } from "@/shared/utils/csv";

// The cookie-based (user) client. Building the real one needs request cookies.
const infra = vi.hoisted(() => ({ createClient: vi.fn<() => Promise<unknown>>() }));
vi.mock("@/infrastructure/auth/supabase/server", () => infra);

// Must never be touched: the export reads as the user, never as the service role.
vi.mock("@/infrastructure/supabase/admin", () => ({
  createAdminClient: vi.fn(() => {
    throw new Error("the activity export must not use the service role");
  }),
}));

import {
  buildAccountActivityExportCsv,
  UNRECOGNISED_ACTIVITY_DETAIL,
  UNRECOGNISED_ACTIVITY_TITLE,
} from "./account-activity-export";
import {
  ACCOUNT_ACTIVITY_EXPORT_MAX_ENTRIES,
  ACCOUNT_ACTIVITY_EXPORT_PAGE_SIZE,
  collectAccountActivityForExport,
} from "./collect-account-activity-export";

const USER = "11111111-1111-4111-8111-111111111111";
const OTHER = "22222222-2222-4222-8222-222222222222";

const PROFILE = { changes: { fullName: { from: "A", to: "B" } } };

/** `count` rows for `user`, ids `firstId…`, one second apart, newest = highest id. */
const history = (count: number, user = USER, firstId = 1): StoredRow[] =>
  Array.from({ length: count }, (_, i) => ({
    id: firstId + i,
    user_id: user,
    event_type: "profile.updated",
    details: PROFILE,
    occurred_at: new Date(Date.UTC(2026, 0, 1) + (firstId + i) * 1000)
      .toISOString()
      .replace("Z", "+00:00"),
  }));

const idsOf = (
  result: Awaited<ReturnType<typeof collectAccountActivityForExport>>,
): number[] => {
  if (!result.ok) throw new Error(`expected ok, got ${result.reason}`);
  return result.entries.map((e) => e.id);
};

/** Ids newest first, as the export lists them. */
const newestFirst = (rows: StoredRow[]) =>
  [...rows]
    .sort(
      (a, b) =>
        micros(String(b.occurred_at)) - micros(String(a.occurred_at)) || b.id - a.id,
    )
    .map((row) => row.id);

beforeEach(() => {
  vi.clearAllMocks();
  vi.spyOn(console, "error").mockImplementation(() => {});
  vi.spyOn(console, "warn").mockImplementation(() => {});
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe("collectAccountActivityForExport – paging through everything", () => {
  it("reads at the maximum page size, as the user, filtered on the user", async () => {
    const fake = createFakeSupabase(activityTable(history(3)));
    infra.createClient.mockResolvedValue(fake.client);

    await collectAccountActivityForExport(USER);

    expect(ACCOUNT_ACTIVITY_EXPORT_PAGE_SIZE).toBe(100);
    expect(infra.createClient).toHaveBeenCalledTimes(1);
    expect(fake.queries[0].table).toBe("account_activity");
    expect(fake.argsOf(fake.queries[0], "eq")).toEqual(["user_id", USER]);
    expect(fake.argsOf(fake.queries[0], "limit")).toEqual([101]);
  });

  it("returns an empty history as ok with no entries (one read)", async () => {
    const fake = createFakeSupabase(activityTable([]));

    const result = await collectAccountActivityForExport(USER, { supabase: fake.client });

    expect(result).toEqual({ ok: true, entries: [], unrecognised: 0 });
    expect(fake.queries).toHaveLength(1);
  });

  it.each([
    [1, 1],
    [99, 1],
    [100, 1], // exactly one full page: the extra row says there is no more
    [101, 2], // one row over: a second page holding just that row
    [250, 3],
    [1_000, 10],
  ])(
    "collects all %i rows in %i reads, newest first, each exactly once",
    async (count, reads) => {
      const rows = history(count);
      const fake = createFakeSupabase(activityTable(rows));

      const result = await collectAccountActivityForExport(USER, {
        supabase: fake.client,
      });

      expect(idsOf(result)).toEqual(newestFirst(rows));
      expect(fake.queries).toHaveLength(reads);
    },
  );

  it("continues each page strictly after the last row of the one before", async () => {
    const fake = createFakeSupabase(activityTable(history(250)));

    await collectAccountActivityForExport(USER, { supabase: fake.client });

    expect(fake.argsOf(fake.queries[0], "or")).toBeUndefined();
    // Newest is id 250; page 1 ends at id 151, page 2 at id 51.
    expect(fake.argsOf(fake.queries[1], "or")?.[0]).toMatch(/,id\.lt\.151\)$/);
    expect(fake.argsOf(fake.queries[2], "or")?.[0]).toMatch(/,id\.lt\.51\)$/);
  });

  it("neither skips nor repeats rows that share a timestamp across a page boundary", async () => {
    // 250 rows recorded in the same instant (one transaction): only the id orders them.
    const rows = history(250).map((row) => ({
      ...row,
      occurred_at: "2026-03-01T10:00:00.123456+00:00",
    }));
    const fake = createFakeSupabase(activityTable(rows));

    const result = await collectAccountActivityForExport(USER, { supabase: fake.client });

    expect(idsOf(result)).toEqual(newestFirst(rows));
  });

  it("orders by the full microsecond timestamp, not by id, when they disagree", async () => {
    // Ids are not time-ordered across concurrent transactions.
    const rows = history(205).map((row, i) => ({
      ...row,
      occurred_at: `2026-03-01T10:00:00.${String(1000 + ((i * 7919) % 205)).padStart(6, "0")}+00:00`,
    }));
    const fake = createFakeSupabase(activityTable(rows));

    const result = await collectAccountActivityForExport(USER, { supabase: fake.client });

    expect(idsOf(result)).toEqual(newestFirst(rows));
  });

  it("never includes another account's rows", async () => {
    const rows = [...history(150, OTHER, 1), ...history(120, USER, 1_000)];
    const fake = createFakeSupabase(activityTable(rows));

    const result = await collectAccountActivityForExport(USER, { supabase: fake.client });

    expect(idsOf(result)).toEqual(newestFirst(rows.filter((r) => r.user_id === USER)));
    for (const query of fake.queries) {
      expect(fake.argsOf(query, "eq")).toEqual(["user_id", USER]);
    }
  });
});

describe("collectAccountActivityForExport – unrecognised entries are kept", () => {
  it("keeps an unknown event type and a known type with unreadable details, in place", async () => {
    const rows = history(5);
    rows[3] = {
      ...rows[3],
      event_type: "billing.plan_changed",
      details: { plan: "pro" },
    };
    rows[1] = { ...rows[1], details: { changes: {} } }; // profile.updated, old shape

    const fake = createFakeSupabase(activityTable(rows));

    const result = await collectAccountActivityForExport(USER, { supabase: fake.client });

    expect(result).toEqual({
      ok: true,
      unrecognised: 2,
      entries: [
        expect.objectContaining({ id: 5 }),
        {
          unrecognised: true,
          id: 4,
          occurredAt: rows[3].occurred_at,
          eventType: "billing.plan_changed",
        },
        expect.objectContaining({ id: 3 }),
        {
          unrecognised: true,
          id: 2,
          occurredAt: rows[1].occurred_at,
          eventType: "profile.updated",
        },
        expect.objectContaining({ id: 1 }),
      ],
    });
    expect(console.warn).toHaveBeenCalledWith(
      "[settings] account activity export includes unrecognised entries",
      { userId: USER, unrecognised: 2 },
    );
  });

  it("carries on past pages holding nothing but unrecognised entries", async () => {
    // The card shows such a page as "nothing to show yet"; the export must not
    // take it for the end.
    const rows = history(350).map((row) =>
      row.id > 100 ? { ...row, event_type: "future.event", details: {} } : row,
    );
    const fake = createFakeSupabase(activityTable(rows));

    const result = await collectAccountActivityForExport(USER, { supabase: fake.client });

    expect(idsOf(result)).toEqual(newestFirst(rows));
    expect(result).toMatchObject({ ok: true, unrecognised: 250 });
  });

  it("never passes on the stored details of an unrecognised entry", async () => {
    const rows = history(1).map((row) => ({
      ...row,
      event_type: "future.event",
      details: { secret: "do-not-export" },
    }));
    const fake = createFakeSupabase(activityTable(rows));

    const result = await collectAccountActivityForExport(USER, { supabase: fake.client });

    expect(JSON.stringify(result)).not.toContain("do-not-export");
  });

  it("ends up in the CSV as a row that says so, not as a gap", async () => {
    const rows = history(3);
    rows[1] = { ...rows[1], event_type: "future.event", details: { x: 1 } };
    const fake = createFakeSupabase(activityTable(rows));

    const result = await collectAccountActivityForExport(USER, { supabase: fake.client });
    if (!result.ok) throw new Error("expected ok");

    const csv = buildAccountActivityExportCsv(result.entries);
    const [, ...body] = parseCsv(csv.slice(CSV_UTF8_BOM.length));

    expect(body).toHaveLength(3);
    expect(body[1]).toEqual([
      "2026-01-01T00:00:02Z",
      UNRECOGNISED_ACTIVITY_TITLE,
      UNRECOGNISED_ACTIVITY_DETAIL,
      "future.event",
    ]);
  });
});

describe("collectAccountActivityForExport – all or nothing", () => {
  it("fails, with no entries, when a later page cannot be read", async () => {
    const table = activityTable(history(250));
    let reads = 0;
    const fake = createFakeSupabase((query) =>
      ++reads === 2
        ? {
            ...OK_RESPONSE,
            status: 500,
            data: null,
            error: { message: "timeout", code: "57014" },
          }
        : table(query),
    );

    const result = await collectAccountActivityForExport(USER, { supabase: fake.client });

    expect(result).toEqual({ ok: false, reason: "read_failed" });
    expect(fake.queries).toHaveLength(2);
  });

  it("fails when a read throws", async () => {
    const fake = createFakeSupabase(() => {
      throw new Error("socket hang up");
    });

    await expect(
      collectAccountActivityForExport(USER, { supabase: fake.client }),
    ).resolves.toEqual({ ok: false, reason: "read_failed" });
  });

  it("fails when the user's client cannot be built", async () => {
    infra.createClient.mockRejectedValue(new TypeError("cookies unavailable: SECRET"));

    await expect(collectAccountActivityForExport(USER)).resolves.toEqual({
      ok: false,
      reason: "read_failed",
    });
    expect(JSON.stringify(vi.mocked(console.error).mock.calls)).not.toContain("SECRET");
  });

  it("fails on a row it cannot read at all, rather than leave it out", async () => {
    const table = activityTable(history(120));
    // Row 60 sits mid-page; its timestamp arrives as a number (wrong column type).
    const fake = createFakeSupabase((query) => {
      const response = table(query);
      return {
        ...response,
        data: (response.data as StoredRow[]).map((r) =>
          r.id === 60 ? { ...r, occurred_at: 12345 } : r,
        ),
      };
    });

    await expect(
      collectAccountActivityForExport(USER, { supabase: fake.client }),
    ).resolves.toEqual({ ok: false, reason: "malformed_row" });
  });

  it("fails when more rows exist but the last row read cannot say where they start", async () => {
    const rows = history(150);
    const table = activityTable(rows);
    // Row 51 is the last of the first page (newest 150 → 51).
    const fake = createFakeSupabase((query) => {
      const response = table(query);
      return {
        ...response,
        data: (response.data as StoredRow[]).map((r) =>
          r.id === 51 ? { ...r, occurred_at: "yesterday" } : r,
        ),
      };
    });

    await expect(
      collectAccountActivityForExport(USER, { supabase: fake.client }),
    ).resolves.toEqual({ ok: false, reason: "unpageable" });
  });

  it("fails when the database ignores the cursor and serves the same page again", async () => {
    const table = activityTable(history(150));
    const fake = createFakeSupabase((query) =>
      table({ ...query, calls: query.calls.filter((c) => c.method !== "or") }),
    );

    await expect(
      collectAccountActivityForExport(USER, { supabase: fake.client }),
    ).resolves.toEqual({ ok: false, reason: "inconsistent_paging" });
    expect(fake.queries).toHaveLength(2);
  });

  it("fails when a later page overlaps rows already collected, even though the cursor moved", async () => {
    const rows = history(250);
    const table = activityTable(rows);
    let reads = 0;
    // The second read starts five rows too early (ids 155…), then pages on normally.
    const fake = createFakeSupabase((query) => {
      reads += 1;
      if (reads !== 2) return table(query);
      const shifted = {
        ...query,
        calls: query.calls.map((c) =>
          c.method === "or"
            ? {
                method: "or",
                args: [
                  `occurred_at.lt."${rows[155].occurred_at}",and(occurred_at.eq."${rows[155].occurred_at}",id.lt.156)`,
                ],
              }
            : c,
        ),
      };
      return table(shifted);
    });

    await expect(
      collectAccountActivityForExport(USER, { supabase: fake.client }),
    ).resolves.toEqual({ ok: false, reason: "inconsistent_paging" });
  });

  it("refuses a history over the limit as a whole, and accepts one exactly at it", async () => {
    const over = createFakeSupabase(activityTable(history(151)));
    await expect(
      collectAccountActivityForExport(USER, { supabase: over.client, maxEntries: 150 }),
    ).resolves.toEqual({ ok: false, reason: "too_large" });

    const exact = createFakeSupabase(activityTable(history(150)));
    const result = await collectAccountActivityForExport(USER, {
      supabase: exact.client,
      maxEntries: 150,
    });
    expect(idsOf(result)).toHaveLength(150);
  });

  it("has a default limit of 10,000 entries", () => {
    expect(ACCOUNT_ACTIVITY_EXPORT_MAX_ENTRIES).toBe(10_000);
  });

  it("logs why it refused, without row content", async () => {
    const rows = history(1).map((row) => ({ ...row, details: { secret: "SECRET" } }));
    const table = activityTable(rows);
    const fake = createFakeSupabase((query) => {
      const response = table(query);
      return {
        ...response,
        data: (response.data as StoredRow[]).map((r) => ({ ...r, id: "1" })),
      };
    });

    await collectAccountActivityForExport(USER, { supabase: fake.client });

    expect(console.error).toHaveBeenCalledWith(
      "[settings] account activity export refused",
      { userId: USER, reason: "malformed_row", pages: 1, malformed: 1 },
    );
    expect(JSON.stringify(vi.mocked(console.error).mock.calls)).not.toContain("SECRET");
  });
});

describe("collectAccountActivityForExport – date range", () => {
  const MARCH = { from: "2026-03-01", to: "2026-03-31" };

  /** One row per timestamp, ids in the order given. */
  const at = (timestamps: string[], user = USER, firstId = 1): StoredRow[] =>
    timestamps.map((occurred_at, i) => ({
      id: firstId + i,
      user_id: user,
      event_type: "profile.updated",
      details: PROFILE,
      occurred_at,
    }));

  /** `count` rows one hour apart, the first at `start` (ISO, UTC). */
  const hourly = (start: string, count: number, firstId = 1) =>
    at(
      Array.from({ length: count }, (_, i) =>
        new Date(Date.parse(start) + i * 3_600_000).toISOString().replace("Z", "+00:00"),
      ),
      USER,
      firstId,
    );

  it("asks the database for [midnight of the first day, midnight after the last) on every page", async () => {
    const fake = createFakeSupabase(activityTable(hourly("2026-03-01T00:00:00Z", 250)));

    await collectAccountActivityForExport(USER, { supabase: fake.client, range: MARCH });

    expect(fake.queries).toHaveLength(3);
    for (const query of fake.queries) {
      expect(fake.argsOf(query, "eq")).toEqual(["user_id", USER]);
      expect(fake.argsOf(query, "gte")).toEqual([
        "occurred_at",
        "2026-03-01T00:00:00.000Z",
      ]);
      expect(fake.argsOf(query, "lt")).toEqual([
        "occurred_at",
        "2026-04-01T00:00:00.000Z",
      ]);
    }
    // Paging still continues after the last row of each page, within the range.
    expect(fake.argsOf(fake.queries[1], "or")).toBeDefined();
  });

  it("sends only the bound that is set", async () => {
    const from = createFakeSupabase(activityTable([]));
    await collectAccountActivityForExport(USER, {
      supabase: from.client,
      range: { from: "2026-03-01", to: null },
    });
    expect(fake(from).methods).toEqual(expect.arrayContaining(["gte"]));
    expect(fake(from).methods).not.toContain("lt");

    const to = createFakeSupabase(activityTable([]));
    await collectAccountActivityForExport(USER, {
      supabase: to.client,
      range: { from: null, to: "2026-03-31" },
    });
    expect(fake(to).methods).toContain("lt");
    expect(fake(to).methods).not.toContain("gte");

    const open = createFakeSupabase(activityTable([]));
    await collectAccountActivityForExport(USER, {
      supabase: open.client,
      range: { from: null, to: null },
    });
    expect(fake(open).methods).not.toContain("gte");
    expect(fake(open).methods).not.toContain("lt");
  });

  it("includes the first and last microsecond of the range and nothing either side", async () => {
    const rows = at([
      "2026-02-28T23:59:59.999999+00:00", // out
      "2026-03-01T00:00:00+00:00", // in: first instant
      "2026-03-01T00:00:00.000001+00:00", // in
      "2026-03-31T23:59:59.999+00:00", // in
      "2026-03-31T23:59:59.999999+00:00", // in: last microsecond
      "2026-04-01T00:00:00+00:00", // out
      "2026-04-01T00:00:00.000001+00:00", // out
    ]);
    const fake = createFakeSupabase(activityTable(rows));

    const result = await collectAccountActivityForExport(USER, {
      supabase: fake.client,
      range: MARCH,
    });

    expect(idsOf(result)).toEqual([5, 4, 3, 2]);
  });

  it("collects every in-range row across many pages, whatever lies either side", async () => {
    // 24 rows before, 744 hourly rows in March, 30 after (ids in time order).
    const rows = [
      ...hourly("2026-02-28T00:00:00Z", 24, 1),
      ...hourly("2026-03-01T00:00:00Z", 744, 25),
      ...hourly("2026-04-01T00:00:00Z", 30, 769),
    ];
    const fake = createFakeSupabase(activityTable(rows));

    const result = await collectAccountActivityForExport(USER, {
      supabase: fake.client,
      range: MARCH,
    });

    expect(idsOf(result)).toEqual(
      newestFirst(rows.filter((r) => String(r.occurred_at).startsWith("2026-03"))),
    );
    expect(idsOf(result)).toHaveLength(744);
    expect(fake.queries).toHaveLength(8);
  });

  it("covers a one-day range completely, including rows sharing a timestamp at the boundary", async () => {
    const rows = [
      ...at(Array(120).fill("2026-03-15T00:00:00+00:00"), USER, 1), // first instant, 120 ties
      ...at(Array(5).fill("2026-03-15T12:00:00+00:00"), USER, 121),
      ...at(Array(3).fill("2026-03-16T00:00:00+00:00"), USER, 126), // next day: out
      ...at(Array(3).fill("2026-03-14T23:59:59.999999+00:00"), USER, 129), // day before: out
    ];
    const fake = createFakeSupabase(activityTable(rows));

    const result = await collectAccountActivityForExport(USER, {
      supabase: fake.client,
      range: { from: "2026-03-15", to: "2026-03-15" },
    });

    expect(idsOf(result)).toHaveLength(125);
    expect(idsOf(result)).toEqual(newestFirst(rows.slice(0, 125)));
  });

  it("places rows stored with other offsets by their UTC instant", async () => {
    const rows = at([
      "2026-03-01T00:30:00+01:00", // 28 Feb 23:30 UTC: out
      "2026-02-28T23:30:00-01:00", // 1 Mar 00:30 UTC: in
      "2026-04-01T00:30:00+01:00", // 31 Mar 23:30 UTC: in
      "2026-03-31T23:30:00-01:00", // 1 Apr 00:30 UTC: out
    ]);
    const fake = createFakeSupabase(activityTable(rows));

    const result = await collectAccountActivityForExport(USER, {
      supabase: fake.client,
      range: MARCH,
    });

    expect(idsOf(result)).toEqual([3, 2]);
  });

  it("returns a range that matches nothing as an empty, successful export", async () => {
    const fake = createFakeSupabase(activityTable(hourly("2026-01-01T00:00:00Z", 300)));

    await expect(
      collectAccountActivityForExport(USER, { supabase: fake.client, range: MARCH }),
    ).resolves.toEqual({ ok: true, entries: [], unrecognised: 0 });
    expect(fake.queries).toHaveLength(1);
  });

  it("keeps unrecognised entries that fall inside the range", async () => {
    const rows = hourly("2026-02-28T22:00:00Z", 4).map((row) => ({
      ...row,
      event_type: "future.event",
      details: {},
    }));
    const fake = createFakeSupabase(activityTable(rows));

    const result = await collectAccountActivityForExport(USER, {
      supabase: fake.client,
      range: MARCH,
    });

    // 22:00 and 23:00 on 28 Feb are out; 00:00 and 01:00 on 1 Mar are in.
    expect(result).toMatchObject({
      ok: true,
      unrecognised: 2,
      entries: [
        { unrecognised: true, id: 4 },
        { unrecognised: true, id: 3 },
      ],
    });
  });

  it("never includes another account's rows inside the range", async () => {
    const rows = [
      ...hourly("2026-03-01T00:00:00Z", 150, 1),
      ...hourly("2026-03-01T00:30:00Z", 150, 1_000).map((r) => ({
        ...r,
        user_id: OTHER,
      })),
    ];
    const fake = createFakeSupabase(activityTable(rows));

    const result = await collectAccountActivityForExport(USER, {
      supabase: fake.client,
      range: MARCH,
    });

    expect(idsOf(result)).toEqual(newestFirst(rows.filter((r) => r.user_id === USER)));
  });

  describe("when the database returns rows outside the range anyway", () => {
    it("leaves them out but keeps paging — pages holding only such rows do not end the export", async () => {
      // 300 rows, only the OLDEST 50 in March: with the range ignored, the first
      // two pages hold nothing in range.
      const rows = [
        ...hourly("2026-03-29T00:00:00Z", 50, 1), // 29 Mar 00:00 … 31 Mar 01:00
        ...hourly("2026-04-10T00:00:00Z", 250, 51),
      ];
      const fake = createFakeSupabase(activityTable(rows, { ignoreRange: true }));

      const result = await collectAccountActivityForExport(USER, {
        supabase: fake.client,
        range: MARCH,
      });

      expect(idsOf(result)).toEqual(newestFirst(rows.slice(0, 50)));
      expect(fake.queries).toHaveLength(3);
      expect(console.warn).toHaveBeenCalledWith(
        "[settings] account activity export left out rows outside the range",
        { userId: USER, outOfRange: 250 },
      );
    });

    it("counts them towards the size limit, so an ignored range cannot page without bound", async () => {
      const rows = [
        ...hourly("2026-03-30T00:00:00Z", 10, 1),
        ...hourly("2026-04-10T00:00:00Z", 200, 11),
      ];
      const fake = createFakeSupabase(activityTable(rows, { ignoreRange: true }));

      await expect(
        collectAccountActivityForExport(USER, {
          supabase: fake.client,
          range: MARCH,
          maxEntries: 150,
        }),
      ).resolves.toEqual({ ok: false, reason: "too_large" });
    });
  });

  it("with the range applied, only rows inside it count towards the size limit", async () => {
    const rows = [
      ...hourly("2026-03-01T00:00:00Z", 120, 1),
      ...hourly("2026-05-01T00:00:00Z", 500, 121),
    ];
    const fake = createFakeSupabase(activityTable(rows));

    const result = await collectAccountActivityForExport(USER, {
      supabase: fake.client,
      range: MARCH,
      maxEntries: 150,
    });

    expect(idsOf(result)).toHaveLength(120);
  });

  describe("failures still fail the whole export", () => {
    it("a later page that cannot be read", async () => {
      const table = activityTable(hourly("2026-03-01T00:00:00Z", 250));
      let reads = 0;
      const fake = createFakeSupabase((query) =>
        ++reads === 3
          ? { ...OK_RESPONSE, status: 503, data: null, error: { message: "unavailable" } }
          : table(query),
      );

      await expect(
        collectAccountActivityForExport(USER, { supabase: fake.client, range: MARCH }),
      ).resolves.toEqual({ ok: false, reason: "read_failed" });
    });

    it("a row whose time cannot be read (it cannot be placed in or out of the range)", async () => {
      const table = activityTable(hourly("2026-03-01T00:00:00Z", 50));
      const fake = createFakeSupabase((query) => {
        const response = table(query);
        return {
          ...response,
          data: (response.data as StoredRow[]).map((r) =>
            r.id === 20 ? { ...r, occurred_at: "sometime in March" } : r,
          ),
        };
      });

      await expect(
        collectAccountActivityForExport(USER, { supabase: fake.client, range: MARCH }),
      ).resolves.toEqual({ ok: false, reason: "malformed_row" });
    });

    it("more rows in range but no way to ask for them", async () => {
      const table = activityTable(hourly("2026-03-01T00:00:00Z", 150));
      // Newest is id 150; the first page ends at id 51.
      const fake = createFakeSupabase((query) => {
        const response = table(query);
        return {
          ...response,
          data: (response.data as StoredRow[]).map((r) =>
            r.id === 51 ? { ...r, occurred_at: "2026-03-03" } : r,
          ),
        };
      });

      await expect(
        collectAccountActivityForExport(USER, { supabase: fake.client, range: MARCH }),
      ).resolves.toEqual({ ok: false, reason: "unpageable" });
    });

    it("more in-range rows than the limit", async () => {
      const fake = createFakeSupabase(activityTable(hourly("2026-03-01T00:00:00Z", 151)));

      await expect(
        collectAccountActivityForExport(USER, {
          supabase: fake.client,
          range: MARCH,
          maxEntries: 150,
        }),
      ).resolves.toEqual({ ok: false, reason: "too_large" });
    });
  });

  describe("an invalid range is refused before anything is read", () => {
    it.each([
      ["swapped ends", { from: "2026-03-31", to: "2026-03-01" }],
      ["a day that does not exist", { from: "2026-02-30", to: null }],
      ["a timestamp instead of a day", { from: "2026-03-01T00:00:00Z", to: null }],
      ["a year out of bounds", { from: null, to: "2200-01-01" }],
      ["a missing field", { from: "2026-03-01" }],
      ["not a string", { from: 20260301, to: null }],
      ["a filter smuggled in", { from: '2026-03-01",occurred_at.gt."1970', to: null }],
      ["not an object", "2026-03"],
    ])("%s", async (_label, range) => {
      const fake = createFakeSupabase(activityTable(history(3)));
      infra.createClient.mockResolvedValue(fake.client);

      await expect(
        collectAccountActivityForExport(USER, {
          range: range as unknown as { from: string | null; to: string | null },
        }),
      ).resolves.toEqual({ ok: false, reason: "invalid_range" });
      expect(infra.createClient).not.toHaveBeenCalled();
      expect(fake.queries).toHaveLength(0);
    });
  });
});

/** Method names chained onto the queries of a fake client. */
function fake(client: ReturnType<typeof createFakeSupabase>) {
  return { methods: client.queries.flatMap((q) => q.calls.map((c) => c.method)) };
}
