// @vitest-environment node
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { createFakeSupabase, type FakeQuery, OK_RESPONSE } from "@/shared/test/supabase";

// The cookie-based (user) client. Building the real one needs request cookies.
const infra = vi.hoisted(() => ({ createClient: vi.fn<() => Promise<unknown>>() }));
vi.mock("@/infrastructure/auth/supabase/server", () => infra);

// Must never be touched: reads run as the user, never as the service role.
vi.mock("@/infrastructure/supabase/admin", () => ({
  createAdminClient: vi.fn(() => {
    throw new Error("the activity reader must not use the service role");
  }),
}));

import { decodeAccountActivityCursor, encodeAccountActivityCursor } from "./cursor";
import {
  ACCOUNT_ACTIVITY_DEFAULT_LIMIT,
  ACCOUNT_ACTIVITY_MAX_LIMIT,
  listAccountActivity,
} from "./list-account-activity";

const USER = "11111111-1111-4111-8111-111111111111";

const row = (
  id: number,
  details: unknown = { changes: { fullName: { from: "A", to: "B" } } },
) => ({
  id,
  event_type: "profile.updated",
  details,
  occurred_at: `2026-03-0${(id % 9) + 1}T10:00:00+00:00`,
});

const withRows = (rows: unknown[]) =>
  createFakeSupabase(() => ({ ...OK_RESPONSE, status: 200, data: rows }));

/** `{ method: args }` view of one query, for readable assertions. */
const shape = (query: FakeQuery) =>
  query.calls.map((call) => [call.method, ...call.args]);

beforeEach(() => {
  vi.clearAllMocks();
  vi.spyOn(console, "error").mockImplementation(() => {});
  vi.spyOn(console, "warn").mockImplementation(() => {});
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe("listAccountActivity – the query", () => {
  it("reads the user's rows as the user, newest first, one row beyond the page", async () => {
    const fake = withRows([]);
    infra.createClient.mockResolvedValue(fake.client);

    await listAccountActivity(USER, { limit: 5 });

    expect(infra.createClient).toHaveBeenCalledTimes(1);
    expect(fake.queries).toHaveLength(1);
    expect(fake.queries[0].table).toBe("account_activity");
    expect(shape(fake.queries[0])).toEqual([
      ["select", "id, event_type, details, occurred_at"],
      ["eq", "user_id", USER],
      ["order", "occurred_at", { ascending: false }],
      ["order", "id", { ascending: false }],
      ["limit", 6],
    ]);
  });

  it("with a cursor, reads only rows strictly older than that row in the list's order", async () => {
    const fake = withRows([]);
    const before = { occurredAt: "2026-03-01T10:00:00.123456+00:00", id: 42 };

    await listAccountActivity(USER, { limit: 5, before, supabase: fake.client });

    expect(shape(fake.queries[0])).toEqual([
      ["select", "id, event_type, details, occurred_at"],
      ["eq", "user_id", USER],
      [
        "or",
        'occurred_at.lt."2026-03-01T10:00:00.123456+00:00",and(occurred_at.eq."2026-03-01T10:00:00.123456+00:00",id.lt.42)',
      ],
      ["order", "occurred_at", { ascending: false }],
      ["order", "id", { ascending: false }],
      ["limit", 6],
    ]);
  });

  it("uses an injected client instead of building one", async () => {
    const fake = withRows([]);

    await listAccountActivity(USER, { supabase: fake.client });

    expect(infra.createClient).not.toHaveBeenCalled();
    expect(fake.queries).toHaveLength(1);
  });

  it.each([
    ["absent", undefined, ACCOUNT_ACTIVITY_DEFAULT_LIMIT],
    ["zero", 0, 1],
    ["negative", -3, 1],
    ["fractional", 2.7, 2],
    ["NaN", Number.NaN, ACCOUNT_ACTIVITY_DEFAULT_LIMIT],
    ["Infinity", Number.POSITIVE_INFINITY, ACCOUNT_ACTIVITY_DEFAULT_LIMIT],
    ["over the maximum", ACCOUNT_ACTIVITY_MAX_LIMIT + 50, ACCOUNT_ACTIVITY_MAX_LIMIT],
  ])("clamps the page size (%s)", async (_label, limit, expected) => {
    const fake = withRows([]);

    await listAccountActivity(USER, { limit, supabase: fake.client });

    expect(fake.argsOf(fake.queries[0], "limit")).toEqual([expected + 1]);
  });
});

describe("listAccountActivity – the result", () => {
  it("maps rows to typed entries and names the last row of the page as the next cursor", async () => {
    const fake = withRows([row(3), row(2), row(1)]);

    const result = await listAccountActivity(USER, { limit: 2, supabase: fake.client });

    expect(result).toEqual({
      ok: true,
      nextCursor: encodeAccountActivityCursor({
        occurredAt: "2026-03-03T10:00:00+00:00",
        id: 2,
      }),
      entries: [
        {
          id: 3,
          occurredAt: "2026-03-04T10:00:00+00:00",
          event: {
            type: "profile.updated",
            details: { changes: { fullName: { from: "A", to: "B" } } },
          },
        },
        {
          id: 2,
          occurredAt: "2026-03-03T10:00:00+00:00",
          event: {
            type: "profile.updated",
            details: { changes: { fullName: { from: "A", to: "B" } } },
          },
        },
      ],
    });
  });

  it("ends the list (no cursor) when the page is not full, and handles an empty history", async () => {
    const some = withRows([row(1)]);
    await expect(
      listAccountActivity(USER, { limit: 2, supabase: some.client }),
    ).resolves.toMatchObject({ ok: true, nextCursor: null });

    const exact = withRows([row(2), row(1)]);
    await expect(
      listAccountActivity(USER, { limit: 2, supabase: exact.client }),
    ).resolves.toMatchObject({ ok: true, nextCursor: null });

    const none = withRows([]);
    await expect(
      listAccountActivity(USER, { limit: 2, supabase: none.client }),
    ).resolves.toEqual({ ok: true, entries: [], nextCursor: null });

    const nullData = createFakeSupabase(() => ({
      ...OK_RESPONSE,
      status: 200,
      data: null,
    }));
    await expect(
      listAccountActivity(USER, { limit: 2, supabase: nullData.client }),
    ).resolves.toEqual({ ok: true, entries: [], nextCursor: null });
  });

  it("the next cursor decodes back to the last row shown, so the next page continues after it", async () => {
    const fake = withRows([row(3), row(2), row(1)]);

    const result = await listAccountActivity(USER, { limit: 2, supabase: fake.client });

    expect(result.ok && decodeAccountActivityCursor(result.nextCursor)).toEqual({
      occurredAt: "2026-03-03T10:00:00+00:00",
      id: 2,
    });
  });

  it("ends the list rather than offer a page it cannot ask for (last row has a malformed timestamp)", async () => {
    const fake = withRows([row(3), { ...row(2), occurred_at: "yesterday" }, row(1)]);

    const result = await listAccountActivity(USER, { limit: 2, supabase: fake.client });

    expect(result).toMatchObject({ ok: true, nextCursor: null });
    expect(console.error).toHaveBeenCalledWith(
      "[account-activity] last row of the page cannot form a cursor",
      { userId: USER },
    );
  });

  it("never exposes the user id on an entry", async () => {
    const fake = withRows([{ ...row(1), user_id: USER }]);

    const result = await listAccountActivity(USER, { supabase: fake.client });

    expect(JSON.stringify(result)).not.toContain(USER);
  });

  it("leaves out rows the catalogue cannot read, with one warning, keeping the rest", async () => {
    const fake = withRows([
      row(5),
      { ...row(4), event_type: "email.changed" }, // a type this version does not know
      { ...row(3), details: { changes: {} } }, // known type, details do not match
      { ...row(2), details: "not an object" },
      { id: "1", event_type: "profile.updated", details: {}, occurred_at: 1 }, // wrong column types
    ]);

    const result = await listAccountActivity(USER, { limit: 10, supabase: fake.client });

    expect(result).toMatchObject({ ok: true, nextCursor: null });
    expect(result.ok && result.entries.map((e) => e.id)).toEqual([5]);
    expect(console.warn).toHaveBeenCalledTimes(1);
    expect(console.warn).toHaveBeenCalledWith(
      "[account-activity] skipped entries the catalogue does not recognise",
      { userId: USER, skipped: 4 },
    );
  });

  it("pages on rows in the database, not on entries kept: unreadable rows still advance the cursor", async () => {
    // limit 2, three rows back: more exist — even if the two on the page are
    // unreadable, and the cursor names the second (unreadable) row, so the next
    // page does not loop on it.
    const fake = withRows([
      { ...row(3), event_type: "x.unknown" },
      { ...row(2), event_type: "x.unknown" },
      row(1),
    ]);

    await expect(
      listAccountActivity(USER, { limit: 2, supabase: fake.client }),
    ).resolves.toEqual({
      ok: true,
      entries: [],
      nextCursor: encodeAccountActivityCursor({
        occurredAt: "2026-03-03T10:00:00+00:00",
        id: 2,
      }),
    });
  });
});

describe("listAccountActivity – failures are reported, never thrown", () => {
  it("returns ok: false and logs code + message when the read is refused", async () => {
    const fake = createFakeSupabase(() => ({
      ...OK_RESPONSE,
      status: 403,
      data: null,
      error: {
        message: "permission denied for table account_activity",
        code: "42501",
        details: "SECRET",
        hint: "SECRET",
      },
    }));

    await expect(listAccountActivity(USER, { supabase: fake.client })).resolves.toEqual({
      ok: false,
    });

    expect(console.error).toHaveBeenCalledWith(
      "[account-activity] could not read history",
      {
        userId: USER,
        error: { message: "permission denied for table account_activity", code: "42501" },
      },
    );
    expect(JSON.stringify(vi.mocked(console.error).mock.calls)).not.toContain("SECRET");
  });

  it("turns a thrown error (client construction) into ok: false, logging only its class", async () => {
    infra.createClient.mockRejectedValue(new TypeError("cookies unavailable: SECRET"));

    await expect(listAccountActivity(USER)).resolves.toEqual({ ok: false });

    expect(console.error).toHaveBeenCalledWith(
      "[account-activity] reading history threw unexpectedly",
      { userId: USER, error: { name: "TypeError" } },
    );
    expect(JSON.stringify(vi.mocked(console.error).mock.calls)).not.toContain("SECRET");
  });

  it("turns a rejected query into ok: false as well", async () => {
    const fake = createFakeSupabase(() => {
      throw new Error("socket hang up");
    });

    await expect(listAccountActivity(USER, { supabase: fake.client })).resolves.toEqual({
      ok: false,
    });
  });
});
