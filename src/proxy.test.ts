// @vitest-environment node
/**
 * Proxy (Next 16 middleware) coverage.
 *
 * 1. Route matching — the `config.matcher` is compiled with Next's own compiler
 *    (the one `next build` uses), so the assertions reflect what will actually run
 *    in production, not a re-implementation of the matcher syntax.
 * 2. Behaviour — the real `@supabase/ssr` client against a faked Supabase Auth
 *    server: pass-through without cookies, session refresh persisted to both the
 *    response (browser) and the request (this render), and no crash on failure.
 */
import { NextRequest } from "next/server";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const { SUPABASE_URL, ANON_KEY } = vi.hoisted(() => ({
  SUPABASE_URL: "https://example.supabase.co",
  ANON_KEY: "anon-public-key",
}));

vi.mock("@/config/env.client", () => ({
  clientEnv: {
    NEXT_PUBLIC_APP_URL: "http://localhost:3000",
    NEXT_PUBLIC_SUPABASE_URL: SUPABASE_URL,
    NEXT_PUBLIC_SUPABASE_ANON_KEY: ANON_KEY,
  },
}));

import { config, proxy } from "./proxy";

// --- 1. route matching ------------------------------------------------------------

/** Compiles the matcher exactly like `next build` does. Internal API, pinned by this test. */
async function compileMatchers(): Promise<RegExp[]> {
  const { getMiddlewareMatchers } =
    (await import("next/dist/build/analysis/get-page-static-info")) as unknown as {
      getMiddlewareMatchers: (
        matchers: string[],
        nextConfig: Record<string, unknown>,
      ) => { regexp: string }[];
    };
  return getMiddlewareMatchers(config.matcher, {}).map((m) => new RegExp(m.regexp));
}

const runsFor = (regexps: RegExp[], pathname: string) =>
  regexps.some((re) => re.test(pathname));

describe("proxy config.matcher", () => {
  let regexps: RegExp[];

  beforeEach(async () => {
    regexps = await compileMatchers();
  });

  it("is a plain string literal (Next evaluates the export statically at build time)", () => {
    expect(Array.isArray(config.matcher)).toBe(true);
    for (const source of config.matcher) {
      expect(typeof source).toBe("string");
      expect(source.startsWith("/")).toBe(true);
    }
  });

  it.each([
    "/",
    "/login",
    "/dashboard",
    "/dashboard/settings",
    "/pricing",
    "/pricing/",
    "/dashboard?checkout=success".split("?")[0],
    "/some/new/page",
    "/api/health",
  ])("runs for page and app routes: %s", (pathname) => {
    expect(runsFor(regexps, pathname)).toBe(true);
  });

  it("runs for Server Action POSTs (they target the page's own URL)", () => {
    // Sign-in posts to /login, sign-out and checkout to /dashboard and /pricing.
    for (const pathname of ["/login", "/dashboard", "/pricing"]) {
      expect(runsFor(regexps, pathname)).toBe(true);
    }
  });

  it.each([
    "/_next/static/chunks/main-app.js",
    "/_next/static/css/app.css",
    "/_next/static/media/inter.woff2",
    "/_next/image",
  ])("skips Next build output and the image optimiser: %s", (pathname) => {
    expect(runsFor(regexps, pathname)).toBe(false);
  });

  it.each([
    "/favicon.ico",
    "/next.svg",
    "/vercel.svg",
    "/file.svg",
    "/globe.svg",
    "/window.svg",
    "/images/hero.png",
    "/images/hero.jpg",
    "/images/hero.jpeg",
    "/images/hero.gif",
    "/images/hero.webp",
    "/images/hero.avif",
    "/robots.txt",
    "/sitemap.xml",
    "/site.webmanifest",
    "/manifest.json",
    "/fonts/inter.woff",
    "/fonts/inter.woff2",
    "/fonts/inter.ttf",
    "/scripts/analytics.js",
    "/scripts/analytics.js.map",
    "/styles/legacy.css",
  ])("skips public/static files: %s", (pathname) => {
    expect(runsFor(regexps, pathname)).toBe(false);
  });

  it("skips the Stripe webhook (no browser cookies; authenticated by signature)", () => {
    expect(runsFor(regexps, "/api/stripe/webhook")).toBe(false);
  });

  it("does not over-match: a dotted segment that is not a static file still runs", () => {
    expect(runsFor(regexps, "/users/jane.doe")).toBe(true);
    expect(runsFor(regexps, "/v1.2/overview")).toBe(true);
  });

  it("excludes every public file currently shipped in /public", async () => {
    const { readdirSync } = await import("node:fs");
    const files = readdirSync(new URL("../public", import.meta.url)).filter((f) =>
      /\.[a-z0-9]+$/i.test(f),
    );

    expect(files.length).toBeGreaterThan(0);
    for (const file of files) {
      expect(runsFor(regexps, `/${file}`), `/${file} should be skipped`).toBe(false);
    }
  });
});

// --- 2. behaviour -----------------------------------------------------------------

const USER = {
  id: "11111111-1111-4111-8111-111111111111",
  aud: "authenticated",
  role: "authenticated",
  email: "jane@example.com",
  app_metadata: {},
  user_metadata: {},
  created_at: "2026-01-01T00:00:00Z",
};
const COOKIE = "sb-example-auth-token";
const b64url = (value: object) =>
  Buffer.from(JSON.stringify(value)).toString("base64url");
const now = () => Math.floor(Date.now() / 1000);
const jwt = (exp: number) =>
  `${b64url({ alg: "HS256" })}.${b64url({ sub: USER.id, exp, role: "authenticated" })}.sig`;
const session = (exp: number, refresh_token: string) => ({
  access_token: jwt(exp),
  refresh_token,
  token_type: "bearer",
  expires_in: exp - now(),
  expires_at: exp,
  user: USER,
});
const encodeCookie = (value: object) => "base64-" + b64url(value);
const decodeCookie = (value: string) =>
  JSON.parse(Buffer.from(value.replace(/^base64-/, ""), "base64url").toString()) as {
    refresh_token: string;
  };

const requestFor = (
  pathname: string,
  cookie?: string,
  extra: Record<string, string> = {},
) =>
  new NextRequest(`http://localhost:3000${pathname}`, {
    headers: { ...(cookie ? { cookie: `${COOKIE}=${cookie}` } : {}), ...extra },
  });

/** A Server Action call: Next posts to the page's URL with this header. */
const actionRequestFor = (pathname: string, cookie?: string) =>
  requestFor(pathname, cookie, { "next-action": "7f3a9c" });

const revokedRefresh = () =>
  new Response(
    JSON.stringify({
      error_code: "refresh_token_not_found",
      msg: "Invalid Refresh Token",
    }),
    { status: 400, headers: { "content-type": "application/json" } },
  );

const fetchCalls: string[] = [];
let refreshResponse: () => Response;

beforeEach(() => {
  fetchCalls.length = 0;
  refreshResponse = () =>
    new Response(JSON.stringify(session(now() + 3600, "rt-new")), {
      status: 200,
      headers: { "content-type": "application/json" },
    });
  vi.spyOn(globalThis, "fetch").mockImplementation(async (input, init) => {
    const url = String(input);
    fetchCalls.push(`${init?.method ?? "GET"} ${url.replace(SUPABASE_URL, "")}`);
    if (url.includes("grant_type=refresh_token")) return refreshResponse();
    if (url.endsWith("/auth/v1/user")) {
      return new Response(JSON.stringify(USER), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    }
    return new Response("{}", { status: 404 });
  });
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe("proxy behaviour", () => {
  it("passes the request through untouched when there is no session (e.g. a webhook or anonymous visit)", async () => {
    const response = await proxy(requestFor("/api/stripe/webhook"));

    expect(response.headers.get("x-middleware-next")).toBe("1");
    expect(response.headers.get("set-cookie")).toBeNull();
    // Decided locally from the empty cookie jar; nothing was sent to Supabase.
    expect(fetchCalls).toEqual([]);
  });

  it("validates a live session with Supabase and sets no cookies when nothing changed", async () => {
    const response = await proxy(
      requestFor("/dashboard", encodeCookie(session(now() + 3600, "rt-1"))),
    );

    expect(fetchCalls).toEqual(["GET /auth/v1/user"]);
    expect(response.headers.get("set-cookie")).toBeNull();
  });

  it("refreshes an expired session and persists the new tokens to the RESPONSE (browser)", async () => {
    const response = await proxy(
      requestFor("/dashboard", encodeCookie(session(now() - 60, "rt-old"))),
    );

    expect(fetchCalls).toEqual([
      "POST /auth/v1/token?grant_type=refresh_token",
      "GET /auth/v1/user",
    ]);
    const updated = response.cookies.get(COOKIE);
    expect(updated).toBeDefined();
    expect(decodeCookie(updated!.value).refresh_token).toBe("rt-new");
  });

  it("also updates the REQUEST cookies so the Server Components of this same request see the fresh session", async () => {
    const request = requestFor("/dashboard", encodeCookie(session(now() - 60, "rt-old")));

    await proxy(request);

    expect(decodeCookie(request.cookies.get(COOKIE)!.value).refresh_token).toBe("rt-new");
  });

  it("does not throw when Supabase is unreachable; the session is kept and the page decides what to do", async () => {
    refreshResponse = () =>
      new Response(JSON.stringify({ msg: "unavailable" }), { status: 503 });
    const request = requestFor("/dashboard", encodeCookie(session(now() - 60, "rt-old")));
    // supabase-js retries retryable failures with exponential backoff for up to 30 s.
    vi.useFakeTimers();

    try {
      const pending = proxy(request);
      await vi.advanceTimersByTimeAsync(60_000);
      const response = await pending;

      expect(response.headers.get("x-middleware-next")).toBe("1");
      expect(response.cookies.get(COOKIE)).toBeUndefined(); // not cleared: the outage is not a sign-out
      expect(
        fetchCalls.filter((c) => c.includes("refresh_token")).length,
      ).toBeGreaterThan(1);
    } finally {
      vi.useRealTimers();
    }
  });

  it("clears the session cookie when the refresh token was revoked (a genuine sign-out)", async () => {
    refreshResponse = () =>
      new Response(
        JSON.stringify({
          error_code: "refresh_token_not_found",
          msg: "Invalid Refresh Token",
        }),
        { status: 400, headers: { "content-type": "application/json" } },
      );

    const response = await proxy(
      requestFor("/dashboard", encodeCookie(session(now() - 60, "rt-revoked"))),
    );

    const cleared = response.cookies.get(COOKIE);
    expect(cleared).toBeDefined();
    expect(cleared!.value).toBe("");
    expect(cleared!.maxAge).toBe(0);
  });

  describe("during a Server Action request", () => {
    // Regression, found in Chromium: clearing the cookies of a dead session
    // while an action was being handled made Next answer
    // `x-action-revalidated` (it merges the proxy's cookies into the action's),
    // the client refreshed the route, and the (protected) guard sent the tab
    // to /login mid-action — losing everything unsaved on the page.
    it("does not clear a dead session's cookie: not on the response, not on the request", async () => {
      refreshResponse = revokedRefresh;
      const cookie = encodeCookie(session(now() - 60, "rt-revoked"));
      const request = actionRequestFor("/support", cookie);

      const response = await proxy(request);

      expect(response.cookies.get(COOKIE)).toBeUndefined();
      expect(response.headers.get("set-cookie")).toBeNull();
      expect(response.headers.get("x-middleware-set-cookie")).toBeNull();
      // The request the action sees still carries it; the action's own
      // session lookup then finds the session dead and reports it in place.
      expect(request.cookies.get(COOKIE)?.value).toBe(cookie);
    });

    it("still persists a refreshed session (a save, not a removal)", async () => {
      const response = await proxy(
        actionRequestFor("/support", encodeCookie(session(now() - 60, "rt-old"))),
      );

      const written = response.cookies.get(COOKIE);
      expect(written?.value).toBeTruthy();
      expect(decodeCookie(written!.value).refresh_token).toBe("rt-new");
    });

    it("a page request still clears the dead session as before", async () => {
      refreshResponse = revokedRefresh;

      const response = await proxy(
        requestFor("/support", encodeCookie(session(now() - 60, "rt-revoked"))),
      );

      expect(response.cookies.get(COOKIE)?.value).toBe("");
      expect(response.cookies.get(COOKIE)?.maxAge).toBe(0);
    });
  });
});
