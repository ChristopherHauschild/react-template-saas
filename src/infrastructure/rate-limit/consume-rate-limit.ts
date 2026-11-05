import "server-only";

import type { SupabaseClient } from "@supabase/supabase-js";

import { createAdminClient } from "@/infrastructure/supabase/admin";

/** Database name; must match `supabase/migrations/*_rate_limits.sql`. */
export const CONSUME_RATE_LIMIT_RPC = "consume_rate_limit";

/** Matches the database's `rate_limits_bucket_format` check. */
export const RATE_LIMIT_BUCKET_PATTERN = /^[a-z][a-z0-9_]*(\.[a-z][a-z0-9_]*)*$/;

/**
 * How much of something a user may do: `burst` at once, then one more every
 * `intervalSeconds` (GCRA; see the migration). Both are whole numbers within
 * what the database accepts (burst 1..1000, interval 1..86400 s).
 */
export type RateLimitPolicy = {
  /** What is limited, e.g. `export.invoices`. */
  bucket: string;
  burst: number;
  intervalSeconds: number;
};

export type RateLimitDecision =
  | { outcome: "allowed" }
  /** Over the allowance: nothing was consumed; one request is allowed again after this many seconds (≥ 1). */
  | { outcome: "limited"; retryAfterSeconds: number }
  /** The allowance could not be checked. Already logged. Callers protecting a resource must refuse. */
  | { outcome: "unavailable" };

function isValidPolicy(policy: RateLimitPolicy): boolean {
  return (
    typeof policy.bucket === "string" &&
    policy.bucket.length <= 64 &&
    RATE_LIMIT_BUCKET_PATTERN.test(policy.bucket) &&
    Number.isInteger(policy.burst) &&
    policy.burst >= 1 &&
    policy.burst <= 1000 &&
    Number.isInteger(policy.intervalSeconds) &&
    policy.intervalSeconds >= 1 &&
    policy.intervalSeconds <= 86400
  );
}

/** The function's one row, as PostgREST returns a set-returning function (an array). */
function readDecision(data: unknown): RateLimitDecision | null {
  const row = Array.isArray(data) && data.length === 1 ? data[0] : null;
  if (row === null || typeof row !== "object") return null;

  const { allowed, retry_after_seconds } = row as {
    allowed?: unknown;
    retry_after_seconds?: unknown;
  };

  if (allowed === true) return { outcome: "allowed" };

  if (
    allowed === false &&
    typeof retry_after_seconds === "number" &&
    Number.isSafeInteger(retry_after_seconds) &&
    retry_after_seconds >= 1
  ) {
    return { outcome: "limited", retryAfterSeconds: retry_after_seconds };
  }

  return null;
}

/**
 * Takes one request from `userId`'s allowance for `policy.bucket`, or says
 * how long until one is available.
 *
 * The decision is the database's (`public.consume_rate_limit`): shared by
 * every server instance, atomic under concurrency, and out of the user's
 * reach — the function is executable by the service role alone, so this
 * runs with the service-role client. `userId` must be the id of the user the
 * request was verified for (`requireAuth()`); nothing from the client may
 * choose it.
 *
 * Never throws. Anything that prevents a decision — an invalid policy (a
 * programming error), a failed call, an answer of the wrong shape — is
 * logged and reported as `unavailable`, which callers that protect a costly
 * resource must treat as "no".
 */
export async function consumeRateLimit(
  userId: string,
  policy: RateLimitPolicy,
  supabase?: SupabaseClient,
): Promise<RateLimitDecision> {
  if (!isValidPolicy(policy)) {
    console.error("[rate-limit] invalid policy; request refused", {
      bucket: policy?.bucket,
    });
    return { outcome: "unavailable" };
  }

  try {
    const client = supabase ?? createAdminClient();

    const { data, error } = await client.rpc(CONSUME_RATE_LIMIT_RPC, {
      p_user_id: userId,
      p_bucket: policy.bucket,
      p_interval_seconds: policy.intervalSeconds,
      p_burst: policy.burst,
    });

    if (error) {
      console.error("[rate-limit] could not check the allowance", {
        bucket: policy.bucket,
        userId,
        error: { message: error.message, code: error.code },
      });
      return { outcome: "unavailable" };
    }

    const decision = readDecision(data);

    if (decision === null) {
      console.error("[rate-limit] unexpected response from the rate limit function", {
        bucket: policy.bucket,
        userId,
      });
      return { outcome: "unavailable" };
    }

    return decision;
  } catch (thrown) {
    // Client construction (missing env) or a non-PostgREST failure.
    console.error("[rate-limit] checking the allowance threw unexpectedly", {
      bucket: policy.bucket,
      userId,
      error: { name: thrown instanceof Error ? thrown.name : typeof thrown },
    });
    return { outcome: "unavailable" };
  }
}
