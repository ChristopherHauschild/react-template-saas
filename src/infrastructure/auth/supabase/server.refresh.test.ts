// @vitest-environment node
/**
 * Regression coverage for session refresh through the cookie-based server client.
 *
 * Scenario: the access token in the cookie has expired and `getUser()` has to
 * refresh it. supabase-js then asks our `setAll` to persist the new tokens.
 *   - In a Server Action / Route Handler the cookie store is writable: persist.
 *   - In a Server Component render Next forbids writes and throws. Before the fix
 *     supabase-js rethrew that and the page crashed; now the write is skipped and
 *     rendering continues with the refreshed in-memory session.
 *   - Any other failure of the cookie store is reported (console.error) and the
 *     request continues with the in-memory session: throwing from the adapter
 *     would leave supabase-js's internal promises rejected with nobody awaiting
 *     them (unhandled rejections in the server process).
 *
 * Real `@supabase/ssr` + supabase-js; only `fetch` and Next's cookie store are faked.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const { SUPABASE_URL, ANON_KEY, READONLY_MESSAGE } = vi.hoisted(() => ({
  SUPABASE_URL: "https://example.supabase.co",
  ANON_KEY: "anon-public-key",
  /** Next's `ReadonlyRequestCookiesError` (not exported publicly; message is the contract). */
  READONLY_MESSAGE:
    "Cookies can only be modified in a Server Action or Route Handler. Read more: https://nextjs.org/docs/app/api-reference/functions/cookies#options",
}));
/** `@supabase/ssr` derives the cookie name from the project host. */
const COOKIE = "sb-example-auth-token";

type Mode = "action" | "render" | "broken";

const cookieStore = vi.hoisted(() => {
  const jar = new Map<string, string>();
  const state = { mode: "action" as "action" | "render" | "broken" };
  return {
    jar,
    state,
    getAll: vi.fn(() => [...jar].map(([name, value]) => ({ name, value }))),
    set: vi.fn((name: string, value: string) => {
      if (state.mode === "render") throw new Error(READONLY_MESSAGE);
      if (state.mode === "broken") throw new TypeError("cookie store is broken");
      jar.set(name, value);
    }),
  };
});
vi.mock("next/headers", () => ({ cookies: vi.fn(async () => cookieStore) }));

vi.mock("@/config/env.client", () => ({
  clientEnv: {
    NEXT_PUBLIC_APP_URL: "http://localhost:3000",
    NEXT_PUBLIC_SUPABASE_URL: SUPABASE_URL,
    NEXT_PUBLIC_SUPABASE_ANON_KEY: ANON_KEY,
  },
}));

import { createClient } from "./server";

// --- fixtures -------------------------------------------------------------------

const b64url = (value: object) =>
  Buffer.from(JSON.stringify(value)).toString("base64url");
const jwt = (exp: number, sessionId: string) =>
  `${b64url({ alg: "HS256", typ: "JWT" })}.${b64url({ sub: USER.id, exp, session_id: sessionId, role: "authenticated" })}.sig`;

const USER = {
  id: "11111111-1111-4111-8111-111111111111",
  aud: "authenticated",
  role: "authenticated",
  email: "jane@example.com",
  app_metadata: {},
  user_metadata: {},
  created_at: "2026-01-01T00:00:00Z",
};

const now = () => Math.floor(Date.now() / 1000);

const session = (exp: number, refreshToken: string, sessionId: string) => ({
  access_token: jwt(exp, sessionId),
  refresh_token: refreshToken,
  token_type: "bearer",
  expires_in: exp - now(),
  expires_at: exp,
  user: USER,
});

const OLD_REFRESH_TOKEN = "rt-old";
const NEW_REFRESH_TOKEN = "rt-new";

/** Stores a session in the cookie jar the way `@supabase/ssr` encodes it. */
const storeSession = (value: object) =>
  cookieStore.jar.set(
    COOKIE,
    "base64-" + Buffer.from(JSON.stringify(value)).toString("base64url"),
  );

const storedSession = () => {
  const raw = cookieStore.jar.get(COOKIE);
  if (!raw) return null;
  return JSON.parse(
    Buffer.from(raw.replace(/^base64-/, ""), "base64url").toString("utf8"),
  ) as { refresh_token: string };
};

/** Fake GoTrue: refresh succeeds (once) and /user validates the fresh token. */
const fetchCalls: string[] = [];
let freshAccessToken = "";
const fakeSupabaseFetch = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
  const url = String(input);
  fetchCalls.push(`${init?.method ?? "GET"} ${url.replace(SUPABASE_URL, "")}`);
  const json = (status: number, body: unknown) =>
    new Response(JSON.stringify(body), {
      status,
      headers: { "content-type": "application/json" },
    });

  if (url.includes("grant_type=refresh_token")) {
    const { refresh_token } = JSON.parse(String(init?.body)) as { refresh_token: string };
    if (refresh_token !== OLD_REFRESH_TOKEN) {
      return json(400, {
        error_code: "refresh_token_not_found",
        msg: "Invalid Refresh Token",
      });
    }
    const fresh = session(now() + 3600, NEW_REFRESH_TOKEN, "s2");
    freshAccessToken = fresh.access_token;
    return json(200, fresh);
  }
  if (url.endsWith("/auth/v1/user")) {
    const token = new Headers(init?.headers).get("authorization")?.replace("Bearer ", "");
    return token === freshAccessToken
      ? json(200, USER)
      : json(403, { error_code: "session_not_found", msg: "Session not found" });
  }
  return json(404, { msg: "not faked" });
});

// --------------------------------------------------------------------------------

beforeEach(() => {
  vi.clearAllMocks();
  cookieStore.jar.clear();
  cookieStore.state.mode = "action";
  fetchCalls.length = 0;
  freshAccessToken = "";
  vi.spyOn(globalThis, "fetch").mockImplementation(fakeSupabaseFetch);
  vi.spyOn(console, "warn").mockImplementation(() => {});
  vi.spyOn(console, "error").mockImplementation(() => {});
  // An expired access token with a still-valid refresh token.
  storeSession(session(now() - 60, OLD_REFRESH_TOKEN, "s1"));
});

afterEach(() => {
  vi.restoreAllMocks();
});

const setMode = (mode: Mode) => {
  cookieStore.state.mode = mode;
};

describe("expired session in a Server Action / Route Handler (cookies writable)", () => {
  it("refreshes the session and persists the new tokens to the cookies", async () => {
    const supabase = await createClient();

    const { data, error } = await supabase.auth.getUser();

    expect(error).toBeNull();
    expect(data.user?.email).toBe("jane@example.com");
    expect(fetchCalls).toEqual([
      "POST /auth/v1/token?grant_type=refresh_token",
      "GET /auth/v1/user",
    ]);
    expect(cookieStore.set).toHaveBeenCalled();
    expect(storedSession()?.refresh_token).toBe(NEW_REFRESH_TOKEN);
    expect(console.warn).not.toHaveBeenCalled();
  });
});

describe("expired session during Server Component rendering (cookies read-only) — regression", () => {
  it("does not throw: getUser() resolves with the refreshed user instead of crashing the page", async () => {
    setMode("render");
    const supabase = await createClient();

    const { data, error } = await supabase.auth.getUser();

    expect(error).toBeNull();
    expect(data.user?.id).toBe(USER.id);
    expect(fetchCalls).toContain("POST /auth/v1/token?grant_type=refresh_token");
  });

  it("leaves the existing cookies untouched (the proxy persists the refresh on the next request)", async () => {
    setMode("render");
    const supabase = await createClient();

    await supabase.auth.getUser();

    expect(cookieStore.set).toHaveBeenCalled(); // the write was attempted…
    expect(storedSession()?.refresh_token).toBe(OLD_REFRESH_TOKEN); // …and rejected by Next
  });

  it("logs a warning without token values", async () => {
    setMode("render");
    const supabase = await createClient();

    await supabase.auth.getUser();

    expect(console.warn).toHaveBeenCalledTimes(1);
    const logged = JSON.stringify(vi.mocked(console.warn).mock.calls[0]);
    expect(logged).toMatch(/could not be updated during rendering/);
    expect(logged).not.toContain(NEW_REFRESH_TOKEN);
    expect(logged).not.toContain(freshAccessToken);
  });

  it("leaves no unhandled promise rejection behind", async () => {
    setMode("render");
    const unhandled: unknown[] = [];
    const onUnhandled = (reason: unknown) => unhandled.push(reason);
    process.on("unhandledRejection", onUnhandled);

    try {
      const supabase = await createClient();
      await supabase.auth.getUser();
      await new Promise((resolve) => setImmediate(resolve));
    } finally {
      process.off("unhandledRejection", onUnhandled);
    }

    expect(unhandled).toEqual([]);
  });

  it("is consistent across the two typical render-phase callers (layout guard + page data)", async () => {
    setMode("render");
    const supabase = await createClient();

    const first = await supabase.auth.getUser();
    const second = await supabase.auth.getUser(); // same client, session now in memory

    expect(first.data.user?.id).toBe(USER.id);
    expect(second.data.user?.id).toBe(USER.id);
    // One refresh only; the refreshed session is reused in memory.
    expect(fetchCalls.filter((c) => c.includes("refresh_token"))).toHaveLength(1);
  });
});

describe("unexpected cookie-store failures during a refresh are reported, not thrown", () => {
  // Throwing from the cookie adapter happens inside supabase-js's auth
  // state-change callback. It used to crash the request AND leave supabase-js's
  // internal refresh promise rejected with nobody awaiting it — an unhandled
  // rejection in the server process. The adapter now reports the failure and
  // lets the request continue with the refreshed in-memory session.

  it("getUser() still resolves with the refreshed user", async () => {
    setMode("broken");
    const supabase = await createClient();

    const { data, error } = await supabase.auth.getUser();

    expect(error).toBeNull();
    expect(data.user?.id).toBe(USER.id);
    expect(fetchCalls).toContain("POST /auth/v1/token?grant_type=refresh_token");
    expect(cookieStore.set).toHaveBeenCalled(); // the write was attempted…
    expect(storedSession()?.refresh_token).toBe(OLD_REFRESH_TOKEN); // …and failed
  });

  it("logs the failure as an error (not as the expected read-only warning), without token values", async () => {
    setMode("broken");
    const supabase = await createClient();

    await supabase.auth.getUser();

    expect(console.warn).not.toHaveBeenCalled();
    expect(console.error).toHaveBeenCalledTimes(1);
    const logged = JSON.stringify(vi.mocked(console.error).mock.calls[0]);
    expect(logged).toMatch(/session cookies could not be updated/);
    expect(logged).toMatch(/"name":"TypeError"/);
    expect(logged).not.toMatch(/cookie store is broken/);
    expect(logged).not.toContain(NEW_REFRESH_TOKEN);
    expect(logged).not.toContain(OLD_REFRESH_TOKEN);
    expect(logged).not.toContain(freshAccessToken);
  });

  it("leaves no unhandled promise rejection behind", async () => {
    setMode("broken");
    const unhandled: unknown[] = [];
    const onUnhandled = (reason: unknown) => unhandled.push(reason);
    process.on("unhandledRejection", onUnhandled);

    try {
      const supabase = await createClient();
      await supabase.auth.getUser();
      await new Promise((resolve) => setTimeout(resolve, 20));
    } finally {
      process.off("unhandledRejection", onUnhandled);
    }

    expect(unhandled).toEqual([]);
  });

  it("treats a failure thrown as a non-Error value the same way", async () => {
    cookieStore.set.mockImplementationOnce(() => {
      throw "cookie store exploded";
    });
    const supabase = await createClient();

    const { data } = await supabase.auth.getUser();

    expect(data.user?.id).toBe(USER.id);
    const logged = JSON.stringify(vi.mocked(console.error).mock.calls[0]);
    expect(logged).toMatch(/"name":"string"/);
    expect(logged).not.toMatch(/cookie store exploded/);
  });
});

describe("no session / invalid refresh token (unchanged behaviour)", () => {
  it("returns no user and makes no request when there are no cookies", async () => {
    cookieStore.jar.clear();
    const supabase = await createClient();

    const { data, error } = await supabase.auth.getUser();

    expect(data.user).toBeNull();
    expect(error?.name).toBe("AuthSessionMissingError");
    expect(fetchCalls).toEqual([]);
  });

  it("returns an auth error (not a throw) when the refresh token was revoked, so guards redirect to /login", async () => {
    storeSession(session(now() - 60, "rt-revoked", "s1"));
    setMode("render");
    const supabase = await createClient();

    const { data, error } = await supabase.auth.getUser();

    expect(data.user).toBeNull();
    expect(error?.code).toBe("refresh_token_not_found");
  });
});
