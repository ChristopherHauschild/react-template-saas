import type { SupabaseClient } from "@supabase/supabase-js";

/** One chained call on a query builder, e.g. `{ method: "eq", args: ["id", 1] }`. */
export type FakeQueryCall = { method: string; args: unknown[] };

/**
 * Everything that was chained onto a single `supabase.from(table)` call, or a
 * single `supabase.rpc(fn, params)` call (recorded as `table = fn`, one `rpc` call).
 */
export type FakeQuery = { table: string; calls: FakeQueryCall[] };

/** Shape of what awaiting a supabase-js query resolves to (never rejects). */
export type FakeQueryResponse = {
  data: unknown;
  error: { message: string; code?: string; details?: string; hint?: string } | null;
  count?: number | null;
  status?: number;
  statusText?: string;
};

export type FakeQueryResponder = (
  query: FakeQuery,
) => FakeQueryResponse | Promise<FakeQueryResponse>;

export const OK_RESPONSE: FakeQueryResponse = {
  data: null,
  error: null,
  count: null,
  status: 201,
  statusText: "Created",
};

/**
 * Minimal fake for the PostgREST query builder used by supabase-js.
 *
 * Every method chained onto `from(table)` is recorded and returns the same builder;
 * awaiting the builder resolves with whatever `respond` returns for that query.
 * Like the real client it resolves with `{ data, error }` and never rejects, unless
 * the responder itself throws, which is useful to simulate unexpected failures.
 */
export function createFakeSupabase(respond: FakeQueryResponder = () => OK_RESPONSE) {
  const queries: FakeQuery[] = [];

  const start = (table: string, initialCalls: FakeQueryCall[] = []) => {
    const query: FakeQuery = { table, calls: [...initialCalls] };
    queries.push(query);

    const target: Record<string | symbol, unknown> = {
      then(
        onFulfilled?: (value: FakeQueryResponse) => unknown,
        onRejected?: (reason: unknown) => unknown,
      ) {
        return Promise.resolve()
          .then(() => respond(query))
          .then(onFulfilled, onRejected);
      },
    };

    const builder: unknown = new Proxy(target, {
      get(obj, prop) {
        if (prop in obj) return obj[prop];
        if (typeof prop !== "string") return undefined;

        return (...args: unknown[]) => {
          query.calls.push({ method: prop, args });
          return builder;
        };
      },
    });

    return builder;
  };

  const client = {
    from: (table: string) => start(table),
    rpc: (fn: string, params?: Record<string, unknown>) =>
      start(fn, [{ method: "rpc", args: [fn, params] }]),
  };

  return {
    client: client as unknown as SupabaseClient,
    /** Queries in the order they were started. */
    queries,
    /** Convenience: the chained method names of a query, e.g. `["update", "eq", "select"]`. */
    methodsOf: (query: FakeQuery) => query.calls.map((call) => call.method),
    /** Convenience: arguments of the first call with the given method name. */
    argsOf: (query: FakeQuery, method: string) =>
      query.calls.find((call) => call.method === method)?.args,
  };
}

/** Projection row kept by the mock (mirrors the four `subscriptions` columns). */
export type FakeSubscriptionRow = {
  stripe_subscription_id: string;
  stripe_customer_id: string | null;
  userId: string | null;
  status: string;
};

type RpcParams = {
  p_event_id: string;
  p_event_type: string;
  p_event_created: number;
  p_type_rank: number;
  p_stripe_subscription_id: string;
  p_stripe_customer_id: string | null;
  p_user_id: string | null;
  p_status: string;
};

const TERMINAL_STATUSES = new Set(["canceled", "incomplete_expired"]);

/**
 * In-memory MOCK of `public.stripe_apply_subscription_event` from
 * `supabase/migrations/*_stripe_subscription_lifecycle.sql`, for unit tests only.
 *
 * It mirrors the function's observable contract — claim by event id, one event
 * at a time per subscription, (created, rank) ordering for `status`, terminal
 * statuses never left, user association kept/filled/borrowed from the same
 * customer, and "a failed call leaves nothing behind" — so route/handler tests can
 * exercise duplicate, out-of-order and parallel deliveries without a database.
 * It does NOT prove the database semantics; `*.integration.test.ts` does that.
 */
export function createFakeIdempotentSupabase(
  options: {
    /** Pre-existing projection rows (e.g. legacy rows without ledger history). */
    existingRows?: FakeSubscriptionRow[];
    /** Make the Nth call (1-based) for an event fail, e.g. `{ evt_1: [1] }`. */
    failOnAttempt?: Record<string, number[]>;
    /** Artificial latency per call, to make interleavings visible. */
    latencyMs?: number;
  } = {},
) {
  /** event id → outcome recorded ("applied" | "stale"). */
  const ledger = new Map<
    string,
    { outcome: "applied" | "stale"; created: number; rank: number; sub: string }
  >();
  const rows = new Map<string, FakeSubscriptionRow>(
    (options.existingRows ?? []).map((r) => [r.stripe_subscription_id, { ...r }]),
  );
  const attempts = new Map<string, number>();
  /** Open "transactions" by event id (primary-key wait) and by subscription (advisory lock). */
  const eventInFlight = new Map<string, Promise<void>>();
  const subscriptionInFlight = new Map<string, Promise<void>>();

  const newestApplied = (sub: string) => {
    let best: { created: number; rank: number } | null = null;
    for (const entry of ledger.values()) {
      if (entry.sub !== sub || entry.outcome !== "applied") continue;
      if (
        !best ||
        entry.created > best.created ||
        (entry.created === best.created && entry.rank > best.rank)
      ) {
        best = entry;
      }
    }
    return best;
  };

  const acquire = async (map: Map<string, Promise<void>>, key: string) => {
    while (map.has(key)) await map.get(key);
    let release!: () => void;
    map.set(key, new Promise<void>((resolve) => (release = resolve)));
    return () => {
      map.delete(key);
      release();
    };
  };

  const fake = createFakeSupabase(async (query) => {
    const [fn, params] = query.calls[0]?.args as [string, RpcParams];

    if (fn !== "stripe_apply_subscription_event") {
      return {
        ...OK_RESPONSE,
        status: 404,
        data: null,
        error: { message: `function ${fn} does not exist`, code: "PGRST202" },
      };
    }

    const eventId = params.p_event_id;
    const sub = params.p_stripe_subscription_id;

    // 1. Claim (primary key on event_id): wait for an open transaction on this event.
    const releaseEvent = await acquire(eventInFlight, eventId);

    try {
      if (ledger.has(eventId)) {
        return { ...OK_RESPONSE, status: 200, data: "duplicate" };
      }

      // 2. Advisory lock: one event at a time per subscription.
      const releaseSubscription = await acquire(subscriptionInFlight, sub);

      try {
        if (options.latencyMs) {
          await new Promise((resolve) => setTimeout(resolve, options.latencyMs));
        }

        const attempt = (attempts.get(eventId) ?? 0) + 1;
        attempts.set(eventId, attempt);

        // Failure inside the transaction: rolled back, nothing is recorded.
        if (options.failOnAttempt?.[eventId]?.includes(attempt)) {
          return {
            ...OK_RESPONSE,
            status: 500,
            data: null,
            error: { message: "simulated persistence failure", code: "XX000" },
          };
        }

        const current = rows.get(sub);
        let applyStatus = true;

        if (current) {
          const last = newestApplied(sub);
          if (
            last &&
            (params.p_event_created < last.created ||
              (params.p_event_created === last.created && params.p_type_rank < last.rank))
          ) {
            applyStatus = false;
          }
          if (
            TERMINAL_STATUSES.has(current.status) &&
            params.p_status !== current.status
          ) {
            applyStatus = false;
          }
        }

        let userId = current?.userId ?? params.p_user_id ?? null;
        const customer =
          current?.stripe_customer_id ?? params.p_stripe_customer_id ?? null;
        if (userId === null && customer !== null) {
          for (const row of rows.values()) {
            if (row.stripe_customer_id === customer && row.userId !== null) {
              userId = row.userId;
              break;
            }
          }
        }

        rows.set(sub, {
          stripe_subscription_id: sub,
          stripe_customer_id: customer,
          userId,
          status: applyStatus || !current ? params.p_status : current.status,
        });

        const outcome = applyStatus ? "applied" : "stale";
        ledger.set(eventId, {
          outcome,
          created: params.p_event_created,
          rank: params.p_type_rank,
          sub,
        });

        return { ...OK_RESPONSE, status: 200, data: outcome };
      } finally {
        releaseSubscription();
      }
    } finally {
      releaseEvent();
    }
  });

  return {
    ...fake,
    ledger,
    rows,
    attempts,
    /** Convenience accessor for a subscription's projected row. */
    row: (sub: string) => rows.get(sub),
  };
}
