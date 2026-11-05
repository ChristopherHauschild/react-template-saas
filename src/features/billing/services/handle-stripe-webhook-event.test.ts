// @vitest-environment node
import { readdir, readFile } from "node:fs/promises";
import path from "node:path";
import type Stripe from "stripe";
import { describe, expect, it } from "vitest";

import {
  createFakeIdempotentSupabase,
  createFakeSupabase,
  OK_RESPONSE,
} from "@/shared/test/supabase";

import {
  EVENT_TYPE_RANK,
  extractSubscriptionChange,
  HANDLED_EVENT_TYPES,
  handleStripeWebhookEvent,
  provisionalStatusFromCheckout,
  statusFromInvoice,
  STRIPE_RPC,
} from "./handle-stripe-webhook-event";

// ---------------------------------------------------------------------------
// Event builders: only the fields the handler reads are populated.
// ---------------------------------------------------------------------------

type EventOptions = { id?: string; created?: number };

function stripeEvent(
  type: Stripe.Event.Type,
  object: Record<string, unknown>,
  opts: EventOptions = {},
) {
  return {
    id: opts.id ?? `evt_${type.replace(/\./g, "_")}`,
    object: "event",
    api_version: "2026-02-25.clover",
    created: opts.created ?? 1_700_000_000,
    livemode: false,
    pending_webhooks: 1,
    request: null,
    type,
    data: { object },
  } as unknown as Stripe.Event;
}

const checkout = (overrides: Record<string, unknown> = {}, opts?: EventOptions) =>
  stripeEvent(
    "checkout.session.completed",
    {
      id: "cs_1",
      object: "checkout.session",
      mode: "subscription",
      payment_status: "paid",
      subscription: "sub_1",
      customer: "cus_1",
      metadata: { userId: "user_1" },
      ...overrides,
    },
    opts,
  );

const subscription = (
  type:
    | "customer.subscription.created"
    | "customer.subscription.updated"
    | "customer.subscription.deleted",
  overrides: Record<string, unknown> = {},
  opts?: EventOptions,
) =>
  stripeEvent(
    type,
    {
      id: "sub_1",
      object: "subscription",
      customer: "cus_1",
      status: type === "customer.subscription.deleted" ? "canceled" : "active",
      metadata: {},
      ...overrides,
    },
    opts,
  );

const invoice = (
  type: "invoice.paid" | "invoice.payment_succeeded" | "invoice.payment_failed",
  overrides: Record<string, unknown> = {},
  opts?: EventOptions,
) =>
  stripeEvent(
    type,
    {
      id: "in_1",
      object: "invoice",
      customer: "cus_1",
      billing_reason: "subscription_cycle",
      amount_paid: 2900,
      parent: {
        type: "subscription_details",
        subscription_details: { subscription: "sub_1", metadata: null },
      },
      ...overrides,
    },
    opts,
  );

const rpcResult = (data: unknown) => ({ ...OK_RESPONSE, status: 200, data });
const rpcParams = (db: ReturnType<typeof createFakeSupabase>) =>
  db.argsOf(db.queries[0], "rpc")?.[1] as Record<string, unknown>;

const dbError = { message: "permission denied", code: "42501", details: "d", hint: "h" };

// ---------------------------------------------------------------------------

describe("extractSubscriptionChange – what each event says about a subscription", () => {
  it("checkout.session.completed: ids + user metadata, status derived from payment outcome", () => {
    expect(extractSubscriptionChange(checkout())).toEqual({
      change: {
        stripeSubscriptionId: "sub_1",
        stripeCustomerId: "cus_1",
        userId: "user_1",
        status: "active",
      },
    });
    expect(
      extractSubscriptionChange(checkout({ payment_status: "unpaid" })),
    ).toMatchObject({
      change: { status: "incomplete" },
    });
    expect(
      extractSubscriptionChange(checkout({ payment_status: "no_payment_required" })),
    ).toMatchObject({
      change: { status: "trialing" },
    });
  });

  it("checkout.session.completed without a subscription (payment mode) is skipped", () => {
    expect(
      extractSubscriptionChange(checkout({ subscription: null, mode: "payment" })),
    ).toMatchObject({
      skip: "missing_subscription_id",
    });
  });

  it("customer.subscription.* : Stripe's real status, customer and subscription metadata", () => {
    expect(
      extractSubscriptionChange(
        subscription("customer.subscription.updated", {
          status: "past_due",
          metadata: { userId: "user_meta" },
        }),
      ),
    ).toEqual({
      change: {
        stripeSubscriptionId: "sub_1",
        stripeCustomerId: "cus_1",
        userId: "user_meta",
        status: "past_due",
      },
    });

    expect(
      extractSubscriptionChange(subscription("customer.subscription.deleted")),
    ).toMatchObject({
      change: { status: "canceled", userId: null },
    });
  });

  it("accepts expanded objects and normalises them to ids", () => {
    expect(
      extractSubscriptionChange(
        checkout({
          subscription: { id: "sub_x", object: "subscription" },
          customer: { id: "cus_x", object: "customer" },
        }),
      ),
    ).toMatchObject({
      change: { stripeSubscriptionId: "sub_x", stripeCustomerId: "cus_x" },
    });
  });

  it("invoice.*: subscription from parent.subscription_details, user from its metadata snapshot", () => {
    expect(
      extractSubscriptionChange(
        invoice("invoice.paid", {
          parent: {
            type: "subscription_details",
            subscription_details: {
              subscription: "sub_1",
              metadata: { userId: "user_inv" },
            },
          },
        }),
      ),
    ).toEqual({
      change: {
        stripeSubscriptionId: "sub_1",
        stripeCustomerId: "cus_1",
        userId: "user_inv",
        status: "active",
      },
    });
  });

  it("invoice.* without a subscription parent (one-off invoice) is skipped", () => {
    expect(
      extractSubscriptionChange(invoice("invoice.paid", { parent: null })),
    ).toMatchObject({
      skip: "missing_subscription_id",
    });
  });

  it("invoice.* whose billing reason implies no status is skipped", () => {
    expect(
      extractSubscriptionChange(invoice("invoice.paid", { billing_reason: "manual" })),
    ).toMatchObject({
      skip: "payment_event_not_mapped",
    });
  });

  it("returns null for event types outside the subscription lifecycle", () => {
    expect(
      extractSubscriptionChange(stripeEvent("charge.refunded", { id: "ch_1" })),
    ).toBeNull();
  });
});

describe("status mapping tables", () => {
  it("payment outcome → subscription status, per Stripe's documented behaviour", () => {
    expect(statusFromInvoice("paid", "subscription_cycle", 2900)).toBe("active");
    expect(statusFromInvoice("paid", "subscription_update", 500)).toBe("active");
    expect(statusFromInvoice("paid", "subscription_create", 2900)).toBe("active");
    expect(statusFromInvoice("paid", "subscription_create", 0)).toBeNull(); // trial or 100% coupon: unknown
    expect(statusFromInvoice("paid", "manual", 2900)).toBeNull();
    expect(statusFromInvoice("paid", null, 2900)).toBeNull();

    expect(statusFromInvoice("failed", "subscription_create", 0)).toBe("incomplete");
    expect(statusFromInvoice("failed", "subscription_cycle", 0)).toBe("past_due");
    expect(statusFromInvoice("failed", "subscription_update", 0)).toBe("past_due");
    expect(statusFromInvoice("failed", "subscription_threshold", 0)).toBe("past_due");
    expect(statusFromInvoice("failed", "manual", 0)).toBeNull();
  });

  it("checkout payment status → provisional subscription status", () => {
    expect(provisionalStatusFromCheckout("paid")).toBe("active");
    expect(provisionalStatusFromCheckout("unpaid")).toBe("incomplete");
    expect(provisionalStatusFromCheckout("no_payment_required")).toBe("trialing");
  });

  it("ranks: every handled type has one; subscription object > payment events > checkout; deletion highest", () => {
    for (const type of HANDLED_EVENT_TYPES)
      expect(EVENT_TYPE_RANK[type]).toEqual(expect.any(Number));

    const r = EVENT_TYPE_RANK;
    expect(r["checkout.session.completed"]).toBeLessThan(
      r["customer.subscription.created"],
    );
    expect(r["customer.subscription.created"]).toBeLessThan(r["invoice.paid"]);
    expect(r["invoice.paid"]).toBe(r["invoice.payment_succeeded"]);
    expect(r["invoice.paid"]).toBe(r["invoice.payment_failed"]);
    expect(r["invoice.payment_failed"]).toBeLessThan(r["customer.subscription.updated"]);
    expect(r["customer.subscription.updated"]).toBeLessThan(
      r["customer.subscription.deleted"],
    );
  });
});

describe("handleStripeWebhookEvent – RPC contract (mocked database)", () => {
  it("passes event position, ids, user and status to the single lifecycle function", async () => {
    const db = createFakeSupabase(() => rpcResult("applied"));

    const outcome = await handleStripeWebhookEvent(
      subscription(
        "customer.subscription.updated",
        { status: "past_due" },
        { id: "evt_u", created: 1_700_000_123 },
      ),
      db.client,
    );

    expect(outcome).toEqual({
      kind: "processed",
      eventType: "customer.subscription.updated",
      status: "past_due",
    });
    expect(db.queries).toHaveLength(1);
    expect(db.queries[0].table).toBe(STRIPE_RPC.applySubscriptionEvent.fn);
    expect(rpcParams(db)).toEqual({
      p_event_id: "evt_u",
      p_event_type: "customer.subscription.updated",
      p_event_created: 1_700_000_123,
      p_type_rank: EVENT_TYPE_RANK["customer.subscription.updated"],
      p_stripe_subscription_id: "sub_1",
      p_stripe_customer_id: "cus_1",
      p_user_id: null,
      p_status: "past_due",
    });
    expect(Object.keys(rpcParams(db)).sort()).toEqual(
      [...STRIPE_RPC.applySubscriptionEvent.params].sort(),
    );
  });

  it("maps 'stale' to a stale outcome (acknowledged, status untouched)", async () => {
    const db = createFakeSupabase(() => rpcResult("stale"));
    expect(
      await handleStripeWebhookEvent(checkout({}, { id: "evt_s" }), db.client),
    ).toEqual({
      kind: "stale",
      eventType: "checkout.session.completed",
      eventId: "evt_s",
    });
  });

  it("maps 'duplicate' to a duplicate outcome", async () => {
    const db = createFakeSupabase(() => rpcResult("duplicate"));
    expect(
      await handleStripeWebhookEvent(checkout({}, { id: "evt_d" }), db.client),
    ).toEqual({
      kind: "duplicate",
      eventType: "checkout.session.completed",
      eventId: "evt_d",
    });
  });

  it("reports a failed outcome with the database error instead of swallowing it", async () => {
    const db = createFakeSupabase(() => ({ ...OK_RESPONSE, data: null, error: dbError }));
    expect(
      await handleStripeWebhookEvent(
        subscription("customer.subscription.deleted"),
        db.client,
      ),
    ).toEqual({
      kind: "failed",
      eventType: "customer.subscription.deleted",
      error: dbError,
    });
  });

  it("treats an unknown RPC result as a failure rather than acknowledging blindly", async () => {
    const db = createFakeSupabase(() => rpcResult(null));
    expect(await handleStripeWebhookEvent(checkout(), db.client)).toMatchObject({
      kind: "failed",
      error: { message: expect.stringContaining("unexpected result") },
    });
  });

  it("skipped events never reach the database", async () => {
    const db = createFakeSupabase();

    expect(
      await handleStripeWebhookEvent(
        stripeEvent("charge.refunded", { id: "ch_1" }),
        db.client,
      ),
    ).toEqual({
      kind: "skipped",
      eventType: "charge.refunded",
      reason: "unhandled_event_type",
    });
    expect(
      await handleStripeWebhookEvent(
        invoice("invoice.paid", { billing_reason: "manual" }),
        db.client,
      ),
    ).toMatchObject({
      kind: "skipped",
      reason: "payment_event_not_mapped",
    });
    expect(db.queries).toHaveLength(0);
  });
});

describe("handleStripeWebhookEvent – lifecycle scenarios against the in-memory MOCK", () => {
  // The mock mirrors the SQL function's contract; the same scenarios are verified
  // against real PostgreSQL in stripe-webhook-idempotency.integration.test.ts.

  const T = 1_700_000_000;

  it("in-order lifecycle: created(incomplete) → paid → updated(active) → payment failed → updated(past_due) → deleted", async () => {
    const db = createFakeIdempotentSupabase();
    const run = (e: Stripe.Event) => handleStripeWebhookEvent(e, db.client);

    await run(
      subscription(
        "customer.subscription.created",
        { status: "incomplete" },
        { id: "e1", created: T },
      ),
    );
    expect(db.row("sub_1")?.status).toBe("incomplete");

    await run(
      invoice(
        "invoice.paid",
        { billing_reason: "subscription_create" },
        { id: "e2", created: T + 1 },
      ),
    );
    expect(db.row("sub_1")?.status).toBe("active");

    await run(
      subscription(
        "customer.subscription.updated",
        { status: "active" },
        { id: "e3", created: T + 1 },
      ),
    );
    expect(db.row("sub_1")?.status).toBe("active");

    await run(
      invoice("invoice.payment_failed", {}, { id: "e4", created: T + 2_592_000 }),
    );
    expect(db.row("sub_1")?.status).toBe("past_due");

    await run(
      subscription(
        "customer.subscription.updated",
        { status: "past_due" },
        { id: "e5", created: T + 2_592_000 },
      ),
    );
    expect(db.row("sub_1")?.status).toBe("past_due");

    const del = await run(
      subscription(
        "customer.subscription.deleted",
        {},
        { id: "e6", created: T + 2_600_000 },
      ),
    );
    expect(del.kind).toBe("processed");
    expect(db.row("sub_1")?.status).toBe("canceled");
  });

  it("out of order: checkout completion arriving after the cancellation does not resurrect the subscription", async () => {
    const db = createFakeIdempotentSupabase();

    await handleStripeWebhookEvent(
      subscription(
        "customer.subscription.deleted",
        {},
        { id: "e_del", created: T + 100 },
      ),
      db.client,
    );
    const late = await handleStripeWebhookEvent(
      checkout({}, { id: "e_checkout", created: T }),
      db.client,
    );

    expect(late.kind).toBe("stale");
    expect(db.row("sub_1")?.status).toBe("canceled");
    // ...but the identity it carried was still merged in.
    expect(db.row("sub_1")?.userId).toBe("user_1");
  });

  it("out of order: an older update does not overwrite a newer one", async () => {
    const db = createFakeIdempotentSupabase();

    await handleStripeWebhookEvent(
      subscription(
        "customer.subscription.updated",
        { status: "active" },
        { id: "newer", created: T + 10 },
      ),
      db.client,
    );
    const old = await handleStripeWebhookEvent(
      subscription(
        "customer.subscription.updated",
        { status: "past_due" },
        { id: "older", created: T },
      ),
      db.client,
    );

    expect(old.kind).toBe("stale");
    expect(db.row("sub_1")?.status).toBe("active");
  });

  it("same second: subscription object outranks checkout and payment events regardless of arrival order", async () => {
    const db = createFakeIdempotentSupabase();

    await handleStripeWebhookEvent(
      subscription(
        "customer.subscription.updated",
        { status: "active" },
        { id: "u", created: T },
      ),
      db.client,
    );
    expect(
      (
        await handleStripeWebhookEvent(
          checkout({ payment_status: "unpaid" }, { id: "c", created: T }),
          db.client,
        )
      ).kind,
    ).toBe("stale");
    expect(
      (
        await handleStripeWebhookEvent(
          invoice("invoice.payment_failed", {}, { id: "i", created: T }),
          db.client,
        )
      ).kind,
    ).toBe("stale");
    expect(db.row("sub_1")?.status).toBe("active");
  });

  it("terminal: nothing moves a canceled subscription back, even with a newer timestamp", async () => {
    const db = createFakeIdempotentSupabase();

    await handleStripeWebhookEvent(
      subscription("customer.subscription.deleted", {}, { id: "d", created: T }),
      db.client,
    );
    const later = await handleStripeWebhookEvent(
      subscription(
        "customer.subscription.updated",
        { status: "active" },
        { id: "u", created: T + 5 },
      ),
      db.client,
    );

    expect(later.kind).toBe("stale");
    expect(db.row("sub_1")?.status).toBe("canceled");
  });

  it("missing metadata: created without userId, then checkout fills it; later events keep it", async () => {
    const db = createFakeIdempotentSupabase();

    await handleStripeWebhookEvent(
      subscription(
        "customer.subscription.created",
        { status: "incomplete" },
        { id: "c1", created: T },
      ),
      db.client,
    );
    expect(db.row("sub_1")?.userId).toBeNull();

    await handleStripeWebhookEvent(checkout({}, { id: "c2", created: T }), db.client);
    expect(db.row("sub_1")?.userId).toBe("user_1");

    await handleStripeWebhookEvent(
      subscription(
        "customer.subscription.updated",
        { status: "active", metadata: {} },
        { id: "c3", created: T + 1 },
      ),
      db.client,
    );
    expect(db.row("sub_1")).toMatchObject({ userId: "user_1", status: "active" });
  });

  it("missing metadata: a new subscription of a known customer borrows the user from the customer's other subscription", async () => {
    const db = createFakeIdempotentSupabase({
      existingRows: [
        {
          stripe_subscription_id: "sub_old",
          stripe_customer_id: "cus_1",
          userId: "user_1",
          status: "canceled",
        },
      ],
    });

    await handleStripeWebhookEvent(
      subscription(
        "customer.subscription.created",
        { id: "sub_new", status: "active", metadata: {} },
        { id: "n1", created: T },
      ),
      db.client,
    );

    expect(db.row("sub_new")).toMatchObject({
      userId: "user_1",
      stripe_customer_id: "cus_1",
      status: "active",
    });
  });

  it("duplicate delivery is reported and changes nothing", async () => {
    const db = createFakeIdempotentSupabase();
    const e = subscription(
      "customer.subscription.updated",
      { status: "active" },
      { id: "dup", created: T },
    );

    expect((await handleStripeWebhookEvent(e, db.client)).kind).toBe("processed");
    expect((await handleStripeWebhookEvent(e, db.client)).kind).toBe("duplicate");
    expect(db.attempts.get("dup")).toBe(1);
  });

  it("concurrent updates for one subscription: final status is the newest position, whatever finishes first", async () => {
    const db = createFakeIdempotentSupabase({ latencyMs: 3 });
    const events = [
      subscription(
        "customer.subscription.updated",
        { status: "active" },
        { id: "p1", created: T + 3 },
      ),
      subscription("customer.subscription.deleted", {}, { id: "p2", created: T + 4 }),
      subscription(
        "customer.subscription.created",
        { status: "incomplete" },
        { id: "p3", created: T },
      ),
      invoice("invoice.payment_failed", {}, { id: "p4", created: T + 2 }),
      checkout({}, { id: "p5", created: T + 1 }),
    ];

    const outcomes = await Promise.all(
      events.map((e) => handleStripeWebhookEvent(e, db.client)),
    );

    expect(outcomes.every((o) => o.kind === "processed" || o.kind === "stale")).toBe(
      true,
    );
    expect(db.row("sub_1")).toMatchObject({ status: "canceled", userId: "user_1" });
  });

  it("parallel delivery of the same event: exactly one applied", async () => {
    const db = createFakeIdempotentSupabase({ latencyMs: 3 });
    const e = checkout({}, { id: "same", created: T });

    const kinds = (
      await Promise.all(
        Array.from({ length: 8 }, () => handleStripeWebhookEvent(e, db.client)),
      )
    ).map((o) => o.kind);

    expect(kinds.filter((k) => k === "processed")).toHaveLength(1);
    expect(kinds.filter((k) => k === "duplicate")).toHaveLength(7);
  });

  it("failure recovery: a failed transaction records nothing; the retry applies; a third delivery is a duplicate", async () => {
    const db = createFakeIdempotentSupabase({ failOnAttempt: { f1: [1] } });
    const e = subscription(
      "customer.subscription.created",
      { status: "active" },
      { id: "f1", created: T },
    );

    expect((await handleStripeWebhookEvent(e, db.client)).kind).toBe("failed");
    expect(db.ledger.has("f1")).toBe(false);
    expect(db.row("sub_1")).toBeUndefined();

    expect((await handleStripeWebhookEvent(e, db.client)).kind).toBe("processed");
    expect((await handleStripeWebhookEvent(e, db.client)).kind).toBe("duplicate");
    expect(db.row("sub_1")?.status).toBe("active");
  });
});

describe("TS ↔ SQL contract (static check against the migration files)", () => {
  it("the lifecycle function, its parameters and result values appear in the lifecycle migration", async () => {
    const dir = path.resolve(__dirname, "../../../../supabase/migrations");
    const files = (await readdir(dir)).filter((f) =>
      f.endsWith("_stripe_subscription_lifecycle.sql"),
    );
    expect(files).toHaveLength(1);

    const sql = await readFile(path.join(dir, files[0]), "utf8");
    const { fn, params } = STRIPE_RPC.applySubscriptionEvent;

    expect(sql).toMatch(new RegExp(`create function public\\.${fn}\\(`));
    expect(sql).toMatch(
      new RegExp(
        `revoke execute on function public\\.${fn}\\([^)]*\\)\\s+from public, anon, authenticated`,
      ),
    );
    expect(sql).toMatch(
      new RegExp(
        `grant\\s+execute on function public\\.${fn}\\([^)]*\\)\\s+to service_role`,
      ),
    );
    for (const param of params)
      expect(sql).toMatch(new RegExp(`\\b${param}\\s+(text|bigint|smallint)\\b`));
    for (const result of STRIPE_RPC.results) expect(sql).toContain(`'${result}'`);
  });
});
