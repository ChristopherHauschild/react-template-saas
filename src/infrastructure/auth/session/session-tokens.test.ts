// @vitest-environment node
import {
  AuthApiError,
  createClient as createSupabaseClient,
} from "@supabase/supabase-js";
import { beforeEach, describe, expect, it, vi } from "vitest";

const infra = vi.hoisted(() => ({ createClient: vi.fn<() => Promise<unknown>>() }));
vi.mock("../supabase/server", () => infra);

import {
  accessTokenLifetimeSeconds,
  getCurrentSessionInfo,
  revokeOtherSessions,
} from "./session-tokens";

/** An unsigned JWT-shaped token; only the payload matters here. */
const jwt = (claims: Record<string, unknown>) =>
  [
    Buffer.from(JSON.stringify({ alg: "HS256", typ: "JWT" })).toString("base64url"),
    Buffer.from(JSON.stringify(claims)).toString("base64url"),
    "signature",
  ].join(".");

const NOW_S = Math.floor(Date.now() / 1000);
const TOKEN = jwt({ sub: "user-1", session_id: "s-1", iat: NOW_S, exp: NOW_S + 3600 });

const auth = {
  getSession: vi.fn(),
  admin: { signOut: vi.fn() },
  signOut: vi.fn(),
};

beforeEach(() => {
  vi.clearAllMocks();
  infra.createClient.mockResolvedValue({ auth });
  auth.getSession.mockResolvedValue({
    data: { session: { access_token: TOKEN } },
    error: null,
  });
  auth.admin.signOut.mockResolvedValue({ data: null, error: null });
});

describe("accessTokenLifetimeSeconds", () => {
  it("reads exp - iat from the payload", () => {
    expect(accessTokenLifetimeSeconds(TOKEN)).toBe(3600);
    expect(accessTokenLifetimeSeconds(jwt({ iat: 100, exp: 400 }))).toBe(300);
  });

  it.each([
    ["no payload", "abc"],
    ["not JSON", "a.bm90LWpzb24.c"],
    ["missing exp", jwt({ iat: 1 })],
    ["non-numeric claims", jwt({ iat: "1", exp: "2" })],
    ["exp before iat", jwt({ iat: 10, exp: 5 })],
    ["JSON that is not an object", `a.${Buffer.from("42").toString("base64url")}.c`],
  ])("returns null for %s", (_label, token) => {
    expect(accessTokenLifetimeSeconds(token)).toBeNull();
  });
});

describe("getCurrentSessionInfo", () => {
  it("reports the current token's lifetime", async () => {
    await expect(getCurrentSessionInfo()).resolves.toEqual({
      accessTokenLifetimeSeconds: 3600,
    });
  });

  it("reports null without a session, and never throws", async () => {
    auth.getSession.mockResolvedValue({ data: { session: null }, error: null });
    await expect(getCurrentSessionInfo()).resolves.toEqual({
      accessTokenLifetimeSeconds: null,
    });

    infra.createClient.mockRejectedValue(new Error("cookies unavailable"));
    await expect(getCurrentSessionInfo()).resolves.toEqual({
      accessTokenLifetimeSeconds: null,
    });
  });
});

describe("revokeOtherSessions", () => {
  it("asks GoTrue to end every OTHER session, identified by this session's access token", async () => {
    await expect(revokeOtherSessions()).resolves.toEqual({ ok: true });

    expect(auth.admin.signOut).toHaveBeenCalledTimes(1);
    expect(auth.admin.signOut).toHaveBeenCalledWith(TOKEN, "others");
  });

  it("never uses the client sign-out (it reports success on 401/403 without revoking anything)", async () => {
    await revokeOtherSessions();

    expect(auth.signOut).not.toHaveBeenCalled();
  });

  it.each([
    [
      "the current session was revoked",
      new AuthApiError("Session not found", 403, "session_not_found"),
    ],
    ["the access token is invalid", new AuthApiError("invalid JWT", 401, "bad_jwt")],
    ["rate limited", new AuthApiError("Too many", 429, "over_request_rate_limit")],
  ])("returns GoTrue's refusal as a failure when %s", async (_label, error) => {
    auth.admin.signOut.mockResolvedValue({ data: null, error });

    await expect(revokeOtherSessions()).resolves.toEqual({ ok: false, error });
  });

  it("fails — rather than silently succeeding — when there is no session at all", async () => {
    auth.getSession.mockResolvedValue({ data: { session: null }, error: null });

    const result = await revokeOtherSessions();

    expect(result.ok).toBe(false);
    expect(result).toMatchObject({ error: { name: "AuthSessionMissingError" } });
    expect(auth.admin.signOut).not.toHaveBeenCalled();
  });

  it("fails when the session cannot be loaded (refresh refused)", async () => {
    const error = new AuthApiError(
      "Invalid Refresh Token",
      400,
      "refresh_token_not_found",
    );
    auth.getSession.mockResolvedValue({ data: { session: null }, error });

    await expect(revokeOtherSessions()).resolves.toEqual({ ok: false, error });
    expect(auth.admin.signOut).not.toHaveBeenCalled();
  });

  it("reuses the caller's server client instead of building another", async () => {
    const client = { auth } as never;

    await revokeOtherSessions(client);

    expect(infra.createClient).not.toHaveBeenCalled();
    expect(auth.admin.signOut).toHaveBeenCalledWith(TOKEN, "others");
  });
});

/**
 * Evidence for the design, against the REAL supabase-js with a fake network:
 * GoTrue refuses `/logout?scope=others` with 403 (the current session is gone),
 * the client sign-out reports success anyway, the admin sign-out reports the
 * refusal. If a future supabase-js stops swallowing, this test says so.
 */
describe("supabase-js behaviour this module depends on", () => {
  const SUPABASE_URL = "https://project.supabase.co";

  function realClientWithFakeGoTrue(logout = { status: 403, code: "session_not_found" }) {
    const requests: string[] = [];
    const fetch = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = new URL(typeof input === "string" ? input : input.toString());
      requests.push(`${init?.method ?? "GET"} ${url.pathname}${url.search}`);

      if (url.pathname === "/auth/v1/token") {
        return new Response(
          JSON.stringify({
            access_token: TOKEN,
            refresh_token: "refresh-1",
            token_type: "bearer",
            expires_in: 3600,
            expires_at: NOW_S + 3600,
            user: { id: "user-1", aud: "authenticated", email: "jane@example.com" },
          }),
          { status: 200, headers: { "content-type": "application/json" } },
        );
      }

      if (url.pathname === "/auth/v1/logout") {
        return new Response(
          JSON.stringify({ code: logout.code, msg: "refused by GoTrue" }),
          {
            status: logout.status,
            headers: {
              "content-type": "application/json",
              "x-supabase-api-version": "2024-01-01",
            },
          },
        );
      }

      return new Response("{}", { status: 404 });
    });

    const client = createSupabaseClient(SUPABASE_URL, "anon-key", {
      auth: { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false },
      global: { fetch: fetch as typeof globalThis.fetch },
    });

    return { client, requests };
  }

  it("client signOut({ scope: 'others' }) hides a 403 from /logout; admin.signOut reports it", async () => {
    const { client, requests } = realClientWithFakeGoTrue();
    await client.auth.signInWithPassword({ email: "jane@example.com", password: "x" });

    const viaClient = await client.auth.signOut({ scope: "others" });
    const viaAdmin = await client.auth.admin.signOut(TOKEN, "others");

    expect(requests.filter((r) => r.startsWith("POST /auth/v1/logout"))).toEqual([
      "POST /auth/v1/logout?scope=others",
      "POST /auth/v1/logout?scope=others",
    ]);
    expect(viaClient.error).toBeNull(); // ← why the client sign-out cannot be trusted
    // supabase-js turns `session_not_found` into AuthSessionMissingError; it is
    // still an error here, and maps to "sign in again".
    expect(viaAdmin.error).toMatchObject({ name: "AuthSessionMissingError" });
  });

  it("the same holds for a 401 (invalid token): hidden by the client, reported by admin", async () => {
    const { client } = realClientWithFakeGoTrue({ status: 401, code: "bad_jwt" });
    await client.auth.signInWithPassword({ email: "jane@example.com", password: "x" });

    expect((await client.auth.signOut({ scope: "others" })).error).toBeNull();
    expect((await client.auth.admin.signOut(TOKEN, "others")).error).toMatchObject({
      status: 401,
      code: "bad_jwt",
    });
  });
});
