// @vitest-environment node
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const ANON_KEY = "anon-public-key";
const SUPABASE_URL = "https://example.supabase.co";

// A Stripe webhook request carries no browser cookies, so the cookie store is empty.
const cookieStore = vi.hoisted(() => ({
  getAll: vi.fn(() => [] as { name: string; value: string }[]),
  set: vi.fn(),
}));

vi.mock("next/headers", () => ({
  cookies: vi.fn(async () => cookieStore),
}));

vi.mock("@/config/env.client", () => ({
  clientEnv: {
    NEXT_PUBLIC_APP_URL: "http://localhost:3000",
    NEXT_PUBLIC_SUPABASE_URL: SUPABASE_URL,
    NEXT_PUBLIC_SUPABASE_ANON_KEY: ANON_KEY,
  },
}));

vi.mock("@supabase/ssr", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@supabase/ssr")>();
  return { ...actual, createServerClient: vi.fn(actual.createServerClient) };
});

const spyOnFetch = () => vi.spyOn(globalThis, "fetch");

describe("cookie-based Supabase client in a Stripe webhook request (no user session)", () => {
  let fetchSpy: ReturnType<typeof spyOnFetch>;

  beforeEach(() => {
    fetchSpy = spyOnFetch().mockRejectedValue(new Error("network must not be used"));
  });

  afterEach(() => {
    vi.restoreAllMocks();
    cookieStore.getAll.mockClear();
    cookieStore.set.mockClear();
  });

  it("is built with the public anon key, not a privileged one", async () => {
    const { createServerClient } = await import("@supabase/ssr");
    const { createClient } = await import("./server");

    await createClient();

    expect(createServerClient).toHaveBeenCalledWith(
      SUPABASE_URL,
      ANON_KEY,
      expect.objectContaining({ cookies: expect.any(Object) }),
    );
  });

  it("has no authenticated user when the request has no cookies", async () => {
    const { createClient } = await import("./server");
    const supabase = await createClient();

    const { data, error } = await supabase.auth.getUser();

    expect(cookieStore.getAll).toHaveBeenCalled();
    expect(data.user).toBeNull();
    expect(error?.name).toBe("AuthSessionMissingError");
    // Decided locally from the (empty) cookie jar; nothing was sent to Supabase.
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("therefore would issue database requests with the anon key only (subject to RLS)", async () => {
    const { createClient } = await import("./server");
    const supabase = await createClient();

    // Capture the outgoing PostgREST request instead of performing it.
    fetchSpy.mockImplementation(async (input: RequestInfo | URL, init?: RequestInit) => {
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

    const { data } = await supabase
      .from("subscriptions")
      .select("stripe_subscription_id");

    expect(data).toMatchObject({
      url: expect.stringContaining(`${SUPABASE_URL}/rest/v1/subscriptions`),
      apikey: ANON_KEY,
      authorization: `Bearer ${ANON_KEY}`,
    });
  });
});
