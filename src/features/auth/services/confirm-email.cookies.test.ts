// @vitest-environment node
/**
 * End-to-end check of the part of email confirmation that unit tests mock away:
 * that verifying a link through the cookie-backed server client actually leaves
 * a session cookie behind for the redirect to carry — and what happens when the
 * cookie store refuses the write.
 *
 * Real `@supabase/ssr` + supabase-js; only `fetch` (GoTrue) and Next's cookie
 * store are faked. Covers both link shapes: `token_hash` (the email template;
 * also resent emails) and the PKCE `code` fallback.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const { SUPABASE_URL, ANON_KEY } = vi.hoisted(() => ({
  SUPABASE_URL: "https://example.supabase.co",
  ANON_KEY: "anon-public-key",
}));
/** `@supabase/ssr` derives the cookie name from the project host. */
const SESSION_COOKIE = "sb-example-auth-token";
const VERIFIER_COOKIE = "sb-example-auth-token-code-verifier";

const cookieStore = vi.hoisted(() => {
  const jar = new Map<string, string>();
  const state = { writable: true };
  return {
    jar,
    state,
    getAll: vi.fn(() => [...jar].map(([name, value]) => ({ name, value }))),
    set: vi.fn((name: string, value: string, options?: { maxAge?: number }) => {
      if (!state.writable) throw new TypeError("cookie store is broken");
      // Next expires a cookie by setting it with maxAge 0; model that as removal.
      if (options?.maxAge === 0) jar.delete(name);
      else jar.set(name, value);
    }),
  };
});
vi.mock("next/headers", () => ({ cookies: vi.fn(async () => cookieStore) }));

vi.mock("@/config/env.client", () => ({
  clientEnv: {
    NEXT_PUBLIC_APP_URL: "http://127.0.0.1:3000",
    NEXT_PUBLIC_SUPABASE_URL: SUPABASE_URL,
    NEXT_PUBLIC_SUPABASE_ANON_KEY: ANON_KEY,
  },
}));

import { confirmEmail, confirmEmailWithTokenHash } from "./confirm-email";
import { CONFIRMATION_FAILURES } from "./email-confirmation-errors";

// --- fixtures -------------------------------------------------------------------

const b64url = (value: object) =>
  Buffer.from(JSON.stringify(value)).toString("base64url");
const USER = {
  id: "11111111-1111-4111-8111-111111111111",
  aud: "authenticated",
  role: "authenticated",
  email: "jane@example.com",
  email_confirmed_at: "2026-01-01T00:00:00Z",
  app_metadata: {},
  user_metadata: {},
  created_at: "2026-01-01T00:00:00Z",
};
const exp = () => Math.floor(Date.now() / 1000) + 3600;
const SESSION = () => ({
  access_token: `${b64url({ alg: "HS256", typ: "JWT" })}.${b64url({ sub: USER.id, exp: exp(), session_id: "s1", role: "authenticated" })}.sig`,
  refresh_token: "rt-1",
  token_type: "bearer",
  expires_in: 3600,
  expires_at: exp(),
  user: USER,
});

const TOKEN_HASH = "pbkdf2-secret-token-hash";
const CODE = "0b6f1d2e-secret-one-time-code";
const VERIFIER = "pkce-verifier-from-sign-up";

type GoTrueCall = { path: string; body: Record<string, unknown> };
const calls: GoTrueCall[] = [];
const gotrue = { status: 200 as number, body: {} as unknown };

const fakeFetch = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
  const url = new URL(String(input));
  calls.push({
    path: url.pathname + url.search,
    body: init?.body ? (JSON.parse(String(init.body)) as Record<string, unknown>) : {},
  });
  return new Response(JSON.stringify(gotrue.body), {
    status: gotrue.status,
    headers: { "content-type": "application/json" },
  });
});

const storedSession = () => {
  const raw = cookieStore.jar.get(SESSION_COOKIE);
  if (!raw) return null;
  return JSON.parse(
    Buffer.from(raw.replace(/^base64-/, ""), "base64url").toString("utf8"),
  ) as { access_token: string; refresh_token: string };
};

beforeEach(() => {
  cookieStore.jar.clear();
  cookieStore.state.writable = true;
  cookieStore.set.mockClear();
  calls.length = 0;
  gotrue.status = 200;
  gotrue.body = SESSION();
  vi.stubGlobal("fetch", fakeFetch);
  vi.spyOn(console, "error").mockImplementation(() => {});
  vi.spyOn(console, "warn").mockImplementation(() => {});
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

// --- token_hash (email template; original and resent links) ---------------------

describe("token_hash link → session cookie", () => {
  it("verifies server-to-server and writes the session cookie, with nothing required from the browser", async () => {
    // No cookies at all: a different browser/device than the one that signed up.
    expect(cookieStore.jar.size).toBe(0);

    await expect(confirmEmailWithTokenHash(TOKEN_HASH, "signup")).resolves.toEqual({
      ok: true,
    });

    expect(calls).toHaveLength(1);
    expect(calls[0].path).toBe("/auth/v1/verify");
    expect(calls[0].body).toMatchObject({ token_hash: TOKEN_HASH, type: "signup" });
    expect(storedSession()?.refresh_token).toBe("rt-1");
  });

  it("an expired or already-used link (GoTrue: otp_expired) leaves no session behind", async () => {
    gotrue.status = 403;
    gotrue.body = {
      code: 403,
      error_code: "otp_expired",
      msg: "Email link is invalid or has expired",
    };

    await expect(confirmEmailWithTokenHash(TOKEN_HASH, "signup")).resolves.toEqual({
      ok: false,
      failure: CONFIRMATION_FAILURES.expired,
    });
    expect(storedSession()).toBeNull();
    expect(console.error).not.toHaveBeenCalled();
  });

  it("a verified token whose session cookie cannot be written is reported as unavailable (the token is spent; the copy tells the user to sign in)", async () => {
    cookieStore.state.writable = false;

    await expect(confirmEmailWithTokenHash(TOKEN_HASH, "signup")).resolves.toEqual({
      ok: false,
      failure: CONFIRMATION_FAILURES.unavailable,
    });
    expect(calls).toHaveLength(1); // GoTrue did consume the token
    expect(storedSession()).toBeNull();
    // The cookie adapter reports the store failure (name only) without throwing —
    // a throw there is not survivable with supabase-js — and the confirmation
    // checks the store itself before claiming success.
    expect(console.error).toHaveBeenCalledWith(
      "[auth] session cookies could not be updated",
      { cookies: 1, error: { name: "TypeError" } },
    );
    expect(console.error).toHaveBeenCalledWith(
      "[auth] email confirmation verified but the issued session is not in the cookies",
    );
    const logged = JSON.stringify(
      vi.mocked(console.error).mock.calls.map((call) => call.map(String)),
    );
    expect(logged).not.toContain(TOKEN_HASH);
    expect(logged).not.toContain("rt-1"); // nor the session GoTrue returned
  });

  it("REGRESSION: a stale session cookie left in the browser does not make a failed write look like a success", async () => {
    // The browser still carries a session from an earlier sign-in (maybe revoked
    // long ago). GoTrue issues a new one for this link, but the store refuses the
    // write: the old cookie stays. Before, "a session cookie exists" passed and
    // the user was sent to a dashboard that bounced them back to /login.
    const stale = {
      ...SESSION(),
      access_token: "stale.access.token",
      refresh_token: "rt-stale",
    };
    cookieStore.jar.set(
      SESSION_COOKIE,
      "base64-" + Buffer.from(JSON.stringify(stale)).toString("base64url"),
    );
    cookieStore.state.writable = false;

    await expect(confirmEmailWithTokenHash(TOKEN_HASH, "signup")).resolves.toEqual({
      ok: false,
      failure: CONFIRMATION_FAILURES.unavailable,
    });
    expect(calls).toHaveLength(1); // the token was spent
    expect(storedSession()?.access_token).toBe("stale.access.token"); // untouched
    expect(console.error).toHaveBeenCalledWith(
      "[auth] email confirmation verified but the issued session is not in the cookies",
    );
  });

  it("REGRESSION: the PKCE verifier cookie alone is not a persisted session", async () => {
    cookieStore.jar.set(VERIFIER_COOKIE, VERIFIER);
    cookieStore.state.writable = false;

    await expect(confirmEmailWithTokenHash(TOKEN_HASH, "signup")).resolves.toEqual({
      ok: false,
      failure: CONFIRMATION_FAILURES.unavailable,
    });
  });

  it("a stale session cookie is REPLACED by the issued one when the write works — and that counts", async () => {
    const stale = {
      ...SESSION(),
      access_token: "stale.access.token",
      refresh_token: "rt-stale",
    };
    cookieStore.jar.set(
      SESSION_COOKIE,
      "base64-" + Buffer.from(JSON.stringify(stale)).toString("base64url"),
    );

    await expect(confirmEmailWithTokenHash(TOKEN_HASH, "signup")).resolves.toEqual({
      ok: true,
    });
    expect(storedSession()?.refresh_token).toBe("rt-1");
    expect(storedSession()?.access_token).not.toBe("stale.access.token");
  });

  it("never sends the hash anywhere but to GoTrue's /verify, and never logs it", async () => {
    await confirmEmailWithTokenHash(TOKEN_HASH, "signup");

    expect(calls.every((c) => c.path === "/auth/v1/verify")).toBe(true);
    expect(
      JSON.stringify([
        ...vi.mocked(console.error).mock.calls,
        ...vi.mocked(console.warn).mock.calls,
      ]),
    ).not.toContain(TOKEN_HASH);
  });
});

// --- PKCE code (Supabase's default template) ------------------------------------

describe("PKCE code link → session cookie", () => {
  it("same browser: exchanges the code with the stored verifier, writes the session and drops the verifier", async () => {
    cookieStore.jar.set(VERIFIER_COOKIE, VERIFIER);

    await expect(confirmEmail(CODE)).resolves.toEqual({ ok: true });

    expect(calls[0].path).toBe("/auth/v1/token?grant_type=pkce");
    expect(calls[0].body).toMatchObject({ auth_code: CODE, code_verifier: VERIFIER });
    expect(storedSession()?.refresh_token).toBe("rt-1");
    expect(cookieStore.jar.has(VERIFIER_COOKIE)).toBe(false);
  });

  it("different browser (no verifier cookie): refused locally as invalid, GoTrue is never contacted, nothing stored", async () => {
    await expect(confirmEmail(CODE)).resolves.toEqual({
      ok: false,
      failure: CONFIRMATION_FAILURES.invalid,
    });

    expect(calls).toHaveLength(0);
    expect(storedSession()).toBeNull();
    expect(console.error).not.toHaveBeenCalled();
  });

  it("reused code (GoTrue: flow_state_not_found) → invalid, nothing stored", async () => {
    cookieStore.jar.set(VERIFIER_COOKIE, VERIFIER);
    gotrue.status = 404;
    gotrue.body = {
      code: 404,
      error_code: "flow_state_not_found",
      msg: "invalid flow state",
    };

    await expect(confirmEmail(CODE)).resolves.toEqual({
      ok: false,
      failure: CONFIRMATION_FAILURES.invalid,
    });
    expect(storedSession()).toBeNull();
  });

  it("expired flow state (GoTrue: flow_state_expired) → expired, nothing stored", async () => {
    cookieStore.jar.set(VERIFIER_COOKIE, VERIFIER);
    gotrue.status = 400;
    gotrue.body = {
      code: 400,
      error_code: "flow_state_expired",
      msg: "flow state expired",
    };

    await expect(confirmEmail(CODE)).resolves.toEqual({
      ok: false,
      failure: CONFIRMATION_FAILURES.expired,
    });
    expect(storedSession()).toBeNull();
  });
});
