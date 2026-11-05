// @vitest-environment node
import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@/config/env.client", () => ({
  clientEnv: {
    NEXT_PUBLIC_APP_URL: "https://app.example.com",
    NEXT_PUBLIC_SUPABASE_URL: "https://project.supabase.co",
    NEXT_PUBLIC_SUPABASE_ANON_KEY: "anon-key",
  },
}));

const supabase = vi.hoisted(() => ({ createClient: vi.fn() }));
vi.mock("@supabase/supabase-js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@supabase/supabase-js")>()),
  createClient: supabase.createClient,
}));

import { createStatelessClient } from "./stateless";

describe("createStatelessClient", () => {
  beforeEach(() => {
    supabase.createClient.mockReset();
    supabase.createClient.mockImplementation(() => ({ auth: {} }));
  });

  it("uses the public project URL and anon key", () => {
    createStatelessClient();

    const [url, key] = supabase.createClient.mock.calls[0];
    expect(url).toBe("https://project.supabase.co");
    expect(key).toBe("anon-key");
  });

  it("keeps its session in memory only and never refreshes it", () => {
    createStatelessClient();

    const [, , options] = supabase.createClient.mock.calls[0];
    expect(options).toEqual({
      auth: { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false },
    });
  });

  it("returns a fresh instance per call (no shared state between requests)", () => {
    const first = createStatelessClient();
    const second = createStatelessClient();

    expect(supabase.createClient).toHaveBeenCalledTimes(2);
    expect(first).not.toBe(second);
  });
});
