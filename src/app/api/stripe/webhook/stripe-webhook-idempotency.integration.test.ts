// @vitest-environment node
/**
 * INTEGRATION TESTS — run against a real PostgreSQL server.
 *
 * Everything asserted here is database behaviour (transactions, primary-key and
 * advisory-lock serialisation, ordering, rollback, privileges), exercised through
 * the real application code path: signed Stripe request → route → handler → SQL
 * function. The only substitutions are (1) the Supabase HTTP layer (PostgREST) is
 * replaced by a direct connection that does what PostgREST does for a service-role
 * call, and (2) the pre-existing `subscriptions` table is a stand-in (see
 * createStandInSubscriptionsTable).
 *
 * Skipped unless TEST_DATABASE_URL is set. Run with `npm run test:db`.
 */
import { readdir } from "node:fs/promises";
import Stripe from "stripe";
import {
  afterAll,
  afterEach,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from "vitest";

import {
  EVENT_TYPE_RANK,
  handleStripeWebhookEvent,
} from "@/features/billing/services/handle-stripe-webhook-event";
import {
  applyMigrations,
  createPgRpcClient,
  createStandInSubscriptionsTable,
  createTestDatabase,
  emulateSupabaseRoles,
  MIGRATIONS_DIR,
  TEST_DATABASE_URL,
  type TestDatabase,
} from "@/shared/test/postgres";

const WEBHOOK_SECRET = "whsec_integration_secret";

// Route under test persists via the admin client; point it at the real database.
const rpc = vi.hoisted(() => ({
  current: undefined as unknown as ReturnType<
    typeof import("@/shared/test/postgres").createPgRpcClient
  >,
}));

vi.mock("@/infrastructure/supabase/admin", () => ({
  createAdminClient: vi.fn(() => rpc.current.client),
}));

const stripe = new Stripe("sk_test_dummy");

function signedRequest(payload: unknown) {
  const body = JSON.stringify(payload);
  const signature = stripe.webhooks.generateTestHeaderString({
    payload: body,
    secret: WEBHOOK_SECRET,
  });

  return new Request("http://localhost/api/stripe/webhook", {
    method: "POST",
    headers: { "stripe-signature": signature, "content-type": "application/json" },
    body,
  });
}

// ---------------------------------------------------------------------------
// Event builders
// ---------------------------------------------------------------------------

const T0 = 1_700_000_000;
let seq = 0;

type EventOptions = { id?: string; created?: number };

function stripeEvent(
  type: Stripe.Event.Type,
  object: Record<string, unknown>,
  opts: EventOptions = {},
) {
  return {
    id: opts.id ?? `evt_${++seq}`,
    object: "event",
    api_version: "2026-02-25.clover",
    created: opts.created ?? T0,
    livemode: false,
    pending_webhooks: 1,
    request: null,
    type,
    data: { object },
  };
}

const USER_A = "11111111-1111-4111-8111-111111111111";
const USER_B = "22222222-2222-4222-8222-222222222222";

const checkout = (
  sub: string,
  opts: EventOptions = {},
  overrides: Record<string, unknown> = {},
) =>
  stripeEvent(
    "checkout.session.completed",
    {
      id: `cs_${sub}`,
      object: "checkout.session",
      mode: "subscription",
      payment_status: "paid",
      subscription: sub,
      customer: `cus_${sub}`,
      metadata: { userId: USER_A },
      ...overrides,
    },
    opts,
  );

const subscriptionEvent = (
  type:
    | "customer.subscription.created"
    | "customer.subscription.updated"
    | "customer.subscription.deleted",
  sub: string,
  status: Stripe.Subscription.Status,
  opts: EventOptions = {},
  overrides: Record<string, unknown> = {},
) =>
  stripeEvent(
    type,
    {
      id: sub,
      object: "subscription",
      customer: `cus_${sub}`,
      status,
      metadata: {},
      ...overrides,
    },
    opts,
  );

const invoiceEvent = (
  type: "invoice.paid" | "invoice.payment_failed",
  sub: string,
  billingReason: Stripe.Invoice.BillingReason,
  opts: EventOptions = {},
  overrides: Record<string, unknown> = {},
) =>
  stripeEvent(
    type,
    {
      id: `in_${sub}_${seq}`,
      object: "invoice",
      customer: `cus_${sub}`,
      billing_reason: billingReason,
      amount_paid: 2900,
      parent: {
        type: "subscription_details",
        subscription_details: { subscription: sub, metadata: null },
      },
      ...overrides,
    },
    opts,
  );

const asEvent = (e: ReturnType<typeof stripeEvent>) => e as unknown as Stripe.Event;

// ---------------------------------------------------------------------------

describe.skipIf(!TEST_DATABASE_URL)(
  "Stripe subscription lifecycle (real PostgreSQL)",
  () => {
    let db: TestDatabase;
    let POST: typeof import("./route").POST;

    const apply = (e: ReturnType<typeof stripeEvent>) =>
      handleStripeWebhookEvent(asEvent(e), rpc.current.client);

    const row = async (sub: string) => {
      const { rows } = await db.pool.query(
        `select stripe_customer_id, stripe_subscription_id, status, "userId"::text as user_id
         from public.subscriptions where stripe_subscription_id = $1`,
        [sub],
      );
      return rows;
    };
    const ledger = async (eventId: string) => {
      const { rows } = await db.pool.query(
        `select outcome, stripe_subscription_id, event_created::int as event_created, type_rank
         from public.stripe_webhook_events where event_id = $1`,
        [eventId],
      );
      return rows[0] ?? null;
    };

    /** Runs a function call on its own connection inside an explicit transaction that stays open. */
    async function openTransaction(
      e: ReturnType<typeof stripeEvent>,
      change: { sub: string; status: string },
    ) {
      const conn = await db.pool.connect();
      await conn.query("begin");
      await conn.query("set local role service_role");
      const { rows } = await conn.query(
        `select public.stripe_apply_subscription_event($1, $2, $3, $4, $5, $6, $7, $8) as r`,
        [
          e.id,
          e.type,
          e.created,
          EVENT_TYPE_RANK[e.type as keyof typeof EVENT_TYPE_RANK],
          change.sub,
          `cus_${change.sub}`,
          null,
          change.status,
        ],
      );
      return {
        result: rows[0].r as string,
        commit: () => conn.query("commit").finally(() => conn.release()),
        rollback: () => conn.query("rollback").finally(() => conn.release()),
      };
    }

    const settle = <T>(p: Promise<T>) => {
      const state = { settled: false, value: undefined as T | undefined };
      const tracked = p.then((v) => {
        state.settled = true;
        state.value = v;
        return v;
      });
      return { state, tracked };
    };

    beforeAll(async () => {
      db = await createTestDatabase(TEST_DATABASE_URL!);
      await emulateSupabaseRoles(db.pool);
      await createStandInSubscriptionsTable(db.pool);
      await applyMigrations(db.pool);

      rpc.current = createPgRpcClient(db.pool);

      vi.stubEnv("STRIPE_SECRET_KEY", "sk_test_dummy");
      vi.stubEnv("STRIPE_WEBHOOK_SECRET", WEBHOOK_SECRET);
      ({ POST } = await import("./route"));
    });

    afterAll(async () => {
      vi.unstubAllEnvs();
      await db?.destroy();
    });

    beforeEach(() => {
      vi.spyOn(console, "error").mockImplementation(() => {});
      vi.spyOn(console, "warn").mockImplementation(() => {});
      vi.spyOn(console, "info").mockImplementation(() => {});
    });

    afterEach(() => {
      vi.restoreAllMocks();
    });

    // -------------------------------------------------------------------------
    describe("migrations", () => {
      it("apply in order: ledger gains ordering columns + index, old functions are gone, new one exists", async () => {
        const { rows: cols } = await db.pool.query(
          `select column_name from information_schema.columns
          where table_schema = 'public' and table_name = 'stripe_webhook_events' order by ordinal_position`,
        );
        expect(cols.map((c) => c.column_name)).toEqual([
          "event_id",
          "event_type",
          "processed_at",
          "stripe_subscription_id",
          "event_created",
          "type_rank",
          "outcome",
        ]);

        const { rows: idx } = await db.pool.query(
          `select indexname from pg_indexes where tablename = 'stripe_webhook_events' and indexname like '%position%'`,
        );
        expect(idx).toHaveLength(1);

        const { rows: fns } = await db.pool.query(
          `select proname from pg_proc where pronamespace = 'public'::regnamespace and proname like 'stripe_apply_%' order by 1`,
        );
        expect(fns.map((r) => r.proname)).toEqual(["stripe_apply_subscription_event"]);

        const { rows: rls } = await db.pool.query(
          `select relrowsecurity from pg_class where oid = 'public.stripe_webhook_events'::regclass`,
        );
        expect(rls[0].relrowsecurity).toBe(true);
      });

      it("denies EXECUTE to public, anon and authenticated; grants it to service_role only", async () => {
        const fn =
          "public.stripe_apply_subscription_event(text,text,bigint,smallint,text,text,text,text)";

        for (const role of ["anon", "authenticated"]) {
          const { rows } = await db.pool.query(
            `select has_function_privilege($1, $2, 'EXECUTE') as ok`,
            [role, fn],
          );
          expect(rows[0].ok, role).toBe(false);
        }
        const { rows: svc } = await db.pool.query(
          `select has_function_privilege('service_role', $1, 'EXECUTE') as ok`,
          [fn],
        );
        expect(svc[0].ok).toBe(true);

        const { rows: acl } = await db.pool.query(
          `select coalesce(array_to_string(proacl, ','), '') as acl from pg_proc where oid = $1::regprocedure`,
          [fn],
        );
        expect(acl[0].acl).not.toMatch(/(^|,)=X\//); // no grant to PUBLIC

        for (const role of ["anon", "authenticated"]) {
          for (const priv of ["SELECT", "INSERT", "UPDATE", "DELETE"]) {
            const { rows } = await db.pool.query(
              `select has_table_privilege($1, 'public.stripe_webhook_events', $2) as ok`,
              [role, priv],
            );
            expect(rows[0].ok, `${role} ${priv}`).toBe(false);
          }
        }
      });

      it("rejects a forged call from anon / authenticated", async () => {
        for (const role of ["anon", "authenticated"]) {
          const forged = createPgRpcClient(db.pool, role);
          const { data, error } = await forged.client.rpc(
            "stripe_apply_subscription_event",
            {
              p_event_id: `evt_forged_${role}`,
              p_event_type: "customer.subscription.updated",
              p_event_created: T0,
              p_type_rank: 30,
              p_stripe_subscription_id: "sub_forged",
              p_stripe_customer_id: null,
              p_user_id: null,
              p_status: "active",
            },
          );

          expect(data).toBeNull();
          expect(error).toMatchObject({ code: "42501" });
          expect(await row("sub_forged")).toHaveLength(0);
        }
      });

      it("apply on a database without a subscriptions table (late-bound bodies); first call fails cleanly", async () => {
        const bare = await createTestDatabase(TEST_DATABASE_URL!);
        try {
          await emulateSupabaseRoles(bare.pool);
          // Every migration file applies (none depends on `subscriptions` at apply time).
          const files = (await readdir(MIGRATIONS_DIR)).filter((f) => f.endsWith(".sql"));
          await expect(applyMigrations(bare.pool)).resolves.toHaveLength(files.length);

          const outcome = await handleStripeWebhookEvent(
            asEvent(checkout("sub_bare")),
            createPgRpcClient(bare.pool).client,
          );
          expect(outcome).toMatchObject({ kind: "failed", error: { code: "42P01" } });

          const { rows } = await bare.pool.query(
            `select count(*) from public.stripe_webhook_events`,
          );
          expect(Number(rows[0].count)).toBe(0);
        } finally {
          await bare.destroy();
        }
      });
    });

    // -------------------------------------------------------------------------
    describe("lifecycle transitions (in order)", () => {
      const sub = "sub_life";

      it("created(incomplete, no metadata) → checkout(paid, user) → updated(active) → payment failed → updated(past_due) → paid → deleted", async () => {
        expect(
          await apply(
            subscriptionEvent("customer.subscription.created", sub, "incomplete", {
              id: "life_1",
              created: T0,
            }),
          ),
        ).toMatchObject({ kind: "processed", status: "incomplete" });
        expect(await row(sub)).toEqual([
          {
            stripe_customer_id: `cus_${sub}`,
            stripe_subscription_id: sub,
            status: "incomplete",
            user_id: null,
          },
        ]);

        // Same second as `created` but lower rank: the provisional checkout status
        // does not beat Stripe's own subscription object, yet the user is linked.
        expect(await apply(checkout(sub, { id: "life_2", created: T0 }))).toMatchObject({
          kind: "stale",
        });
        expect(await row(sub)).toMatchObject([{ status: "incomplete", user_id: USER_A }]);

        expect(
          await apply(
            subscriptionEvent("customer.subscription.updated", sub, "active", {
              id: "life_3",
              created: T0 + 1,
            }),
          ),
        ).toMatchObject({ kind: "processed" });
        expect(await row(sub)).toMatchObject([{ status: "active", user_id: USER_A }]);

        expect(
          await apply(
            invoiceEvent("invoice.payment_failed", sub, "subscription_cycle", {
              id: "life_4",
              created: T0 + 2_592_000,
            }),
          ),
        ).toMatchObject({ kind: "processed", status: "past_due" });
        expect(await row(sub)).toMatchObject([{ status: "past_due" }]);

        expect(
          await apply(
            subscriptionEvent("customer.subscription.updated", sub, "past_due", {
              id: "life_5",
              created: T0 + 2_592_000,
            }),
          ),
        ).toMatchObject({ kind: "processed" });

        expect(
          await apply(
            invoiceEvent("invoice.paid", sub, "subscription_cycle", {
              id: "life_6",
              created: T0 + 2_600_000,
            }),
          ),
        ).toMatchObject({ kind: "processed", status: "active" });
        expect(await row(sub)).toMatchObject([{ status: "active", user_id: USER_A }]);

        expect(
          await apply(
            subscriptionEvent("customer.subscription.deleted", sub, "canceled", {
              id: "life_7",
              created: T0 + 5_000_000,
            }),
          ),
        ).toMatchObject({ kind: "processed", status: "canceled" });
        expect(await row(sub)).toMatchObject([{ status: "canceled", user_id: USER_A }]);

        const { rows } = await db.pool.query(
          `select event_id, outcome from public.stripe_webhook_events where stripe_subscription_id = $1 order by event_created, type_rank`,
          [sub],
        );
        expect(rows).toHaveLength(7);
        expect(rows.map((r) => [r.event_id, r.outcome])).toEqual([
          ["life_2", "stale"], // (T0, rank 10)
          ["life_1", "applied"], // (T0, rank 20)
          ["life_3", "applied"],
          ["life_4", "applied"],
          ["life_5", "applied"],
          ["life_6", "applied"],
          ["life_7", "applied"],
        ]);
      });

      it("writes Stripe's real statuses, including trialing, paused and unpaid", async () => {
        const s = "sub_statuses";
        await apply(
          subscriptionEvent("customer.subscription.created", s, "trialing", {
            created: T0,
          }),
        );
        expect(await row(s)).toMatchObject([{ status: "trialing" }]);
        await apply(
          subscriptionEvent("customer.subscription.updated", s, "paused", {
            created: T0 + 1,
          }),
        );
        expect(await row(s)).toMatchObject([{ status: "paused" }]);
        await apply(
          subscriptionEvent("customer.subscription.updated", s, "unpaid", {
            created: T0 + 2,
          }),
        );
        expect(await row(s)).toMatchObject([{ status: "unpaid" }]);
      });
    });

    // -------------------------------------------------------------------------
    describe("out-of-order and duplicate deliveries", () => {
      it("checkout completion delivered AFTER the cancellation does not resurrect it, but still links the user", async () => {
        const sub = "sub_late_checkout";

        expect(
          (
            await apply(
              subscriptionEvent("customer.subscription.deleted", sub, "canceled", {
                id: "lc_del",
                created: T0 + 100,
              }),
            )
          ).kind,
        ).toBe("processed");
        expect(await row(sub)).toMatchObject([{ status: "canceled", user_id: null }]);

        const late = await apply(checkout(sub, { id: "lc_checkout", created: T0 }));
        expect(late).toMatchObject({ kind: "stale", eventId: "lc_checkout" });

        expect(await row(sub)).toMatchObject([{ status: "canceled", user_id: USER_A }]);
        expect(await ledger("lc_checkout")).toMatchObject({
          outcome: "stale",
          stripe_subscription_id: sub,
          type_rank: 10,
        });
      });

      it("deletion arriving before creation: row is created as canceled, the late creation is stale", async () => {
        const sub = "sub_del_first";

        await apply(
          subscriptionEvent("customer.subscription.deleted", sub, "canceled", {
            created: T0 + 10,
          }),
        );
        expect(
          (
            await apply(
              subscriptionEvent("customer.subscription.created", sub, "incomplete", {
                created: T0,
              }),
            )
          ).kind,
        ).toBe("stale");
        expect(
          (
            await apply(
              subscriptionEvent("customer.subscription.updated", sub, "active", {
                created: T0 + 5,
              }),
            )
          ).kind,
        ).toBe("stale");

        expect(await row(sub)).toMatchObject([{ status: "canceled" }]);
      });

      it("an older update does not overwrite a newer one", async () => {
        const sub = "sub_old_update";

        await apply(
          subscriptionEvent("customer.subscription.updated", sub, "active", {
            created: T0 + 10,
          }),
        );
        expect(
          (
            await apply(
              subscriptionEvent("customer.subscription.updated", sub, "past_due", {
                created: T0,
              }),
            )
          ).kind,
        ).toBe("stale");
        expect(await row(sub)).toMatchObject([{ status: "active" }]);
      });

      it("same second: the subscription object outranks checkout and payment events", async () => {
        const sub = "sub_same_second";

        await apply(
          subscriptionEvent("customer.subscription.updated", sub, "active", {
            created: T0,
          }),
        );
        expect(
          (
            await apply(
              subscriptionEvent("customer.subscription.created", sub, "incomplete", {
                created: T0,
              }),
            )
          ).kind,
        ).toBe("stale");
        expect(
          (await apply(checkout(sub, { created: T0 }, { payment_status: "unpaid" })))
            .kind,
        ).toBe("stale");
        expect(
          (
            await apply(
              invoiceEvent("invoice.payment_failed", sub, "subscription_create", {
                created: T0,
              }),
            )
          ).kind,
        ).toBe("stale");
        expect(await row(sub)).toMatchObject([{ status: "active" }]);

        // Equal position (two updates in one second): the later delivery wins.
        expect(
          (
            await apply(
              subscriptionEvent("customer.subscription.updated", sub, "past_due", {
                created: T0,
              }),
            )
          ).kind,
        ).toBe("processed");
        expect(await row(sub)).toMatchObject([{ status: "past_due" }]);
      });

      it("terminal statuses are never left, even by a newer-looking event", async () => {
        const sub = "sub_terminal";

        await apply(
          subscriptionEvent("customer.subscription.deleted", sub, "canceled", {
            created: T0,
          }),
        );
        expect(
          (
            await apply(
              subscriptionEvent("customer.subscription.updated", sub, "active", {
                created: T0 + 60,
              }),
            )
          ).kind,
        ).toBe("stale");
        expect(await row(sub)).toMatchObject([{ status: "canceled" }]);

        const s2 = "sub_expired";
        await apply(
          subscriptionEvent("customer.subscription.updated", s2, "incomplete_expired", {
            created: T0,
          }),
        );
        expect(
          (
            await apply(
              invoiceEvent("invoice.paid", s2, "subscription_cycle", {
                created: T0 + 60,
              }),
            )
          ).kind,
        ).toBe("stale");
        expect(await row(s2)).toMatchObject([{ status: "incomplete_expired" }]);
      });

      it("duplicate delivery (handler and HTTP): acknowledged, nothing re-applied", async () => {
        const sub = "sub_dup";
        const e = subscriptionEvent("customer.subscription.updated", sub, "active", {
          id: "dup_1",
          created: T0,
        });

        expect((await apply(e)).kind).toBe("processed");
        expect((await apply(e)).kind).toBe("duplicate");

        const http = checkout("sub_dup_http", { id: "dup_http" });
        const [a, b] = [await POST(signedRequest(http)), await POST(signedRequest(http))];
        expect([a.status, b.status]).toEqual([200, 200]);
        expect(await row("sub_dup_http")).toHaveLength(1);
      });

      it("legacy row without ledger history: the first event applies (no position to compare against)", async () => {
        await db.pool.query(
          `insert into public.subscriptions (stripe_customer_id, stripe_subscription_id, status, "userId") values ('cus_legacy', 'sub_legacy', 'active', $1)`,
          [USER_B],
        );

        expect(
          (
            await apply(
              subscriptionEvent(
                "customer.subscription.updated",
                "sub_legacy",
                "past_due",
                { created: T0 - 1_000_000 },
              ),
            )
          ).kind,
        ).toBe("processed");
        expect(await row("sub_legacy")).toMatchObject([
          { status: "past_due", user_id: USER_B },
        ]);
      });
    });

    // -------------------------------------------------------------------------
    describe("user association without metadata", () => {
      it("created without metadata → no user; checkout (lower rank, same second) fills it without touching status", async () => {
        const sub = "sub_assoc";

        await apply(
          subscriptionEvent("customer.subscription.created", sub, "active", {
            created: T0,
          }),
        );
        expect(await row(sub)).toMatchObject([{ status: "active", user_id: null }]);

        // Same second, lower rank: stale for status, but identity is merged.
        const c = await apply(
          checkout(sub, { created: T0 }, { payment_status: "unpaid" }),
        );
        expect(c.kind).toBe("stale");
        expect(await row(sub)).toMatchObject([{ status: "active", user_id: USER_A }]);
      });

      it("a second subscription of the same customer with no metadata borrows the user from the first", async () => {
        const first = "sub_cust_1";
        const second = "sub_cust_2";

        await apply(
          checkout(
            first,
            { created: T0 },
            { customer: "cus_shared", metadata: { userId: USER_B } },
          ),
        );
        await apply(
          subscriptionEvent(
            "customer.subscription.created",
            second,
            "active",
            { created: T0 + 1 },
            { customer: "cus_shared", metadata: {} },
          ),
        );

        expect(await row(second)).toEqual([
          {
            stripe_customer_id: "cus_shared",
            stripe_subscription_id: second,
            status: "active",
            user_id: USER_B,
          },
        ]);
      });

      it("a user id already on the row is never replaced by a different one from a later event", async () => {
        const sub = "sub_keep_user";

        await apply(checkout(sub, { created: T0 }, { metadata: { userId: USER_A } }));
        await apply(
          subscriptionEvent(
            "customer.subscription.updated",
            sub,
            "active",
            { created: T0 + 1 },
            { metadata: { userId: USER_B } },
          ),
        );

        expect(await row(sub)).toMatchObject([{ user_id: USER_A }]);
      });

      it("invoice events can supply the user through the subscription metadata snapshot", async () => {
        const sub = "sub_inv_meta";

        await apply(
          invoiceEvent(
            "invoice.paid",
            sub,
            "subscription_cycle",
            { created: T0 },
            {
              parent: {
                type: "subscription_details",
                subscription_details: { subscription: sub, metadata: { userId: USER_B } },
              },
            },
          ),
        );

        expect(await row(sub)).toMatchObject([{ status: "active", user_id: USER_B }]);
      });
    });

    // -------------------------------------------------------------------------
    describe("concurrency", () => {
      it("N different events for one subscription on separate connections: final status is the newest position", async () => {
        for (let round = 0; round < 5; round++) {
          const sub = `sub_conc_${round}`;
          const events = [
            subscriptionEvent("customer.subscription.created", sub, "incomplete", {
              created: T0,
            }),
            checkout(sub, { created: T0 + 1 }),
            invoiceEvent("invoice.payment_failed", sub, "subscription_cycle", {
              created: T0 + 2,
            }),
            subscriptionEvent("customer.subscription.updated", sub, "active", {
              created: T0 + 3,
            }),
            subscriptionEvent("customer.subscription.updated", sub, "past_due", {
              created: T0 + 4,
            }),
            subscriptionEvent("customer.subscription.deleted", sub, "canceled", {
              created: T0 + 5,
            }),
          ].sort(() => Math.random() - 0.5);

          const outcomes = await Promise.all(events.map(apply));

          expect(
            outcomes.every((o) => o.kind === "processed" || o.kind === "stale"),
            JSON.stringify(outcomes),
          ).toBe(true);
          expect(await row(sub), `round ${round}`).toEqual([
            {
              stripe_customer_id: `cus_${sub}`,
              stripe_subscription_id: sub,
              status: "canceled",
              user_id: USER_A,
            },
          ]);
        }
      });

      it("simultaneous first events for a new subscription never create two rows", async () => {
        for (let round = 0; round < 5; round++) {
          const sub = `sub_first_${round}`;
          await Promise.all([
            apply(
              subscriptionEvent("customer.subscription.created", sub, "incomplete", {
                created: T0,
              }),
            ),
            apply(
              subscriptionEvent("customer.subscription.updated", sub, "active", {
                created: T0,
              }),
            ),
            apply(checkout(sub, { created: T0 })),
            apply(
              invoiceEvent("invoice.paid", sub, "subscription_create", { created: T0 }),
            ),
          ]);

          expect(await row(sub), `round ${round}`).toEqual([
            {
              stripe_customer_id: `cus_${sub}`,
              stripe_subscription_id: sub,
              status: "active",
              user_id: USER_A,
            },
          ]);
        }
      });

      it("parallel delivery of the same event: exactly one applied", async () => {
        const e = checkout("sub_same_event", { id: "same_event", created: T0 });
        const kinds = (await Promise.all(Array.from({ length: 12 }, () => apply(e)))).map(
          (o) => o.kind,
        );

        expect(kinds.filter((k) => k === "processed")).toHaveLength(1);
        expect(kinds.filter((k) => k === "duplicate")).toHaveLength(11);
        expect(await row("sub_same_event")).toHaveLength(1);
      });

      it("a different event for the same subscription waits for an open transaction, then sees its result (commit)", async () => {
        const sub = "sub_lock_commit";
        const a = await openTransaction(
          subscriptionEvent("customer.subscription.deleted", sub, "canceled", {
            id: "lock_a",
            created: T0 + 10,
          }),
          { sub, status: "canceled" },
        );
        expect(a.result).toBe("applied");

        const b = settle(
          apply(
            subscriptionEvent("customer.subscription.updated", sub, "active", {
              id: "lock_b",
              created: T0,
            }),
          ),
        );
        await new Promise((r) => setTimeout(r, 300));
        expect(b.state.settled, "B must wait on the advisory lock while A is open").toBe(
          false,
        );

        await a.commit();
        expect(await b.tracked).toMatchObject({ kind: "stale" }); // saw A's newer position
        expect(await row(sub)).toMatchObject([{ status: "canceled" }]);
      });

      it("a different event for the same subscription proceeds normally if the open transaction rolls back", async () => {
        const sub = "sub_lock_rollback";
        const a = await openTransaction(
          subscriptionEvent("customer.subscription.deleted", sub, "canceled", {
            id: "lock_ra",
            created: T0 + 10,
          }),
          { sub, status: "canceled" },
        );

        const b = settle(
          apply(
            subscriptionEvent("customer.subscription.updated", sub, "active", {
              id: "lock_rb",
              created: T0,
            }),
          ),
        );
        await new Promise((r) => setTimeout(r, 300));
        expect(b.state.settled).toBe(false);

        await a.rollback();
        expect(await b.tracked).toMatchObject({ kind: "processed" }); // A left nothing behind
        expect(await row(sub)).toMatchObject([{ status: "active" }]);
        expect(await ledger("lock_ra")).toBeNull();
      });

      it("the same event delivered while its first processing is open: waits, then duplicate", async () => {
        const sub = "sub_same_open";
        const e = subscriptionEvent("customer.subscription.updated", sub, "active", {
          id: "same_open",
          created: T0,
        });
        const a = await openTransaction(e, { sub, status: "active" });

        const b = settle(apply(e));
        await new Promise((r) => setTimeout(r, 300));
        expect(b.state.settled).toBe(false);

        await a.commit();
        expect(await b.tracked).toMatchObject({ kind: "duplicate" });
      });
    });

    // -------------------------------------------------------------------------
    describe("failure recovery", () => {
      const installFailure = (sub: string, on: "insert" | "update") =>
        db.pool.query(`
        create or replace function public.__fail() returns trigger language plpgsql as $$
        begin raise exception 'simulated persistence failure'; end $$;
        create trigger __fail before ${on} on public.subscriptions
          for each row when (new.stripe_subscription_id = '${sub}')
          execute function public.__fail();
      `);
      const removeFailure = () =>
        db.pool.query(`drop trigger if exists __fail on public.subscriptions`);

      afterEach(removeFailure);

      it("failed insert: nothing recorded → retry applies once → further deliveries are duplicates", async () => {
        const sub = "sub_fail_insert";
        const e = subscriptionEvent("customer.subscription.created", sub, "active", {
          id: "fi_1",
          created: T0,
        });
        await installFailure(sub, "insert");

        expect(await apply(e)).toMatchObject({
          kind: "failed",
          error: { message: expect.stringContaining("simulated") },
        });
        expect(await ledger("fi_1")).toBeNull();
        expect(await row(sub)).toHaveLength(0);

        await removeFailure();

        expect((await apply(e)).kind).toBe("processed");
        expect((await apply(e)).kind).toBe("duplicate");
        expect(await row(sub)).toHaveLength(1);
      });

      it("failed update: previous status and ledger untouched → retry applies", async () => {
        const sub = "sub_fail_update";
        await apply(
          subscriptionEvent("customer.subscription.created", sub, "active", {
            created: T0,
          }),
        );
        await installFailure(sub, "update");

        const e = subscriptionEvent("customer.subscription.deleted", sub, "canceled", {
          id: "fu_1",
          created: T0 + 1,
        });
        expect((await apply(e)).kind).toBe("failed");
        expect(await ledger("fu_1")).toBeNull();
        expect(await row(sub)).toMatchObject([{ status: "active" }]);

        await removeFailure();

        expect((await apply(e)).kind).toBe("processed");
        expect(await row(sub)).toMatchObject([{ status: "canceled" }]);
        expect(await ledger("fu_1")).toMatchObject({ outcome: "applied" });
      });

      it("route: 500 while persistence fails, 200 on Stripe's retry", async () => {
        const sub = "sub_fail_http";
        await installFailure(sub, "insert");
        const e = checkout(sub, { id: "fh_1" });

        const failed = await POST(signedRequest(e));
        expect(failed.status).toBe(500);
        expect(await failed.text()).toBe("Persistence error");
        expect(await ledger("fh_1")).toBeNull();

        await removeFailure();

        expect((await POST(signedRequest(e))).status).toBe(200);
        expect(await row(sub)).toHaveLength(1);
      });

      it("a user id that does not fit the real column type fails the whole transaction", async () => {
        const e = checkout(
          "sub_bad_uuid",
          { id: "bad_uuid" },
          { metadata: { userId: "not-a-uuid" } },
        );

        expect(await apply(e)).toMatchObject({
          kind: "failed",
          error: { code: "22P02" },
        });
        expect(await ledger("bad_uuid")).toBeNull();
        expect(await row("sub_bad_uuid")).toHaveLength(0);
      });

      it("the function refuses to run without a subscription id or status", async () => {
        const { error } = await rpc.current.client.rpc(
          "stripe_apply_subscription_event",
          {
            p_event_id: "evt_invalid",
            p_event_type: "customer.subscription.updated",
            p_event_created: T0,
            p_type_rank: 30,
            p_stripe_subscription_id: "sub_invalid",
            p_stripe_customer_id: null,
            p_user_id: null,
            p_status: null,
          },
        );

        expect(error).toMatchObject({ code: "22004" });
        expect(await ledger("evt_invalid")).toBeNull();
      });
    });
  },
);
