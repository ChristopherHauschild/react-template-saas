// @vitest-environment node
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
  createFakeIdempotentSupabase,
  createFakeSupabase,
  type FakeQueryResponder,
  OK_RESPONSE,
} from "@/shared/test/supabase";

const WEBHOOK_SECRET = "whsec_test_secret";

// The route must persist through the privileged server-side client. Tests swap it
// for a recording fake; whatever `db.current` points at is what the route gets.
const db = vi.hoisted(() => ({
  current: undefined as unknown as ReturnType<
    typeof import("@/shared/test/supabase").createFakeSupabase
  >,
}));

vi.mock("@/infrastructure/supabase/admin", () => ({
  createAdminClient: vi.fn(() => db.current.client),
}));

// Real Stripe SDK (no network): used both to sign test payloads and, inside the
// route via `getStripe()`, to verify them.
const stripe = new Stripe("sk_test_dummy");

function signedRequest(
  payload: unknown,
  options: { secret?: string; signature?: string } = {},
) {
  const body = JSON.stringify(payload);
  const signature =
    options.signature ??
    stripe.webhooks.generateTestHeaderString({
      payload: body,
      secret: options.secret ?? WEBHOOK_SECRET,
    });

  return new Request("http://localhost/api/stripe/webhook", {
    method: "POST",
    headers: { "stripe-signature": signature, "content-type": "application/json" },
    body,
  });
}

function stripeEvent(type: string, object: Record<string, unknown>) {
  return {
    id: `evt_${type.replace(/\./g, "_")}`,
    object: "event",
    api_version: "2026-02-25.clover",
    created: Math.floor(Date.now() / 1000),
    livemode: false,
    pending_webhooks: 1,
    request: null,
    type,
    data: { object },
  };
}

const checkoutCompleted = stripeEvent("checkout.session.completed", {
  id: "cs_test_1",
  object: "checkout.session",
  mode: "subscription",
  payment_status: "paid",
  subscription: "sub_123",
  customer: "cus_456",
  metadata: { userId: "user_789" },
});

const subscriptionDeleted = stripeEvent("customer.subscription.deleted", {
  id: "sub_123",
  object: "subscription",
  customer: "cus_456",
  status: "canceled",
  metadata: {},
});

const dbError = { message: "permission denied for table subscriptions", code: "42501" };
const rpcResult = (data: unknown) => ({ ...OK_RESPONSE, status: 200, data });

let POST: typeof import("./route").POST;
let consoleError: ReturnType<typeof vi.spyOn>;
let consoleWarn: ReturnType<typeof vi.spyOn>;
let consoleInfo: ReturnType<typeof vi.spyOn>;

function useDb(respond?: FakeQueryResponder) {
  db.current = createFakeSupabase(respond);
  return db.current;
}

beforeAll(async () => {
  vi.stubEnv("STRIPE_SECRET_KEY", "sk_test_dummy");
  vi.stubEnv("STRIPE_WEBHOOK_SECRET", WEBHOOK_SECRET);
  ({ POST } = await import("./route"));
});

afterAll(() => {
  vi.unstubAllEnvs();
});

beforeEach(() => {
  useDb();
  consoleError = vi.spyOn(console, "error").mockImplementation(() => {});
  consoleWarn = vi.spyOn(console, "warn").mockImplementation(() => {});
  consoleInfo = vi.spyOn(console, "info").mockImplementation(() => {});
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe("POST /api/stripe/webhook – signature verification (unchanged behaviour)", () => {
  it("returns 400 when the stripe-signature header is missing", async () => {
    const request = new Request("http://localhost/api/stripe/webhook", {
      method: "POST",
      body: JSON.stringify(checkoutCompleted),
    });

    const response = await POST(request);

    expect(response.status).toBe(400);
    expect(await response.text()).toBe("Missing stripe-signature header");
    expect(db.current.queries).toHaveLength(0);
  });

  it("returns 400 and writes nothing when the signature is invalid", async () => {
    const response = await POST(
      signedRequest(checkoutCompleted, { secret: "whsec_wrong" }),
    );

    expect(response.status).toBe(400);
    expect(await response.text()).toBe("Webhook error");
    expect(db.current.queries).toHaveLength(0);
  });

  it("returns 400 and writes nothing when the body was tampered with", async () => {
    const signature = stripe.webhooks.generateTestHeaderString({
      payload: JSON.stringify(checkoutCompleted),
      secret: WEBHOOK_SECRET,
    });
    const tampered = {
      ...checkoutCompleted,
      data: { object: { ...checkoutCompleted.data.object, subscription: "sub_evil" } },
    };

    const response = await POST(signedRequest(tampered, { signature }));

    expect(response.status).toBe(400);
    expect(db.current.queries).toHaveLength(0);
  });
});

describe("POST /api/stripe/webhook – unknown event types (unchanged behaviour)", () => {
  it("acknowledges with 200 and does not touch the database", async () => {
    const response = await POST(
      signedRequest(stripeEvent("charge.refunded", { id: "ch_1", object: "charge" })),
    );

    expect(response.status).toBe(200);
    expect(await response.text()).toBe("ok");
    expect(db.current.queries).toHaveLength(0);
    expect(consoleWarn).not.toHaveBeenCalled();
    expect(consoleError).not.toHaveBeenCalled();
  });
});

describe("POST /api/stripe/webhook – checkout.session.completed", () => {
  it("returns 200 after a successful insert through the atomic RPC", async () => {
    useDb(() => rpcResult("applied"));

    const response = await POST(signedRequest(checkoutCompleted));

    expect(response.status).toBe(200);
    expect(await response.text()).toBe("ok");

    expect(db.current.queries).toHaveLength(1);
    expect(db.current.argsOf(db.current.queries[0], "rpc")).toEqual([
      "stripe_apply_subscription_event",
      {
        p_event_id: checkoutCompleted.id,
        p_event_type: "checkout.session.completed",
        p_event_created: checkoutCompleted.created,
        p_type_rank: 10,
        p_stripe_subscription_id: "sub_123",
        p_stripe_customer_id: "cus_456",
        p_user_id: "user_789",
        p_status: "active",
      },
    ]);
    expect(consoleError).not.toHaveBeenCalled();
  });

  it("returns 200 (generic ok) when the database reports the event as a duplicate", async () => {
    useDb(() => rpcResult("duplicate"));

    const response = await POST(signedRequest(checkoutCompleted));

    expect(response.status).toBe(200);
    expect(await response.text()).toBe("ok");
    expect(consoleInfo).toHaveBeenCalledTimes(1);
    expect(consoleInfo.mock.calls[0][1]).toMatchObject({ eventId: checkoutCompleted.id });
    expect(consoleError).not.toHaveBeenCalled();
  });

  it("returns 500 (so Stripe retries) when the insert fails, without leaking details", async () => {
    useDb(() => ({ ...OK_RESPONSE, data: null, error: dbError }));

    const response = await POST(signedRequest(checkoutCompleted));

    expect(response.status).toBe(500);
    expect(await response.text()).toBe("Persistence error");

    expect(consoleError).toHaveBeenCalledTimes(1);
    expect(consoleError.mock.calls[0][1]).toMatchObject({
      eventId: checkoutCompleted.id,
      eventType: "checkout.session.completed",
      error: expect.objectContaining(dbError),
    });
  });
});

describe("POST /api/stripe/webhook – customer.subscription.deleted", () => {
  it("returns 200 after a successful update through the atomic RPC", async () => {
    useDb(() => rpcResult("applied"));

    const response = await POST(signedRequest(subscriptionDeleted));

    expect(response.status).toBe(200);
    expect(await response.text()).toBe("ok");

    const [query] = db.current.queries;
    expect(db.current.argsOf(query, "rpc")).toEqual([
      "stripe_apply_subscription_event",
      {
        p_event_id: subscriptionDeleted.id,
        p_event_type: "customer.subscription.deleted",
        p_event_created: subscriptionDeleted.created,
        p_type_rank: 40,
        p_stripe_subscription_id: "sub_123",
        p_stripe_customer_id: "cus_456",
        p_user_id: null,
        p_status: "canceled",
      },
    ]);
    expect(consoleError).not.toHaveBeenCalled();
    expect(consoleWarn).not.toHaveBeenCalled();
  });

  it("returns 200 (generic ok) when the database reports the event as a duplicate", async () => {
    useDb(() => rpcResult("duplicate"));

    const response = await POST(signedRequest(subscriptionDeleted));

    expect(response.status).toBe(200);
    expect(await response.text()).toBe("ok");
    expect(consoleError).not.toHaveBeenCalled();
  });

  it("returns 500 (so Stripe retries) when the update fails, without leaking details", async () => {
    useDb(() => ({ ...OK_RESPONSE, data: null, error: dbError }));

    const response = await POST(signedRequest(subscriptionDeleted));

    expect(response.status).toBe(500);
    expect(await response.text()).toBe("Persistence error");

    expect(consoleError).toHaveBeenCalledTimes(1);
    expect(consoleError.mock.calls[0][1]).toMatchObject({
      eventId: subscriptionDeleted.id,
      eventType: "customer.subscription.deleted",
      error: expect.objectContaining(dbError),
    });
  });

  it("returns 200 (generic ok) when the database reports the event as stale (out of order)", async () => {
    useDb(() => rpcResult("stale"));

    const response = await POST(signedRequest(subscriptionDeleted));

    expect(response.status).toBe(200);
    expect(await response.text()).toBe("ok");
    expect(consoleInfo).toHaveBeenCalledTimes(1);
    expect(consoleInfo.mock.calls[0][1]).toMatchObject({
      eventId: subscriptionDeleted.id,
    });
    expect(consoleWarn).not.toHaveBeenCalled();
    expect(consoleError).not.toHaveBeenCalled();
  });
});

describe("POST /api/stripe/webhook – unexpected failures", () => {
  it("returns 500 when the persistence layer throws instead of returning an error", async () => {
    useDb(() => {
      throw new TypeError("fetch failed");
    });

    const response = await POST(signedRequest(checkoutCompleted));

    expect(response.status).toBe(500);
    expect(await response.text()).toBe("Webhook processing error");
    expect(consoleError).toHaveBeenCalledTimes(1);
    expect(consoleError.mock.calls[0][1]).toMatchObject({
      eventId: checkoutCompleted.id,
      error: expect.any(TypeError),
    });
  });
});

describe("POST /api/stripe/webhook – delivery scenarios against the in-memory ledger MOCK", () => {
  // The mock mirrors the SQL functions' contract; the real database semantics are
  // verified in src/features/billing/services/stripe-webhook-idempotency.integration.test.ts.

  it("duplicate delivery (response lost after commit): both deliveries get 200, one write", async () => {
    const ledgerDb = createFakeIdempotentSupabase();
    db.current = ledgerDb;

    const first = await POST(signedRequest(checkoutCompleted));
    const second = await POST(signedRequest(checkoutCompleted));

    expect(first.status).toBe(200);
    expect(second.status).toBe(200);
    expect(ledgerDb.rows.size).toBe(1);
    expect(ledgerDb.attempts.get(checkoutCompleted.id)).toBe(1); // second never reached the write
  });

  it("parallel delivery: N simultaneous requests for one event → all 200, exactly one write", async () => {
    const ledgerDb = createFakeIdempotentSupabase({ latencyMs: 5 });
    db.current = ledgerDb;

    const responses = await Promise.all(
      Array.from({ length: 8 }, () => POST(signedRequest(checkoutCompleted))),
    );

    expect(responses.map((r) => r.status)).toEqual(Array(8).fill(200));
    expect(ledgerDb.rows.size).toBe(1);
    expect(ledgerDb.attempts.get(checkoutCompleted.id)).toBe(1);
    expect(consoleInfo).toHaveBeenCalledTimes(7); // 7 duplicates acknowledged
  });

  it("failed transaction → 500, then Stripe's retry → 200 and the event is applied once", async () => {
    const ledgerDb = createFakeIdempotentSupabase({
      failOnAttempt: { [checkoutCompleted.id]: [1] },
    });
    db.current = ledgerDb;

    const first = await POST(signedRequest(checkoutCompleted));
    expect(first.status).toBe(500);
    expect(await first.text()).toBe("Persistence error");
    expect(ledgerDb.ledger.has(checkoutCompleted.id)).toBe(false); // not marked processed
    expect(ledgerDb.rows.size).toBe(0);

    const retry = await POST(signedRequest(checkoutCompleted));
    expect(retry.status).toBe(200);
    expect(ledgerDb.ledger.has(checkoutCompleted.id)).toBe(true);
    expect(ledgerDb.rows.size).toBe(1);

    const third = await POST(signedRequest(checkoutCompleted));
    expect(third.status).toBe(200);
    expect(ledgerDb.attempts.get(checkoutCompleted.id)).toBe(2); // duplicate never re-applied
  });
});
