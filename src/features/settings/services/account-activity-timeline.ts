import type { AccountActivityEntry } from "@/infrastructure/account-activity/list-account-activity";

import { formatUtcDay, utcDayKey } from "./format";

/** One day of the timeline: its entries, in the order they were given. */
export type AccountActivityDay = {
  /** "YYYY-MM-DD" (UTC), or "unknown" for entries whose time cannot be read. */
  key: string;
  /** "1 Mar 2026", or "Unknown date". */
  label: string;
  entries: AccountActivityEntry[];
};

export const UNKNOWN_DAY_KEY = "unknown";
export const UNKNOWN_DAY_LABEL = "Unknown date";

/**
 * Splits a newest-first list into its days (UTC — the same zone every
 * timestamp on the settings page is shown in, so a day never straddles two
 * headings and server and client render the same thing).
 *
 * Groups are runs of CONSECUTIVE entries with the same day: the list's order
 * is kept exactly as the server gave it, never re-sorted. A page appended
 * later that starts on the day the previous page ended on simply extends
 * that day's run.
 */
export function groupAccountActivityByDay(
  entries: AccountActivityEntry[],
): AccountActivityDay[] {
  const days: AccountActivityDay[] = [];

  for (const entry of entries) {
    const key = utcDayKey(entry.occurredAt) ?? UNKNOWN_DAY_KEY;
    const current = days[days.length - 1];

    if (current && current.key === key) {
      current.entries.push(entry);
    } else {
      days.push({
        key,
        label: formatUtcDay(entry.occurredAt) ?? UNKNOWN_DAY_LABEL,
        entries: [entry],
      });
    }
  }

  return days;
}
