/**
 * Paging cursors of the account activity history. The list is keyset-paged on
 * `(occurred_at, id)` — the order it is shown in — so a cursor names the last
 * row of a page, and the next page is "everything older than that row". Unlike
 * an offset, it stays correct when rows are appended while the user pages.
 *
 * Cursors are opaque to the client but not secret: the server decodes them
 * strictly (`decodeAccountActivityCursor`) and only uses them inside the
 * signed-in user's own rows. A forged cursor can at most produce an empty
 * page. Strictness matters for another reason too: the decoded values are
 * written into a PostgREST filter expression, so nothing but a well-formed
 * timestamp and a positive integer may come out of here.
 */

export type AccountActivityCursor = {
  /** `occurred_at` of the last row shown, exactly as PostgREST returned it. */
  occurredAt: string;
  /** `id` of that row; breaks ties between rows with the same timestamp. */
  id: number;
};

/** A token is a short base64url string; anything longer is not one of ours. */
export const ACCOUNT_ACTIVITY_CURSOR_MAX_LENGTH = 128;

/**
 * ISO 8601 timestamp with optional fractional seconds and a zone designator,
 * as PostgREST serialises `timestamptz` (e.g. `2026-03-01T10:00:00.123456+00:00`).
 */
const TIMESTAMP = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d{1,6})?(Z|[+-]\d{2}:\d{2})$/;

export function isAccountActivityTimestamp(value: unknown): value is string {
  return (
    typeof value === "string" && TIMESTAMP.test(value) && !Number.isNaN(Date.parse(value))
  );
}

export function encodeAccountActivityCursor(cursor: AccountActivityCursor): string {
  return encodeToken(JSON.stringify({ t: cursor.occurredAt, i: cursor.id }));
}

/**
 * Inverse of `encodeAccountActivityCursor`; `null` for anything that is not a
 * token for a well-formed timestamp and a positive integer id, in the exact
 * form this code would emit.
 */
export function decodeAccountActivityCursor(
  token: unknown,
): AccountActivityCursor | null {
  const text = decodeToken(token, ACCOUNT_ACTIVITY_CURSOR_MAX_LENGTH);
  if (text === null) return null;

  let parsed: unknown;

  try {
    parsed = JSON.parse(text);
  } catch {
    return null;
  }

  if (parsed === null || typeof parsed !== "object") return null;

  const { t, i } = parsed as { t?: unknown; i?: unknown };

  if (!isAccountActivityTimestamp(t)) return null;
  if (typeof i !== "number" || !Number.isSafeInteger(i) || i < 1) return null;

  const cursor = { occurredAt: t, id: i };

  // Canonical form only: the token must be exactly what this code would emit.
  return encodeAccountActivityCursor(cursor) === token ? cursor : null;
}

/** base64url of ASCII text; `btoa`/`atob` exist in Node and browsers alike. */
function encodeToken(text: string): string {
  return btoa(text).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

/** Inverse of `encodeToken`; `null` unless `token` is a base64url string of at most `maxLength`. */
function decodeToken(token: unknown, maxLength: number): string | null {
  if (typeof token !== "string" || token.length === 0 || token.length > maxLength) {
    return null;
  }
  if (!/^[A-Za-z0-9_-]+$/.test(token)) return null;

  try {
    const base64 = token.replace(/-/g, "+").replace(/_/g, "/");
    return atob(base64 + "=".repeat((4 - (base64.length % 4)) % 4));
  } catch {
    return null;
  }
}
