"use client";

import { useEffect, useId, useRef, useState, useTransition } from "react";

import { ROUTES } from "@/config/routes";
import { Badge } from "@/shared/components/ui/badge";
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
  loadMoreSupportRequests,
  type LoadMoreSupportRequestsResult,
} from "../actions/load-more-support-requests";
import { reloadSupportRequests } from "../actions/reload-support-requests";
import type { ListSupportRequestsResult } from "../services/list-support-requests";
import {
  SUPPORT_REQUEST_ERRORS,
  type SupportRequestFailure,
} from "../services/support-request-errors";
import {
  appendRequests,
  categoryLabel,
  firstPageKey,
  formatSentAt,
  loadedAnnouncement,
  statusLabel,
  SUPPORT_HISTORY_COPY as COPY,
  supportHistoryState,
} from "../services/support-request-history";
import type { SupportRequest } from "../services/support-request-row";

type Props = {
  /** The first page, as the server loaded it; `ok: false` when it could not. */
  initial: ListSupportRequestsResult;
  /**
   * The account this list belongs to (the user it was rendered for). Sent
   * with every further read, which the server refuses if the session now
   * belongs to someone else — so another account's requests never enter it.
   */
  ownerId: string;
};

/**
 * Reads the first page again through the non-redirecting action; a failure
 * to reach the server at all (network) is reported like any other outage.
 */
async function fetchFirstPage(ownerId: string): Promise<ListSupportRequestsResult> {
  try {
    return await reloadSupportRequests(ownerId);
  } catch {
    return { ok: false, failure: "unavailable" };
  }
}

/** What the list says when the first page could not be read, by reason. */
function FirstPageFailure({ failure }: { failure: SupportRequestFailure }) {
  if (failure === "sessionExpired" || failure === "accountChanged") {
    return (
      <>
        <p>
          {failure === "sessionExpired"
            ? SUPPORT_REQUEST_ERRORS.listSessionExpired
            : SUPPORT_REQUEST_ERRORS.listAccountChanged}
        </p>
        <SignInAgainLink />
      </>
    );
  }

  return <p>{COPY.unavailable}</p>;
}

/** Identifies a server-rendered result, including failures, for the keys below. */
const resultKey = (result: ListSupportRequestsResult) =>
  result.ok
    ? firstPageKey(result.requests, result.nextCursor)
    : `failed:${result.failure}`;

/**
 * The support page's history: the requests the user has sent, newest first,
 * with "load older" paging.
 *
 * Three shapes that must never be confused:
 * - the history could not be read → "unavailable", with a retry and no claim
 *   about what the user has or has not sent (and, when the session has ended,
 *   a way to sign in again);
 * - nothing sent yet → an empty state that says where requests will appear;
 * - a list, paged by this component. "Empty" is only claimed when the server
 *   says nothing older exists.
 *
 * NOTHING HERE NAVIGATES. The form above may hold an unsent request, and any
 * navigation — a redirect to the login page, a route refresh that runs the
 * `(protected)` guard — would take it away. So retrying and reloading go
 * through Server Actions that never redirect (`reloadSupportRequests`,
 * `loadMoreSupportRequests`); an ended session is reported in place with a
 * link that signs in in a NEW tab, after which the same button simply works.
 * (The form also keeps a copy of its draft in the tab, for navigations that
 * do not start here.)
 *
 * ONE ACCOUNT PER LIST. The list belongs to the account it was rendered for
 * (`ownerId`), and every further read carries that account; the server
 * refuses it if the session has since changed hands (someone signed in as
 * another user, e.g. in another tab), and the list says so instead of showing
 * the other account's requests. The page keys this component by the account,
 * so a re-render for a different account starts a fresh list.
 *
 * Staying current. Filing a request revalidates the support route, so the
 * server re-renders this section and hands in a new first page. The list is
 * keyed by that page (`firstPageKey`: ids, statuses, cursor), so a new page
 * replaces what is shown, while a re-render with the same page leaves the
 * list, its loaded pages and its status untouched. A page fetched here by
 * "Try again" is shown until the server hands in a different one.
 *
 * Paging: one request at a time (buttons are `aria-disabled` and busy, not
 * `disabled`, so keyboard focus stays on them; clicks that slip through are
 * ignored by an in-flight guard); no duplicates (pages are appended by id); no
 * stale data (a response is applied only if it answers the cursor the list is
 * waiting on); failures keep what is on screen. One always-mounted live region
 * says what happened; at the end of the list focus moves to it.
 */
export function SupportRequestHistory({ initial, ownerId }: Props) {
  const id = useId();
  const titleId = `${id}-title`;

  // A first page fetched by "Try again", valid only for the server render it
  // replaced: when the server hands in a new result, that one wins.
  const serverKey = resultKey(initial);
  const [retried, setRetried] = useState<{
    serverKey: string;
    page: ListSupportRequestsResult;
  } | null>(null);
  const current = retried?.serverKey === serverKey ? retried.page : initial;
  const state = supportHistoryState(current);

  const [retrying, startRetry] = useTransition();
  const retryInFlight = useRef(false);

  const retry = () => {
    if (retryInFlight.current) return;
    retryInFlight.current = true;

    startRetry(async () => {
      const page = await fetchFirstPage(ownerId);
      retryInFlight.current = false;
      startRetry(() => setRetried({ serverKey, page }));
    });
  };

  return (
    <Card
      data-support-section="history"
      data-history-state={state}
      aria-labelledby={titleId}
      role="region"
    >
      <CardHeader>
        <CardTitle asChild>
          <h3 id={titleId}>{COPY.title}</h3>
        </CardTitle>
        <CardDescription>{COPY.description[state]}</CardDescription>
      </CardHeader>

      {!current.ok ? (
        <>
          <CardContent>
            <div
              role="alert"
              className="space-y-1 text-sm text-red-600 dark:text-red-400"
            >
              <FirstPageFailure failure={current.failure} />
            </div>
          </CardContent>
          <CardFooter>
            <BusyButton
              busy={retrying}
              onClick={retry}
              label={COPY.retry}
              busyLabel={COPY.retryPending}
            />
          </CardFooter>
        </>
      ) : state === "empty" ? (
        <CardContent>
          <p className="text-sm text-muted-foreground" data-history-empty>
            <span className="font-medium text-foreground">{COPY.empty}</span>{" "}
            {COPY.emptyHint}
          </p>
        </CardContent>
      ) : (
        <SupportRequestList
          key={resultKey(current)}
          ownerId={ownerId}
          initialRequests={current.requests}
          initialCursor={current.nextCursor}
        />
      )}
    </Card>
  );
}

/**
 * What a failed page leaves the list able to do next: load the same page
 * again, or start over from the first page (the cursor is no longer valid) —
 * in both cases possibly after signing in again.
 */
type Failure = { message: string; next: "loadOlder" | "reload"; signIn: boolean };

function failureFrom(
  result: Extract<LoadMoreSupportRequestsResult, { ok: false }>,
): Failure {
  switch (result.recovery) {
    case "reload":
      return { message: result.error, next: "reload", signIn: false };
    case "signIn":
      return { message: result.error, next: "loadOlder", signIn: true };
    case "retry":
      return { message: result.error, next: "loadOlder", signIn: false };
    case "accountChanged":
      // The same page again, once the session is the list's account again.
      return { message: result.error, next: "loadOlder", signIn: true };
  }
}

function SupportRequestList({
  ownerId,
  initialRequests,
  initialCursor,
}: {
  ownerId: string;
  initialRequests: SupportRequest[];
  initialCursor: string | null;
}) {
  const [requests, setRequests] = useState(initialRequests);
  const [nextCursor, setNextCursor] = useState(initialCursor);
  const [failure, setFailure] = useState<Failure | null>(null);
  const [announcement, setAnnouncement] = useState<string | null>(null);
  const [reachedEnd, setReachedEnd] = useState(false);
  const [pending, startTransition] = useTransition();
  /** Which operation is running, so its own button stays in place while busy. */
  const [busyWith, setBusyWith] = useState<Failure["next"] | null>(null);
  /** One request at a time, whichever button started it. */
  const inFlight = useRef(false);
  const statusRef = useRef<HTMLParagraphElement>(null);

  // The button unmounts when the list ends; land keyboard focus on the message
  // that replaces it rather than letting it fall back to the document.
  useEffect(() => {
    if (reachedEnd) statusRef.current?.focus({ preventScroll: true });
  }, [reachedEnd]);

  const loadOlder = () => {
    const cursor = nextCursor;

    if (cursor === null || inFlight.current) return;
    inFlight.current = true;
    setBusyWith("loadOlder");
    setFailure(null);

    startTransition(async () => {
      let result: LoadMoreSupportRequestsResult;

      try {
        result = await loadMoreSupportRequests(cursor, ownerId);
      } catch {
        // The action itself failed (network, an unexpected server error). What
        // is on screen is still correct; only this page is missing.
        result = {
          ok: false,
          cursor,
          error: SUPPORT_REQUEST_ERRORS.listUnavailable,
          recovery: "retry",
        };
      }

      inFlight.current = false;

      // After an `await` React no longer knows these updates belong to the
      // transition; wrapping them again keeps list, status and the pending
      // flag committing together.
      startTransition(() => {
        setBusyWith(null);

        if (result.cursor !== cursor) {
          // Not an answer to the page this list asked for; must not be appended.
          setFailure({
            message: SUPPORT_REQUEST_ERRORS.listUnavailable,
            next: "loadOlder",
            signIn: false,
          });
          return;
        }

        if (!result.ok) {
          setFailure(failureFrom(result));
          return;
        }

        const merged = appendRequests(requests, result.requests);
        const ended = result.nextCursor === null;

        setRequests(merged);
        setNextCursor(result.nextCursor);
        setReachedEnd(ended);
        setAnnouncement(
          loadedAnnouncement(merged.length - requests.length, merged.length, ended),
        );
      });
    });
  };

  // Start over from the first page, in place (see `reloadSupportRequests`).
  const reload = () => {
    if (inFlight.current) return;
    inFlight.current = true;
    setBusyWith("reload");
    setFailure(null);

    startTransition(async () => {
      const page = await fetchFirstPage(ownerId);
      inFlight.current = false;

      startTransition(() => {
        setBusyWith(null);

        if (!page.ok) {
          // Keep what is on screen; offer the reload again.
          setFailure({
            message:
              page.failure === "sessionExpired"
                ? SUPPORT_REQUEST_ERRORS.listSessionExpired
                : page.failure === "accountChanged"
                  ? SUPPORT_REQUEST_ERRORS.listAccountChanged
                  : SUPPORT_REQUEST_ERRORS.listUnavailable,
            next: "reload",
            signIn:
              page.failure === "sessionExpired" || page.failure === "accountChanged",
          });
          return;
        }

        setRequests(page.requests);
        setNextCursor(page.nextCursor);
        setReachedEnd(false);
        setAnnouncement(COPY.reloaded);
      });
    });
  };

  // The button on offer: the running operation's, else what the last failure
  // calls for, else paging on.
  const next = busyWith ?? failure?.next ?? "loadOlder";
  const status = busyWith
    ? busyWith === "reload"
      ? COPY.reloadPending
      : COPY.loadOlderPending
    : (announcement ?? "");
  const showFooter = nextCursor !== null || next === "reload";

  return (
    <>
      <CardContent className="space-y-4">
        {requests.length > 0 ? (
          <ol className="divide-y divide-border" aria-label={COPY.listLabel}>
            {requests.map((request) => (
              <SupportRequestItem key={request.id} request={request} />
            ))}
          </ol>
        ) : nextCursor !== null ? (
          // The pages so far held nothing this version can show, but older
          // requests exist: offer them rather than declare the history empty.
          <p
            className="text-sm text-muted-foreground"
            data-history-page="empty-with-more"
          >
            {COPY.emptyPageWithMore}
          </p>
        ) : (
          // Paged to the end and nothing could be shown: requests exist (the
          // server said so), they just cannot be displayed — not "none sent".
          <p className="text-sm text-muted-foreground" data-history-page="empty-at-end">
            {COPY.nothingToShow}
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

      {showFooter && (
        <CardFooter className="flex-col items-start gap-3">
          {next === "reload" ? (
            // Asking for the same page again cannot help; a fresh first page can.
            <BusyButton
              busy={pending && busyWith === "reload"}
              onClick={reload}
              label={COPY.reload}
              busyLabel={COPY.reloadPending}
            />
          ) : (
            <BusyButton
              busy={pending && busyWith === "loadOlder"}
              onClick={loadOlder}
              label={COPY.loadOlder}
              busyLabel={COPY.loadOlderPending}
            />
          )}

          {failure && (
            <div
              role="alert"
              className="space-y-1 text-sm text-red-600 dark:text-red-400"
            >
              <p>{failure.message}</p>
              {failure.signIn && <SignInAgainLink />}
            </div>
          )}
        </CardFooter>
      )}
    </>
  );
}

/**
 * Signs in WITHOUT leaving this page: a new tab shares the session cookies,
 * so once signed in there, retrying here works — and nothing typed here is
 * lost to a navigation.
 */
function SignInAgainLink() {
  return (
    <p>
      <a
        href={ROUTES.login}
        target="_blank"
        rel="noopener noreferrer"
        className="font-medium underline underline-offset-4"
      >
        {COPY.signInAgain}
      </a>
    </p>
  );
}

/**
 * A button that shows it is working without becoming `disabled` (which would
 * drop keyboard focus): `aria-disabled` + `aria-busy`, with callers guarding
 * against the clicks that still arrive.
 */
function BusyButton({
  busy,
  onClick,
  label,
  busyLabel,
}: {
  busy: boolean;
  onClick: () => void;
  label: string;
  busyLabel: string;
}) {
  return (
    <Button
      type="button"
      variant="outline"
      onClick={onClick}
      aria-disabled={busy || undefined}
      aria-busy={busy || undefined}
      className="min-h-11 aria-disabled:cursor-wait aria-disabled:opacity-70 sm:min-h-8"
    >
      {busy ? busyLabel : label}
    </Button>
  );
}

function SupportRequestItem({ request }: { request: SupportRequest }) {
  const id = useId();
  const subjectId = `${id}-subject`;
  const sentAt = formatSentAt(request.createdAt);

  return (
    <li
      className="py-3 first:pt-0 last:pb-0"
      data-request-id={request.id}
      data-request-status={request.status ?? "unknown"}
    >
      <article aria-labelledby={subjectId} className="space-y-1.5">
        <div className="flex items-start justify-between gap-3">
          <h4
            id={subjectId}
            className="min-w-0 text-sm font-medium [overflow-wrap:anywhere]"
          >
            {request.subject}
          </h4>
          <Badge
            className={cn(
              request.status === "open" &&
                "border-primary/30 bg-primary/10 text-foreground",
            )}
          >
            {statusLabel(request.status)}
          </Badge>
        </div>

        <p className="text-xs text-muted-foreground">
          {categoryLabel(request.category)}
          {" · "}
          {sentAt ? (
            <time dateTime={request.createdAt}>Sent {sentAt}</time>
          ) : (
            "Sent at an unknown time"
          )}
        </p>

        <details className="group text-sm">
          <summary className="cursor-pointer text-xs font-medium text-muted-foreground select-none hover:text-foreground">
            {COPY.showMessage}
          </summary>
          <p className="mt-2 whitespace-pre-wrap text-foreground [overflow-wrap:anywhere]">
            {request.message}
          </p>
        </details>
      </article>
    </li>
  );
}
