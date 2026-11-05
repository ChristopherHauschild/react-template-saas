"use client";

import { useEffect, useRef, useState, useTransition } from "react";

import { Badge } from "@/shared/components/ui/badge";
import { Button } from "@/shared/components/ui/button";
import { cn } from "@/shared/utils/cn";

import {
  loadMoreInvoices,
  type LoadMoreInvoicesResult,
} from "../actions/load-more-invoices";
import {
  appendInvoices,
  formatInvoiceAmount,
  formatInvoiceDate,
  INVOICE_STATUS_CONTENT,
  type InvoiceDocumentKind,
  invoiceDocumentPath,
  type InvoicePage,
  type InvoiceSummary,
  LOAD_MORE_INVOICES_COPY,
} from "../services/invoice-history";

export const LOAD_MORE_LABEL = "Load more invoices";
export const LOAD_MORE_PENDING_LABEL = "Loading more invoices…";
export const SEARCH_MORE_LABEL = "Search older invoices";
export const SEARCH_MORE_PENDING_LABEL = "Searching older invoices…";
export const END_OF_LIST_TEXT = "That's all of your invoices.";
export const END_OF_MATCHES_TEXT = "No more invoices match these filters.";
export const NO_MATCHES_TEXT = "No invoices match these filters.";
export const NO_DOCUMENTS_TEXT = "Not available yet";
export const NO_NUMBER_TEXT = "No number yet";
export const OPENS_IN_NEW_TAB = "opens in a new tab";

const plural = (n: number, word: string) =>
  `${n.toLocaleString("en-US")} ${word}${n === 1 ? "" : "s"}`;

/** How far a filtered listing has looked, e.g. "Checked 300 invoices so far." */
export function checkedSoFar(examined: number): string {
  return `Checked ${plural(examined, "invoice")} so far.`;
}

/** What the live region says after a page was appended. */
export function loadedAnnouncement(added: number, shown: number): string {
  return added === 0
    ? `No new invoices. ${plural(shown, "invoice")} shown.`
    : `Loaded ${plural(added, "more invoice")}. ${plural(shown, "invoice")} shown.`;
}

/** What the live region says when the listing ends. */
export function endAnnouncement(filtersActive: boolean, examined: number): string {
  return filtersActive
    ? `${END_OF_MATCHES_TEXT} Checked all ${plural(examined, "invoice")}.`
    : END_OF_LIST_TEXT;
}

/** Link text per document; the accessible name adds the invoice it belongs to. */
export const INVOICE_DOCUMENT_LABELS: Record<InvoiceDocumentKind, string> = {
  view: "View",
  pdf: "PDF",
};

const TONE_CLASS = {
  neutral: "border-border bg-muted text-foreground",
  attention: "border-red-400/40 bg-red-500/10 text-red-600 dark:text-red-400",
} as const;

const LINK_FOCUS =
  "rounded-sm outline-none focus-visible:ring-3 focus-visible:ring-ring/50 focus-visible:border-ring";

type Props = {
  initial: InvoicePage;
  /** Any filter is set: copy speaks of "matches", and the end is "no more matches". */
  filtersActive?: boolean;
  /** A number search is set: paging reads as "search older invoices". */
  searching?: boolean;
};

type Failure = { message: string; restart: boolean };

/**
 * The invoice list with "load more" paging: a table from the `lg` breakpoint
 * (where it fits next to the sidebar) and one card per invoice below it, so
 * nothing has to be scrolled sideways to reach a document on a phone or a
 * portrait tablet. Only one of the two is displayed at a time; each carries
 * full semantics on its own.
 *
 * The first page comes from the server render; further pages are appended
 * through the `loadMoreInvoices` action, which resolves the user's customer
 * again on every call — the client sends nothing but the cursor it was given.
 *
 * What the list guarantees while paging:
 * - one request at a time: the button is marked `aria-disabled` and busy while
 *   a page is loading (not `disabled`, which would throw keyboard focus away),
 *   and a click that slips through is ignored by an in-flight guard;
 * - no duplicates: a page is appended by key, so a response that arrives
 *   twice or overlaps cannot show an invoice twice;
 * - no stale data: a response is applied only if it answers the cursor the
 *   list is currently waiting on;
 * - failures keep what is on screen: a failed request shows a message and
 *   offers a retry of the same page, or asks for a reload when a retry cannot
 *   help (the cursor or the records are no longer valid);
 * - the filters travel inside the cursor, so every further page continues the
 *   listing this component was rendered with; a filter change re-renders the
 *   page with a new `key`, and this state starts over;
 * - screen readers hear what happened: a single, always-mounted live region
 *   reports loading, what was appended, how far a search got, and the end of
 *   the list — at which point focus moves to it, since the button is gone.
 */
export function InvoiceHistoryList({
  initial,
  filtersActive = false,
  searching = false,
}: Props) {
  const [invoices, setInvoices] = useState(initial.invoices);
  const [nextCursor, setNextCursor] = useState(initial.nextCursor);
  const [examined, setExamined] = useState(initial.examined);
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

  const loadMore = () => {
    const cursor = nextCursor;

    if (cursor === null || inFlight.current !== null) return;
    inFlight.current = cursor;
    setFailure(null);

    startTransition(async () => {
      let result: LoadMoreInvoicesResult;

      try {
        result = await loadMoreInvoices(cursor);
      } catch {
        // The action itself failed (network, an unexpected server error). The
        // rows on screen are still correct; only this page is missing.
        result = {
          ok: false,
          cursor,
          error: LOAD_MORE_INVOICES_COPY.retry,
          restart: false,
        };
      }

      inFlight.current = null;

      // After an `await` React no longer knows these updates belong to the
      // transition; wrapping them again keeps rows, status and the pending
      // flag committing together (no "loading…" next to already-added rows).
      startTransition(() => {
        if (result.cursor !== cursor) {
          // Not an answer to the page this list asked for; its rows must not
          // be appended. Treated as a failed attempt, so the user can ask again.
          setFailure({ message: LOAD_MORE_INVOICES_COPY.retry, restart: false });
          return;
        }

        if (!result.ok) {
          setFailure({ message: result.error, restart: result.restart });
          return;
        }

        const merged = appendInvoices(invoices, result.invoices);
        const examinedNow = examined + result.examined;
        const ended = result.nextCursor === null;

        setInvoices(merged);
        setNextCursor(result.nextCursor);
        setExamined(examinedNow);
        setReachedEnd(ended);
        setAnnouncement(
          ended
            ? endAnnouncement(filtersActive, examinedNow)
            : `${loadedAnnouncement(merged.length - invoices.length, merged.length)}${
                filtersActive ? ` ${checkedSoFar(examinedNow)}` : ""
              }`,
        );
      });
    });
  };

  const moreLabel = searching ? SEARCH_MORE_LABEL : LOAD_MORE_LABEL;
  const morePendingLabel = searching
    ? SEARCH_MORE_PENDING_LABEL
    : LOAD_MORE_PENDING_LABEL;

  // One live region for the whole list, mounted from the start so that every
  // change to its text is announced. Before anything was loaded it shows how
  // far a filtered first page got (if there is more to look at).
  const status = pending
    ? morePendingLabel
    : (announcement ??
      (filtersActive && invoices.length > 0 && nextCursor !== null
        ? checkedSoFar(examined)
        : ""));

  return (
    <div className="space-y-4" data-invoice-count={invoices.length} aria-busy={pending}>
      {invoices.length > 0 ? (
        <>
          {/* Phones and tablets: one card per invoice, documents as full-size buttons. */}
          <ul
            className="divide-y divide-border lg:hidden"
            aria-label="Invoice history"
            data-invoice-layout="cards"
          >
            {invoices.map((invoice) => (
              <InvoiceCard key={invoice.key} invoice={invoice} />
            ))}
          </ul>

          {/* Laptops and up: the table. A scrollable region must be reachable by
              keyboard, hence the tab stop; it only scrolls if it has to. */}
          <div
            role="region"
            aria-label="Invoice history table"
            tabIndex={0}
            className={cn("hidden overflow-x-auto lg:block", LINK_FOCUS)}
            data-invoice-layout="table"
          >
            <table className="w-full text-sm">
              <caption className="sr-only">
                Invoice history, {plural(invoices.length, "invoice")} shown
              </caption>

              <thead>
                <tr className="border-b border-border text-left text-xs text-muted-foreground">
                  <th scope="col" className="py-2 pr-4 font-medium">
                    Date
                  </th>
                  <th scope="col" className="py-2 pr-4 font-medium">
                    Invoice
                  </th>
                  <th scope="col" className="py-2 pr-4 text-right font-medium">
                    Amount
                  </th>
                  <th scope="col" className="py-2 pr-4 font-medium">
                    Status
                  </th>
                  <th scope="col" className="py-2 font-medium">
                    Documents
                  </th>
                </tr>
              </thead>

              <tbody>
                {invoices.map((invoice) => (
                  <InvoiceRow key={invoice.key} invoice={invoice} />
                ))}
              </tbody>
            </table>
          </div>
        </>
      ) : nextCursor !== null ? (
        // The server hit its scan budget before finding a (matching) invoice:
        // there may be older ones, and the button below keeps looking.
        <p className="text-sm text-muted-foreground" data-invoice-page="empty-with-more">
          {filtersActive
            ? `No matching invoices among the ${examined.toLocaleString("en-US")} checked so far.`
            : "We haven't found any issued invoices yet, but there may be older ones."}
        </p>
      ) : (
        <p className="text-sm text-muted-foreground" data-invoice-page="empty">
          {filtersActive ? NO_MATCHES_TEXT : "No invoices have been issued yet."}
        </p>
      )}

      <p
        ref={statusRef}
        role="status"
        aria-live="polite"
        aria-atomic="true"
        tabIndex={-1}
        data-invoice-examined={examined}
        className={cn(
          "text-xs text-muted-foreground outline-none",
          status === "" && "sr-only",
        )}
      >
        {status}
      </p>

      {nextCursor !== null && (
        <div className="flex flex-col gap-2">
          <Button
            type="button"
            variant="outline"
            onClick={loadMore}
            aria-disabled={pending || undefined}
            aria-busy={pending || undefined}
            className="min-h-11 self-start aria-disabled:cursor-wait aria-disabled:opacity-70 sm:min-h-8"
          >
            {pending ? morePendingLabel : moreLabel}
          </Button>

          {failure && (
            <p role="alert" className="text-sm text-red-600 dark:text-red-400">
              {failure.message}
            </p>
          )}
        </div>
      )}
    </div>
  );
}

function InvoiceRow({ invoice }: { invoice: InvoiceSummary }) {
  const { label, tone } = INVOICE_STATUS_CONTENT[invoice.status];

  return (
    <tr
      className="border-b border-border last:border-0"
      data-invoice-status={invoice.status}
    >
      <td className="py-2 pr-4 whitespace-nowrap">
        <time dateTime={invoice.createdAt}>{formatInvoiceDate(invoice.createdAt)}</time>
      </td>

      <td className="py-2 pr-4 whitespace-nowrap">
        {invoice.number ?? <span className="text-muted-foreground">—</span>}
      </td>

      <td className="py-2 pr-4 text-right whitespace-nowrap tabular-nums">
        {formatInvoiceAmount(invoice.total, invoice.currency)}
      </td>

      <td className="py-2 pr-4">
        <Badge className={cn("text-xs", TONE_CLASS[tone])}>{label}</Badge>
      </td>

      <td className="py-2 whitespace-nowrap">
        <InvoiceDocumentLinks invoice={invoice} layout="table" />
      </td>
    </tr>
  );
}

/**
 * One invoice on a small screen: number and date on the left, amount and
 * status on the right, documents below as buttons big enough for a thumb.
 */
function InvoiceCard({ invoice }: { invoice: InvoiceSummary }) {
  const { label, tone } = INVOICE_STATUS_CONTENT[invoice.status];

  return (
    <li
      className="space-y-3 py-3 first:pt-0 last:pb-0"
      data-invoice-status={invoice.status}
      aria-label={invoice.number ?? NO_NUMBER_TEXT}
    >
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0">
          <p className="font-medium break-all">
            {invoice.number ?? (
              <span className="text-muted-foreground">{NO_NUMBER_TEXT}</span>
            )}
          </p>
          <p className="text-xs text-muted-foreground">
            <time dateTime={invoice.createdAt}>
              {formatInvoiceDate(invoice.createdAt)}
            </time>
          </p>
        </div>

        <div className="flex shrink-0 flex-col items-end gap-1">
          <p className="font-medium tabular-nums">
            {formatInvoiceAmount(invoice.total, invoice.currency)}
          </p>
          <Badge className={cn("text-xs", TONE_CLASS[tone])}>{label}</Badge>
        </div>
      </div>

      <InvoiceDocumentLinks invoice={invoice} layout="cards" />
    </li>
  );
}

/**
 * Links to the hosted invoice page and the PDF — through the application's own
 * document route, never Stripe's tokenised URLs — for the documents Stripe has
 * made available; "Not available yet" otherwise. Opened in a new tab so the
 * list (and any pages loaded into it) stays put; the accessible name says so.
 */
function InvoiceDocumentLinks({
  invoice,
  layout,
}: {
  invoice: InvoiceSummary;
  layout: "table" | "cards";
}) {
  const available = (
    Object.keys(INVOICE_DOCUMENT_LABELS) as InvoiceDocumentKind[]
  ).filter((kind) => invoice.documents[kind]);

  if (available.length === 0) {
    return (
      <span
        className={cn("text-muted-foreground", layout === "cards" && "block text-sm")}
        data-invoice-documents="none"
      >
        {NO_DOCUMENTS_TEXT}
      </span>
    );
  }

  const about = invoice.number ? `invoice ${invoice.number}` : "invoice";

  return (
    <span
      className={cn("flex gap-3", layout === "cards" && "flex-wrap gap-2")}
      data-invoice-documents={available.join(" ")}
    >
      {available.map((kind) => {
        const props = {
          href: invoiceDocumentPath(invoice.key, kind),
          target: "_blank",
          rel: "noopener noreferrer",
          "aria-label": `${INVOICE_DOCUMENT_LABELS[kind]} ${about} (${OPENS_IN_NEW_TAB})`,
        };

        return layout === "cards" ? (
          <Button
            key={kind}
            asChild
            variant="outline"
            className="h-auto min-h-11 flex-1 px-4 sm:flex-none"
          >
            <a {...props}>{INVOICE_DOCUMENT_LABELS[kind]}</a>
          </Button>
        ) : (
          <a
            key={kind}
            {...props}
            className={cn("text-primary underline-offset-4 hover:underline", LINK_FOCUS)}
          >
            {INVOICE_DOCUMENT_LABELS[kind]}
          </a>
        );
      })}
    </span>
  );
}
