import type { AccountActivityEvent } from "@/infrastructure/account-activity/events";

/** Entries per page on the settings card — first page and each "load older". */
export const ACCOUNT_ACTIVITY_PAGE_SIZE = 10;

/** What the card says when a further page could not be loaded. */
export const LOAD_MORE_ACTIVITY_COPY = {
  retry: "We couldn't load older activity right now. Please try again.",
  restart: "Your activity list is out of date. Reload the page to see the current list.",
} as const;

/** One entry as the card shows it: a heading line and an optional detail line. */
export type AccountActivityCopy = {
  title: string;
  detail: string | null;
};

/** Wraps a value in typographic quotes; names can hold any character, so the quotes delimit. */
const quote = (value: string) => `\u201C${value}\u201D`;

/**
 * Turns a catalogued event into the words the card shows. Exhaustive over the
 * catalogue: adding an event type without adding its copy is a type error, so
 * an entry can never be listed as a bare identifier.
 */
export function describeAccountActivity(
  event: AccountActivityEvent,
): AccountActivityCopy {
  switch (event.type) {
    case "profile.updated": {
      const { from, to } = event.details.changes.fullName;

      return {
        title: "Display name changed",
        detail:
          from === null ? `Set to ${quote(to)}.` : `From ${quote(from)} to ${quote(to)}.`,
      };
    }

    case "password.changed":
      return {
        title: "Password changed",
        // "Signed out" only when GoTrue confirmed it (see change-password.ts).
        // Otherwise it is not known either way — GoTrue may have ended them
        // anyway — so the wording claims neither.
        detail: event.details.otherSessionsSignedOut
          ? "Other sessions were signed out."
          : "Signing out other sessions could not be confirmed.",
      };

    case "sessions.others_signed_out":
      return {
        title: "Other sessions signed out",
        detail:
          "Every other browser and device signed in to this account was signed out.",
      };

    case "email.change_requested": {
      const { from, to, resend } = event.details;

      if (resend) {
        return { title: "Email change confirmation resent", detail: `To ${to}.` };
      }

      return {
        title: "Email change requested",
        detail: `${from === null ? `To ${to}` : `From ${from} to ${to}`}; not in effect until confirmed.`,
      };
    }

    case "email.changed":
      return {
        title: "Email address changed",
        detail: event.details.to === null ? null : `Now ${event.details.to}.`,
      };
  }
}
