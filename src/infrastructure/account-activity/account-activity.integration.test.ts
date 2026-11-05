// @vitest-environment node
/**
 * INTEGRATION TESTS — run against a real PostgreSQL server.
 *
 * What `supabase/migrations/*_account_activity.sql` guarantees about
 * `public.account_activity`: users read only their own rows, nobody's session
 * token can write, the service role can only append (through the function),
 * rows are well-formed, and the history follows the account. Also exercises the
 * TypeScript writer end-to-end through the function.
 *
 * Skipped unless TEST_DATABASE_URL is set. Run with `npm run test:db`.
 */
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";

// The writer is exercised with an injected client that talks to the test
// database directly; the service-role client (which would need env) must not
// be built.
vi.mock("@/infrastructure/supabase/admin", () => ({
  createAdminClient: () => {
    throw new Error("the injected client must be used");
  },
}));

import {
  applyMigrations,
  createPgRpcClient,
  createTestDatabase,
  createTestUsers,
  emulateSupabaseRoles,
  queryAs,
  TEST_DATABASE_URL,
  type TestDatabase,
} from "@/shared/test/postgres";

import { recordAccountActivity } from "./record-account-activity";

const ALICE = "11111111-1111-4111-8111-111111111111";
const BOB = "22222222-2222-4222-8222-222222222222";
const NOBODY = "33333333-3333-4333-8333-333333333333";

const RECORD = `select public.record_account_activity($1, $2, $3) as id`;
const LIST = `select id, user_id::text as user_id, event_type, details, occurred_at
                from public.account_activity order by id`;

const expectDenied = (promise: Promise<unknown>) =>
  expect(promise).rejects.toMatchObject({ code: "42501" });
const expectCheckViolation = (promise: Promise<unknown>) =>
  expect(promise).rejects.toMatchObject({ code: "23514" });

describe.skipIf(!TEST_DATABASE_URL)("account activity (real PostgreSQL)", () => {
  let db: TestDatabase;

  /** `details: SQL_NULL` passes a SQL NULL; anything else is sent as JSON. */
  const SQL_NULL = Symbol("SQL NULL");
  const record = (
    user: string | null,
    type: string,
    details: unknown = { changes: {} },
    role: "anon" | "authenticated" | "service_role" = "service_role",
  ) =>
    queryAs(db.pool, role, null, RECORD, [
      user,
      type,
      details === SQL_NULL ? null : JSON.stringify(details),
    ]);

  beforeAll(async () => {
    db = await createTestDatabase(TEST_DATABASE_URL!);
    await emulateSupabaseRoles(db.pool);
    await applyMigrations(db.pool);
    await createTestUsers(db.pool, [ALICE, BOB]);
  });

  afterAll(async () => {
    await db.destroy();
  });

  afterEach(async () => {
    await db.pool.query("delete from public.account_activity");
  });

  describe("recording through the function (service role)", () => {
    it("appends a row for the user with a server timestamp and returns its id", async () => {
      const before = new Date();
      const { rows } = await record(ALICE, "profile.updated", {
        changes: { fullName: { from: null, to: "Alice" } },
      });

      expect(rows[0].id).toEqual(expect.any(String)); // bigint comes back as text from pg

      const all = (await db.pool.query(LIST)).rows;
      expect(all).toHaveLength(1);
      expect(all[0]).toMatchObject({
        id: rows[0].id,
        user_id: ALICE,
        event_type: "profile.updated",
        details: { changes: { fullName: { from: null, to: "Alice" } } },
      });
      expect(new Date(all[0].occurred_at).getTime()).toBeGreaterThanOrEqual(
        before.getTime() - 1000,
      );
    });

    it("stores an empty object when details are omitted or SQL NULL", async () => {
      await db.pool.query("select public.record_account_activity($1, $2)", [
        ALICE,
        "profile.updated",
      ]);
      await record(ALICE, "profile.updated", SQL_NULL);

      const all = (await db.pool.query(LIST)).rows;
      expect(all.map((r) => r.details)).toEqual([{}, {}]);
    });

    it("refuses a row for a user that does not exist", async () => {
      await expect(record(NOBODY, "profile.updated")).rejects.toMatchObject({
        code: "23503",
      });
      await expect(record(null, "profile.updated")).rejects.toMatchObject({
        code: "23502",
      });
    });

    it.each([
      ["no dot", "profile"],
      [
        "a separator that is not a dot (the check's \\. is a literal dot)",
        "profile_updated",
      ],
      ["any other character where the dot should be", "profilexupdated"],
      ["uppercase", "Profile.Updated"],
      ["leading digit", "1profile.updated"],
      ["dash", "profile-updated.x"],
      ["trailing dot", "profile."],
      ["spaces", "profile updated"],
      ["too long", `profile.${"a".repeat(60)}`],
    ])("rejects a malformed event type (%s)", async (_label, type) => {
      await expectCheckViolation(record(ALICE, type));
    });

    it.each([
      ["an array", ["a"]],
      ["a string", "text"],
      ["a number", 1],
      ["a JSON null (unlike SQL NULL)", null],
    ])("rejects details that are not an object (%s)", async (_label, details) => {
      await expectCheckViolation(record(ALICE, "profile.updated", details));
    });

    it("rejects oversized details", async () => {
      await expectCheckViolation(
        record(ALICE, "profile.updated", { blob: "x".repeat(4096) }),
      );
      // Just under the limit is fine.
      await record(ALICE, "profile.updated", { blob: "x".repeat(4000) });
    });
  });

  describe("who may do what", () => {
    it("only the service role may execute the record function", async () => {
      await expectDenied(record(ALICE, "profile.updated", {}, "anon"));
      await expectDenied(record(ALICE, "profile.updated", {}, "authenticated"));
      // Not even a signed-in user for their OWN id.
      await expectDenied(
        queryAs(db.pool, "authenticated", ALICE, RECORD, [
          ALICE,
          "profile.updated",
          "{}",
        ]),
      );
      await record(ALICE, "profile.updated");

      const privileges = await db.pool.query(`
        select r.rolname,
               has_function_privilege(r.rolname, 'public.record_account_activity(uuid, text, jsonb)', 'EXECUTE') as can_execute
          from pg_roles r where r.rolname in ('anon', 'authenticated', 'service_role')
         order by r.rolname`);
      expect(privileges.rows).toEqual([
        { rolname: "anon", can_execute: false },
        { rolname: "authenticated", can_execute: false },
        { rolname: "service_role", can_execute: true },
      ]);
    });

    it("a signed-in user reads only their own rows; the anonymous role reads nothing", async () => {
      await record(ALICE, "profile.updated", { who: "alice" });
      await record(BOB, "profile.updated", { who: "bob" });

      const alice = await queryAs(db.pool, "authenticated", ALICE, LIST);
      expect(alice.rows.map((r) => r.details)).toEqual([{ who: "alice" }]);

      const bob = await queryAs(db.pool, "authenticated", BOB, LIST);
      expect(bob.rows.map((r) => r.details)).toEqual([{ who: "bob" }]);

      // A token without a subject sees nothing rather than everything.
      const nobody = await queryAs(db.pool, "authenticated", null, LIST);
      expect(nobody.rows).toEqual([]);

      await expectDenied(queryAs(db.pool, "anon", null, LIST));
    });

    it("a signed-in user cannot insert, update or delete — not even their own rows", async () => {
      await record(ALICE, "profile.updated", { who: "alice" });

      await expectDenied(
        queryAs(
          db.pool,
          "authenticated",
          ALICE,
          `insert into public.account_activity (user_id, event_type) values ($1, 'profile.updated')`,
          [ALICE],
        ),
      );
      await expectDenied(
        queryAs(
          db.pool,
          "authenticated",
          ALICE,
          `update public.account_activity set details = '{"who":"mallory"}'`,
        ),
      );
      await expectDenied(
        queryAs(db.pool, "authenticated", ALICE, `delete from public.account_activity`),
      );
      // The sequence behind `id` is not reachable either.
      await expectDenied(
        queryAs(
          db.pool,
          "authenticated",
          ALICE,
          `select nextval('public.account_activity_id_seq')`,
        ),
      );

      const all = (await db.pool.query(LIST)).rows;
      expect(all).toHaveLength(1);
      expect(all[0].details).toEqual({ who: "alice" });
    });

    it("the service role can append and read, but not insert directly, update or delete", async () => {
      await record(ALICE, "profile.updated", { who: "alice" });

      const read = await queryAs(db.pool, "service_role", null, LIST);
      expect(read.rows).toHaveLength(1);

      await expectDenied(
        queryAs(
          db.pool,
          "service_role",
          null,
          `insert into public.account_activity (user_id, event_type) values ($1, 'profile.updated')`,
          [ALICE],
        ),
      );
      await expectDenied(
        queryAs(
          db.pool,
          "service_role",
          null,
          `update public.account_activity set event_type = 'profile.deleted'`,
        ),
      );
      await expectDenied(
        queryAs(db.pool, "service_role", null, `delete from public.account_activity`),
      );
    });

    it("has exactly one policy, for SELECT, and RLS is enabled and not forced off", async () => {
      const policies = await db.pool.query(
        `select policyname, cmd, roles::text as roles from pg_policies
          where schemaname = 'public' and tablename = 'account_activity'`,
      );
      expect(policies.rows).toEqual([
        {
          policyname: "account_activity_select_own",
          cmd: "SELECT",
          roles: "{authenticated}",
        },
      ]);

      const rls = await db.pool.query(
        `select relrowsecurity from pg_class where oid = 'public.account_activity'::regclass`,
      );
      expect(rls.rows[0].relrowsecurity).toBe(true);
    });
  });

  describe("lifecycle", () => {
    it("the history is deleted with the account", async () => {
      await createTestUsers(db.pool, [NOBODY]);
      await record(NOBODY, "profile.updated");
      await record(ALICE, "profile.updated");

      await db.pool.query("delete from auth.users where id = $1", [NOBODY]);

      const all = (await db.pool.query(LIST)).rows;
      expect(all.map((r) => r.user_id)).toEqual([ALICE]);
    });

    it("lists newest first with a stable tie-break, served by the index", async () => {
      for (let i = 0; i < 3; i++) {
        await record(ALICE, "profile.updated", { n: i });
      }
      // Two rows with the same timestamp: id decides.
      await db.pool.query(
        `update public.account_activity set occurred_at = '2026-01-01T00:00:00Z'`,
      );

      const page = await queryAs(
        db.pool,
        "authenticated",
        ALICE,
        `select details from public.account_activity where user_id = $1
          order by occurred_at desc, id desc limit 2`,
        [ALICE],
      );
      expect(page.rows.map((r) => r.details.n)).toEqual([2, 1]);

      // Keyset paging on (occurred_at, id) — the predicate the reader sends —
      // walks the whole list once, even across the tie, and stops.
      const seen: number[] = [];
      let cursor: { occurredAt: string; id: number } | null = null;
      for (let guard = 0; guard < 10; guard++) {
        const result: { rows: { n: number; id: string; occurred_at: Date }[] } =
          await queryAs(
            db.pool,
            "authenticated",
            ALICE,
            `select details->>'n' as n, id::text as id, occurred_at from public.account_activity
              where user_id = $1
                and ($2::timestamptz is null
                     or occurred_at < $2::timestamptz
                     or (occurred_at = $2::timestamptz and id < $3::bigint))
              order by occurred_at desc, id desc limit 2`,
            [ALICE, cursor?.occurredAt ?? null, cursor?.id ?? null],
          );
        if (result.rows.length === 0) break;
        seen.push(...result.rows.map((r) => Number(r.n)));
        const last = result.rows[result.rows.length - 1];
        cursor = { occurredAt: last.occurred_at.toISOString(), id: Number(last.id) };
      }
      expect(seen).toEqual([2, 1, 0]);

      const index = await db.pool.query(
        `select indexdef from pg_indexes where indexname = 'account_activity_user_recent_idx'`,
      );
      expect(index.rows[0].indexdef).toMatch(/\(user_id, occurred_at DESC, id DESC\)$/);
    });
  });

  describe("recordAccountActivity (the application writer) through the function", () => {
    afterEach(() => {
      vi.restoreAllMocks();
    });

    it("records a catalogued event as the service role and returns the row id", async () => {
      const { client } = createPgRpcClient(db.pool, "service_role");

      const result = await recordAccountActivity(
        ALICE,
        {
          type: "profile.updated",
          details: { changes: { fullName: { from: "Alice", to: "Alice Liddell" } } },
        },
        client,
      );

      expect(result).toEqual({ ok: true, id: expect.any(Number) });

      const all = (await db.pool.query(LIST)).rows;
      expect(all).toHaveLength(1);
      expect(all[0]).toMatchObject({
        id: String((result as { id: number }).id),
        user_id: ALICE,
        event_type: "profile.updated",
        details: { changes: { fullName: { from: "Alice", to: "Alice Liddell" } } },
      });
    });

    it("fails closed (ok: false, nothing written) when called with a user's role", async () => {
      vi.spyOn(console, "error").mockImplementation(() => {});
      const { client } = createPgRpcClient(db.pool, "authenticated");

      const result = await recordAccountActivity(
        ALICE,
        {
          type: "profile.updated",
          details: { changes: { fullName: { from: null, to: "x" } } },
        },
        client,
      );

      expect(result).toEqual({ ok: false });
      expect((await db.pool.query(LIST)).rows).toEqual([]);
      expect(console.error).toHaveBeenCalledWith(
        "[account-activity] could not record event",
        expect.objectContaining({ error: expect.objectContaining({ code: "42501" }) }),
      );
    });
  });
});
