// @vitest-environment node
import { AuthApiError, AuthRetryableFetchError } from "@supabase/supabase-js";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// --- boundaries ---------------------------------------------------------------

/** Next's redirect() throws; model that so tests can assert the destination. */
class RedirectSignal extends Error {
  constructor(public readonly url: string) {
    super(`NEXT_REDIRECT ${url}`);
  }
}

vi.mock("next/navigation", () => ({
  redirect: vi.fn((url: string) => {
    throw new RedirectSignal(url);
  }),
}));

/** Minimal stand-in for Next's request cookie store (a Server Action may mutate it). */
const jar = vi.hoisted(() => {
  const store = new Map<string, string>();
  return {
    store,
    getAll: vi.fn(() => [...store].map(([name, value]) => ({ name, value }))),
    delete: vi.fn((name: string) => {
      store.delete(name);
    }),
    set: vi.fn((name: string, value: string) => {
      store.set(name, value);
    }),
  };
});
vi.mock("next/headers", () => ({ cookies: vi.fn(async () => jar) }));

const supabase = vi.hoisted(() => ({
  signOut:
    vi.fn<
      (options: {
        scope: string;
      }) => Promise<{ error: { name: string; code?: string } | null }>
    >(),
}));
const infra = vi.hoisted(() => ({ createClient: vi.fn<() => Promise<unknown>>() }));
vi.mock("@/infrastructure/auth/supabase/server", () => infra);

import { signOut } from "./sign-out";

// ------------------------------------------------------------------------------

const SESSION_COOKIES = {
  "sb-abcdefghijklmnop-auth-token.0": "base64-eyJhY2Nlc3NfdG9rZW4iOiJzZWNyZXQt",
  "sb-abcdefghijklmnop-auth-token.1": "dG9rZW4ifQ",
  "sb-abcdefghijklmnop-auth-token-code-verifier": "verifier",
};
const OTHER_COOKIES = { theme: "dark", "sidebar:collapsed": "1" };

const expectRedirect = async (promise: Promise<unknown>) => {
  await expect(promise).rejects.toBeInstanceOf(RedirectSignal);
  return promise.catch((e: RedirectSignal) => e.url);
};

const remainingCookies = () => [...jar.store.keys()].sort();

beforeEach(() => {
  vi.clearAllMocks();
  jar.store.clear();
  for (const [name, value] of Object.entries({ ...SESSION_COOKIES, ...OTHER_COOKIES })) {
    jar.store.set(name, value);
  }
  infra.createClient.mockResolvedValue({ auth: { signOut: supabase.signOut } });
  // Like the real client: a successful sign-out expires the session cookies itself.
  supabase.signOut.mockImplementation(async () => {
    for (const name of Object.keys(SESSION_COOKIES)) jar.store.delete(name);
    return { error: null };
  });
  vi.spyOn(console, "warn").mockImplementation(() => {});
  vi.spyOn(console, "error").mockImplementation(() => {});
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe("signOut – success", () => {
  it("signs out this device only and redirects to /login", async () => {
    expect(await expectRedirect(signOut())).toBe("/login");

    expect(supabase.signOut).toHaveBeenCalledTimes(1);
    expect(supabase.signOut).toHaveBeenCalledWith({ scope: "local" });
    expect(console.warn).not.toHaveBeenCalled();
    expect(console.error).not.toHaveBeenCalled();
  });

  it("leaves unrelated cookies untouched", async () => {
    await expectRedirect(signOut());

    expect(remainingCookies()).toEqual(Object.keys(OTHER_COOKIES).sort());
    expect(jar.delete).not.toHaveBeenCalledWith("theme");
    expect(jar.delete).not.toHaveBeenCalledWith("sidebar:collapsed");
  });
});

describe("signOut – Supabase reports an error (regression: stale session)", () => {
  // supabase-js returns the error and KEEPS the session when the server cannot be
  // reached. Without the local clean-up the cookies would survive, and the login
  // page's guest guard would send the user straight back to the dashboard.
  it("clears every session cookie when Supabase is unreachable, then redirects to /login", async () => {
    supabase.signOut.mockResolvedValue({
      error: new AuthRetryableFetchError("fetch failed", 0),
    });

    expect(await expectRedirect(signOut())).toBe("/login");

    expect(remainingCookies()).toEqual(Object.keys(OTHER_COOKIES).sort());
    for (const name of Object.keys(SESSION_COOKIES)) {
      expect(jar.delete).toHaveBeenCalledWith(name);
    }
  });

  it("clears the cookies on a server-side error too", async () => {
    supabase.signOut.mockResolvedValue({
      error: new AuthApiError("Internal server error", 500, "unexpected_failure"),
    });

    expect(await expectRedirect(signOut())).toBe("/login");
    expect(remainingCookies()).toEqual(Object.keys(OTHER_COOKIES).sort());
  });

  it("logs a warning with the error's name/code/status only — no cookie or token values", async () => {
    supabase.signOut.mockResolvedValue({
      error: new AuthApiError(
        "session_id claim in JWT does not exist",
        403,
        "session_not_found",
      ),
    });

    await expectRedirect(signOut());

    expect(console.warn).toHaveBeenCalledTimes(1);
    const logged = JSON.stringify(vi.mocked(console.warn).mock.calls[0]);
    expect(logged).toContain("session_not_found");
    for (const value of Object.values(SESSION_COOKIES))
      expect(logged).not.toContain(value);
    expect(logged).not.toContain("JWT does not exist");
  });
});

describe("signOut – unexpected exceptions are contained", () => {
  it("still clears the cookies and redirects when signOut() rejects", async () => {
    supabase.signOut.mockRejectedValue(
      new TypeError("Cannot read properties of undefined"),
    );

    expect(await expectRedirect(signOut())).toBe("/login");
    expect(remainingCookies()).toEqual(Object.keys(OTHER_COOKIES).sort());
    expect(console.error).toHaveBeenCalledWith(
      expect.stringContaining("threw unexpectedly"),
      {
        error: { name: "TypeError" },
      },
    );
  });

  it("still clears the cookies and redirects when the Supabase client cannot be created", async () => {
    infra.createClient.mockRejectedValue(
      new Error("NEXT_PUBLIC_SUPABASE_URL is not set"),
    );

    expect(await expectRedirect(signOut())).toBe("/login");
    expect(supabase.signOut).not.toHaveBeenCalled();
    expect(remainingCookies()).toEqual(Object.keys(OTHER_COOKIES).sort());
  });

  it("never logs the message of a thrown error", async () => {
    supabase.signOut.mockRejectedValue(
      new Error(`leak ${SESSION_COOKIES["sb-abcdefghijklmnop-auth-token.1"]}`),
    );

    await expectRedirect(signOut());

    const logged = JSON.stringify(vi.mocked(console.error).mock.calls);
    expect(logged).not.toContain("leak");
    expect(logged).not.toContain(SESSION_COOKIES["sb-abcdefghijklmnop-auth-token.1"]);
  });
});

describe("signOut – edge cases", () => {
  it("works when there is no session at all (idempotent)", async () => {
    jar.store.clear();
    supabase.signOut.mockResolvedValue({ error: null });

    expect(await expectRedirect(signOut())).toBe("/login");
    expect(jar.delete).not.toHaveBeenCalled();
  });

  it("does not swallow the redirect, which Next implements by throwing", async () => {
    await expect(signOut()).rejects.toBeInstanceOf(RedirectSignal);
  });
});
