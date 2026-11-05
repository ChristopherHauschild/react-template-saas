import type { ListSupportRequestsResult } from "./list-support-requests";
import type { SupportRequestStatus } from "./support-request";
import { SUPPORT_REQUEST_CATEGORY_LABELS } from "./support-request-copy";
import type { SupportRequest } from "./support-request-row";

/**
 * Pure pieces of the request history list, kept out of the component so they
 * can be tested directly. Type-only imports from the server-side services:
 * nothing here pulls server code into the browser bundle.
 */

export const SUPPORT_HISTORY_COPY = {
  title: "Your requests",
  description: {
    loading: "Loading your requests…",
    unavailable: "Your requests are unavailable right now.",
    empty: "Requests you send will be listed here.",
    list: "Requests you've sent, newest first.",
  },
  loadingAnnouncement: "Loading your requests…",
  empty: "You haven't sent any requests yet.",
  emptyHint: "When you send one with the form above, it will appear here.",
  unavailable: "We couldn't load your requests right now. Please try again in a moment.",
  retry: "Try again",
  retryPending: "Trying again…",
  loadOlder: "Load older requests",
  loadOlderPending: "Loading older requests…",
  reload: "Reload requests",
  reloadPending: "Reloading requests…",
  reloaded: "Reloaded your requests from the newest.",
  signInAgain: "Sign in again (opens a new tab)",
  end: "That's all of your requests.",
  emptyPageWithMore: "Nothing to show on this page; there may be older requests.",
  nothingToShow: "There are no requests this version of the app can show.",
  showMessage: "Show message",
  listLabel: "Your support requests",
} as const;

/** The shapes the history can take; each has its own copy and `data-history-state`. */
export type SupportHistoryState = "unavailable" | "empty" | "list";

export function supportHistoryState(
  initial: ListSupportRequestsResult,
): SupportHistoryState {
  if (!initial.ok) return "unavailable";
  return initial.requests.length === 0 && initial.nextCursor === null ? "empty" : "list";
}

/**
 * Identifies the first page the server rendered, so the list can tell a new
 * listing from a re-render of the same one. Ids alone are not enough here:
 * a request's status changes when support closes it, and a re-render that
 * says so must replace what is shown.
 */
export function firstPageKey(
  requests: SupportRequest[],
  nextCursor: string | null,
): string {
  return `${requests.map((r) => `${r.id}:${r.status ?? "?"}`).join(",")}|${nextCursor ?? ""}`;
}

/** Appends a page, keeping the first occurrence of an id (a response applied twice adds nothing). */
export function appendRequests(
  current: SupportRequest[],
  page: SupportRequest[],
): SupportRequest[] {
  const seen = new Set(current.map((request) => request.id));
  const added = page.filter((request) => !seen.has(request.id) && seen.add(request.id));

  return added.length === 0 ? current : [...current, ...added];
}

const plural = (n: number, singular: string, pluralForm: string) =>
  `${n} ${n === 1 ? singular : pluralForm}`;

/** What the live region says after a page was appended. */
export function loadedAnnouncement(added: number, shown: number, ended: boolean): string {
  const shownText = `${plural(shown, "request", "requests")} shown.`;
  const base =
    added === 0
      ? `No new requests. ${shownText}`
      : `Loaded ${plural(added, "older request", "older requests")}. ${shownText}`;

  return ended ? `${base} ${SUPPORT_HISTORY_COPY.end}` : base;
}

/** Label for a request's category; unknown to this version → a neutral word, never the raw value. */
export function categoryLabel(category: SupportRequest["category"]): string {
  return category === null ? "General" : SUPPORT_REQUEST_CATEGORY_LABELS[category];
}

export const STATUS_LABELS: Record<SupportRequestStatus, string> = {
  open: "Open",
  closed: "Closed",
};

/** Label for a request's status; unknown to this version → "Unknown", never a guess. */
export function statusLabel(status: SupportRequest["status"]): string {
  return status === null ? "Unknown" : STATUS_LABELS[status];
}

/** Deterministic on server and client (fixed locale and zone): no hydration mismatch. */
const UTC_FORMAT = new Intl.DateTimeFormat("en-GB", {
  dateStyle: "medium",
  timeStyle: "short",
  timeZone: "UTC",
});

/** "1 Mar 2026, 10:00 UTC", or null for a missing or unparsable timestamp. */
export function formatSentAt(iso: string): string | null {
  const date = new Date(iso);

  return Number.isNaN(date.getTime()) ? null : `${UTC_FORMAT.format(date)} UTC`;
}
