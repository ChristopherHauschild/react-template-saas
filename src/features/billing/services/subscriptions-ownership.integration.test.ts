// @vitest-environment node
/**
 * INTEGRATION TESTS — run against a real PostgreSQL server.
 *
 * What `supabase/migrations/*_subscriptions_ownership.sql` guarantees about
 * `public.subscriptions`: who can read which rows, that nobody but the service
 * role writes, one row per Stripe subscription, one owner per Stripe customer,
 * and that the migration copes with the table's unknowns (absent, duplicates
 * already present, "userId" stored as text, leftover permissive policies).
 *
 * Skipped unless TEST_DATABASE_URL is set. Run with `npm run test:db`.
 */
import { readdir, readFile } from "node:fs/promises";
import path from "node:path";
import type Stripe from "stripe";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

import { handleStripeWebhookEvent } from "@/features/billing/services/handle-stripe-webhook-event";
import {
  applyMigrations,
  createPgRpcClient,
  createStandInSubscriptionsTable,
  createTestDatabase,
  emulateSupabaseRoles,
  MIGRATIONS_DIR,
  queryAs,
  TEST_DATABASE_URL,
  type TestDatabase,
} from "@/shared/test/postgres";

const ALICE = "11111111-1111-4111-8111-111111111111";
const BOB = "22222222-2222-4222-8222-222222222222";

const OWNERSHIP_MIGRATION = /_subscriptions_ownership\.sql$/;

type Row = {
  stripe_customer_id: string | null;
  stripe_subscription_id: string | null;
  status: string | null;
  user_id: string | null;
};

async function seed(
  db: TestDatabase,
  rows: [string | null, string | null, string, string | null][],
) {
  for (const [customer, subscription, status, user] of rows) {
    await db.pool.query(
      `insert into public.subscriptions (stripe_customer_id, stripe_subscription_id, status, "userId")
       values ($1, $2, $3, $4)`,
      [customer, subscription, status, user],
    );
  }
}

/** Applies only the ownership migration, returning the NOTICE/WARNING lines it raised. */
async function applyOwnershipMigration(db: TestDatabase): Promise<string[]> {
  const file = (await readdir(MIGRATIONS_DIR)).find((f) => OWNERSHIP_MIGRATION.test(f))!;
  const sql = await readFile(path.join(MIGRATIONS_DIR, file), "utf8");
  const notices: string[] = [];
  const conn = await db.pool.connect();
  conn.on("notice", (n) => notices.push(`${n.severity}: ${n.message}`));

  try {
    await conn.query(sql);
  } finally {
    conn.release();
  }

  return notices;
}

const SELECT_ALL = `select stripe_customer_id, stripe_subscription_id, status, "userId"::text as user_id
                      from public.subscriptions order by stripe_subscription_id`;

const expectDenied = async (promise: Promise<unknown>) =>
  expect(promise).rejects.toMatchObject({ code: "42501" });

function subscriptionEvent(
  id: string,
  sub: string,
  customer: string,
  userId: string | null,
  status = "active",
  created = 1_700_000_000,
): Stripe.Event {
  return {
    id,
    object: "event",
    api_version: "2026-02-25.clover",
    created,
    livemode: false,
    pending_webhooks: 1,
    request: null,
    type: "customer.subscription.updated",
    data: {
      object: {
        id: sub,
        object: "subscription",
        customer,
        status,
        metadata: userId ? { userId } : {},
      },
    },
  } as unknown as Stripe.Event;
}

describe.skipIf(!TEST_DATABASE_URL)("subscriptions ownership (real PostgreSQL)", () => {
  let db: TestDatabase;

  beforeAll(async () => {
    db = await createTestDatabase(TEST_DATABASE_URL!);
    await emulateSupabaseRoles(db.pool);
    await createStandInSubscriptionsTable(db.pool);
    await applyMigrations(db.pool);
  });

  afterAll(async () => {
    await db.destroy();
  });

  beforeEach(async () => {
    await db.pool.query("truncate public.subscriptions, public.stripe_webhook_events");
    await seed(db, [
      ["cus_alice", "sub_alice_live", "active", ALICE],
      ["cus_alice", "sub_alice_old", "canceled", ALICE],
      ["cus_bob", "sub_bob", "past_due", BOB],
      [null, "sub_orphan", "incomplete", null],
    ]);
  });

  describe("privileges and row level security", () => {
    it("enables RLS and installs exactly one policy: owner-only SELECT for authenticated", async () => {
      const { rows: rls } = await db.pool.query(
        "select relrowsecurity from pg_class where oid = 'public.subscriptions'::regclass",
      );
      expect(rls[0].relrowsecurity).toBe(true);

      const { rows: policies } = await db.pool.query(
        `select policyname, cmd, roles from pg_policies
          where schemaname = 'public' and tablename = 'subscriptions'`,
      );
      expect(policies).toEqual([
        {
          policyname: "subscriptions_select_own",
          cmd: "SELECT",
          roles: "{authenticated}",
        },
      ]);
    });

    it("grants: anon nothing, authenticated SELECT only, service_role read/write", async () => {
      const privilege = async (role: string, priv: string) =>
        (
          await db.pool.query(
            "select has_table_privilege($1, 'public.subscriptions', $2) as ok",
            [role, priv],
          )
        ).rows[0].ok;

      for (const priv of ["SELECT", "INSERT", "UPDATE", "DELETE"]) {
        expect(await privilege("anon", priv), `anon ${priv}`).toBe(false);
      }
      expect(await privilege("authenticated", "SELECT")).toBe(true);
      for (const priv of ["INSERT", "UPDATE", "DELETE"]) {
        expect(await privilege("authenticated", priv), `authenticated ${priv}`).toBe(
          false,
        );
      }
      for (const priv of ["SELECT", "INSERT", "UPDATE", "DELETE"]) {
        expect(await privilege("service_role", priv), `service_role ${priv}`).toBe(true);
      }
    });

    it("a signed-in user sees only their own rows", async () => {
      const alice = await queryAs(db.pool, "authenticated", ALICE, SELECT_ALL);
      expect(alice.rows.map((r: Row) => r.stripe_subscription_id)).toEqual([
        "sub_alice_live",
        "sub_alice_old",
      ]);
      expect(alice.rows.every((r: Row) => r.user_id === ALICE)).toBe(true);

      const bob = await queryAs(db.pool, "authenticated", BOB, SELECT_ALL);
      expect(bob.rows.map((r: Row) => r.stripe_subscription_id)).toEqual(["sub_bob"]);
    });

    it("a signed-in user cannot see another user's rows even when asking for them by id", async () => {
      const { rows } = await queryAs(
        db.pool,
        "authenticated",
        BOB,
        `select * from public.subscriptions where stripe_subscription_id = 'sub_alice_live'
            or stripe_customer_id = 'cus_alice' or "userId"::text = $1`,
        [ALICE],
      );

      expect(rows).toEqual([]);
    });

    it("rows without an owner are visible to nobody but the service role", async () => {
      expect(
        (await queryAs(db.pool, "authenticated", ALICE, SELECT_ALL)).rows,
      ).not.toContainEqual(
        expect.objectContaining({ stripe_subscription_id: "sub_orphan" }),
      );
      expect(
        (await queryAs(db.pool, "service_role", null, SELECT_ALL)).rows.map(
          (r: Row) => r.stripe_subscription_id,
        ),
      ).toContain("sub_orphan");
    });

    it("no JWT claim (no session) sees nothing; anon is refused outright", async () => {
      expect((await queryAs(db.pool, "authenticated", null, SELECT_ALL)).rows).toEqual(
        [],
      );
      await expectDenied(queryAs(db.pool, "anon", null, SELECT_ALL));
    });

    it("a signed-in user cannot insert, update or delete — not even their own rows", async () => {
      await expectDenied(
        queryAs(
          db.pool,
          "authenticated",
          ALICE,
          `update public.subscriptions set status = 'active' where stripe_subscription_id = 'sub_alice_old'`,
        ),
      );
      await expectDenied(
        queryAs(
          db.pool,
          "authenticated",
          BOB,
          `update public.subscriptions set status = 'active' where stripe_subscription_id = 'sub_bob'`,
        ),
      );
      await expectDenied(
        queryAs(
          db.pool,
          "authenticated",
          ALICE,
          `delete from public.subscriptions where stripe_subscription_id = 'sub_bob'`,
        ),
      );
      await expectDenied(
        queryAs(
          db.pool,
          "authenticated",
          BOB,
          `insert into public.subscriptions (stripe_customer_id, stripe_subscription_id, status, "userId")
           values ('cus_forged', 'sub_forged', 'active', $1)`,
          [BOB],
        ),
      );

      const { rows } = await db.pool.query(SELECT_ALL);
      expect(rows.find((r: Row) => r.stripe_subscription_id === "sub_bob").status).toBe(
        "past_due",
      );
      expect(rows).toHaveLength(4);
    });

    it("the service role (webhook) still reads and writes everything", async () => {
      const all = await queryAs(db.pool, "service_role", null, SELECT_ALL);
      expect(all.rows).toHaveLength(4);

      await queryAs(
        db.pool,
        "service_role",
        null,
        `update public.subscriptions set status = 'unpaid' where stripe_subscription_id = 'sub_bob'`,
      );
      const { rows } = await db.pool.query(SELECT_ALL);
      expect(rows.find((r: Row) => r.stripe_subscription_id === "sub_bob").status).toBe(
        "unpaid",
      );
    });

    it("the webhook function keeps working through the service role under RLS", async () => {
      const rpc = createPgRpcClient(db.pool);

      const outcome = await handleStripeWebhookEvent(
        subscriptionEvent("evt_rls_1", "sub_bob", "cus_bob", null, "active"),
        rpc.client,
      );

      expect(outcome).toMatchObject({ kind: "processed", status: "active" });
    });
  });

  describe("one row per Stripe subscription", () => {
    it("creates the partial unique index", async () => {
      const { rows } = await db.pool.query(
        `select indexdef from pg_indexes
          where schemaname = 'public' and indexname = 'subscriptions_stripe_subscription_id_key'`,
      );

      expect(rows[0]?.indexdef).toMatch(
        /UNIQUE INDEX .* \(stripe_subscription_id\) WHERE/,
      );
    });

    it("rejects a second row for the same subscription id (23505)", async () => {
      await expect(
        queryAs(
          db.pool,
          "service_role",
          null,
          `insert into public.subscriptions (stripe_customer_id, stripe_subscription_id, status, "userId")
           values ('cus_alice', 'sub_alice_live', 'active', $1)`,
          [ALICE],
        ),
      ).rejects.toMatchObject({ code: "23505" });
    });

    it("still allows several rows without a subscription id (legacy customer-only rows)", async () => {
      await seed(db, [
        ["cus_alice", null, "canceled", ALICE],
        ["cus_alice", null, "canceled", ALICE],
      ]);

      const { rows } = await db.pool.query(
        "select count(*)::int as n from public.subscriptions where stripe_subscription_id is null",
      );
      expect(rows[0].n).toBe(2);
    });
  });

  describe("one owner per Stripe customer", () => {
    it("rejects linking a customer to a second user", async () => {
      await expect(
        queryAs(
          db.pool,
          "service_role",
          null,
          `insert into public.subscriptions (stripe_customer_id, stripe_subscription_id, status, "userId")
           values ('cus_alice', 'sub_alice_new', 'active', $1)`,
          [BOB],
        ),
      ).rejects.toMatchObject({
        code: "23505",
        message: /already linked to a different user/,
      });
    });

    it("rejects moving an existing row's customer to another user", async () => {
      await expect(
        queryAs(
          db.pool,
          "service_role",
          null,
          `update public.subscriptions set "userId" = $1 where stripe_subscription_id = 'sub_alice_old'`,
          [BOB],
        ),
      ).rejects.toMatchObject({ code: "23505" });
    });

    it("allows the same user, a new customer, or rows that carry no owner", async () => {
      await seed(db, [
        ["cus_alice", "sub_alice_new", "active", ALICE],
        ["cus_carol", "sub_carol", "trialing", "33333333-3333-4333-8333-333333333333"],
        ["cus_alice", "sub_alice_unowned", "incomplete", null],
      ]);

      const { rows } = await db.pool.query(
        "select count(*)::int as n from public.subscriptions",
      );
      expect(rows[0].n).toBe(7);
    });

    it("the webhook refuses an event that would cross-link a customer: 'failed', nothing recorded, rows intact", async () => {
      const rpc = createPgRpcClient(db.pool);

      const outcome = await handleStripeWebhookEvent(
        subscriptionEvent("evt_cross_1", "sub_alice_by_bob", "cus_alice", BOB),
        rpc.client,
      );

      expect(outcome).toMatchObject({
        kind: "failed",
        error: { code: "23505", message: expect.stringMatching(/already linked/) },
      });

      const { rows: ledger } = await db.pool.query(
        "select 1 from public.stripe_webhook_events where event_id = 'evt_cross_1'",
      );
      expect(ledger).toHaveLength(0); // rolled back with the claim: Stripe's retry may apply it once fixed

      const { rows } = await db.pool.query(SELECT_ALL);
      expect(rows).toHaveLength(4);
      expect(
        rows
          .filter((r: Row) => r.stripe_customer_id === "cus_alice")
          .every((r: Row) => r.user_id === ALICE),
      ).toBe(true);
    });

    it("the webhook's own owner-borrowing still works: an event without metadata joins the customer's user", async () => {
      const rpc = createPgRpcClient(db.pool);

      const outcome = await handleStripeWebhookEvent(
        subscriptionEvent("evt_borrow_1", "sub_alice_next", "cus_alice", null),
        rpc.client,
      );

      expect(outcome).toMatchObject({ kind: "processed" });
      const { rows } = await db.pool.query(
        `select "userId"::text as user_id from public.subscriptions where stripe_subscription_id = 'sub_alice_next'`,
      );
      expect(rows[0].user_id).toBe(ALICE);
    });
  });

  describe("one owner per Stripe customer – concurrency", () => {
    /**
     * A transaction left open on its own connection, so another one can race it.
     * `finish()` is safe to call in a `finally`: it rolls back whatever is still
     * open so a failing assertion cannot leave the database locked for the tests
     * that follow.
     */
    async function openInsert(customer: string, subscription: string, user: string) {
      const conn = await db.pool.connect();
      let open = true;
      await conn.query("begin");
      await conn.query("set local role service_role");
      const insert = conn.query(
        `insert into public.subscriptions (stripe_customer_id, stripe_subscription_id, status, "userId")
         values ($1, $2, 'active', $3)`,
        [customer, subscription, user],
      );
      insert.catch(() => {}); // inspected later; must not surface as unhandled

      const end = async (statement: "commit" | "rollback") => {
        if (!open) return;
        open = false;
        await conn.query(statement).catch(() => {});
        conn.release();
      };

      return {
        insert,
        commit: () => end("commit"),
        rollback: () => end("rollback"),
        finish: () => end("rollback"),
      };
    }

    const settled = (promise: Promise<unknown>, ms = 300) =>
      Promise.race([
        promise.then(
          () => "resolved",
          () => "rejected",
        ),
        new Promise<"pending">((resolve) => setTimeout(() => resolve("pending"), ms)),
      ]);

    it("REPRODUCES THE RACE: the second writer for a customer waits for the first, then is rejected", async () => {
      // Before the per-customer lock, both inserts passed the EXISTS check
      // (each snapshot predates the other's write) and both committed: one
      // customer, two users. Now the second blocks until the first finishes.
      const first = await openInsert("cus_race", "sub_race_a", ALICE);
      const second = await openInsert("cus_race", "sub_race_b", BOB);
      try {
        await first.insert; // holds the lock, uncommitted
        expect(await settled(second.insert)).toBe("pending"); // blocked, not sneaking through

        await first.commit();

        await expect(second.insert).rejects.toMatchObject({ code: "23505" });
        await second.rollback();

        const { rows } = await db.pool.query(
          `select "userId"::text as user_id from public.subscriptions where stripe_customer_id = 'cus_race'`,
        );
        expect(rows).toEqual([{ user_id: ALICE }]);
      } finally {
        await first.finish();
        await second.finish();
      }
    });

    it("if the first writer rolls back, the waiting writer proceeds (no false rejection)", async () => {
      const first = await openInsert("cus_race2", "sub_race2_a", ALICE);
      const second = await openInsert("cus_race2", "sub_race2_b", BOB);
      try {
        await first.insert;
        expect(await settled(second.insert)).toBe("pending");

        await first.rollback();

        await expect(second.insert).resolves.toMatchObject({ rowCount: 1 });
        await second.commit();

        const { rows } = await db.pool.query(
          `select "userId"::text as user_id from public.subscriptions where stripe_customer_id = 'cus_race2'`,
        );
        expect(rows).toEqual([{ user_id: BOB }]);
      } finally {
        await first.finish();
        await second.finish();
      }
    });

    it("the same user linking the same customer concurrently is not blocked into an error", async () => {
      const first = await openInsert("cus_same", "sub_same_a", ALICE);
      const second = await openInsert("cus_same", "sub_same_b", ALICE);
      try {
        await first.insert;
        expect(await settled(second.insert)).toBe("pending"); // serialised …
        await first.commit();
        await expect(second.insert).resolves.toMatchObject({ rowCount: 1 }); // … but allowed
        await second.commit();
      } finally {
        await first.finish();
        await second.finish();
      }
    });

    it("parallel webhook deliveries claiming one new customer for two users: exactly one wins, every time", async () => {
      const rpc = createPgRpcClient(db.pool);

      for (let round = 0; round < 10; round++) {
        const customer = `cus_parallel_${round}`;
        const outcomes = await Promise.all([
          handleStripeWebhookEvent(
            subscriptionEvent(
              `evt_par_${round}_a`,
              `sub_par_${round}_a`,
              customer,
              ALICE,
            ),
            rpc.client,
          ),
          handleStripeWebhookEvent(
            subscriptionEvent(`evt_par_${round}_b`, `sub_par_${round}_b`, customer, BOB),
            rpc.client,
          ),
        ]);

        const kinds = outcomes.map((o) => o.kind).sort();
        expect(kinds, `round ${round}`).toEqual(["failed", "processed"]);
        expect(outcomes.find((o) => o.kind === "failed")).toMatchObject({
          error: { code: "23505" },
        });

        const { rows } = await db.pool.query(
          `select count(distinct "userId"::text)::int as owners, count(*)::int as rows
             from public.subscriptions where stripe_customer_id = $1`,
          [customer],
        );
        expect(rows[0], `round ${round}`).toEqual({ owners: 1, rows: 1 });

        // The loser's event is not in the ledger: Stripe's retry can still apply it.
        const { rows: ledger } = await db.pool.query(
          `select event_id from public.stripe_webhook_events where event_id like $1`,
          [`evt_par_${round}_%`],
        );
        expect(ledger).toHaveLength(1);
      }
    });

    it("a rejected delivery is retried successfully once the conflict is resolved", async () => {
      const rpc = createPgRpcClient(db.pool);
      const event = subscriptionEvent(
        "evt_retry_1",
        "sub_retry_by_bob",
        "cus_alice",
        BOB,
      );

      // First delivery: cus_alice belongs to Alice → rejected, nothing recorded.
      expect(await handleStripeWebhookEvent(event, rpc.client)).toMatchObject({
        kind: "failed",
        error: { code: "23505" },
      });

      // Operator resolves it in Stripe's favour: the customer really is Bob's now
      // that Alice's rows are gone (or were re-homed).
      await db.pool.query(
        `delete from public.subscriptions where stripe_customer_id = 'cus_alice'`,
      );

      // Stripe's retry of the very same event applies.
      expect(await handleStripeWebhookEvent(event, rpc.client)).toMatchObject({
        kind: "processed",
        status: "active",
      });
      expect(await handleStripeWebhookEvent(event, rpc.client)).toMatchObject({
        kind: "duplicate",
      });

      const { rows } = await db.pool.query(
        `select "userId"::text as user_id, status from public.subscriptions
          where stripe_subscription_id = 'sub_retry_by_bob'`,
      );
      expect(rows).toEqual([{ user_id: BOB, status: "active" }]);
    });

    it("ordinary retries and lifecycle updates for an existing customer are unaffected", async () => {
      const rpc = createPgRpcClient(db.pool);

      const update = subscriptionEvent(
        "evt_life_1",
        "sub_alice_live",
        "cus_alice",
        ALICE,
        "past_due",
        1_700_000_100,
      );
      expect(await handleStripeWebhookEvent(update, rpc.client)).toMatchObject({
        kind: "processed",
        status: "past_due",
      });
      // Redelivery of the same event: duplicate, no error from the trigger.
      expect(await handleStripeWebhookEvent(update, rpc.client)).toMatchObject({
        kind: "duplicate",
      });
      // A newer event for the same subscription and customer: applied.
      expect(
        await handleStripeWebhookEvent(
          subscriptionEvent(
            "evt_life_2",
            "sub_alice_live",
            "cus_alice",
            null,
            "active",
            1_700_000_200,
          ),
          rpc.client,
        ),
      ).toMatchObject({ kind: "processed", status: "active" });
    });
  });

  describe("the migration copes with the table's unknowns", () => {
    it("is idempotent: applying it again changes nothing and keeps one policy", async () => {
      await applyMigrations(db.pool, (file) => OWNERSHIP_MIGRATION.test(file));

      const { rows } = await db.pool.query(
        "select policyname from pg_policies where schemaname = 'public' and tablename = 'subscriptions'",
      );
      expect(rows).toEqual([{ policyname: "subscriptions_select_own" }]);
      expect(
        (await queryAs(db.pool, "authenticated", BOB, SELECT_ALL)).rows,
      ).toHaveLength(1);
    });

    it("drops a leftover permissive policy that would have exposed every row", async () => {
      await db.pool.query(
        `create policy leftover_read_all on public.subscriptions for select to authenticated using (true)`,
      );
      // With policies OR-ed, Bob now sees everyone.
      expect(
        (await queryAs(db.pool, "authenticated", BOB, SELECT_ALL)).rows,
      ).toHaveLength(4);

      await applyMigrations(db.pool, (file) => OWNERSHIP_MIGRATION.test(file));

      expect(
        (await queryAs(db.pool, "authenticated", BOB, SELECT_ALL)).rows,
      ).toHaveLength(1);
    });

    it("re-revokes privileges handed back by accident", async () => {
      await db.pool.query("grant all on public.subscriptions to anon, authenticated");

      await applyMigrations(db.pool, (file) => OWNERSHIP_MIGRATION.test(file));

      await expectDenied(
        queryAs(db.pool, "authenticated", BOB, `delete from public.subscriptions`),
      );
      await expectDenied(queryAs(db.pool, "anon", null, SELECT_ALL));
    });

    it("applies on a database without the table (notice, no error) — and secures it once re-run", async () => {
      const bare = await createTestDatabase(TEST_DATABASE_URL!);
      try {
        await emulateSupabaseRoles(bare.pool);
        // Every migration applies on a bare database, this one included.
        const applied = await applyMigrations(bare.pool);
        expect(applied).toContainEqual(expect.stringMatching(OWNERSHIP_MIGRATION));

        await createStandInSubscriptionsTable(bare.pool);
        const { rows: before } = await bare.pool.query(
          "select relrowsecurity from pg_class where oid = 'public.subscriptions'::regclass",
        );
        expect(before[0].relrowsecurity).toBe(false);

        await applyMigrations(bare.pool, (file) => OWNERSHIP_MIGRATION.test(file));
        const { rows: after } = await bare.pool.query(
          "select relrowsecurity from pg_class where oid = 'public.subscriptions'::regclass",
        );
        expect(after[0].relrowsecurity).toBe(true);
      } finally {
        await bare.destroy();
      }
    });

    it("with duplicate subscription rows already present: secures the table, skips the index with a warning, creates it once cleaned", async () => {
      const dirty = await createTestDatabase(TEST_DATABASE_URL!);
      try {
        await emulateSupabaseRoles(dirty.pool);
        await createStandInSubscriptionsTable(dirty.pool);
        await applyMigrations(dirty.pool, (file) => !OWNERSHIP_MIGRATION.test(file));
        await seed(dirty, [
          ["cus_alice", "sub_dup", "active", ALICE],
          ["cus_alice", "sub_dup", "canceled", ALICE],
          ["cus_bob", "sub_bob", "active", BOB],
        ]);

        const notices = await applyOwnershipMigration(dirty);

        expect(notices.join("\n")).toMatch(
          /WARNING: .*1 Stripe subscription id\(s\) have duplicate rows/,
        );

        // Secured regardless …
        expect(
          (await queryAs(dirty.pool, "authenticated", BOB, SELECT_ALL)).rows,
        ).toHaveLength(1);
        await expectDenied(
          queryAs(dirty.pool, "authenticated", ALICE, "delete from public.subscriptions"),
        );
        // … but no unique index yet.
        const index = () =>
          dirty.pool.query(
            "select 1 from pg_indexes where indexname = 'subscriptions_stripe_subscription_id_key'",
          );
        expect((await index()).rows).toHaveLength(0);

        // Operator resolves the duplicates and re-runs the migration.
        await dirty.pool.query(
          `delete from public.subscriptions where stripe_subscription_id = 'sub_dup' and status = 'active'`,
        );
        await applyMigrations(dirty.pool, (file) => OWNERSHIP_MIGRATION.test(file));
        expect((await index()).rows).toHaveLength(1);
      } finally {
        await dirty.destroy();
      }
    });

    it("warns about customers already linked to several users (the trigger will reject their next write)", async () => {
      const shared = await createTestDatabase(TEST_DATABASE_URL!);
      try {
        await emulateSupabaseRoles(shared.pool);
        await createStandInSubscriptionsTable(shared.pool);
        await applyMigrations(shared.pool, (file) => !OWNERSHIP_MIGRATION.test(file));
        await seed(shared, [
          ["cus_shared", "sub_1", "active", ALICE],
          ["cus_shared", "sub_2", "active", BOB],
        ]);

        const notices = await applyOwnershipMigration(shared);

        expect(notices.join("\n")).toMatch(
          /WARNING: .*1 Stripe customer\(s\) are linked to more than one user/,
        );

        // The next webhook write for that customer fails loudly instead of cross-linking further.
        const outcome = await handleStripeWebhookEvent(
          subscriptionEvent("evt_shared_1", "sub_1", "cus_shared", null, "past_due"),
          createPgRpcClient(shared.pool).client,
        );
        expect(outcome).toMatchObject({ kind: "failed", error: { code: "23505" } });
      } finally {
        await shared.destroy();
      }
    });

    it('works when "userId" is stored as text', async () => {
      const textual = await createTestDatabase(TEST_DATABASE_URL!);
      try {
        await emulateSupabaseRoles(textual.pool);
        await textual.pool.query(`
          create table public.subscriptions (
            id bigserial primary key,
            stripe_customer_id text,
            stripe_subscription_id text,
            status text,
            "userId" text
          );
        `);
        await applyMigrations(textual.pool);
        await seed(textual, [
          ["cus_alice", "sub_alice", "active", ALICE],
          ["cus_bob", "sub_bob", "active", BOB],
        ]);

        const { rows } = await queryAs(textual.pool, "authenticated", ALICE, SELECT_ALL);
        expect(rows.map((r: Row) => r.stripe_subscription_id)).toEqual(["sub_alice"]);
        await expect(
          queryAs(
            textual.pool,
            "service_role",
            null,
            `insert into public.subscriptions (stripe_customer_id, stripe_subscription_id, status, "userId")
             values ('cus_alice', 'sub_x', 'active', $1)`,
            [BOB],
          ),
        ).rejects.toMatchObject({ code: "23505" });
      } finally {
        await textual.destroy();
      }
    });
  });
});
