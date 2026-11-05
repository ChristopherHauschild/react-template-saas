/**
 * The account activity history as a CSV download: the column layout and how
 * each entry becomes a row. Pure — collecting the entries (every page of the
 * signed-in user's own history) is the caller's job; this module only formats
 * what it is given, one row per entry, in the order given.
 *
 * Rows carry the same words the settings card shows (`describeAccountActivity`)
 * plus the event's stable identifier, so the file is readable by a person and
 * filterable by a program. No user id and no row id: the file holds what the
 * user can already see on the page, nothing more.
 */
import type {
  AccountActivityEntry,
  UnrecognisedAccountActivityEntry,
} from "@/infrastructure/account-activity/list-account-activity";
import { CSV_UTF8_BOM, type CsvCell, csvFileName, formatCsv } from "@/shared/utils/csv";

import { describeAccountActivity } from "./account-activity-copy";

/**
 * One row of the export: an entry the catalogue recognises, or one it does
 * not (listed with its time and stored type — never its details — so the
 * export has no silent gaps; see `UnrecognisedAccountActivityEntry`).
 */
export type AccountActivityExportEntry =
  | AccountActivityEntry
  | UnrecognisedAccountActivityEntry;

/** Column headings, in file order. */
export const ACCOUNT_ACTIVITY_EXPORT_COLUMNS = [
  "Time (UTC)",
  "Activity",
  "Details",
  "Event type",
] as const;

/** What the "Activity" and "Details" columns say for an entry this version cannot interpret. */
export const UNRECOGNISED_ACTIVITY_TITLE = "Unrecognised activity";
export const UNRECOGNISED_ACTIVITY_DETAIL =
  "Recorded for your account, but this version of the app cannot describe it.";

/** `account-activity-YYYY-MM-DD.csv`. */
export const ACCOUNT_ACTIVITY_EXPORT_FILE_BASE = "account-activity";

export function accountActivityExportFileName(now: Date): string {
  return csvFileName(ACCOUNT_ACTIVITY_EXPORT_FILE_BASE, now);
}

/**
 * A stored timestamp as ISO 8601 in UTC to the second —
 * `2026-03-01T10:00:00Z` — the zone the settings page uses for every time.
 * Sub-second digits are truncated, not rounded, so an entry never moves into
 * the next second (or day). A value that does not parse is kept as stored
 * rather than blanked: the row must still say when, as best it can.
 */
export function formatAccountActivityExportTime(occurredAt: string): string {
  const time = Date.parse(occurredAt);

  if (Number.isNaN(time)) return occurredAt;

  return new Date(time).toISOString().replace(/\.\d{3}Z$/, "Z");
}

/** One entry as a row, in `ACCOUNT_ACTIVITY_EXPORT_COLUMNS` order. */
export function accountActivityExportRow(entry: AccountActivityExportEntry): CsvCell[] {
  const time = formatAccountActivityExportTime(entry.occurredAt);

  if ("unrecognised" in entry) {
    return [
      time,
      UNRECOGNISED_ACTIVITY_TITLE,
      UNRECOGNISED_ACTIVITY_DETAIL,
      entry.eventType,
    ];
  }

  const { title, detail } = describeAccountActivity(entry.event);

  return [time, title, detail, entry.event.type];
}

/**
 * The complete file: UTF-8 BOM (the copy uses typographic quotes and may hold
 * accented names), header, and one row per entry in the order given (newest
 * first, as listed). An empty history is a header-only file.
 *
 * `entries` must be the user's COMPLETE history, unrecognised entries
 * included. A partial collection (a page failed, paging stopped early) must
 * not be turned into a file at all: nothing in a CSV could tell the user that
 * rows are missing.
 */
export function buildAccountActivityExportCsv(
  entries: readonly AccountActivityExportEntry[],
): string {
  return (
    CSV_UTF8_BOM +
    formatCsv(ACCOUNT_ACTIVITY_EXPORT_COLUMNS, entries.map(accountActivityExportRow))
  );
}
