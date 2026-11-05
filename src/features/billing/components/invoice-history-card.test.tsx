import { render, screen, within } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

import type { InvoiceHistory as History } from "../services/get-invoice-history";
import {
  type ParsedInvoiceFilters,
  parseInvoiceFilters,
} from "../services/invoice-filters";
import {
  encodeInvoiceKey,
  INVOICE_STATUS_CONTENT,
  type InvoiceSummary,
  LISTED_INVOICE_STATUSES,
} from "../services/invoice-history";

import { APPLY_FILTERS_LABEL, CLEAR_FILTERS_LABEL } from "./invoice-filters-form";
import {
  InvoiceHistoryCard,
  invoiceHistoryState,
  invoiceResultSummary,
} from "./invoice-history-card";
import { LOAD_MORE_LABEL, SEARCH_MORE_LABEL } from "./invoice-history-list";

// The embedded list imports the server action; it is never invoked here.
vi.mock("../actions/load-more-invoices", () => ({
  loadMoreInvoices: vi.fn(),
}));
// The filter form navigates through the app router.
const nav = await vi.hoisted(async () =>
  (await import("@/shared/test/next-navigation")).createNextNavigationMock("/billing"),
);
vi.mock("next/navigation", () => nav.module);

let nextKey = 0;

const invoice = (overrides: Partial<InvoiceSummary> = {}): InvoiceSummary => ({
  key: encodeInvoiceKey(`in_${++nextKey}`),
  number: "ABCD-0001",
  createdAt: "2026-03-01T00:00:00.000Z",
  total: 2900,
  currency: "usd",
  status: "paid",
  documents: { view: true, pdf: true },
  ...overrides,
});

const list = (
  invoices: InvoiceSummary[],
  nextCursor: string | null = null,
  examined = invoices.length,
): History => ({ kind: "ok", invoices, nextCursor, examined });

const CURSOR = "cursor-after-next";
const NO_FILTERS = parseInvoiceFilters({});
const PAID_FILTER = parseInvoiceFilters({ status: "paid" });
const SEARCH = parseInvoiceFilters({ q: "ABCD" });
const INVALID = parseInvoiceFilters({ from: "yesterday", status: "draft" });

const stateOf = (container: HTMLElement) =>
  container.querySelector("[data-invoice-state]")?.getAttribute("data-invoice-state");

const renderCard = (
  history: History | null,
  filters: ParsedInvoiceFilters = NO_FILTERS,
) => render(<InvoiceHistoryCard history={history} filters={filters} />);

const filterForm = () => screen.queryByRole("form", { name: "Filter invoices" });

describe("InvoiceHistoryCard – a list of invoices", () => {
  it("shows one row per invoice with its date, number, amount and status, in the order given", () => {
    const { container } = renderCard(
      list([
        invoice({ number: "ABCD-0002", createdAt: "2026-04-01T12:00:00.000Z" }),
        invoice({
          number: "ABCD-0001",
          createdAt: "2026-03-01T00:00:00.000Z",
          total: 9900,
          status: "open",
        }),
      ]),
    );

    expect(stateOf(container)).toBe("list");

    const table = screen.getByRole("table", {
      name: "Invoice history, 2 invoices shown",
    });
    const [, ...rows] = within(table).getAllByRole("row"); // skip the header row

    expect(rows).toHaveLength(2);
    expect(rows[0]).toHaveTextContent(/Apr 1, 2026.*ABCD-0002.*\$29\.00.*Paid/);
    expect(rows[1]).toHaveTextContent(/Mar 1, 2026.*ABCD-0001.*\$99\.00.*Open/);
  });

  it("labels the columns", () => {
    renderCard(list([invoice()]));

    for (const name of ["Date", "Invoice", "Amount", "Status", "Documents"]) {
      expect(screen.getByRole("columnheader", { name })).toBeInTheDocument();
    }
  });

  it("gives each date a machine-readable timestamp", () => {
    renderCard(list([invoice()]));

    const time = within(screen.getByRole("table")).getByText("Mar 1, 2026");

    expect(time.tagName).toBe("TIME");
    expect(time).toHaveAttribute("dateTime", "2026-03-01T00:00:00.000Z");
  });

  it("formats each amount in its own currency", () => {
    renderCard(
      list([
        invoice({ total: 2900, currency: "usd" }),
        invoice({ total: 2900, currency: "jpy" }),
        invoice({ total: 2500, currency: "eur" }),
      ]),
    );

    const table = within(screen.getByRole("table"));

    expect(table.getByText("$29.00")).toBeInTheDocument();
    expect(table.getByText("¥2,900")).toBeInTheDocument();
    expect(table.getByText("€25.00")).toBeInTheDocument();
  });

  it("shows a placeholder, not an empty cell, for an invoice without a number", () => {
    renderCard(list([invoice({ number: null })]));

    const [, row] = screen.getAllByRole("row");

    expect(within(row).getByText("—")).toBeInTheDocument();
  });

  it.each([...LISTED_INVOICE_STATUSES, "unknown"] as const)(
    "shows the %s status with its label and marks the row",
    (status) => {
      const { container } = renderCard(list([invoice({ status })]));

      expect(container.querySelector(`[data-invoice-status="${status}"]`)).not.toBeNull();
      expect(
        within(screen.getByRole("table")).getByText(INVOICE_STATUS_CONTENT[status].label),
      ).toBeInTheDocument();
    },
  );

  it("offers to load more when there is a next page", () => {
    renderCard(list([invoice()], CURSOR));

    expect(screen.getByRole("button", { name: LOAD_MORE_LABEL })).toBeEnabled();
  });

  it("offers nothing more when the page holds them all", () => {
    renderCard(list([invoice()], null));

    expect(
      screen.queryByRole("button", { name: LOAD_MORE_LABEL }),
    ).not.toBeInTheDocument();
  });

  it("does not declare the history empty when the first page found nothing but more remains to scan", () => {
    const { container } = renderCard(list([], CURSOR, 300));

    expect(stateOf(container)).toBe("list");
    expect(screen.queryByText(/No invoices have been issued/)).not.toBeInTheDocument();
    expect(screen.getByText(/there may be older ones/)).toBeInTheDocument();
    expect(screen.getByRole("button", { name: LOAD_MORE_LABEL })).toBeEnabled();
  });

  it("shows the filter form with the list, with nothing to clear when no filter is set", () => {
    renderCard(list([invoice()]));

    expect(filterForm()).toBeInTheDocument();
    expect(screen.getByRole("button", { name: APPLY_FILTERS_LABEL })).toBeInTheDocument();
    expect(
      screen.queryByRole("link", { name: CLEAR_FILTERS_LABEL }),
    ).not.toBeInTheDocument();
  });

  it("raises no alert for a plain list", () => {
    renderCard(list([invoice()]));

    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
  });
});

describe("InvoiceHistoryCard – filters", () => {
  it("shows the filters as set, with a way to clear them", () => {
    renderCard(list([invoice()], CURSOR), PAID_FILTER);

    expect(screen.getByRole("combobox", { name: "Status" })).toHaveValue("paid");
    expect(screen.getByRole("link", { name: CLEAR_FILTERS_LABEL })).toHaveAttribute(
      "href",
      "/billing",
    );
    expect(filterForm()).toHaveAttribute("data-invoice-filters", "active");
  });

  it("reads a number search as searching older invoices", () => {
    renderCard(list([invoice()], CURSOR), SEARCH);

    expect(screen.getByRole("searchbox", { name: "Invoice number" })).toHaveValue("ABCD");
    expect(screen.getByRole("button", { name: SEARCH_MORE_LABEL })).toBeEnabled();
    expect(
      screen.queryByRole("button", { name: LOAD_MORE_LABEL }),
    ).not.toBeInTheDocument();
  });

  it("says 'no matches' — never 'no invoices' — when a filtered listing is empty at the end", () => {
    const { container } = renderCard(list([], null, 120), PAID_FILTER);

    expect(stateOf(container)).toBe("no-matches");
    expect(screen.getByText(/None of your invoices match/)).toHaveAttribute(
      "role",
      "status",
    );
    expect(screen.queryByText(/No invoices have been issued/)).not.toBeInTheDocument();
    expect(filterForm()).toBeInTheDocument();
    expect(screen.getByRole("link", { name: CLEAR_FILTERS_LABEL })).toBeInTheDocument();
  });

  it("keeps searching when a filtered first page found nothing but more remains", () => {
    const { container } = renderCard(list([], CURSOR, 1000), SEARCH);

    expect(stateOf(container)).toBe("list");
    expect(
      screen.getByText(/No matching invoices among the 1,000 checked so far/),
    ).toBeInTheDocument();
    expect(screen.getByRole("button", { name: SEARCH_MORE_LABEL })).toBeEnabled();
  });

  it("shows what is wrong with invalid filters and lists nothing", () => {
    const { container } = renderCard(null, INVALID);

    expect(stateOf(container)).toBe("invalid-filters");
    // (a date input cannot show "yesterday" back; the message and the flag say what is wrong)
    expect(screen.getByLabelText("From")).toHaveAttribute("aria-invalid", "true");
    expect(screen.getByRole("combobox", { name: "Status" })).toHaveAttribute(
      "aria-invalid",
      "true",
    );
    expect(screen.getAllByRole("alert").map((a) => a.textContent)).toEqual([
      "Choose a status from the list.",
      "Enter a date as YYYY-MM-DD.",
    ]);
    expect(screen.getByText(/Fix the highlighted filters/)).toBeInTheDocument();
    expect(screen.queryByRole("table")).not.toBeInTheDocument();
    expect(screen.getByRole("link", { name: CLEAR_FILTERS_LABEL })).toBeInTheDocument();
  });

  it("keeps the filters in the 'try again' link when the list is unavailable", () => {
    renderCard({ kind: "unavailable", reason: "stripe_error" }, PAID_FILTER);

    expect(screen.getByRole("link", { name: "Try again" })).toHaveAttribute(
      "href",
      "/billing?status=paid",
    );
    expect(filterForm()).toBeInTheDocument();
  });

  it("resets the list when the filters change (the list is keyed by them)", () => {
    const { rerender } = render(
      <InvoiceHistoryCard
        history={list([invoice({ number: "OLD-0001" })], CURSOR)}
        filters={NO_FILTERS}
      />,
    );
    expect(screen.getAllByText("OLD-0001")).toHaveLength(2); // table + card

    rerender(
      <InvoiceHistoryCard
        history={list([invoice({ number: "NEW-0001" })], CURSOR)}
        filters={PAID_FILTER}
      />,
    );

    expect(screen.getAllByText("NEW-0001")).toHaveLength(2);
    expect(screen.queryByText("OLD-0001")).not.toBeInTheDocument();
  });
});

describe("InvoiceHistoryCard – one filter form across result states", () => {
  it("keeps the same form element when a filter navigation changes the result shape", () => {
    const { rerender } = render(
      <InvoiceHistoryCard history={list([invoice()], CURSOR)} filters={NO_FILTERS} />,
    );
    const before = filterForm();

    rerender(<InvoiceHistoryCard history={list([], null, 40)} filters={PAID_FILTER} />);
    expect(filterForm()).toBe(before);

    rerender(
      <InvoiceHistoryCard
        history={{ kind: "unavailable", reason: "stripe_error" }}
        filters={PAID_FILTER}
      />,
    );
    expect(filterForm()).toBe(before);

    rerender(<InvoiceHistoryCard history={null} filters={INVALID} />);
    expect(filterForm()).toBe(before);
  });

  it("tells the form what each result shows, for the announcement after a navigation", () => {
    const summary = (history: History | null, filters: ParsedInvoiceFilters) =>
      invoiceResultSummary(invoiceHistoryState(history, filters), history);

    expect(summary(list([invoice(), invoice()], CURSOR), PAID_FILTER)).toBe(
      "2 invoices shown, more available.",
    );
    expect(summary(list([invoice()], null), PAID_FILTER)).toBe("1 invoice shown.");
    expect(summary(list([], CURSOR, 1000), SEARCH)).toBe(
      "No matching invoices found yet; more can be searched.",
    );
    expect(summary(list([], null), PAID_FILTER)).toBe("No invoices match these filters.");
    expect(summary(list([], null), NO_FILTERS)).toBe("No invoices have been issued yet.");
    expect(summary({ kind: "unavailable", reason: "stripe_error" }, PAID_FILTER)).toBe(
      "Your invoice history is unavailable right now.",
    );
    expect(summary(null, INVALID)).toBe("Check the filters.");
  });
});

describe("InvoiceHistoryCard – no invoices", () => {
  it("says no invoices have been issued when the list is empty and Stripe has nothing further", () => {
    const { container } = renderCard(list([], null));

    expect(stateOf(container)).toBe("empty");
    expect(screen.getByText(/No invoices have been issued yet/)).toBeInTheDocument();
    expect(screen.queryByRole("table")).not.toBeInTheDocument();
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
  });

  it("says there is nothing to list when the user has no billing account, without a filter form", () => {
    const { container } = renderCard({ kind: "none" });

    expect(stateOf(container)).toBe("none");
    expect(screen.getByText(/don't have any invoices yet/)).toBeInTheDocument();
    expect(screen.getByText(/once you subscribe/)).toBeInTheDocument();
    expect(screen.queryByRole("table")).not.toBeInTheDocument();
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
    expect(filterForm()).not.toBeInTheDocument();
  });
});

describe("InvoiceHistoryCard – records that cannot be trusted", () => {
  it("explains an ambiguous billing account and lists nothing, without a filter form", () => {
    const { container } = renderCard({ kind: "ambiguous" });

    expect(stateOf(container)).toBe("ambiguous");
    expect(screen.getByRole("alert")).toHaveTextContent(/more than one billing account/);
    expect(screen.getByRole("alert")).toHaveTextContent(/contact support/);
    expect(screen.queryByRole("table")).not.toBeInTheDocument();
    expect(screen.queryByText(/No invoices/)).not.toBeInTheDocument();
    expect(filterForm()).not.toBeInTheDocument();
  });

  it.each([
    "records_unreadable",
    "invalid_customer_id",
    "customer_missing",
    "cursor_invalid",
    "stripe_error",
    "unusable_response",
  ] as const)(
    "says the history is unavailable (never 'no invoices') and offers a retry: %s",
    (reason) => {
      const { container } = renderCard({ kind: "unavailable", reason });

      expect(stateOf(container)).toBe("unavailable");
      expect(screen.getByRole("alert")).toHaveTextContent(/couldn't load your invoices/);
      expect(screen.getByRole("alert")).not.toHaveTextContent(/changed/i);
      expect(screen.getByRole("alert")).toHaveTextContent(/try again/);
      expect(screen.getByRole("link", { name: "Try again" })).toHaveAttribute(
        "href",
        "/billing",
      );
      expect(screen.queryByRole("table")).not.toBeInTheDocument();
      expect(screen.queryByText(/No invoices/)).not.toBeInTheDocument();
      // The reason is for logs; the page does not echo internals.
      expect(container).not.toHaveTextContent(reason);
    },
  );
});
