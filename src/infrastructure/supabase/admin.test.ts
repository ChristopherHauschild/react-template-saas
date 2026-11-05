// @vitest-environment node
import { readdir, readFile } from "node:fs/promises";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";

const SERVICE_ROLE_KEY = "service-role-secret";
const ANON_KEY = "anon-public-key";
const SUPABASE_URL = "https://example.supabase.co";

vi.mock("@/config/env.client", () => ({
  clientEnv: {
    NEXT_PUBLIC_APP_URL: "http://localhost:3000",
    NEXT_PUBLIC_SUPABASE_URL: SUPABASE_URL,
    NEXT_PUBLIC_SUPABASE_ANON_KEY: ANON_KEY,
  },
}));

vi.mock("@/config/env.server", () => ({
  serverEnv: { NODE_ENV: "test", SUPABASE_SERVICE_ROLE_KEY: SERVICE_ROLE_KEY },
}));

vi.mock("@supabase/supabase-js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@supabase/supabase-js")>();
  return { ...actual, createClient: vi.fn(actual.createClient) };
});

// Must never be touched: the admin client has no user session to read or write.
vi.mock("next/headers", () => ({
  cookies: vi.fn(() => {
    throw new Error("admin client must not read request cookies");
  }),
}));

async function* walk(dir: string): AsyncGenerator<string> {
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) yield* walk(full);
    else yield full;
  }
}

describe("createAdminClient", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("authenticates with the service-role key and disables session handling", async () => {
    const { createClient } = await import("@supabase/supabase-js");
    const { createAdminClient } = await import("./admin");

    createAdminClient();

    expect(createClient).toHaveBeenCalledWith(
      SUPABASE_URL,
      SERVICE_ROLE_KEY,
      expect.objectContaining({
        auth: expect.objectContaining({
          persistSession: false,
          autoRefreshToken: false,
          detectSessionInUrl: false,
        }),
      }),
    );
  });

  it("sends database requests with the service-role key (bypassing RLS), independent of cookies", async () => {
    const { createAdminClient } = await import("./admin");

    const fetchSpy = vi
      .spyOn(globalThis, "fetch")
      .mockImplementation(async (input: RequestInfo | URL, init?: RequestInit) => {
        const headers = new Headers(init?.headers);
        return new Response(
          JSON.stringify({
            url: String(input),
            apikey: headers.get("apikey"),
            authorization: headers.get("authorization"),
          }),
          { status: 200, headers: { "content-type": "application/json" } },
        );
      });

    const { data } = await createAdminClient()
      .from("subscriptions")
      .select("stripe_subscription_id");

    expect(fetchSpy).toHaveBeenCalledTimes(1);
    expect(data).toMatchObject({
      url: expect.stringContaining(`${SUPABASE_URL}/rest/v1/subscriptions`),
      apikey: SERVICE_ROLE_KEY,
      authorization: `Bearer ${SERVICE_ROLE_KEY}`,
    });
  });

  it("is marked server-only so the Next.js build rejects it in client bundles", async () => {
    const source = await readFile(path.join(__dirname, "admin.ts"), "utf8");

    expect(source).toMatch(/^import "server-only";/m);
  });

  it("is only imported by the Stripe webhook route, the account activity writer and the rate limiter (not by anything user-facing)", async () => {
    const root = path.resolve(__dirname, "../../..");
    const importers: string[] = [];

    for await (const file of walk(path.join(root, "src"))) {
      if (!/\.(ts|tsx)$/.test(file) || /\.test\.tsx?$/.test(file)) continue;
      const source = await readFile(file, "utf8");
      if (source.includes("infrastructure/supabase/admin")) {
        importers.push(path.relative(root, file).split(path.sep).join("/"));
      }
    }

    expect(importers.sort()).toEqual([
      "src/app/api/stripe/webhook/route.ts",
      "src/infrastructure/account-activity/record-account-activity.ts",
      "src/infrastructure/rate-limit/consume-rate-limit.ts",
    ]);
  });
});
