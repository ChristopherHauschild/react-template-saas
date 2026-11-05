import "server-only";

import type { SupabaseClient } from "@supabase/supabase-js";
import { z } from "zod";

import { createClient } from "@/infrastructure/auth/supabase/server";
import { type DateRange, dateRangeBounds } from "@/shared/utils/date-range";

import {
  type AccountActivityCursor,
  encodeAccountActivityCursor,
  isAccountActivityTimestamp,
} from "./cursor";
import {
  ACCOUNT_ACTIVITY_EVENT_SCHEMA,
  ACCOUNT_ACTIVITY_TABLE,
  type AccountActivityEvent,
} from "./events";

/** Page size when the caller does not say, and the most it may ask for. */
export const ACCOUNT_ACTIVITY_DEFAULT_LIMIT = 20;
export const ACCOUNT_ACTIVITY_MAX_LIMIT = 100;

/**
 * One history entry, ready for display. Crosses into client components, so it
 * carries the row id (for keys), the time, and the typed event — never the
 * user id.
 */
export type AccountActivityEntry = {
  id: number;
  /** ISO 8601, as stored by the server. */
  occurredAt: string;
  event: AccountActivityEvent;
};

/**
 * A stored row this version of the application cannot interpret: an event
 * type it does not know (written by a newer deployment) or details its schema
 * rejects. The settings card leaves these out (`listAccountActivity`); the
 * export lists them, so a "complete history" has no silent gaps. Only the
 * row's position and stored type are kept — its details failed validation, so
 * nothing vouches for what they contain, and they are never passed on.
 */
export type UnrecognisedAccountActivityEntry = {
  unrecognised: true;
  id: number;
  /** `occurred_at` as stored. */
  occurredAt: string;
  /** `event_type` as stored (the database constrains it to a dotted identifier). */
  eventType: string;
};

export type ListAccountActivityResult =
  | {
      ok: true;
      /** Newest first. */
      entries: AccountActivityEntry[];
      /**
       * Opaque token for the page after this one (pass it back as `before`
       * after decoding); `null` when nothing older exists.
       */
      nextCursor: string | null;
    }
  /** The history could not be read. Already logged. */
  | { ok: false };

export type ListAccountActivityOptions = {
  /** Page size, 1..`ACCOUNT_ACTIVITY_MAX_LIMIT`; `ACCOUNT_ACTIVITY_DEFAULT_LIMIT` if omitted. */
  limit?: number;
  /** Only rows older than this one (a decoded `nextCursor`); the first page if omitted. */
  before?: AccountActivityCursor;
  /** Injectable for tests; production callers use the cookie-based client. */
  supabase?: SupabaseClient;
};

/** The columns as PostgREST returns them. */
const rowSchema = z.object({
  id: z.number().int(),
  event_type: z.string(),
  details: z.unknown(),
  occurred_at: z.string(),
});

/** One row of a page, classified. Nothing read is dropped at this level. */
export type AccountActivityPageItem =
  | AccountActivityEntry
  | UnrecognisedAccountActivityEntry;

export type AccountActivityPage =
  | {
      ok: true;
      /** The page's rows that could be read, newest first, recognised or not. */
      items: AccountActivityPageItem[];
      /**
       * Rows of the page that could not be read at all (columns missing or of
       * the wrong type — impossible for rows the database's constraints
       * admitted, so a sign that something is badly wrong). Not in `items`.
       */
      malformed: number;
      /** Whether the database holds rows beyond this page. */
      hasMore: boolean;
      /**
       * Position of the page's last row, where the next page starts; `null`
       * when there is no next page OR the last row cannot name a position
       * (then `hasMore` is still true — callers must not mistake it for the end).
       */
      next: AccountActivityCursor | null;
    }
  | { ok: false };

export type ReadAccountActivityPageOptions = {
  /** Page size, 1..`ACCOUNT_ACTIVITY_MAX_LIMIT`; `ACCOUNT_ACTIVITY_DEFAULT_LIMIT` if omitted. */
  limit?: number;
  /** Only rows older than this position; the first page if omitted. */
  before?: AccountActivityCursor;
  /**
   * Only rows that occurred within these UTC days (validated by the caller;
   * see `isValidDateRange`). Applied in the query, so rows outside it are
   * never read and paging walks only the rows inside it.
   */
  range?: DateRange;
};

/**
 * Reads one page of the user's account activity and classifies every row:
 * an entry the catalogue recognises, an unrecognised one (kept, see
 * `UnrecognisedAccountActivityEntry`), or malformed (counted). The building
 * block of `listAccountActivity` (the settings card) and of the export, which
 * must not lose rows the card may leave out.
 *
 * Performed with `client`, which must be the USER's (cookie-based) client:
 * row level security restricts the read to the user's own rows, and the
 * explicit `user_id` filter states the intent in the query as well. `userId`
 * must be the id of the user the request was verified for (`requireAuth()`).
 *
 * Pages are keyed on `(occurred_at, id)`, the order rows are shown in: with
 * `before` set, only rows strictly older than that position are read, so a
 * row appended while the user pages can neither shift nor repeat what is
 * shown.
 *
 * Never throws: a failed read is logged and reported as `ok: false`.
 */
export async function readAccountActivityPage(
  client: SupabaseClient,
  userId: string,
  options: ReadAccountActivityPageOptions = {},
): Promise<AccountActivityPage> {
  const limit = clampLimit(options.limit);

  try {
    let query = client
      .from(ACCOUNT_ACTIVITY_TABLE)
      .select("id, event_type, details, occurred_at")
      .eq("user_id", userId);

    if (options.range) {
      // Half-open: from midnight of the first day to (not including)
      // midnight after the last, so no fraction of the last day is lost.
      const { start, end } = dateRangeBounds(options.range);

      if (start !== null) query = query.gte("occurred_at", new Date(start).toISOString());
      if (end !== null) query = query.lt("occurred_at", new Date(end).toISOString());
    }

    if (options.before) {
      query = query.or(olderThan(options.before));
    }

    const { data, error } = await query
      .order("occurred_at", { ascending: false })
      .order("id", { ascending: false })
      // One extra row tells us whether there is another page.
      .limit(limit + 1);

    if (error) {
      console.error("[account-activity] could not read history", {
        userId,
        error: { message: error.message, code: error.code },
      });
      return { ok: false };
    }

    const rows = Array.isArray(data) ? data : [];
    const page = rows.slice(0, limit);
    const items: AccountActivityPageItem[] = [];
    let malformed = 0;

    for (const raw of page) {
      const item = toItem(raw);

      if (item) {
        items.push(item);
      } else {
        malformed += 1;
      }
    }

    const hasMore = rows.length > limit;

    return {
      ok: true,
      items,
      malformed,
      hasMore,
      next: hasMore ? positionOf(page[page.length - 1], userId) : null,
    };
  } catch (thrown) {
    console.error("[account-activity] reading history threw unexpectedly", {
      userId,
      error: { name: thrown instanceof Error ? thrown.name : typeof thrown },
    });
    return { ok: false };
  }
}

/**
 * Reads the newest entries of the signed-in user's account activity, for the
 * settings card (see `readAccountActivityPage` for access and paging).
 *
 * `nextCursor` names the last row of the page — whether or not that row was
 * recognised — so paging always makes progress.
 *
 * Rows the catalogue does not recognise — an event type this version of the
 * application does not know, or details it cannot parse — are left out and
 * counted in a warning rather than failing the whole list: the history must
 * stay readable across deployments. (The export keeps them instead; see
 * `UnrecognisedAccountActivityEntry`.) Whether a next page exists is decided
 * on rows in the database, not on entries shown.
 *
 * Never throws: a failed read is logged and reported as `ok: false`, so the
 * page can say "unavailable" instead of crashing.
 */
export async function listAccountActivity(
  userId: string,
  options: ListAccountActivityOptions = {},
): Promise<ListAccountActivityResult> {
  let client: SupabaseClient;

  try {
    client = options.supabase ?? (await createClient());
  } catch (thrown) {
    console.error("[account-activity] reading history threw unexpectedly", {
      userId,
      error: { name: thrown instanceof Error ? thrown.name : typeof thrown },
    });
    return { ok: false };
  }

  const page = await readAccountActivityPage(client, userId, {
    limit: options.limit,
    before: options.before,
  });

  if (!page.ok) return page;

  const entries = page.items.filter(
    (item): item is AccountActivityEntry => !("unrecognised" in item),
  );
  const skipped = page.items.length - entries.length + page.malformed;

  if (skipped > 0) {
    console.warn("[account-activity] skipped entries the catalogue does not recognise", {
      userId,
      skipped,
    });
  }

  return {
    ok: true,
    entries,
    nextCursor: page.next === null ? null : encodeAccountActivityCursor(page.next),
  };
}

/**
 * PostgREST filter for "strictly older than the cursor's row" in the list's
 * order: `occurred_at < t`, or the same instant and a smaller id. The timestamp
 * is quoted for PostgREST's parser; the cursor decoder guarantees both values
 * are well-formed, so nothing else can end up in the expression.
 */
function olderThan(before: AccountActivityCursor): string {
  const t = `"${before.occurredAt}"`;

  return `occurred_at.lt.${t},and(occurred_at.eq.${t},id.lt.${before.id})`;
}

/** Position of `raw` (the last row of a page), or null if it cannot be named. */
function positionOf(raw: unknown, userId: string): AccountActivityCursor | null {
  const row = rowSchema.safeParse(raw);

  if (!row.success || !isAccountActivityTimestamp(row.data.occurred_at)) {
    // The card stops here rather than offering a page that cannot be asked
    // for; the export fails (`hasMore` is still true).
    console.error("[account-activity] last row of the page cannot form a cursor", {
      userId,
    });
    return null;
  }

  return { occurredAt: row.data.occurred_at, id: row.data.id };
}

function clampLimit(limit: number | undefined): number {
  if (limit === undefined || !Number.isFinite(limit)) {
    return ACCOUNT_ACTIVITY_DEFAULT_LIMIT;
  }

  return Math.min(Math.max(Math.floor(limit), 1), ACCOUNT_ACTIVITY_MAX_LIMIT);
}

/** A recognised entry, an unrecognised one, or `null` for a row that cannot be read at all. */
function toItem(raw: unknown): AccountActivityPageItem | null {
  const row = rowSchema.safeParse(raw);

  if (!row.success) return null;

  const event = ACCOUNT_ACTIVITY_EVENT_SCHEMA.safeParse({
    type: row.data.event_type,
    details: row.data.details,
  });

  if (!event.success) {
    return {
      unrecognised: true,
      id: row.data.id,
      occurredAt: row.data.occurred_at,
      eventType: row.data.event_type,
    };
  }

  return { id: row.data.id, occurredAt: row.data.occurred_at, event: event.data };
}
