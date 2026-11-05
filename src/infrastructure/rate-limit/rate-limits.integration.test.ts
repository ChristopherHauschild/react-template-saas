// @vitest-environment node
/**
 * INTEGRATION TESTS — run against a real PostgreSQL server.
 *
 * What `supabase/migrations/*_rate_limits.sql` guarantees: the GCRA decision
 * (a burst, then one per interval, with an exact wait when refused), separate
 * allowances per user and per bucket, atomic decisions under concurrency
 * (N parallel requests never get more than the burst), validation of its
 * arguments, privileges (service_role only; nobody can read or reset a row),
 * and rows that go with the user. Also drives the TypeScript limiter
 * end-to-end through the function.
 *
 * Skipped unless TEST_DATABASE_URL is set. Run with `npm run test:db`.
 */
import type { SupabaseClient } from "@supabase/supabase-js";
import type pg from "pg";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";

// The injected client below talks to the test database; the service-role
// client (which would need env) must not be built.
vi.mock("@/infrastructure/supabase/admin", () => ({
  createAdminClient: () => {
    throw new Error("the injected client must be used");
  },
}));

import {
  applyMigrations,
  createTestDatabase,
  createTestUsers,
  emulateSupabaseRoles,
  queryAs,
  TEST_DATABASE_URL,
  type TestDatabase,
} from "@/shared/test/postgres";

import { consumeRateLimit } from "./consume-rate-limit";

const ALICE = "11111111-1111-4111-8111-111111111111";
const BOB = "22222222-2222-4222-8222-222222222222";
const NOBODY = "33333333-3333-4333-8333-333333333333";

const CONSUME = `select allowed, retry_after_seconds
                   from public.consume_rate_limit($1, $2, $3, $4)`;

type Decision = { allowed: boolean; retry_after_seconds: number };

describe.skipIf(!TEST_DATABASE_URL)("rate limits (real PostgreSQL)", () => {
  let db: TestDatabase;

  /** One call as the service role (how the application calls it), on its own connection. */
  const consume = async (
    user: string | null,
    bucket: string | null = "export.invoices",
    interval: number | null = 60,
    burst: number | null = 5,
  ): Promise<Decision> =>
    (
      await queryAs(db.pool, "service_role", null, CONSUME, [
        user,
        bucket,
        interval,
        burst,
      ])
    ).rows[0] as Decision;

  const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

  /**
   * A supabase-js stand-in for `.rpc()` that runs the call the way PostgREST
   * does for a set-returning function: as the given role, answering the rows
   * as an array.
   */
  const rpcClient = (pool: pg.Pool, role = "service_role") =>
    ({
      async rpc(fn: string, params: Record<string, unknown>) {
        const keys = Object.keys(params);
        const sql = `select * from public.${fn}(${keys.map((k, i) => `${k} => $${i + 1}`).join(", ")})`;
        try {
          const result = await queryAs(
            pool,
            role as "service_role",
            null,
            sql,
            keys.map((k) => params[k]),
          );
          return { data: result.rows, error: null, status: 200 };
        } catch (error) {
          const e = error as pg.DatabaseError;
          return { data: null, error: { message: e.message, code: e.code }, status: 400 };
        }
      },
    }) as unknown as SupabaseClient;

  beforeAll(async () => {
    db = await createTestDatabase(TEST_DATABASE_URL!);
    await emulateSupabaseRoles(db.pool);
    await applyMigrations(db.pool, (file) => file.includes("rate_limits"));
    await createTestUsers(db.pool, [ALICE, BOB]);
  }, 60_000);

  afterAll(async () => {
    await db?.destroy();
  });

  afterEach(async () => {
    await db.pool.query("delete from public.rate_limits");
  });

  describe("the decision", () => {
    it("allows the burst at once, then refuses with the wait until the next slot", async () => {
      const decisions = [];
      for (let i = 0; i < 6; i++) decisions.push(await consume(ALICE));

      expect(decisions.slice(0, 5)).toEqual(
        Array(5).fill({ allowed: true, retry_after_seconds: 0 }),
      );
      expect(decisions[5].allowed).toBe(false);
      // One interval (60 s), less the few milliseconds the calls took; rounded up.
      expect(decisions[5].retry_after_seconds).toBe(60);
    });

    it("a refused request consumes nothing: refusing again says the same", async () => {
      for (let i = 0; i < 5; i++) await consume(ALICE);

      const first = await consume(ALICE);
      const again = await consume(ALICE);

      expect(first.allowed).toBe(false);
      expect(again).toEqual(first);
    });

    it("refills one slot per interval, in real time", async () => {
      // Burst 1, one per second.
      expect(await consume(ALICE, "test.refill", 1, 1)).toEqual({
        allowed: true,
        retry_after_seconds: 0,
      });
      expect(await consume(ALICE, "test.refill", 1, 1)).toEqual({
        allowed: false,
        retry_after_seconds: 1,
      });

      await sleep(1100);

      expect((await consume(ALICE, "test.refill", 1, 1)).allowed).toBe(true);
      expect((await consume(ALICE, "test.refill", 1, 1)).allowed).toBe(false);
    });

    it("does not bank unused time beyond the burst", async () => {
      await consume(ALICE, "test.bank", 1, 2);
      await sleep(3100); // three intervals idle: still only a burst of 2

      const decisions = [];
      for (let i = 0; i < 3; i++)
        decisions.push((await consume(ALICE, "test.bank", 1, 2)).allowed);

      expect(decisions).toEqual([true, true, false]);
    });

    it("keeps a separate allowance per user and per bucket", async () => {
      for (let i = 0; i < 5; i++) await consume(ALICE);
      expect((await consume(ALICE)).allowed).toBe(false);

      expect((await consume(BOB)).allowed).toBe(true);
      expect((await consume(ALICE, "export.activity")).allowed).toBe(true);
    });

    it("keeps one row per user and bucket, however many requests", async () => {
      for (let i = 0; i < 12; i++) await consume(ALICE);
      await consume(ALICE, "export.activity");

      const { rows } = await db.pool.query(
        "select user_id::text, bucket from public.rate_limits order by bucket",
      );
      expect(rows).toEqual([
        { user_id: ALICE, bucket: "export.activity" },
        { user_id: ALICE, bucket: "export.invoices" },
      ]);
    });
  });

  describe("atomic under concurrency", () => {
    it.each([
      ["a bucket used for the first time (racing on the insert)", false],
      ["a bucket already in use (racing on the row lock)", true],
    ])("grants exactly the burst to 20 parallel requests: %s", async (_label, warm) => {
      if (warm) {
        // Use up 2 of 5, then let the interval be long enough not to refill mid-test.
        await consume(ALICE, "test.race", 3600, 5);
        await consume(ALICE, "test.race", 3600, 5);
      }

      const decisions = await Promise.all(
        Array.from({ length: 20 }, () => consume(ALICE, "test.race", 3600, 5)),
      );

      expect(decisions.filter((d) => d.allowed)).toHaveLength(warm ? 3 : 5);
      expect(
        decisions.filter((d) => !d.allowed).every((d) => d.retry_after_seconds >= 1),
      ).toBe(true);
    });
  });

  describe("arguments", () => {
    it("refuses a missing user or bucket", async () => {
      await expect(consume(null)).rejects.toMatchObject({ code: "22004" });
      await expect(consume(ALICE, null)).rejects.toMatchObject({ code: "22004" });
    });

    it.each([
      ["a zero interval", 0, 5],
      ["an interval over a day", 86401, 5],
      ["a null interval", null, 5],
      ["a zero burst", 60, 0],
      ["a burst over 1000", 60, 1001],
      ["a null burst", 60, null],
    ])("refuses %s", async (_label, interval, burst) => {
      await expect(
        consume(ALICE, "export.invoices", interval, burst),
      ).rejects.toMatchObject({
        code: "22023",
      });
    });

    it.each([
      "Export.Invoices",
      "export invoices",
      "export-invoices",
      ".export",
      "export.",
      `x.${"a".repeat(63)}`,
    ])("refuses the malformed bucket %j", async (bucket) => {
      await expect(consume(ALICE, bucket)).rejects.toMatchObject({ code: "23514" });
    });

    it("refuses a user that does not exist", async () => {
      await expect(consume(NOBODY)).rejects.toMatchObject({ code: "23503" });
    });
  });

  describe("privileges", () => {
    const denied = (promise: Promise<unknown>) =>
      expect(promise).rejects.toMatchObject({ code: "42501" });

    it("only the service role may consume an allowance", async () => {
      for (const role of ["anon", "authenticated"] as const) {
        await denied(
          queryAs(db.pool, role, ALICE, CONSUME, [ALICE, "export.invoices", 60, 5]),
        );
      }
    });

    it("nobody can read, create, reset or delete a row through the API roles", async () => {
      await consume(ALICE);

      for (const role of ["anon", "authenticated", "service_role"] as const) {
        await denied(queryAs(db.pool, role, ALICE, "select * from public.rate_limits"));
        await denied(
          queryAs(
            db.pool,
            role,
            ALICE,
            "insert into public.rate_limits (user_id, bucket, tat) values ($1, 'export.invoices', now())",
            [ALICE],
          ),
        );
        await denied(
          queryAs(
            db.pool,
            role,
            ALICE,
            "update public.rate_limits set tat = '-infinity'",
          ),
        );
        await denied(queryAs(db.pool, role, ALICE, "delete from public.rate_limits"));
      }

      // The allowance is untouched.
      const { rows } = await db.pool.query(
        "select count(*)::int as n from public.rate_limits",
      );
      expect(rows[0].n).toBe(1);
    });

    it("has row level security enabled, with no policy at all", async () => {
      const { rows } = await db.pool.query(
        `select c.relrowsecurity as rls,
                (select count(*)::int from pg_policies p
                  where p.schemaname = 'public' and p.tablename = 'rate_limits') as policies
           from pg_class c where c.oid = 'public.rate_limits'::regclass`,
      );
      expect(rows[0]).toEqual({ rls: true, policies: 0 });
    });
  });

  it("removes a user's allowances with the user", async () => {
    const GONE = "44444444-4444-4444-8444-444444444444";
    await createTestUsers(db.pool, [GONE]);
    await consume(GONE);

    await db.pool.query("delete from auth.users where id = $1", [GONE]);

    const { rows } = await db.pool.query(
      "select count(*)::int as n from public.rate_limits where user_id = $1",
      [GONE],
    );
    expect(rows[0].n).toBe(0);
  });

  describe("the TypeScript limiter, end to end", () => {
    const POLICY = { bucket: "export.invoices", burst: 5, intervalSeconds: 60 };

    it("answers allowed five times, then limited with the wait", async () => {
      const client = rpcClient(db.pool);
      const outcomes = [];
      for (let i = 0; i < 6; i++)
        outcomes.push(await consumeRateLimit(ALICE, POLICY, client));

      expect(outcomes.slice(0, 5)).toEqual(Array(5).fill({ outcome: "allowed" }));
      expect(outcomes[5]).toEqual({ outcome: "limited", retryAfterSeconds: 60 });
    });

    it("answers unavailable when called with a user's token instead of the service role", async () => {
      vi.spyOn(console, "error").mockImplementation(() => {});

      await expect(
        consumeRateLimit(ALICE, POLICY, rpcClient(db.pool, "authenticated")),
      ).resolves.toEqual({ outcome: "unavailable" });

      vi.restoreAllMocks();
    });
  });
});
