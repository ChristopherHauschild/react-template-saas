import "server-only";

import { createHmac, hkdfSync, timingSafeEqual } from "node:crypto";

import { serverEnv } from "@/config/env.server";

/**
 * Authenticated cookie values: `<payload>.<HMAC-SHA256(payload)>`, both
 * base64url. Anything this app needs to believe later — but cannot verify
 * against a backend — travels like this, so a value that was not produced by
 * this server (typed, copied from another browser, edited in DevTools, set by
 * a sibling subdomain) is rejected before its contents are even parsed.
 *
 * Keys are derived per purpose with HKDF, so a signature for one kind of cookie
 * can never be replayed as another kind, and none of them is the secret itself.
 * The input key material is `APP_SECRET`, or — so a default local setup works
 * with no extra configuration — the Supabase service-role key, which every
 * deployment already has. The derived key is not reversible to either.
 */
const HKDF_SALT = "react-template-saas/signed-cookie/v1";
const KEY_BYTES = 32;

const keys = new Map<string, Buffer>();

/** A 32-byte signing key for one purpose; the same purpose always yields the same key. */
export function signingKeyFor(purpose: string): Buffer {
  const cached = keys.get(purpose);
  if (cached) return cached;

  const ikm = serverEnv.APP_SECRET ?? serverEnv.SUPABASE_SERVICE_ROLE_KEY;
  const key = Buffer.from(hkdfSync("sha256", ikm, HKDF_SALT, purpose, KEY_BYTES));

  keys.set(purpose, key);

  return key;
}

function mac(payload: string, key: Uint8Array): Buffer {
  return createHmac("sha256", key).update(payload).digest();
}

/** `payload` must not contain "."; it is stored as base64url anyway. */
export function signCookieValue(payload: string, key: Uint8Array): string {
  const encoded = Buffer.from(payload, "utf8").toString("base64url");

  return `${encoded}.${mac(encoded, key).toString("base64url")}`;
}

/**
 * The payload of a value produced by {@link signCookieValue} with the same key,
 * or null. Constant-time comparison; no exceptions for garbage input.
 */
export function readSignedCookieValue(
  value: string | undefined,
  key: Uint8Array,
): string | null {
  if (!value) return null;

  const parts = value.split(".");
  if (parts.length !== 2) return null;

  const [encoded, signature] = parts;
  if (!/^[A-Za-z0-9_-]+$/.test(encoded) || !/^[A-Za-z0-9_-]+$/.test(signature))
    return null;

  const expected = mac(encoded, key);
  const given = Buffer.from(signature, "base64url");

  if (given.length !== expected.length || !timingSafeEqual(given, expected)) return null;

  return Buffer.from(encoded, "base64url").toString("utf8");
}

/** Test seam: forget derived keys (e.g. after changing the mocked environment). */
export function resetSigningKeysForTests() {
  keys.clear();
}
