import Link from "next/link";

import { ROUTES } from "@/config/routes";
import { Button } from "@/shared/components/ui/button";
import {
  Card,
  CardContent,
  CardDescription,
  CardFooter,
  CardHeader,
  CardTitle,
} from "@/shared/components/ui/card";

import type { InvoiceHistory } from "../services/get-invoice-history";
import {
  invoiceFiltersToQuery,
  type ParsedInvoiceFilters,
} from "../services/invoice-filters";

import { InvoiceFiltersForm } from "./invoice-filters-form";
import { InvoiceHistoryList } from "./invoice-history-list";

type Props = {
  /** `null` when the filters did not parse: nothing was listed. */
  history: InvoiceHistory | null;
  filters: ParsedInvoiceFilters;
};

/** The card's shapes; each has its own copy and `data-invoice-state`. */
export type InvoiceHistoryState =
  | "invalid-filters"
  | "unavailable"
  | "none"
  | "ambiguous"
  | "no-matches"
  | "empty"
  | "list";

export function invoiceHistoryState(
  history: InvoiceHistory | null,
  filters: ParsedInvoiceFilters,
): InvoiceHistoryState {
  if (!filters.ok) return "invalid-filters";
  if (history === null || history.kind === "unavailable") return "unavailable";
  if (history.kind === "none" || history.kind === "ambiguous") return history.kind;
  if (history.invoices.length === 0 && history.nextCursor === null) {
    return filters.active ? "no-matches" : "empty";
  }
  return "list";
}

const DESCRIPTION: Record<InvoiceHistoryState, string> = {
  "invalid-filters": "Check the filters.",
  unavailable: "Your invoice history is unavailable right now.",
  none: "You don't have any invoices yet.",
  ambiguous: "Your invoice history can't be shown.",
  "no-matches": "No invoices match these filters.",
  empty: "No invoices have been issued yet.",
  list: "Invoices issued for your billing account, newest first.",
};

/** What a screen reader hears once a filter navigation has rendered this state. */
export function invoiceResultSummary(
  state: InvoiceHistoryState,
  history: InvoiceHistory | null,
): string {
  if (state === "list" && history?.kind === "ok") {
    const n = history.invoices.length;
    return n === 0
      ? "No matching invoices found yet; more can be searched."
      : `${n} ${n === 1 ? "invoice" : "invoices"} shown${history.nextCursor ? ", more available" : ""}.`;
  }
  return DESCRIPTION[state];
}

/**
 * The billing page's invoice list: date, invoice number, amount, status and
 * documents of each invoice Stripe holds for the user's billing account, with
 * filters (status, dates, number search) and "load more" paging.
 *
 * The shapes must never be confused with each other:
 * - the list could not be produced → "unavailable", with a way to retry and
 *   no claim about what the user was or was not billed;
 * - no billing account → nothing to list, said plainly;
 * - several / unidentifiable accounts → an explanation, never one account's
 *   invoices standing in for the user's (same rule as the billing portal);
 * - invalid filters → the form shows what is wrong; nothing was listed;
 * - a list, possibly empty — paged by `InvoiceHistoryList`. "Empty" is only
 *   claimed when Stripe has nothing further; a first page that found no
 *   matching invoice but has more to scan is handed to the list, which offers
 *   to continue rather than declaring the history empty. With filters set, an
 *   empty end result says "no matches", never "no invoices".
 *
 * One card shell for every shape, so that the filter form — shown whenever
 * there is (or could be) a list to filter, not when there is no billing
 * account or it cannot be identified — is the same element before and after
 * a filter navigation, whichever shape the result takes: its pending state,
 * its announcement and keyboard focus survive the change.
 */
export function InvoiceHistoryCard({ history, filters }: Props) {
  const state = invoiceHistoryState(history, filters);
  const showForm = filters.ok ? state !== "none" && state !== "ambiguous" : true;

  return (
    <Card data-invoice-state={state}>
      <CardHeader>
        <CardTitle>Invoices</CardTitle>
        <CardDescription>{DESCRIPTION[state]}</CardDescription>
      </CardHeader>

      <CardContent className="space-y-4">
        {showForm && (
          <InvoiceFiltersForm
            parsed={filters}
            resultSummary={invoiceResultSummary(state, history)}
          />
        )}

        <InvoiceHistoryBody state={state} history={history} filters={filters} />
      </CardContent>

      {state === "unavailable" && filters.ok && (
        <CardFooter>
          <Button asChild variant="outline">
            <Link href={retryPath(filters)}>Try again</Link>
          </Button>
        </CardFooter>
      )}
    </Card>
  );
}

function InvoiceHistoryBody({
  state,
  history,
  filters,
}: {
  state: InvoiceHistoryState;
  history: InvoiceHistory | null;
  filters: ParsedInvoiceFilters;
}) {
  switch (state) {
    case "invalid-filters":
      return (
        <p className="text-sm text-muted-foreground">
          Fix the highlighted filters to see your invoices.
        </p>
      );

    case "unavailable":
      return (
        <p role="alert" className="text-sm text-red-600 dark:text-red-400">
          We couldn&apos;t load your invoices. Please try again in a moment; if this keeps
          happening, contact support.
        </p>
      );

    case "none":
      return (
        <p className="text-sm text-muted-foreground">
          Invoices appear here once you subscribe to a paid plan.
        </p>
      );

    case "ambiguous":
      return (
        <p role="alert" className="text-sm text-red-600 dark:text-red-400">
          Your records point at more than one billing account, or at one we can&apos;t
          identify, so your invoices can&apos;t be shown safely. Please contact support.
        </p>
      );

    case "no-matches":
      return (
        <p className="text-sm text-muted-foreground" role="status">
          None of your invoices match these filters. Change or clear them to see more.
        </p>
      );

    case "empty":
      return (
        <p className="text-sm text-muted-foreground">
          Your invoices will be listed here as soon as Stripe issues them.
        </p>
      );

    case "list":
      if (!filters.ok || history?.kind !== "ok") return null;

      return (
        // Keyed by the filters: a new listing starts from a clean client state.
        <InvoiceHistoryList
          key={invoiceFiltersToQuery(filters.filters)}
          initial={{
            invoices: history.invoices,
            nextCursor: history.nextCursor,
            examined: history.examined,
          }}
          filtersActive={filters.active}
          searching={filters.filters.number !== null}
        />
      );
  }
}

/** "Try again" keeps the filters the user had set. */
function retryPath(filters: Extract<ParsedInvoiceFilters, { ok: true }>): string {
  const query = invoiceFiltersToQuery(filters.filters);

  return query === "" ? ROUTES.billing : `${ROUTES.billing}?${query}`;
}
