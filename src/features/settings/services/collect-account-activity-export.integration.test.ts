// @vitest-environment node
/**
 * INTEGRATION TESTS — run against a real PostgreSQL server.
 *
 * The activity export pages with keyset filters on `(occurred_at, id)`. The
 * unit tests check that against a fake table; this checks it against the real
 * thing: `timestamptz` ordering and microsecond precision, many rows sharing
 * one timestamp (recorded in one transaction), timestamps serialised in a
 * non-UTC session zone, unrecognised rows, row level security, and the date
 * range's edges down to the microsecond.
 *
 * There is no PostgREST here. `postgrestAs` below translates the ONE query
 * shape the reader sends (select / eq / gte / lt / keyset or / order / limit) into SQL
 * and runs it as PostgREST would: as `authenticated`, with the JWT `sub`
 * claim set (so RLS applies), timestamps rendered by `to_json` like
 * PostgREST's JSON output. It proves the SQL semantics the reader relies on,
 * not PostgREST's own filter parser.
 *
 * Skipped unless TEST_DATABASE_URL is set. Run with `npm run test:db`.
 */
import type { SupabaseClient } from "@supabase/supabase-js";
import type pg from "pg";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@/infrastructure/auth/supabase/server", () => ({
  createClient: () => {
    throw new Error("the injected client must be used");
  },
}));

import {
  applyMigrations,
  createTestDatabase,
  createTestUsers,
  emulateSupabaseRoles,
  TEST_DATABASE_URL,
  type TestDatabase,
} from "@/shared/test/postgres";

import { collectAccountActivityForExport } from "./collect-account-activity-export";

const ALICE = "11111111-1111-4111-8111-111111111111";
const BOB = "22222222-2222-4222-8222-222222222222";

const OLDER_THAN =
  /^occurred_at\.lt\."([^"]+)",and\(occurred_at\.eq\."([^"]+)",id\.lt\.(\d+)\)$/;

/**
 * A supabase-js stand-in for `from("account_activity")` reads, executed in
 * PostgreSQL as `authenticated` with `auth.uid() = jwtUser`, in `timeZone`.
 */
function postgrestAs(
  pool: pg.Pool,
  jwtUser: string,
  timeZone = "UTC",
): { client: SupabaseClient; queries: string[] } {
  const queries: string[] = [];

  const from = (table: string) => {
    if (table !== "account_activity") throw new Error(`unexpected table ${table}`);

    const where: string[] = [];
    const params: unknown[] = [];
    const order: string[] = [];
    let limit: number | null = null;
    let columns = "";

    const builder = {
      select(cols: string) {
        columns = cols;
        return builder;
      },
      eq(column: string, value: unknown) {
        if (column !== "user_id") throw new Error(`unexpected eq ${column}`);
        params.push(value);
        where.push(`user_id = $${params.length}`);
        return builder;
      },
      gte(column: string, value: string) {
        if (column !== "occurred_at") throw new Error(`unexpected gte ${column}`);
        params.push(value);
        where.push(`occurred_at >= $${params.length}::timestamptz`);
        return builder;
      },
      lt(column: string, value: string) {
        if (column !== "occurred_at") throw new Error(`unexpected lt ${column}`);
        params.push(value);
        where.push(`occurred_at < $${params.length}::timestamptz`);
        return builder;
      },
      or(filter: string) {
        const match = OLDER_THAN.exec(filter);
        if (!match || match[1] !== match[2]) throw new Error(`unexpected or ${filter}`);
        params.push(match[1], Number(match[3]));
        const t = `$${params.length - 1}::timestamptz`;
        where.push(
          `(occurred_at < ${t} or (occurred_at = ${t} and id < $${params.length}))`,
        );
        return builder;
      },
      order(column: string, { ascending }: { ascending: boolean }) {
        if (column !== "occurred_at" && column !== "id") throw new Error(column);
        order.push(`activity.${column} ${ascending ? "asc" : "desc"}`);
        return builder;
      },
      limit(n: number) {
        limit = n;
        return builder;
      },
      async then(resolve: (value: unknown) => unknown, reject: (e: unknown) => unknown) {
        if (columns !== "id, event_type, details, occurred_at") {
          return reject(new Error(`unexpected columns ${columns}`));
        }
        const sql = `select id::int as id, event_type, details,
                            to_json(occurred_at) #>> '{}' as occurred_at
                       from public.account_activity as activity
                      ${where.length ? `where ${where.join(" and ")}` : ""}
                      ${order.length ? `order by ${order.join(", ")}` : ""}
                      ${limit === null ? "" : `limit ${Number(limit)}`}`;
        queries.push(sql);

        const conn = await pool.connect();
        try {
          await conn.query("begin");
          await conn.query("set local role authenticated");
          await conn.query("select set_config('request.jwt.claim.sub', $1, true)", [
            jwtUser,
          ]);
          await conn.query("select set_config('TimeZone', $1, true)", [timeZone]);
          const result = await conn.query(sql, params);
          await conn.query("commit");
          return resolve({ data: result.rows, error: null, status: 200 });
        } catch (error) {
          await conn.query("rollback").catch(() => {});
          const e = error as pg.DatabaseError;
          return resolve({
            data: null,
            error: { message: e.message, code: e.code },
            status: 400,
          });
        } finally {
          conn.release();
        }
      },
    };

    return builder;
  };

  return { client: { from } as unknown as SupabaseClient, queries };
}

describe.skipIf(!TEST_DATABASE_URL)("account activity export (real PostgreSQL)", () => {
  let db: TestDatabase;

  /**
   * Inserts as the table owner (so tests can set `occurred_at`), in ONE
   * statement: rows without `at` share its now(), and the shared test cluster
   * gets one round trip instead of hundreds. Row order = id order.
   */
  const insert = async (
    rows: { user: string; type?: string; details?: unknown; at?: string }[],
  ) => {
    await db.pool.query(
      `insert into public.account_activity (user_id, event_type, details, occurred_at)
       select u, t, d, coalesce(a, now())
         from unnest($1::uuid[], $2::text[], $3::jsonb[], $4::timestamptz[])
              with ordinality as r(u, t, d, a, n)
        order by n`,
      [
        rows.map((row) => row.user),
        rows.map((row) => row.type ?? "sessions.others_signed_out"),
        rows.map((row) => JSON.stringify(row.details ?? {})),
        rows.map((row) => row.at ?? null),
      ],
    );
  };

  /** The user's ids in the order the history is shown, straight from SQL. */
  const expectedOrder = async (user: string) =>
    (
      await db.pool.query(
        `select id::int as id from public.account_activity
          where user_id = $1 order by occurred_at desc, id desc`,
        [user],
      )
    ).rows.map((row: { id: number }) => row.id);

  beforeAll(async () => {
    db = await createTestDatabase(TEST_DATABASE_URL!);
    await emulateSupabaseRoles(db.pool);
    await applyMigrations(db.pool, (file) => file.includes("account_activity"));
    await createTestUsers(db.pool, [ALICE, BOB]);
  }, 60_000);

  afterAll(async () => {
    await db?.destroy();
  });

  beforeEach(async () => {
    await db.pool.query("truncate public.account_activity restart identity");
  });

  it("collects 250 rows recorded in one transaction (one shared timestamp) across three pages", async () => {
    await insert(Array.from({ length: 250 }, () => ({ user: ALICE })));
    const { client, queries } = postgrestAs(db.pool, ALICE);

    const result = await collectAccountActivityForExport(ALICE, { supabase: client });

    if (!result.ok) throw new Error(result.reason);
    expect(result.entries.map((e) => e.id)).toEqual(await expectedOrder(ALICE));
    expect(result.entries).toHaveLength(250);
    expect(queries).toHaveLength(3);
  });

  it("follows microsecond timestamps that disagree with id order", async () => {
    // Ids ascend while times jump around within one second, down to the microsecond.
    await insert(
      Array.from({ length: 230 }, (_, i) => ({
        user: ALICE,
        at: `2026-03-01T10:00:00.${String(100_000 + ((i * 7919) % 230) * 3).padStart(6, "0")}Z`,
      })),
    );
    const { client } = postgrestAs(db.pool, ALICE);

    const result = await collectAccountActivityForExport(ALICE, { supabase: client });

    if (!result.ok) throw new Error(result.reason);
    expect(result.entries.map((e) => e.id)).toEqual(await expectedOrder(ALICE));
  });

  it("pages correctly when timestamps come back in a non-UTC zone (offset in the cursor)", async () => {
    await insert(
      Array.from({ length: 210 }, (_, i) => ({
        user: ALICE,
        at: new Date(Date.UTC(2026, 2, 29, 0, 30) + i * 60_000).toISOString(), // across a DST change
      })),
    );
    const { client } = postgrestAs(db.pool, ALICE, "Europe/Berlin");

    const result = await collectAccountActivityForExport(ALICE, { supabase: client });

    if (!result.ok) throw new Error(result.reason);
    expect(result.entries.map((e) => e.id)).toEqual(await expectedOrder(ALICE));
    expect(result.entries[0].occurredAt).toMatch(/\+0[12]:00$/);
  });

  it("keeps unrecognised rows in place, without their details", async () => {
    await insert([
      { user: ALICE, at: "2026-03-01T10:00:03Z" },
      {
        user: ALICE,
        type: "future.event",
        details: { secret: "do-not-export" },
        at: "2026-03-01T10:00:02Z",
      },
      {
        user: ALICE,
        type: "profile.updated",
        details: { legacy: true },
        at: "2026-03-01T10:00:01Z",
      },
    ]);
    const { client } = postgrestAs(db.pool, ALICE);

    const result = await collectAccountActivityForExport(ALICE, { supabase: client });

    expect(result).toMatchObject({
      ok: true,
      unrecognised: 2,
      entries: [
        { event: { type: "sessions.others_signed_out" } },
        { unrecognised: true, eventType: "future.event" },
        { unrecognised: true, eventType: "profile.updated" },
      ],
    });
    expect(JSON.stringify(result)).not.toContain("do-not-export");
  });

  it("never includes another account's rows, interleaved in time", async () => {
    await insert(
      Array.from({ length: 300 }, (_, i) => ({
        user: i % 3 === 0 ? ALICE : BOB,
        at: new Date(Date.UTC(2026, 0, 1) + i * 1000).toISOString(),
      })),
    );
    const { client } = postgrestAs(db.pool, ALICE);

    const result = await collectAccountActivityForExport(ALICE, { supabase: client });

    if (!result.ok) throw new Error(result.reason);
    expect(result.entries.map((e) => e.id)).toEqual(await expectedOrder(ALICE));
    expect(result.entries).toHaveLength(100);
  });

  it("row level security holds even if the user filter named someone else", async () => {
    await insert([{ user: BOB }, { user: BOB }]);
    // Signed in as Alice, asking for Bob's rows: RLS leaves nothing to read.
    const { client } = postgrestAs(db.pool, ALICE);

    await expect(
      collectAccountActivityForExport(BOB, { supabase: client }),
    ).resolves.toEqual({ ok: true, entries: [], unrecognised: 0 });
  });

  describe("date range", () => {
    const MARCH = { from: "2026-03-01", to: "2026-03-31" };

    /** Ids of the user's rows inside [from, to+1day) per PostgreSQL itself, newest first. */
    const expectedInRange = async (user: string, from: string, toExclusive: string) =>
      (
        await db.pool.query(
          `select id::int as id from public.account_activity
            where user_id = $1 and occurred_at >= $2::date::timestamp at time zone 'UTC'
              and occurred_at < $3::date::timestamp at time zone 'UTC'
            order by occurred_at desc, id desc`,
          [user, from, toExclusive],
        )
      ).rows.map((row: { id: number }) => row.id);

    it.each(["UTC", "Europe/Berlin", "America/Los_Angeles", "Asia/Kolkata"])(
      "takes the first and last microsecond of the range and nothing either side (session zone %s)",
      async (timeZone) => {
        await insert(
          [
            "2026-02-28T23:59:59.999999Z", // out
            "2026-03-01T00:00:00Z", // in
            "2026-03-01T00:00:00.000001Z", // in
            "2026-03-01T00:30:00+01:00", // out: 28 Feb 23:30 UTC
            "2026-03-31T23:30:00-01:00", // out: 1 Apr 00:30 UTC
            "2026-03-31T23:59:59.999999Z", // in: the last microsecond
            "2026-04-01T00:00:00Z", // out
          ].map((at) => ({ user: ALICE, at })),
        );
        const { client } = postgrestAs(db.pool, ALICE, timeZone);

        const result = await collectAccountActivityForExport(ALICE, {
          supabase: client,
          range: MARCH,
        });

        if (!result.ok) throw new Error(result.reason);
        expect(result.entries.map((e) => e.id)).toEqual([6, 3, 2]);
      },
    );

    it("pages through a range across many pages, with ties at its first instant", async () => {
      const march = Date.UTC(2026, 2, 1);
      await insert([
        // 150 rows at exactly midnight on 1 March (one page boundary falls among them)…
        ...Array.from({ length: 150 }, () => ({
          user: ALICE,
          at: "2026-03-01T00:00:00Z",
        })),
        // …300 across the month, to the microsecond…
        ...Array.from({ length: 300 }, (_, i) => ({
          user: ALICE,
          at: new Date(march + 1 + i * 8_927_999).toISOString().replace("Z", "917Z"),
        })),
        // …and plenty on either side, plus Bob's inside it.
        ...Array.from({ length: 120 }, (_, i) => ({
          user: ALICE,
          at: new Date(march - 1 - i * 60_000).toISOString(),
        })),
        ...Array.from({ length: 120 }, (_, i) => ({
          user: ALICE,
          at: new Date(Date.UTC(2026, 3, 1) + i * 60_000).toISOString(),
        })),
        ...Array.from({ length: 80 }, () => ({ user: BOB, at: "2026-03-15T12:00:00Z" })),
      ]);
      const { client, queries } = postgrestAs(db.pool, ALICE, "Europe/Berlin");

      const result = await collectAccountActivityForExport(ALICE, {
        supabase: client,
        range: MARCH,
      });

      if (!result.ok) throw new Error(result.reason);
      const expected = await expectedInRange(ALICE, "2026-03-01", "2026-04-01");
      expect(expected).toHaveLength(450);
      expect(result.entries.map((e) => e.id)).toEqual(expected);
      expect(queries).toHaveLength(5);
    });

    it("returns an empty export for a range with nothing in it", async () => {
      await insert([{ user: ALICE, at: "2026-02-01T00:00:00Z" }]);
      const { client } = postgrestAs(db.pool, ALICE);

      await expect(
        collectAccountActivityForExport(ALICE, { supabase: client, range: MARCH }),
      ).resolves.toEqual({ ok: true, entries: [], unrecognised: 0 });
    });
  });
});
