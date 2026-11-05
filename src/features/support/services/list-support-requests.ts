import "server-only";

import type { SupabaseClient } from "@supabase/supabase-js";

import { createClient } from "@/infrastructure/auth/supabase/server";

import { SUPPORT_REQUESTS_TABLE } from "./support-request";
import {
  encodeSupportRequestCursor,
  isSupportRequestId,
  isSupportRequestTimestamp,
  type SupportRequestCursor,
} from "./support-request-cursor";
import {
  summarizeSupportRequestError,
  type SupportRequestFailure,
  toSupportRequestFailure,
} from "./support-request-errors";
import {
  SUPPORT_REQUEST_SELECT,
  type SupportRequest,
  toSupportRequest,
} from "./support-request-row";

/** Page size when the caller does not say, and the most it may ask for. */
export const SUPPORT_REQUESTS_DEFAULT_LIMIT = 10;
export const SUPPORT_REQUESTS_MAX_LIMIT = 100;

export type ListSupportRequestsResult =
  | {
      ok: true;
      /** Newest first. */
      requests: SupportRequest[];
      /**
       * Opaque token for the page after this one (pass it back as `before`
       * after decoding); `null` when nothing older exists.
       */
      nextCursor: string | null;
    }
  /** The list could not be read. Already logged. */
  | { ok: false; failure: SupportRequestFailure };

export type ListSupportRequestsOptions = {
  /** Page size, 1..`SUPPORT_REQUESTS_MAX_LIMIT`; `SUPPORT_REQUESTS_DEFAULT_LIMIT` if omitted. */
  limit?: number;
  /** Only rows older than this one (a decoded `nextCursor`); the first page if omitted. */
  before?: SupportRequestCursor;
  /** Injectable for tests; production callers use the cookie-based client. */
  supabase?: SupabaseClient;
};

/**
 * Reads a page of the signed-in user's support requests, newest first.
 *
 * Performed AS THE USER (cookie-based client), never with the service role:
 * row level security confines the read to their own rows, and the explicit
 * `user_id` filter states the same intent in the query — two independent
 * reasons why one user can never see another's requests. `userId` must be the
 * id the request was verified for (`requireAuth()`).
 *
 * Pages are keyset-paged on `(created_at, id)`, the order rows are shown in:
 * with `before` set, only rows strictly older than that position are read, so
 * a request filed while the user pages can neither shift nor repeat what is
 * already on screen. `nextCursor` names the last row of the page, so paging
 * always makes progress.
 *
 * A row that cannot be displayed at all is left out and counted in a warning
 * rather than failing the page; one unreadable row must not hide the rest of
 * a user's history. Whether a next page exists is decided on rows in the
 * database, not on rows shown.
 *
 * Never throws: a failed read is logged and reported as `ok: false`, so the
 * page can say "unavailable" instead of crashing.
 */
export async function listSupportRequests(
  userId: string,
  options: ListSupportRequestsOptions = {},
): Promise<ListSupportRequestsResult> {
  const limit = clampLimit(options.limit);

  try {
    const client = options.supabase ?? (await createClient());

    let query = client
      .from(SUPPORT_REQUESTS_TABLE)
      .select(SUPPORT_REQUEST_SELECT)
      .eq("user_id", userId);

    if (options.before) {
      query = query.or(olderThan(options.before));
    }

    const { data, error } = await query
      .order("created_at", { ascending: false })
      .order("id", { ascending: false })
      // One extra row tells us whether there is another page.
      .limit(limit + 1);

    if (error) {
      const failure = toSupportRequestFailure(error);

      console.error("[support] could not read requests", {
        userId,
        failure,
        error: summarizeSupportRequestError(error),
      });

      return { ok: false, failure };
    }

    const rows = Array.isArray(data) ? data : [];
    const page = rows.slice(0, limit);
    const requests: SupportRequest[] = [];
    let skipped = 0;

    for (const raw of page) {
      const request = toSupportRequest(raw);

      if (request) {
        requests.push(request);
      } else {
        skipped += 1;
      }
    }

    if (skipped > 0) {
      console.warn("[support] skipped rows that cannot be displayed", {
        userId,
        skipped,
      });
    }

    const nextCursor = rows.length > limit ? nextCursorFor(page, userId) : null;

    return { ok: true, requests, nextCursor };
  } catch (thrown) {
    console.error("[support] reading requests threw unexpectedly", {
      userId,
      error: { name: thrown instanceof Error ? thrown.name : typeof thrown },
    });

    return { ok: false, failure: "unavailable" };
  }
}

/**
 * PostgREST filter for "strictly older than the cursor's row" in the list's
 * order: `created_at < t`, or the same instant and a smaller id. Values are
 * quoted for PostgREST's parser; the cursor decoder guarantees both are
 * well-formed (a timestamp and a UUID), so nothing else can end up in the
 * expression.
 */
function olderThan(before: SupportRequestCursor): string {
  const t = `"${before.createdAt}"`;

  return `created_at.lt.${t},and(created_at.eq.${t},id.lt.${before.id})`;
}

/**
 * Cursor for the page after `page`: the position of its last row.
 *
 * A row whose position is unusable (a mangled id or timestamp) must not end
 * paging — everything older than it would become unreachable — so the search
 * walks back to the newest row that can form one. The next page then re-reads
 * the rows in between, which are skipped again; that costs a few rows and
 * always makes progress. Only a page with no usable position at all stops the
 * list, which is logged.
 */
function nextCursorFor(page: unknown[], userId: string): string | null {
  for (let index = page.length - 1; index >= 0; index--) {
    const row = page[index] as { id?: unknown; created_at?: unknown } | null;

    if (isSupportRequestTimestamp(row?.created_at) && isSupportRequestId(row?.id)) {
      if (index !== page.length - 1) {
        console.warn("[support] paging from an earlier row of the page", {
          userId,
          skipped: page.length - 1 - index,
        });
      }

      return encodeSupportRequestCursor({ createdAt: row.created_at, id: row.id });
    }
  }

  // Nothing on this page can be paged from: stop rather than offer a page that
  // cannot be asked for, or one that would repeat this page forever.
  console.error("[support] no row of the page can form a cursor", { userId });

  return null;
}

function clampLimit(limit: number | undefined): number {
  if (limit === undefined || !Number.isFinite(limit)) {
    return SUPPORT_REQUESTS_DEFAULT_LIMIT;
  }

  return Math.min(Math.max(Math.floor(limit), 1), SUPPORT_REQUESTS_MAX_LIMIT);
}
