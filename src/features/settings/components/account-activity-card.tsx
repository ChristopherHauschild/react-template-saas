"use client";

import { useEffect, useRef, useState, useTransition } from "react";
import Link from "next/link";

import {
  KeyRound,
  type LucideIcon,
  MailCheck,
  MailPlus,
  MonitorOff,
  UserPen,
} from "lucide-react";

import { ROUTES } from "@/config/routes";
import type { AccountActivityEventType } from "@/infrastructure/account-activity/events";
import type {
  AccountActivityEntry,
  ListAccountActivityResult,
} from "@/infrastructure/account-activity/list-account-activity";
import { Button } from "@/shared/components/ui/button";
import {
  Card,
  CardContent,
  CardDescription,
  CardFooter,
  CardHeader,
  CardTitle,
} from "@/shared/components/ui/card";
import { cn } from "@/shared/utils/cn";

import {
  loadMoreAccountActivity,
  type LoadMoreAccountActivityResult,
} from "../actions/load-more-account-activity";
import {
  describeAccountActivity,
  LOAD_MORE_ACTIVITY_COPY,
} from "../services/account-activity-copy";
import {
  type AccountActivityDay,
  groupAccountActivityByDay,
} from "../services/account-activity-timeline";
import { formatUtcTime } from "../services/format";

export const LOAD_OLDER_LABEL = "Load older activity";
export const LOAD_OLDER_PENDING_LABEL = "Loading older activity…";
export const END_OF_ACTIVITY_TEXT = "That's all of your activity.";
export const EMPTY_ACTIVITY_TEXT = "No activity yet.";
export const EMPTY_ACTIVITY_HINT =
  "Changes to your account — like updating your display name — will be listed here.";
export const EMPTY_PAGE_WITH_MORE_TEXT =
  "Nothing to show on this page yet; there may be older activity.";
export const NOTHING_TO_SHOW_TEXT =
  "There is no activity this version of the app can show.";
export const RELOAD_LABEL = "Reload activity";
export const UNAVAILABLE_ACTIVITY_TEXT =
  "We couldn't load your account activity right now. Please try again in a moment.";

/**
 * One icon per event type, so a glance tells profile, password, session and
 * email events apart. Decorative: the entry's text carries the meaning. The
 * `name` is what tests and `data-activity-icon` see.
 */
export const ACTIVITY_ICONS: Record<
  AccountActivityEventType,
  { icon: LucideIcon; name: string }
> = {
  "profile.updated": { icon: UserPen, name: "profile" },
  "password.changed": { icon: KeyRound, name: "password" },
  "sessions.others_signed_out": { icon: MonitorOff, name: "sessions" },
  "email.change_requested": { icon: MailPlus, name: "email-requested" },
  "email.changed": { icon: MailCheck, name: "email-changed" },
};

/** The card's shapes; each has its own copy and `data-activity-state`. */
export type AccountActivityState = "unavailable" | "empty" | "list";

export function accountActivityState(
  initial: ListAccountActivityResult,
): AccountActivityState {
  if (!initial.ok) return "unavailable";
  return initial.entries.length === 0 && initial.nextCursor === null ? "empty" : "list";
}

const DESCRIPTION: Record<AccountActivityState, string> = {
  unavailable: "Your account activity is unavailable right now.",
  empty: "Changes to your account will be listed here.",
  list: "Changes to your account, newest first.",
};

const plural = (n: number, singular: string, pluralForm: string) =>
  `${n} ${n === 1 ? singular : pluralForm}`;

/** What the live region says after a page was appended. */
export function loadedAnnouncement(added: number, shown: number): string {
  const shownText = plural(shown, "entry", "entries");

  return added === 0
    ? `No new entries. ${shownText} shown.`
    : `Loaded ${plural(added, "older entry", "older entries")}. ${shownText} shown.`;
}

/**
 * Identifies the first page the server rendered, so the list can tell a new
 * listing from a re-render of the same one. Entries are append-only and ids
 * are unique, so the ids plus the next cursor pin the page down.
 */
export function firstPageKey(
  entries: AccountActivityEntry[],
  nextCursor: string | null,
): string {
  return `${entries.map((entry) => entry.id).join(",")}|${nextCursor ?? ""}`;
}

/** Appends a page, keeping the first occurrence of an id (a response applied twice adds nothing). */
export function appendEntries(
  current: AccountActivityEntry[],
  page: AccountActivityEntry[],
): AccountActivityEntry[] {
  const seen = new Set(current.map((entry) => entry.id));
  const added = page.filter((entry) => !seen.has(entry.id) && seen.add(entry.id));

  return added.length === 0 ? current : [...current, ...added];
}

type Props = {
  /** The first page, as the settings page loaded it; `ok: false` when it could not. */
  initial: ListAccountActivityResult;
};

type Failure = { message: string; restart: boolean };

/**
 * The settings page's account activity: what changed on the account, newest
 * first, with "load older" paging.
 *
 * The shapes must never be confused with each other:
 * - the history could not be read → "unavailable", with a way to retry and no
 *   claim about what did or did not happen; the rest of the settings page is
 *   unaffected (the page hands in the failure, it does not throw);
 * - nothing recorded yet → an empty state that says what will appear;
 * - a list — paged by this component. "Empty" is only claimed when the server
 *   says nothing older exists.
 *
 * The first page comes from the server render; older pages are appended
 * through the `loadMoreAccountActivity` action, which verifies the session
 * again on every call — the client sends nothing but the cursor it was given.
 *
 * The first page is also how the card stays current: every settings action
 * that records an event revalidates the route, so the page re-renders and
 * hands in a new first page. The list is keyed by that page (`firstPageKey`),
 * so a new one replaces what is shown — including any older pages that were
 * loaded, which the user can load again — while a re-render with the same
 * page leaves the list, its loaded pages and its status untouched.
 *
 * While paging: one request at a time (the button is `aria-disabled` and busy,
 * not `disabled`, so keyboard focus stays put; a click that slips through is
 * ignored by an in-flight guard); no duplicates (pages are appended by id);
 * no stale data (a response is applied only if it answers the cursor the list
 * is waiting on); failures keep what is on screen and offer a retry, or — when
 * a retry cannot help because the cursor itself is no longer valid — replace
 * the button with a reload of the page, which brings a fresh first page; and a
 * single, always-mounted live region tells screen readers what happened — at
 * the end of the list, focus moves to it, since the button is gone.
 */
export function AccountActivityCard({ initial }: Props) {
  const state = accountActivityState(initial);

  return (
    <Card data-settings-section="activity" data-activity-state={state}>
      <CardHeader>
        <CardTitle asChild>
          <h3>Account activity</h3>
        </CardTitle>
        <CardDescription>{DESCRIPTION[state]}</CardDescription>
      </CardHeader>

      {state === "unavailable" ? (
        <>
          <CardContent>
            <p role="alert" className="text-sm text-red-600 dark:text-red-400">
              {UNAVAILABLE_ACTIVITY_TEXT}
            </p>
          </CardContent>
          <CardFooter>
            <Button asChild variant="outline">
              <Link href={ROUTES.settings}>Try again</Link>
            </Button>
          </CardFooter>
        </>
      ) : state === "empty" ? (
        <CardContent>
          <p className="text-sm text-muted-foreground">
            <span className="font-medium text-foreground">{EMPTY_ACTIVITY_TEXT}</span>{" "}
            {EMPTY_ACTIVITY_HINT}
          </p>
        </CardContent>
      ) : (
        initial.ok && (
          <AccountActivityList
            key={firstPageKey(initial.entries, initial.nextCursor)}
            initialEntries={initial.entries}
            initialCursor={initial.nextCursor}
          />
        )
      )}
    </Card>
  );
}

function AccountActivityList({
  initialEntries,
  initialCursor,
}: {
  initialEntries: AccountActivityEntry[];
  initialCursor: string | null;
}) {
  const [entries, setEntries] = useState(initialEntries);
  const [nextCursor, setNextCursor] = useState(initialCursor);
  const [failure, setFailure] = useState<Failure | null>(null);
  const [announcement, setAnnouncement] = useState<string | null>(null);
  const [reachedEnd, setReachedEnd] = useState(false);
  const [pending, startTransition] = useTransition();
  const inFlight = useRef<string | null>(null);
  const statusRef = useRef<HTMLParagraphElement>(null);

  // The button unmounts when the list ends; land keyboard focus on the message
  // that replaces it rather than letting it fall back to the document.
  useEffect(() => {
    if (reachedEnd) statusRef.current?.focus({ preventScroll: true });
  }, [reachedEnd]);

  const loadOlder = () => {
    const cursor = nextCursor;

    if (cursor === null || inFlight.current !== null) return;
    inFlight.current = cursor;
    setFailure(null);

    startTransition(async () => {
      let result: LoadMoreAccountActivityResult;

      try {
        result = await loadMoreAccountActivity(cursor);
      } catch {
        // The action itself failed (network, an unexpected server error). The
        // entries on screen are still correct; only this page is missing.
        result = {
          ok: false,
          cursor,
          error: LOAD_MORE_ACTIVITY_COPY.retry,
          restart: false,
        };
      }

      inFlight.current = null;

      // After an `await` React no longer knows these updates belong to the
      // transition; wrapping them again keeps entries, status and the pending
      // flag committing together.
      startTransition(() => {
        if (result.cursor !== cursor) {
          // Not an answer to the page this list asked for; must not be appended.
          setFailure({ message: LOAD_MORE_ACTIVITY_COPY.retry, restart: false });
          return;
        }

        if (!result.ok) {
          setFailure({ message: result.error, restart: result.restart });
          return;
        }

        const merged = appendEntries(entries, result.entries);
        const ended = result.nextCursor === null;

        setEntries(merged);
        setNextCursor(result.nextCursor);
        setReachedEnd(ended);
        setAnnouncement(
          ended
            ? `${loadedAnnouncement(merged.length - entries.length, merged.length)} ${END_OF_ACTIVITY_TEXT}`
            : loadedAnnouncement(merged.length - entries.length, merged.length),
        );
      });
    });
  };

  const status = pending ? LOAD_OLDER_PENDING_LABEL : (announcement ?? "");

  return (
    <>
      <CardContent className="space-y-4">
        {entries.length > 0 ? (
          <AccountActivityTimeline entries={entries} />
        ) : nextCursor !== null ? (
          // The pages so far held nothing this version can show, but older
          // entries exist: offer them rather than declare the history empty.
          <p
            className="text-sm text-muted-foreground"
            data-activity-page="empty-with-more"
          >
            {EMPTY_PAGE_WITH_MORE_TEXT}
          </p>
        ) : (
          // Paged to the end and nothing was recognised: entries exist (the
          // server said so), they just cannot be shown — not "no activity".
          <p className="text-sm text-muted-foreground" data-activity-page="empty-at-end">
            {NOTHING_TO_SHOW_TEXT}
          </p>
        )}

        <p
          ref={statusRef}
          role="status"
          aria-live="polite"
          aria-atomic="true"
          tabIndex={-1}
          className={cn(
            "text-xs text-muted-foreground outline-none",
            status === "" && "sr-only",
          )}
        >
          {status}
        </p>
      </CardContent>

      {nextCursor !== null && (
        <CardFooter className="flex-col items-start gap-3">
          {failure?.restart ? (
            // Asking for the same page again cannot help; a fresh page can.
            <Button asChild variant="outline" className="min-h-11 sm:min-h-8">
              <Link href={ROUTES.settings}>{RELOAD_LABEL}</Link>
            </Button>
          ) : (
            <Button
              type="button"
              variant="outline"
              onClick={loadOlder}
              aria-disabled={pending || undefined}
              aria-busy={pending || undefined}
              className="min-h-11 aria-disabled:cursor-wait aria-disabled:opacity-70 sm:min-h-8"
            >
              {pending ? LOAD_OLDER_PENDING_LABEL : LOAD_OLDER_LABEL}
            </Button>
          )}

          {failure && (
            <p role="alert" className="text-sm text-red-600 dark:text-red-400">
              {failure.message}
            </p>
          )}
        </CardFooter>
      )}
    </>
  );
}

/**
 * The entries as a vertical timeline: one node per event on a single line,
 * grouped under the day they happened (UTC, like every time on this page).
 *
 * The line is drawn piecewise — a connector below each day label and each
 * node except the very last — so it spans exactly the gaps between nodes and
 * ends at the last one. Every vertical gap is the same (`space-y-4` at all
 * three levels) so the connectors (`after:-bottom-4` / `after:h-4`) meet
 * without seams. Columns: the spine and nodes live in a 2rem gutter (`pl-10`
 * on text); nodes are 2rem wide so their centre sits on the line at 1rem.
 *
 * Layout is the same on a phone, single column; only the time moves next to
 * the text from `sm` up, as on the rest of the settings page.
 */
function AccountActivityTimeline({ entries }: { entries: AccountActivityEntry[] }) {
  const days = groupAccountActivityByDay(entries);

  return (
    <ol
      className="space-y-4"
      aria-label="Account activity"
      data-activity-layout="timeline"
    >
      {days.map((day, dayIndex) => (
        <AccountActivityDayGroup
          // Groups are runs, never merged, so a day could in principle recur;
          // the first entry's id keeps keys unique regardless.
          key={`${day.key}:${day.entries[0].id}`}
          day={day}
          last={dayIndex === days.length - 1}
        />
      ))}
    </ol>
  );
}

function AccountActivityDayGroup({
  day,
  last,
}: {
  day: AccountActivityDay;
  /** The last day shown: its last entry ends the line. */
  last: boolean;
}) {
  return (
    <li className="space-y-4" data-activity-day={day.key}>
      <h4
        className={cn(
          "relative pl-10 text-xs leading-4 font-semibold tracking-wide text-muted-foreground uppercase",
          // The day's marker on the line, and the connector down to its first entry.
          "before:absolute before:top-1/2 before:left-4 before:size-2 before:-translate-x-1/2 before:-translate-y-1/2 before:rounded-full before:bg-border",
          "after:absolute after:top-full after:left-4 after:h-4 after:w-px after:bg-border",
        )}
      >
        {day.label}
      </h4>

      <ol className="space-y-4" aria-label={`Activity on ${day.label}`}>
        {day.entries.map((entry, index) => (
          <AccountActivityNode
            key={entry.id}
            entry={entry}
            connect={!(last && index === day.entries.length - 1)}
          />
        ))}
      </ol>
    </li>
  );
}

function AccountActivityNode({
  entry,
  connect,
}: {
  entry: AccountActivityEntry;
  /** Whether the line continues below this node (false for the last one). */
  connect: boolean;
}) {
  const { title, detail } = describeAccountActivity(entry.event);
  const { icon: Icon, name } = ACTIVITY_ICONS[entry.event.type];
  const when = formatUtcTime(entry.occurredAt);

  return (
    <li
      className={cn(
        "relative flex flex-col gap-1 pl-10 sm:flex-row sm:items-start sm:justify-between sm:gap-4",
        connect &&
          "after:absolute after:top-8 after:-bottom-4 after:left-4 after:w-px after:bg-border",
      )}
      data-activity-event={entry.event.type}
    >
      <span
        aria-hidden="true"
        data-activity-icon={name}
        className="absolute top-0 left-0 flex size-8 items-center justify-center rounded-full border border-border bg-card text-muted-foreground"
      >
        <Icon size={16} />
      </span>

      {/* `pt-1.5` centres the first text line (1.25rem tall) on the 2rem node. */}
      <div className="min-w-0 space-y-0.5 pt-1.5">
        <p className="text-sm font-medium">{title}</p>
        {detail && (
          <p className="text-sm text-muted-foreground [overflow-wrap:anywhere]">
            {detail}
          </p>
        )}
      </div>

      <p className="shrink-0 text-xs text-muted-foreground sm:pt-2 sm:text-right">
        {when ? <time dateTime={entry.occurredAt}>{when}</time> : "Unknown time"}
      </p>
    </li>
  );
}
