/**
 * In-memory stand-in for `public.consume_rate_limit` (see
 * `supabase/migrations/*_rate_limits.sql`), for unit tests of code that runs
 * the real limiter through a service-role client. Same arithmetic (GCRA: a
 * burst, then one per interval), same validation, same answer shape — a
 * one-row array `{ allowed, retry_after_seconds }` — on the test's clock
 * (`Date.now`, so fake timers move it). It does NOT prove the database's
 * atomicity or privileges; the integration tests do.
 */
import { createFakeSupabase, OK_RESPONSE } from "./supabase";

type Params = {
  p_user_id: string;
  p_bucket: string;
  p_interval_seconds: number;
  p_burst: number;
};

export function createFakeRateLimitDatabase() {
  /** `${user}|${bucket}` → theoretical arrival time, epoch ms. */
  const tat = new Map<string, number>();

  const fake = createFakeSupabase((query) => {
    const [fn, params] = (query.calls[0]?.args ?? []) as [string, Params];

    if (fn !== "consume_rate_limit") {
      return {
        ...OK_RESPONSE,
        status: 404,
        data: null,
        error: { message: `function ${fn} does not exist`, code: "PGRST202" },
      };
    }

    const { p_user_id, p_bucket, p_interval_seconds: interval, p_burst: burst } = params;

    if (
      !p_user_id ||
      !/^[a-z][a-z0-9_]*(\.[a-z][a-z0-9_]*)*$/.test(p_bucket) ||
      !Number.isInteger(interval) ||
      interval < 1 ||
      interval > 86400 ||
      !Number.isInteger(burst) ||
      burst < 1 ||
      burst > 1000
    ) {
      return {
        ...OK_RESPONSE,
        status: 400,
        data: null,
        error: { message: "consume_rate_limit: invalid arguments", code: "22023" },
      };
    }

    const key = `${p_user_id}|${p_bucket}`;
    const now = Date.now();
    const intervalMs = interval * 1000;
    const tolerance = intervalMs * (burst - 1);
    const current = Math.max(tat.get(key) ?? -Infinity, now);

    if (current - now > tolerance) {
      const retry = Math.max(1, Math.ceil((current - tolerance - now) / 1000));
      return {
        ...OK_RESPONSE,
        status: 200,
        data: [{ allowed: false, retry_after_seconds: retry }],
      };
    }

    tat.set(key, current + intervalMs);
    return {
      ...OK_RESPONSE,
      status: 200,
      data: [{ allowed: true, retry_after_seconds: 0 }],
    };
  });

  return {
    ...fake,
    /** How many times the function was called. */
    calls: () => fake.queries.length,
    reset: () => tat.clear(),
  };
}
