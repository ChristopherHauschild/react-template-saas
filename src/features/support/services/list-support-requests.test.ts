// @vitest-environment node
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { createFakeSupabase, type FakeQuery, OK_RESPONSE } from "@/shared/test/supabase";

// The cookie-based (user) client. Building the real one needs request cookies.
const infra = vi.hoisted(() => ({ createClient: vi.fn<() => Promise<unknown>>() }));
vi.mock("@/infrastructure/auth/supabase/server", () => infra);

// Must never be touched: reads run as the user, so row level security applies.
vi.mock("@/infrastructure/supabase/admin", () => ({
  createAdminClient: vi.fn(() => {
    throw new Error("the request reader must not use the service role");
  }),
}));

import {
  listSupportRequests,
  SUPPORT_REQUESTS_DEFAULT_LIMIT,
  SUPPORT_REQUESTS_MAX_LIMIT,
} from "./list-support-requests";
import {
  decodeSupportRequestCursor,
  encodeSupportRequestCursor,
} from "./support-request-cursor";

const USER = "11111111-1111-4111-8111-111111111111";
const SELECT = "id, created_at, category, status, subject, message";

const id = (n: number) =>
  `3f2504e0-4f89-41d3-9a0c-0305e82c33${String(n).padStart(2, "0")}`;

const row = (n: number, overrides: Record<string, unknown> = {}) => ({
  id: id(n),
  created_at: `2026-03-${String(n).padStart(2, "0")}T10:00:00+00:00`,
  category: "billing",
  status: "open",
  subject: `Request ${n}`,
  message: "Details.",
  ...overrides,
});

const withRows = (rows: unknown[]) =>
  createFakeSupabase(() => ({ ...OK_RESPONSE, status: 200, data: rows }));

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

describe("listSupportRequests – the query", () => {
  it("reads the user's own rows as the user, newest first, one row beyond the page", async () => {
    const fake = withRows([]);
    infra.createClient.mockResolvedValue(fake.client);

    await listSupportRequests(USER, { limit: 5 });

    expect(infra.createClient).toHaveBeenCalledTimes(1);
    expect(fake.queries).toHaveLength(1);
    expect(fake.queries[0].table).toBe("support_requests");
    expect(shape(fake.queries[0])).toEqual([
      ["select", SELECT],
      // Belt and braces: row level security already restricts the read.
      ["eq", "user_id", USER],
      ["order", "created_at", { ascending: false }],
      ["order", "id", { ascending: false }],
      ["limit", 6],
    ]);
  });

  it("with a cursor, reads only rows strictly older than that row in the list's order", async () => {
    const fake = withRows([]);
    const before = { createdAt: "2026-03-01T10:00:00.123456+00:00", id: id(7) };

    await listSupportRequests(USER, { limit: 5, before, supabase: fake.client });

    expect(shape(fake.queries[0])).toEqual([
      ["select", SELECT],
      ["eq", "user_id", USER],
      [
        "or",
        `created_at.lt."2026-03-01T10:00:00.123456+00:00",and(created_at.eq."2026-03-01T10:00:00.123456+00:00",id.lt.${id(7)})`,
      ],
      ["order", "created_at", { ascending: false }],
      ["order", "id", { ascending: false }],
      ["limit", 6],
    ]);
  });

  it.each([
    ["no limit", undefined, SUPPORT_REQUESTS_DEFAULT_LIMIT],
    ["zero", 0, 1],
    ["a negative limit", -5, 1],
    ["a fractional limit", 7.9, 7],
    ["more than the maximum", 5000, SUPPORT_REQUESTS_MAX_LIMIT],
    ["NaN", Number.NaN, SUPPORT_REQUESTS_DEFAULT_LIMIT],
    ["Infinity", Number.POSITIVE_INFINITY, SUPPORT_REQUESTS_DEFAULT_LIMIT],
  ])("clamps %s to %s", async (_label, limit, expected) => {
    const fake = withRows([]);

    await listSupportRequests(USER, { limit, supabase: fake.client });

    expect(fake.argsOf(fake.queries[0], "limit")).toEqual([expected + 1]);
  });
});

describe("listSupportRequests – pages", () => {
  it("returns a page and a cursor naming its last row when more exist", async () => {
    const rows = [row(5), row(4), row(3)];
    const fake = withRows(rows);

    const result = await listSupportRequests(USER, { limit: 2, supabase: fake.client });

    expect(result).toMatchObject({ ok: true });
    if (!result.ok) return;

    expect(result.requests.map((r) => r.subject)).toEqual(["Request 5", "Request 4"]);
    expect(decodeSupportRequestCursor(result.nextCursor)).toEqual({
      createdAt: rows[1].created_at,
      id: rows[1].id,
    });
  });

  it("has no cursor when the extra row is absent (the last page)", async () => {
    const fake = withRows([row(2), row(1)]);

    const result = await listSupportRequests(USER, { limit: 2, supabase: fake.client });

    expect(result).toEqual({
      ok: true,
      requests: [
        expect.objectContaining({ subject: "Request 2" }),
        expect.objectContaining({ subject: "Request 1" }),
      ],
      nextCursor: null,
    });
  });

  it("returns an empty page for a user with no requests", async () => {
    const fake = withRows([]);

    await expect(listSupportRequests(USER, { supabase: fake.client })).resolves.toEqual({
      ok: true,
      requests: [],
      nextCursor: null,
    });
  });

  it("paging with the returned cursor walks the list without repeats or gaps", async () => {
    const all = [row(5), row(4), row(3), row(2), row(1)];
    const fake = createFakeSupabase((query) => {
      const or = query.calls.find((call) => call.method === "or")?.args[0] as
        | string
        | undefined;
      const after = or ? all.findIndex((r) => or.includes(r.id)) + 1 : 0;

      return { ...OK_RESPONSE, status: 200, data: all.slice(after, after + 3) };
    });

    const seen: string[] = [];
    let cursor: string | null = null;

    for (let guard = 0; guard < 10; guard++) {
      const before = cursor ? decodeSupportRequestCursor(cursor) : undefined;
      const page = await listSupportRequests(USER, {
        limit: 2,
        ...(before ? { before } : {}),
        supabase: fake.client,
      });

      expect(page.ok).toBe(true);
      if (!page.ok) break;

      seen.push(...page.requests.map((r) => r.subject));
      cursor = page.nextCursor;
      if (!cursor) break;
    }

    expect(cursor).toBeNull();
    expect(seen).toEqual([
      "Request 5",
      "Request 4",
      "Request 3",
      "Request 2",
      "Request 1",
    ]);
  });

  it("skips rows it cannot display but still reports whether more exist", async () => {
    const fake = withRows([row(5), { ...row(4), id: "not-a-uuid" }, row(3)]);

    const result = await listSupportRequests(USER, { limit: 2, supabase: fake.client });

    expect(result).toMatchObject({ ok: true });
    if (!result.ok) return;

    expect(result.requests.map((r) => r.subject)).toEqual(["Request 5"]);
    // The page held two database rows, so there is another page. Its last row
    // has no usable position, so paging resumes from the row before it.
    expect(decodeSupportRequestCursor(result.nextCursor)).toEqual({
      createdAt: row(5).created_at,
      id: row(5).id,
    });
    expect(console.warn).toHaveBeenCalledWith(
      "[support] skipped rows that cannot be displayed",
      { userId: USER, skipped: 1 },
    );
  });

  it("keeps requests whose category or status this version does not know", async () => {
    const fake = withRows([row(1, { category: "shipping", status: "escalated" })]);

    const result = await listSupportRequests(USER, { supabase: fake.client });

    expect(result).toMatchObject({
      ok: true,
      requests: [
        expect.objectContaining({ category: null, status: null, subject: "Request 1" }),
      ],
    });
  });

  it("stops paging only when no row of the page has a usable position", async () => {
    const fake = withRows([
      { ...row(3), created_at: "whenever" },
      { ...row(2), id: "nope" },
      row(1),
    ]);

    const result = await listSupportRequests(USER, { limit: 2, supabase: fake.client });

    expect(result).toMatchObject({ ok: true, nextCursor: null });
    expect(console.error).toHaveBeenCalledWith(
      "[support] no row of the page can form a cursor",
      {
        userId: USER,
      },
    );
  });

  it("never re-offers the same position, so paging cannot loop", async () => {
    // The page's last row is unusable; the cursor names the row before it, and
    // the next page starts strictly older than that row.
    const fake = withRows([row(3), { ...row(2), id: "nope" }, row(1)]);

    const result = await listSupportRequests(USER, { limit: 2, supabase: fake.client });

    expect(result).toMatchObject({ ok: true });
    if (!result.ok) return;

    expect(decodeSupportRequestCursor(result.nextCursor)).toEqual({
      createdAt: row(3).created_at,
      id: row(3).id,
    });
    expect(console.warn).toHaveBeenCalledWith(
      "[support] paging from an earlier row of the page",
      {
        userId: USER,
        skipped: 1,
      },
    );
  });

  it("never exposes the owner column to callers", async () => {
    const fake = withRows([row(1, { user_id: USER })]);

    const result = await listSupportRequests(USER, { supabase: fake.client });

    expect(JSON.stringify(result)).not.toContain(USER);
  });
});

describe("listSupportRequests – failures", () => {
  it.each([
    ["42501", "sessionExpired"],
    ["PGRST301", "sessionExpired"],
    ["42P01", "unavailable"],
  ])("maps SQLSTATE %s to %s and logs only the code", async (code, failure) => {
    const fake = createFakeSupabase(() => ({
      ...OK_RESPONSE,
      status: 400,
      data: null,
      error: { message: "Failing row contains (…, 'private')", code },
    }));

    await expect(listSupportRequests(USER, { supabase: fake.client })).resolves.toEqual({
      ok: false,
      failure,
    });

    const [, logged] = vi.mocked(console.error).mock.calls[0];
    expect(logged).toEqual({ userId: USER, failure, error: { code } });
  });

  it("never throws when the client or the network does", async () => {
    infra.createClient.mockRejectedValue(new TypeError("fetch failed"));

    await expect(listSupportRequests(USER)).resolves.toEqual({
      ok: false,
      failure: "unavailable",
    });
    expect(console.error).toHaveBeenCalledWith(
      "[support] reading requests threw unexpectedly",
      expect.objectContaining({ error: { name: "TypeError" } }),
    );
  });

  it("logs only the type of a non-Error throw, never its value", async () => {
    infra.createClient.mockRejectedValue("secret detail");

    await listSupportRequests(USER);

    expect(console.error).toHaveBeenCalledWith(
      "[support] reading requests threw unexpectedly",
      { userId: USER, error: { name: "string" } },
    );
  });

  it("treats a response that is not a list as empty", async () => {
    const fake = createFakeSupabase(() => ({
      ...OK_RESPONSE,
      status: 200,
      data: { id: id(1) },
    }));

    await expect(listSupportRequests(USER, { supabase: fake.client })).resolves.toEqual({
      ok: true,
      requests: [],
      nextCursor: null,
    });
  });
});

describe("listSupportRequests – cursors are positions, not filters", () => {
  it("only ever embeds a decoded cursor in the filter", () => {
    // The encoder/decoder pair is the only way to build a `before`, and the
    // decoder accepts nothing but a timestamp and a uuid — so the filter
    // expression cannot be steered from outside.
    const forged = encodeSupportRequestCursor({
      createdAt: "2026-03-01T10:00:00+00:00",
      id: id(1),
    });

    expect(decodeSupportRequestCursor(forged)).toEqual({
      createdAt: "2026-03-01T10:00:00+00:00",
      id: id(1),
    });
    expect(
      decodeSupportRequestCursor(
        btoa('{"t":"2026-03-01T10:00:00+00:00","i":"x,user_id.neq.y"}'),
      ),
    ).toBeNull();
  });
});
