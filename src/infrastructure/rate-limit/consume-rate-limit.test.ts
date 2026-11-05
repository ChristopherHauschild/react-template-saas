// @vitest-environment node
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { createFakeSupabase, OK_RESPONSE } from "@/shared/test/supabase";

const admin = vi.hoisted(() => ({ createAdminClient: vi.fn() }));
vi.mock("@/infrastructure/supabase/admin", () => admin);

import {
  CONSUME_RATE_LIMIT_RPC,
  consumeRateLimit,
  type RateLimitPolicy,
} from "./consume-rate-limit";

const USER = "11111111-1111-4111-8111-111111111111";
const POLICY: RateLimitPolicy = {
  bucket: "export.invoices",
  burst: 5,
  intervalSeconds: 60,
};

const answering = (
  data: unknown,
  error: { message: string; code?: string } | null = null,
) =>
  createFakeSupabase(() => ({ ...OK_RESPONSE, status: error ? 400 : 200, data, error }));

beforeEach(() => {
  vi.clearAllMocks();
  vi.spyOn(console, "error").mockImplementation(() => {});
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe("consumeRateLimit – the call", () => {
  it("calls the database function with the user, bucket and policy", async () => {
    const fake = answering([{ allowed: true, retry_after_seconds: 0 }]);

    await consumeRateLimit(USER, POLICY, fake.client);

    expect(CONSUME_RATE_LIMIT_RPC).toBe("consume_rate_limit");
    expect(fake.queries).toHaveLength(1);
    expect(fake.queries[0].calls[0]).toEqual({
      method: "rpc",
      args: [
        "consume_rate_limit",
        {
          p_user_id: USER,
          p_bucket: "export.invoices",
          p_interval_seconds: 60,
          p_burst: 5,
        },
      ],
    });
  });

  it("uses the service-role client by default (the function is service_role only)", async () => {
    const fake = answering([{ allowed: true, retry_after_seconds: 0 }]);
    admin.createAdminClient.mockReturnValue(fake.client);

    await consumeRateLimit(USER, POLICY);

    expect(admin.createAdminClient).toHaveBeenCalledTimes(1);
    expect(fake.queries).toHaveLength(1);
  });
});

describe("consumeRateLimit – decisions", () => {
  it("allowed", async () => {
    await expect(
      consumeRateLimit(
        USER,
        POLICY,
        answering([{ allowed: true, retry_after_seconds: 0 }]).client,
      ),
    ).resolves.toEqual({ outcome: "allowed" });
  });

  it("limited, with the wait", async () => {
    await expect(
      consumeRateLimit(
        USER,
        POLICY,
        answering([{ allowed: false, retry_after_seconds: 42 }]).client,
      ),
    ).resolves.toEqual({ outcome: "limited", retryAfterSeconds: 42 });
  });

  it.each([
    ["no rows", []],
    ["two rows", [{ allowed: true }, { allowed: true }]],
    ["a bare object", { allowed: true, retry_after_seconds: 0 }],
    ["null", null],
    ["allowed as a string", [{ allowed: "true" }]],
    ["limited without a wait", [{ allowed: false }]],
    ["limited with a zero wait", [{ allowed: false, retry_after_seconds: 0 }]],
    ["limited with a fractional wait", [{ allowed: false, retry_after_seconds: 1.5 }]],
  ])(
    "treats an answer with %s as unavailable (never as allowed)",
    async (_label, data) => {
      await expect(
        consumeRateLimit(USER, POLICY, answering(data).client),
      ).resolves.toEqual({
        outcome: "unavailable",
      });
      expect(console.error).toHaveBeenCalledWith(
        "[rate-limit] unexpected response from the rate limit function",
        { bucket: "export.invoices", userId: USER },
      );
    },
  );
});

describe("consumeRateLimit – failures are reported, never thrown", () => {
  it("a database error (message and code only in the log)", async () => {
    const fake = createFakeSupabase(() => ({
      ...OK_RESPONSE,
      status: 404,
      data: null,
      error: {
        message: "Could not find the function public.consume_rate_limit",
        code: "PGRST202",
        details: "SECRET",
        hint: "SECRET",
      },
    }));

    await expect(consumeRateLimit(USER, POLICY, fake.client)).resolves.toEqual({
      outcome: "unavailable",
    });
    expect(console.error).toHaveBeenCalledWith(
      "[rate-limit] could not check the allowance",
      {
        bucket: "export.invoices",
        userId: USER,
        error: {
          message: "Could not find the function public.consume_rate_limit",
          code: "PGRST202",
        },
      },
    );
    expect(JSON.stringify(vi.mocked(console.error).mock.calls)).not.toContain("SECRET");
  });

  it("a client that cannot be built (missing service-role key)", async () => {
    admin.createAdminClient.mockImplementation(() => {
      throw new TypeError("SUPABASE_SERVICE_ROLE_KEY: SECRET");
    });

    await expect(consumeRateLimit(USER, POLICY)).resolves.toEqual({
      outcome: "unavailable",
    });
    expect(JSON.stringify(vi.mocked(console.error).mock.calls)).not.toContain("SECRET");
  });

  it("a call that throws", async () => {
    const fake = createFakeSupabase(() => {
      throw new Error("socket hang up");
    });

    await expect(consumeRateLimit(USER, POLICY, fake.client)).resolves.toEqual({
      outcome: "unavailable",
    });
  });

  it.each<[string, RateLimitPolicy]>([
    ["an empty bucket", { ...POLICY, bucket: "" }],
    ["an upper-case bucket", { ...POLICY, bucket: "Export.Invoices" }],
    ["a bucket with spaces", { ...POLICY, bucket: "export invoices" }],
    ["a 65-character bucket", { ...POLICY, bucket: "a".repeat(65) }],
    ["a zero burst", { ...POLICY, burst: 0 }],
    ["a fractional burst", { ...POLICY, burst: 1.5 }],
    ["a burst over 1000", { ...POLICY, burst: 1001 }],
    ["a zero interval", { ...POLICY, intervalSeconds: 0 }],
    ["an interval over a day", { ...POLICY, intervalSeconds: 86401 }],
  ])("refuses %s without calling the database", async (_label, policy) => {
    const fake = answering([{ allowed: true, retry_after_seconds: 0 }]);

    await expect(consumeRateLimit(USER, policy, fake.client)).resolves.toEqual({
      outcome: "unavailable",
    });
    expect(fake.queries).toHaveLength(0);
  });
});
