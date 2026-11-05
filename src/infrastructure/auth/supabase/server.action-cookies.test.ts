// @vitest-environment node
/**
 * The cookie-based server client during a Server Action request: a dead
 * session's cookies are not cleared (Next would refresh the route and its
 * guard would navigate the tab away mid-action — see action-session-cookies.ts),
 * while saving a session is unaffected. Page requests behave as before.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const COOKIE = "sb-example-auth-token";

const request = vi.hoisted(() => ({
  cookies: [] as { name: string; value: string }[],
  headers: new Headers(),
}));
const cookieStore = vi.hoisted(() => ({
  getAll: vi.fn(() => request.cookies),
  set: vi.fn(),
}));

vi.mock("next/headers", () => ({
  cookies: vi.fn(async () => cookieStore),
  headers: vi.fn(async () => request.headers),
}));

// Literal inside the factory: `vi.mock` is hoisted above the constants.
vi.mock("@/config/env.client", () => ({
  clientEnv: {
    NEXT_PUBLIC_APP_URL: "http://localhost:3000",
    NEXT_PUBLIC_SUPABASE_URL: "https://example.supabase.co",
    NEXT_PUBLIC_SUPABASE_ANON_KEY: "anon-public-key",
  },
}));

const ssr = vi.hoisted(() => ({
  options: null as null | { cookies: { setAll: (c: unknown[]) => void } },
}));
vi.mock("@supabase/ssr", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@supabase/ssr")>();
  return {
    ...actual,
    createServerClient: vi.fn((url: string, key: string, options: never) => {
      ssr.options = options;
      return actual.createServerClient(url, key, options);
    }),
  };
});

import { createClient } from "./server";

const b64url = (value: object) =>
  Buffer.from(JSON.stringify(value)).toString("base64url");
const now = () => Math.floor(Date.now() / 1000);
/** A session whose access token is still valid, but which GoTrue no longer knows. */
const revokedSessionCookie = () => {
  const exp = now() + 3600;
  const jwt = `${b64url({ alg: "HS256" })}.${b64url({ sub: "u1", exp, role: "authenticated", session_id: "s1" })}.sig`;
  return (
    "base64-" +
    b64url({
      access_token: jwt,
      refresh_token: "rt",
      token_type: "bearer",
      expires_in: 3600,
      expires_at: exp,
      user: { id: "u1" },
    })
  );
};

const asAction = () => (request.headers = new Headers({ "next-action": "7f3a9c" }));
const asPage = () => (request.headers = new Headers());

beforeEach(() => {
  request.cookies = [];
  asPage();
  cookieStore.set.mockClear();
  vi.spyOn(console, "warn").mockImplementation(() => {});
  vi.spyOn(console, "error").mockImplementation(() => {});
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe("the server client's cookie writes", () => {
  it("during an action: skips a batch that only clears the session", async () => {
    asAction();
    await createClient();

    ssr.options!.cookies.setAll([{ name: COOKIE, value: "", options: { maxAge: 0 } }]);

    expect(cookieStore.set).not.toHaveBeenCalled();
  });

  it("during an action: still writes a session save, stale-chunk clearing included", async () => {
    asAction();
    await createClient();

    ssr.options!.cookies.setAll([
      { name: `${COOKIE}.1`, value: "", options: { maxAge: 0 } },
      { name: `${COOKIE}.0`, value: "base64-new", options: {} },
    ]);

    expect(cookieStore.set).toHaveBeenCalledTimes(2);
    expect(cookieStore.set).toHaveBeenCalledWith(`${COOKIE}.1`, "", { maxAge: 0 });
    expect(cookieStore.set).toHaveBeenCalledWith(`${COOKIE}.0`, "base64-new", {});
  });

  it("on a page request: clears the session as before", async () => {
    await createClient();

    ssr.options!.cookies.setAll([{ name: COOKIE, value: "", options: { maxAge: 0 } }]);

    expect(cookieStore.set).toHaveBeenCalledWith(COOKIE, "", { maxAge: 0 });
  });

  it("end to end: an action finding the session gone at the auth server writes no cookie — and sees no user", async () => {
    request.cookies = [{ name: COOKIE, value: revokedSessionCookie() }];
    vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response(
        JSON.stringify({
          code: 403,
          error_code: "session_not_found",
          msg: "Session from session_id claim in JWT does not exist",
        }),
        { status: 403, headers: { "content-type": "application/json" } },
      ),
    );
    asAction();

    const supabase = await createClient();
    const { data } = await supabase.auth.getUser();

    expect(data.user).toBeNull();
    expect(cookieStore.set).not.toHaveBeenCalled();
  });

  it("end to end, same on a page request: the dead session IS cleared (control)", async () => {
    request.cookies = [{ name: COOKIE, value: revokedSessionCookie() }];
    vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response(
        JSON.stringify({
          code: 403,
          error_code: "session_not_found",
          msg: "Session from session_id claim in JWT does not exist",
        }),
        { status: 403, headers: { "content-type": "application/json" } },
      ),
    );

    const supabase = await createClient();
    await supabase.auth.getUser();

    expect(cookieStore.set).toHaveBeenCalledWith(
      COOKIE,
      "",
      expect.objectContaining({ maxAge: 0 }),
    );
  });

  it("outside a request (headers() unavailable) behaves like a page request", async () => {
    const { headers } = await import("next/headers");
    vi.mocked(headers).mockRejectedValueOnce(new Error("outside a request scope"));
    await createClient();

    ssr.options!.cookies.setAll([{ name: COOKIE, value: "", options: { maxAge: 0 } }]);

    expect(cookieStore.set).toHaveBeenCalled();
  });
});
