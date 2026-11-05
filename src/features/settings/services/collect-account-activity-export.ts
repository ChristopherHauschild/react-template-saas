import "server-only";

import type { SupabaseClient } from "@supabase/supabase-js";

import type { AccountActivityCursor } from "@/infrastructure/account-activity/cursor";
import {
  ACCOUNT_ACTIVITY_MAX_LIMIT,
  readAccountActivityPage,
} from "@/infrastructure/account-activity/list-account-activity";
import { createClient } from "@/infrastructure/auth/supabase/server";
import {
  type DateRange,
  isInDateRange,
  isValidDateRange,
} from "@/shared/utils/date-range";

import type { AccountActivityExportEntry } from "./account-activity-export";

/** Rows per database read while exporting: the most one read may ask for. */
export const ACCOUNT_ACTIVITY_EXPORT_PAGE_SIZE = ACCOUNT_ACTIVITY_MAX_LIMIT;

/**
 * Most entries one export may hold. A history beyond it is refused as a
 * whole (`too_large`) rather than cut short: a truncated file would look
 * complete. Generous for a per-account change log; it exists so a single
 * request has a bounded number of reads and a bounded response.
 */
export const ACCOUNT_ACTIVITY_EXPORT_MAX_ENTRIES = 10_000;

export type AccountActivityExportCollection =
  | {
      ok: true;
      /** The whole history, newest first, unrecognised entries included. */
      entries: AccountActivityExportEntry[];
      /** How many of `entries` this version cannot describe (for the log/UI). */
      unrecognised: number;
    }
  | {
      ok: false;
      reason: /** The date range given is not a valid one; nothing was read. */
        | "invalid_range"
        /** A read failed (refused, network, client construction). Transient; retry. */
        | "read_failed"
        /** A row could not be read at all (or, with a range, its time could not be), so it could not be exported. */
        | "malformed_row"
        /** More rows exist, but the last row read cannot name where to continue. */
        | "unpageable"
        /** The same row came back twice, or a page made no progress. */
        | "inconsistent_paging"
        /** More than `ACCOUNT_ACTIVITY_EXPORT_MAX_ENTRIES` rows (in the range, if one is given). */
        | "too_large";
    };

export type CollectAccountActivityExportOptions = {
  /**
   * Only entries that occurred within these UTC days (both inclusive). Must
   * be valid (`parseDateRange` / `isValidDateRange`); anything else is refused
   * as `invalid_range` before a single row is read. Omitted: everything.
   */
  range?: DateRange;
  /** Injectable for tests; production callers use the cookie-based (user) client. */
  supabase?: SupabaseClient;
  /** Overrides `ACCOUNT_ACTIVITY_EXPORT_MAX_ENTRIES` (tests). */
  maxEntries?: number;
};

/**
 * Reads the signed-in user's ENTIRE account activity history for the export:
 * every page, every row — including rows this version cannot interpret,
 * which the settings card leaves out but an export must not.
 *
 * All or nothing. Any page that fails, any row that cannot be read, any sign
 * that paging is not advancing cleanly, or a history over the limit, and the
 * result is `ok: false` with no entries: a partial history must never be
 * offered as a file, because nothing in a CSV can say rows are missing.
 *
 * Access is the settings card's: every read is made AS THE USER with one
 * cookie-based client, so row level security confines it to their own rows,
 * and each query also filters on `userId`, which must be the id the request
 * was verified for (`requireAuth()`). No cursor or other input comes from the
 * client. Pages are keyed on `(occurred_at, id)`; rows recorded while the
 * export runs are newer than its first page and simply not included.
 *
 * With a `range`, the database applies it (`occurred_at` from midnight UTC
 * of the first day up to, not including, midnight after the last), so only
 * rows inside it are paged through — a range that matches nothing is an
 * empty, successful export. Each row is checked against the range again on
 * the way out: one outside it (which a correct query never returns) is left
 * out and counted, but never ends the scan; one whose time cannot be read
 * cannot be placed either way and fails the export. Every failure rule above
 * holds unchanged with a range.
 *
 * Never throws; failures are logged (counts and reasons, never row content).
 */
export async function collectAccountActivityForExport(
  userId: string,
  options: CollectAccountActivityExportOptions = {},
): Promise<AccountActivityExportCollection> {
  const maxEntries = options.maxEntries ?? ACCOUNT_ACTIVITY_EXPORT_MAX_ENTRIES;
  const fail = (
    reason: Extract<AccountActivityExportCollection, { ok: false }>["reason"],
    extra: Record<string, unknown> = {},
  ): AccountActivityExportCollection => {
    console.error("[settings] account activity export refused", {
      userId,
      reason,
      ...extra,
    });
    return { ok: false, reason };
  };

  const range = options.range;

  // Before anything is read: a malformed range must not reach the query.
  if (range !== undefined && !isValidDateRange(range)) return fail("invalid_range");

  let client: SupabaseClient;

  try {
    client = options.supabase ?? (await createClient());
  } catch (thrown) {
    return fail("read_failed", {
      error: { name: thrown instanceof Error ? thrown.name : typeof thrown },
    });
  }

  const entries: AccountActivityExportEntry[] = [];
  const seen = new Set<number>();
  let unrecognised = 0;
  let outOfRange = 0;
  let before: AccountActivityCursor | undefined;

  for (let pages = 1; ; pages++) {
    const page = await readAccountActivityPage(client, userId, {
      limit: ACCOUNT_ACTIVITY_EXPORT_PAGE_SIZE,
      before,
      range,
    });

    // The reader has logged the cause.
    if (!page.ok) return fail("read_failed", { pages });

    if (page.malformed > 0) {
      return fail("malformed_row", { pages, malformed: page.malformed });
    }

    for (const item of page.items) {
      if (seen.has(item.id)) return fail("inconsistent_paging", { pages });
      seen.add(item.id);

      if (range !== undefined) {
        const inside = isInDateRange(item.occurredAt, range);

        if (inside === null) return fail("malformed_row", { pages, malformed: 1 });
        if (!inside) {
          // Still counts as read (duplicates, progress, size), just not exported.
          outOfRange += 1;
          continue;
        }
      }

      entries.push(item);
      if ("unrecognised" in item) unrecognised += 1;
    }

    // Counted on rows READ, so a query that ignored the range cannot make the
    // export page through more than the limit either.
    if (seen.size > maxEntries) return fail("too_large", { pages, maxEntries });

    if (!page.hasMore) break;

    // More rows exist but nothing says where they start: stopping here would
    // silently drop them.
    if (page.next === null) return fail("unpageable", { pages });

    // A page that added nothing, or a position that did not move, would loop
    // or skip; neither can happen with keyset paging working as intended.
    if (
      page.items.length === 0 ||
      (before !== undefined &&
        before.id === page.next.id &&
        before.occurredAt === page.next.occurredAt)
    ) {
      return fail("inconsistent_paging", { pages });
    }

    before = page.next;
  }

  if (outOfRange > 0) {
    // The query should have excluded these; the export did, but say so.
    console.warn("[settings] account activity export left out rows outside the range", {
      userId,
      outOfRange,
    });
  }

  if (unrecognised > 0) {
    // Expected across deployments; worth knowing how often it happens.
    console.warn("[settings] account activity export includes unrecognised entries", {
      userId,
      unrecognised,
    });
  }

  return { ok: true, entries, unrecognised };
}
