// @vitest-environment node
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const env = vi.hoisted(() => ({
  serverEnv: {
    NODE_ENV: "test",
    SUPABASE_SERVICE_ROLE_KEY: "service-role-key-A",
    APP_SECRET: undefined as string | undefined,
  },
}));
vi.mock("@/config/env.server", () => env);

import {
  readSignedCookieValue,
  resetSigningKeysForTests,
  signCookieValue,
  signingKeyFor,
} from "./signed-cookie";

beforeEach(() => {
  env.serverEnv.SUPABASE_SERVICE_ROLE_KEY = "service-role-key-A";
  env.serverEnv.APP_SECRET = undefined;
  resetSigningKeysForTests();
});

afterEach(() => resetSigningKeysForTests());

describe("signingKeyFor", () => {
  it("derives a 32-byte key that is neither secret in clear", () => {
    const key = signingKeyFor("purpose-1");

    expect(key).toHaveLength(32);
    expect(key.toString("utf8")).not.toContain("service-role-key-A");
  });

  it("is stable for a purpose and different across purposes (no cross-cookie replay)", () => {
    expect(signingKeyFor("a").equals(signingKeyFor("a"))).toBe(true);
    expect(signingKeyFor("a").equals(signingKeyFor("b"))).toBe(false);
  });

  it("changes with the key material, and prefers APP_SECRET when set", () => {
    const fromServiceRole = Buffer.from(signingKeyFor("a"));

    resetSigningKeysForTests();
    env.serverEnv.SUPABASE_SERVICE_ROLE_KEY = "service-role-key-B";
    const fromOtherServiceRole = Buffer.from(signingKeyFor("a"));

    resetSigningKeysForTests();
    env.serverEnv.APP_SECRET = "dedicated-app-secret";
    const fromAppSecret = Buffer.from(signingKeyFor("a"));

    resetSigningKeysForTests();
    env.serverEnv.SUPABASE_SERVICE_ROLE_KEY = "service-role-key-A"; // irrelevant now
    const fromAppSecretAgain = Buffer.from(signingKeyFor("a"));

    expect(fromServiceRole.equals(fromOtherServiceRole)).toBe(false);
    expect(fromAppSecret.equals(fromServiceRole)).toBe(false);
    expect(fromAppSecret.equals(fromAppSecretAgain)).toBe(true);
  });
});

describe("signCookieValue / readSignedCookieValue", () => {
  const key = Buffer.alloc(32, 7);
  const otherKey = Buffer.alloc(32, 8);

  it("round-trips a payload, including '.', '|' and unicode", () => {
    for (const payload of ["v2|confirmed|-|1", "a.b.c", "héllo wörld"]) {
      expect(readSignedCookieValue(signCookieValue(payload, key), key)).toBe(payload);
    }
  });

  it("does not accept an empty payload (nothing to believe)", () => {
    expect(readSignedCookieValue(signCookieValue("", key), key)).toBeNull();
  });

  it("produces base64url parts only (cookie-safe) and a 256-bit tag", () => {
    const [encoded, tag] = signCookieValue("v2|confirmed|-|1", key).split(".");

    expect(encoded).toMatch(/^[A-Za-z0-9_-]+$/);
    expect(tag).toMatch(/^[A-Za-z0-9_-]{43}$/);
  });

  it("rejects a value signed with a different key", () => {
    expect(readSignedCookieValue(signCookieValue("payload", otherKey), key)).toBeNull();
  });

  it("rejects any alteration of the payload or the tag", () => {
    const value = signCookieValue("v2|expired|-|1", key);
    const [encoded, tag] = value.split(".");

    const forgedPayload = Buffer.from("v2|confirmed|-|1").toString("base64url");
    expect(readSignedCookieValue(`${forgedPayload}.${tag}`, key)).toBeNull();

    const flipped = (tag[0] === "A" ? "B" : "A") + tag.slice(1);
    expect(readSignedCookieValue(`${encoded}.${flipped}`, key)).toBeNull();
    expect(readSignedCookieValue(`${encoded}.${tag.slice(0, -1)}`, key)).toBeNull();
    expect(readSignedCookieValue(`${encoded}.${tag}x`, key)).toBeNull();
  });

  it("rejects an unsigned or malformed value without throwing", () => {
    for (const value of [
      undefined,
      "",
      "payload",
      "payload.",
      ".tag",
      "a.b.c",
      "v2.confirmed.-.1",
      "not base64url!.tag",
      `${Buffer.from("x").toString("base64url")}.not*base64url`,
    ]) {
      expect(readSignedCookieValue(value, key)).toBeNull();
    }
  });
});
