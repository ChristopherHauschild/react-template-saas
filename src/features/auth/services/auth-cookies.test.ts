// @vitest-environment node
import { describe, expect, it } from "vitest";

import { isSupabaseAuthCookie, persistedAccessTokens } from "./auth-cookies";

describe("isSupabaseAuthCookie", () => {
  it.each([
    "sb-abcdefghijklmnop-auth-token",
    "sb-abcdefghijklmnop-auth-token.0",
    "sb-abcdefghijklmnop-auth-token.1",
    "sb-127-auth-token", // local Supabase (127.0.0.1)
    "sb-localhost-auth-token-code-verifier",
  ])("matches %s", (name) => {
    expect(isSupabaseAuthCookie(name)).toBe(true);
  });

  it.each([
    "__Host-next-auth.csrf-token",
    "sidebar:collapsed",
    "sb-analytics",
    "theme",
    "",
  ])("leaves %s alone", (name) => {
    expect(isSupabaseAuthCookie(name)).toBe(false);
  });
});

describe("persistedAccessTokens", () => {
  const encode = (session: object) =>
    "base64-" + Buffer.from(JSON.stringify(session)).toString("base64url");
  const SESSION = {
    access_token: "jwt-new",
    refresh_token: "rt-new",
    user: { id: "u1" },
  };

  it("reads the access token of a base64url-encoded session cookie", async () => {
    const tokens = await persistedAccessTokens([
      { name: "sb-project-auth-token", value: encode(SESSION) },
    ]);

    expect([...tokens]).toEqual(["jwt-new"]);
  });

  it("reassembles a chunked session cookie in order", async () => {
    const whole = encode(SESSION);
    const cut = Math.floor(whole.length / 3);
    const tokens = await persistedAccessTokens([
      { name: "sb-project-auth-token.2", value: whole.slice(2 * cut) },
      { name: "sb-project-auth-token.0", value: whole.slice(0, cut) },
      { name: "sb-project-auth-token.1", value: whole.slice(cut, 2 * cut) },
    ]);

    expect([...tokens]).toEqual(["jwt-new"]);
  });

  it("supports the raw JSON encoding too", async () => {
    const tokens = await persistedAccessTokens([
      { name: "sb-127-auth-token", value: JSON.stringify(SESSION) },
    ]);

    expect([...tokens]).toEqual(["jwt-new"]);
  });

  it("REGRESSION: the PKCE verifier cookie is not a session", async () => {
    const tokens = await persistedAccessTokens([
      { name: "sb-project-auth-token-code-verifier", value: "verifier-secret" },
    ]);

    expect(tokens.size).toBe(0);
  });

  it("ignores the -user cookie and unrelated cookies", async () => {
    const tokens = await persistedAccessTokens([
      {
        name: "sb-project-auth-token-user",
        value: encode({ access_token: "not-a-session" }),
      },
      { name: "theme", value: "dark" },
      { name: "__Host-csrf", value: encode(SESSION) },
    ]);

    expect(tokens.size).toBe(0);
  });

  it("reports every stored session, so a caller can tell a stale one from the new one", async () => {
    const tokens = await persistedAccessTokens([
      { name: "sb-old-project-auth-token", value: encode({ access_token: "jwt-old" }) },
      { name: "sb-project-auth-token", value: encode(SESSION) },
    ]);

    expect(tokens).toEqual(new Set(["jwt-old", "jwt-new"]));
  });

  it("ignores malformed values without throwing", async () => {
    const tokens = await persistedAccessTokens([
      { name: "sb-a-auth-token", value: "base64-!!!not-base64" },
      { name: "sb-b-auth-token", value: "{not json" },
      { name: "sb-c-auth-token", value: encode({ refresh_token: "only" }) },
      { name: "sb-d-auth-token", value: encode("a string" as unknown as object) },
      { name: "sb-e-auth-token", value: "" },
    ]);

    expect(tokens.size).toBe(0);
  });
});
