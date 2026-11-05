import { act, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";

import type { LoadMoreInvoicesResult } from "../actions/load-more-invoices";
import {
  encodeInvoiceKey,
  type InvoicePage,
  type InvoiceSummary,
  LOAD_MORE_INVOICES_COPY,
} from "../services/invoice-history";

// The list calls the server action; substitute it with a controllable fake.
const action = vi.hoisted(() => ({
  loadMoreInvoices: vi.fn<(cursor: unknown) => Promise<LoadMoreInvoicesResult>>(),
}));
vi.mock("../actions/load-more-invoices", () => action);

import {
  checkedSoFar,
  END_OF_LIST_TEXT,
  END_OF_MATCHES_TEXT,
  endAnnouncement,
  InvoiceHistoryList,
  LOAD_MORE_LABEL,
  LOAD_MORE_PENDING_LABEL,
  loadedAnnouncement,
  NO_DOCUMENTS_TEXT,
  NO_MATCHES_TEXT,
  NO_NUMBER_TEXT,
  OPENS_IN_NEW_TAB,
  SEARCH_MORE_LABEL,
  SEARCH_MORE_PENDING_LABEL,
} from "./invoice-history-list";

const invoice = (
  id: string,
  overrides: Partial<InvoiceSummary> = {},
): InvoiceSummary => ({
  key: encodeInvoiceKey(id),
  number: id.toUpperCase().replace("IN_", "INV-"),
  createdAt: "2026-03-01T00:00:00.000Z",
  total: 2900,
  currency: "usd",
  status: "paid",
  documents: { view: true, pdf: true },
  ...overrides,
});

const page = (
  ids: string[],
  nextCursor: string | null,
  examined = ids.length,
): InvoicePage => ({
  invoices: ids.map((id) => invoice(id)),
  nextCursor,
  examined,
});

// Opaque to this component: it only hands cursors back to the action.
const CURSOR_1 = "cursor-after-b";
const CURSOR_2 = "cursor-after-d";

const ok = (
  cursor: string,
  ids: string[],
  nextCursor: string | null,
  examined = ids.length,
): LoadMoreInvoicesResult => ({
  ok: true,
  cursor,
  invoices: ids.map((id) => invoice(id)),
  nextCursor,
  examined,
});

const failed = (cursor: string, restart = false): LoadMoreInvoicesResult => ({
  ok: false,
  cursor,
  error: restart ? LOAD_MORE_INVOICES_COPY.restart : LOAD_MORE_INVOICES_COPY.retry,
  restart,
});

/** A promise the test resolves by hand, to hold a request in flight. */
function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

/** The two layouts share the DOM (CSS shows one at a time); tests address each explicitly. */
const table = () => screen.getByRole("table");
const cards = () => screen.getByRole("list", { name: "Invoice history" });

const rowNumbers = () =>
  within(table())
    .getAllByRole("row")
    .slice(1)
    .map((row) => within(row).getAllByRole("cell")[1].textContent);

const cardNumbers = () =>
  within(cards())
    .getAllByRole("listitem")
    .map((item) => item.getAttribute("aria-label"));

const loadMoreButton = () => screen.queryByRole("button", { name: LOAD_MORE_LABEL });
const status = () => screen.getByRole("status");
const docLink = (scope: HTMLElement, label: string, number = "INV-A") =>
  within(scope).getByRole("link", {
    name: `${label} invoice ${number} (${OPENS_IN_NEW_TAB})`,
  });

beforeEach(() => {
  vi.clearAllMocks();
});

describe("InvoiceHistoryList – first page", () => {
  it("renders the page it is given and offers more when there is a cursor", () => {
    render(<InvoiceHistoryList initial={page(["in_a", "in_b"], CURSOR_1)} />);

    expect(rowNumbers()).toEqual(["INV-A", "INV-B"]);
    expect(cardNumbers()).toEqual(["INV-A", "INV-B"]);
    expect(loadMoreButton()).toBeEnabled();
    expect(screen.queryByText(END_OF_LIST_TEXT)).not.toBeInTheDocument();
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
  });

  it("offers nothing more when there is no cursor, without claiming the end was just reached", () => {
    render(<InvoiceHistoryList initial={page(["in_a"], null)} />);

    expect(loadMoreButton()).not.toBeInTheDocument();
    expect(screen.queryByText(END_OF_LIST_TEXT)).not.toBeInTheDocument();
  });

  it("does not declare the history empty when the server found nothing yet but has more to scan", () => {
    const { container } = render(<InvoiceHistoryList initial={page([], CURSOR_1)} />);

    expect(screen.queryByRole("table")).not.toBeInTheDocument();
    expect(
      container.querySelector('[data-invoice-page="empty-with-more"]'),
    ).toHaveTextContent(/there may be older ones/);
    expect(screen.queryByText(/No invoices have been issued/)).not.toBeInTheDocument();
    expect(loadMoreButton()).toBeEnabled();
  });

  it("never shows Stripe identifiers", () => {
    const { container } = render(
      <InvoiceHistoryList initial={page(["in_secret1"], CURSOR_1)} />,
    );

    expect(container.innerHTML).not.toMatch(/in_secret1|in_b\b/);
  });
});

describe("InvoiceHistoryList – two layouts, one set of semantics", () => {
  it("renders the same invoices as a table (large screens) and as cards (small screens)", () => {
    const { container } = render(
      <InvoiceHistoryList initial={page(["in_a", "in_b"], null)} />,
    );

    const tableWrap = container.querySelector('[data-invoice-layout="table"]')!;
    const cardList = container.querySelector('[data-invoice-layout="cards"]')!;

    expect(tableWrap.className).toMatch(/\bhidden\b/);
    expect(tableWrap.className).toMatch(/\blg:block\b/);
    expect(cardList.className).toMatch(/\blg:hidden\b/);
    expect(rowNumbers()).toEqual(cardNumbers());
  });

  it("makes the table's scroll region reachable by keyboard, with a name", () => {
    render(<InvoiceHistoryList initial={page(["in_a"], null)} />);

    const region = screen.getByRole("region", { name: "Invoice history table" });

    expect(region).toHaveAttribute("tabindex", "0");
    expect(region).toContainElement(table());
  });

  it("tells screen readers how many invoices the table holds", () => {
    render(<InvoiceHistoryList initial={page(["in_a", "in_b", "in_c"], null)} />);

    expect(table()).toHaveAccessibleName("Invoice history, 3 invoices shown");
  });

  it("shows number, date, amount and status on each card", () => {
    render(
      <InvoiceHistoryList
        initial={{
          invoices: [invoice("in_a", { total: 9900, currency: "eur", status: "open" })],
          nextCursor: null,
          examined: 1,
        }}
      />,
    );

    const card = within(cards()).getByRole("listitem");

    expect(card).toHaveTextContent(/INV-A/);
    expect(card).toHaveTextContent(/Mar 1, 2026/);
    expect(card).toHaveTextContent(/€99\.00/);
    expect(card).toHaveTextContent(/Open/);
  });

  it("names a card without a number rather than leaving it blank", () => {
    render(
      <InvoiceHistoryList
        initial={{
          invoices: [invoice("in_a", { number: null })],
          nextCursor: null,
          examined: 1,
        }}
      />,
    );

    expect(within(cards()).getByRole("listitem")).toHaveAccessibleName(NO_NUMBER_TEXT);
    expect(within(cards()).getByText(NO_NUMBER_TEXT)).toBeInTheDocument();
  });
});

describe("InvoiceHistoryList – documents", () => {
  it("links to the hosted page and the PDF through the application's own route, in a new tab, and says so", () => {
    render(<InvoiceHistoryList initial={page(["in_a"], null)} />);

    for (const scope of [table(), cards()]) {
      const view = docLink(scope, "View");
      const pdf = docLink(scope, "PDF");

      expect(view).toHaveAttribute(
        "href",
        `/billing/invoices/${encodeInvoiceKey("in_a")}/view`,
      );
      expect(pdf).toHaveAttribute(
        "href",
        `/billing/invoices/${encodeInvoiceKey("in_a")}/pdf`,
      );
      for (const link of [view, pdf]) {
        expect(link).toHaveAttribute("target", "_blank");
        expect(link).toHaveAttribute("rel", "noopener noreferrer");
        // Label-in-name: the visible text starts the accessible name.
        expect(link.getAttribute("aria-label")).toMatch(
          new RegExp(`^${link.textContent}`),
        );
      }
    }
  });

  it("gives the card links a thumb-sized target", () => {
    render(<InvoiceHistoryList initial={page(["in_a"], null)} />);

    expect(docLink(cards(), "PDF").className).toMatch(/\bmin-h-11\b/);
    expect(docLink(table(), "PDF").className).not.toMatch(/\bmin-h-11\b/);
  });

  it("shows only the documents Stripe has made available", () => {
    render(
      <InvoiceHistoryList
        initial={{
          invoices: [
            invoice("in_a", { documents: { view: true, pdf: false } }),
            invoice("in_b", { documents: { view: false, pdf: true } }),
          ],
          nextCursor: null,
          examined: 2,
        }}
      />,
    );

    for (const scope of [table(), cards()]) {
      expect(docLink(scope, "View", "INV-A")).toBeInTheDocument();
      expect(
        within(scope).queryByRole("link", { name: /PDF invoice INV-A/ }),
      ).not.toBeInTheDocument();
      expect(
        within(scope).queryByRole("link", { name: /View invoice INV-B/ }),
      ).not.toBeInTheDocument();
      expect(docLink(scope, "PDF", "INV-B")).toBeInTheDocument();
    }
  });

  it("says a document is not available yet instead of linking nowhere", () => {
    render(
      <InvoiceHistoryList
        initial={{
          invoices: [invoice("in_a", { documents: { view: false, pdf: false } })],
          nextCursor: null,
          examined: 1,
        }}
      />,
    );

    expect(screen.getAllByText(NO_DOCUMENTS_TEXT)).toHaveLength(2); // table + card
    expect(screen.queryAllByRole("link")).toHaveLength(0);
  });

  it("names the invoice in the link for an invoice without a number too", () => {
    render(
      <InvoiceHistoryList
        initial={{
          invoices: [invoice("in_a", { number: null })],
          nextCursor: null,
          examined: 1,
        }}
      />,
    );

    expect(
      within(table()).getByRole("link", { name: `PDF invoice (${OPENS_IN_NEW_TAB})` }),
    ).toBeInTheDocument();
  });

  it("never puts a Stripe URL or id in the markup", () => {
    const { container } = render(
      <InvoiceHistoryList initial={page(["in_secret1"], null)} />,
    );

    expect(container.innerHTML).not.toMatch(/stripe\.com|https?:|in_secret1/);
  });
});

describe("InvoiceHistoryList – loading more", () => {
  it("appends the next page after the rows already shown and moves the cursor on", async () => {
    action.loadMoreInvoices.mockResolvedValue(ok(CURSOR_1, ["in_c", "in_d"], CURSOR_2));
    const user = userEvent.setup();
    render(<InvoiceHistoryList initial={page(["in_a", "in_b"], CURSOR_1)} />);

    await user.click(loadMoreButton()!);

    await waitFor(() =>
      expect(rowNumbers()).toEqual(["INV-A", "INV-B", "INV-C", "INV-D"]),
    );
    expect(cardNumbers()).toEqual(["INV-A", "INV-B", "INV-C", "INV-D"]);
    expect(action.loadMoreInvoices).toHaveBeenCalledTimes(1);
    expect(action.loadMoreInvoices).toHaveBeenCalledWith(CURSOR_1);

    // The next click asks for the page after the one just appended.
    action.loadMoreInvoices.mockResolvedValue(ok(CURSOR_2, ["in_e"], null));
    await user.click(loadMoreButton()!);

    await waitFor(() => expect(rowNumbers()).toContain("INV-E"));
    expect(action.loadMoreInvoices).toHaveBeenLastCalledWith(CURSOR_2);
  });

  it("shows a loading state, keeps the button focusable and busy, and announces it", async () => {
    const request = deferred<LoadMoreInvoicesResult>();
    action.loadMoreInvoices.mockReturnValue(request.promise);
    const user = userEvent.setup();
    render(<InvoiceHistoryList initial={page(["in_a"], CURSOR_1)} />);

    await user.click(loadMoreButton()!);

    const pendingButton = await screen.findByRole("button", {
      name: LOAD_MORE_PENDING_LABEL,
    });
    expect(pendingButton).toHaveAttribute("aria-disabled", "true");
    expect(pendingButton).toHaveAttribute("aria-busy", "true");
    expect(pendingButton).not.toBeDisabled(); // a disabled button would throw focus away
    expect(pendingButton).toHaveFocus();
    expect(status()).toHaveTextContent(LOAD_MORE_PENDING_LABEL);
    expect(rowNumbers()).toEqual(["INV-A"]); // nothing appended yet

    await act(async () => request.resolve(ok(CURSOR_1, ["in_b"], CURSOR_2)));

    await waitFor(() => expect(rowNumbers()).toEqual(["INV-A", "INV-B"]));
    expect(
      screen.queryByRole("button", { name: LOAD_MORE_PENDING_LABEL }),
    ).not.toBeInTheDocument();
    expect(loadMoreButton()).toHaveFocus(); // still where the user was
  });

  it("announces what was appended through one live region", async () => {
    action.loadMoreInvoices.mockResolvedValue(ok(CURSOR_1, ["in_b", "in_c"], CURSOR_2));
    const user = userEvent.setup();
    render(<InvoiceHistoryList initial={page(["in_a"], CURSOR_1)} />);

    const live = status();
    expect(live).toHaveAttribute("aria-live", "polite");
    expect(live).toHaveAttribute("aria-atomic", "true");

    await user.click(loadMoreButton()!);

    await waitFor(() => expect(live).toHaveTextContent(loadedAnnouncement(2, 3)));
    expect(live).toHaveTextContent("Loaded 2 more invoices. 3 invoices shown.");
    expect(screen.getAllByRole("status")).toHaveLength(1); // the same element throughout
  });

  it("issues one request for a double click, and shows the page once", async () => {
    const request = deferred<LoadMoreInvoicesResult>();
    action.loadMoreInvoices.mockReturnValue(request.promise);
    const user = userEvent.setup();
    render(<InvoiceHistoryList initial={page(["in_a"], CURSOR_1)} />);

    await user.dblClick(loadMoreButton()!);

    await act(async () => request.resolve(ok(CURSOR_1, ["in_b", "in_c"], null)));

    await waitFor(() => expect(rowNumbers()).toEqual(["INV-A", "INV-B", "INV-C"]));
    expect(action.loadMoreInvoices).toHaveBeenCalledTimes(1);
  });

  it("ignores Enter/Space repeats while a page is in flight", async () => {
    const request = deferred<LoadMoreInvoicesResult>();
    action.loadMoreInvoices.mockReturnValue(request.promise);
    const user = userEvent.setup();
    render(<InvoiceHistoryList initial={page(["in_a"], CURSOR_1)} />);

    loadMoreButton()!.focus();
    await user.keyboard("{Enter}{Enter} ");

    await act(async () => request.resolve(ok(CURSOR_1, ["in_b"], null)));

    await waitFor(() => expect(rowNumbers()).toEqual(["INV-A", "INV-B"]));
    expect(action.loadMoreInvoices).toHaveBeenCalledTimes(1);
  });

  it("drops an invoice the next page repeats instead of listing it twice, and says how many were new", async () => {
    action.loadMoreInvoices.mockResolvedValue(
      ok(CURSOR_1, ["in_b", "in_c", "in_c"], CURSOR_2),
    );
    const user = userEvent.setup();
    render(<InvoiceHistoryList initial={page(["in_a", "in_b"], CURSOR_1)} />);

    await user.click(loadMoreButton()!);

    await waitFor(() => expect(status()).toHaveTextContent(loadedAnnouncement(1, 3)));
    expect(rowNumbers()).toEqual(["INV-A", "INV-B", "INV-C"]);
  });

  it("ignores an answer to a different cursor than the one it asked for", async () => {
    action.loadMoreInvoices.mockResolvedValue(ok(CURSOR_2, ["in_z"], null)); // mismatched echo
    const user = userEvent.setup();
    render(<InvoiceHistoryList initial={page(["in_a"], CURSOR_1)} />);

    await user.click(loadMoreButton()!);

    expect(await screen.findByRole("alert")).toHaveTextContent(
      LOAD_MORE_INVOICES_COPY.retry,
    );
    expect(rowNumbers()).toEqual(["INV-A"]);
    expect(loadMoreButton()).toBeEnabled(); // the same page can be asked for again
  });

  it("says so when the last page has been reached, and moves focus to that message", async () => {
    action.loadMoreInvoices.mockResolvedValue(ok(CURSOR_1, ["in_b"], null));
    const user = userEvent.setup();
    render(<InvoiceHistoryList initial={page(["in_a"], CURSOR_1)} />);

    await user.click(loadMoreButton()!);

    await waitFor(() => expect(status()).toHaveTextContent(END_OF_LIST_TEXT));
    expect(loadMoreButton()).not.toBeInTheDocument();
    await waitFor(() => expect(status()).toHaveFocus()); // the button is gone; focus did not fall to the document
    expect(rowNumbers()).toEqual(["INV-A", "INV-B"]);
  });

  it("handles a final page that is empty (only drafts were left) as the end, keeping the rows", async () => {
    action.loadMoreInvoices.mockResolvedValue(ok(CURSOR_1, [], null));
    const user = userEvent.setup();
    render(<InvoiceHistoryList initial={page(["in_a"], CURSOR_1)} />);

    await user.click(loadMoreButton()!);

    await waitFor(() => expect(status()).toHaveTextContent(END_OF_LIST_TEXT));
    expect(rowNumbers()).toEqual(["INV-A"]);
    expect(loadMoreButton()).not.toBeInTheDocument();
  });

  it("reads as empty — not 'there may be more' — once an empty scan reaches the end", async () => {
    action.loadMoreInvoices.mockResolvedValue(ok(CURSOR_1, [], null));
    const user = userEvent.setup();
    const { container } = render(<InvoiceHistoryList initial={page([], CURSOR_1)} />);

    await user.click(loadMoreButton()!);

    await waitFor(() =>
      expect(container.querySelector('[data-invoice-page="empty"]')).toHaveTextContent(
        /No invoices have been issued yet/,
      ),
    );
    expect(screen.queryByText(/there may be older ones/)).not.toBeInTheDocument();
  });
});

describe("InvoiceHistoryList – failures", () => {
  it("shows the message, keeps the rows and lets the user retry the same page", async () => {
    action.loadMoreInvoices.mockResolvedValueOnce(failed(CURSOR_1));
    const user = userEvent.setup();
    render(<InvoiceHistoryList initial={page(["in_a"], CURSOR_1)} />);

    await user.click(loadMoreButton()!);

    expect(await screen.findByRole("alert")).toHaveTextContent(
      LOAD_MORE_INVOICES_COPY.retry,
    );
    expect(rowNumbers()).toEqual(["INV-A"]);
    expect(loadMoreButton()).toBeEnabled();
    expect(loadMoreButton()).toHaveFocus();

    action.loadMoreInvoices.mockResolvedValueOnce(ok(CURSOR_1, ["in_b"], null));
    await user.click(loadMoreButton()!);

    await waitFor(() => expect(rowNumbers()).toEqual(["INV-A", "INV-B"]));
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
    expect(action.loadMoreInvoices).toHaveBeenNthCalledWith(2, CURSOR_1); // the same page again
  });

  it("asks for a reload when a retry cannot help (the cursor or the records are out of date)", async () => {
    action.loadMoreInvoices.mockResolvedValue(failed(CURSOR_1, true));
    const user = userEvent.setup();
    render(<InvoiceHistoryList initial={page(["in_a"], CURSOR_1)} />);

    await user.click(loadMoreButton()!);

    expect(await screen.findByRole("alert")).toHaveTextContent(/Reload the page/);
    expect(rowNumbers()).toEqual(["INV-A"]);
  });

  it("treats an action that throws (network, server error) as a failed attempt, not a crash", async () => {
    action.loadMoreInvoices.mockRejectedValueOnce(new Error("Failed to fetch"));
    const user = userEvent.setup();
    render(<InvoiceHistoryList initial={page(["in_a"], CURSOR_1)} />);

    await user.click(loadMoreButton()!);

    expect(await screen.findByRole("alert")).toHaveTextContent(
      LOAD_MORE_INVOICES_COPY.retry,
    );
    expect(screen.getByRole("alert")).not.toHaveTextContent(/Failed to fetch/);
    expect(rowNumbers()).toEqual(["INV-A"]);
    expect(loadMoreButton()).toBeEnabled();
  });

  it("clears the message once a retry succeeds", async () => {
    action.loadMoreInvoices
      .mockRejectedValueOnce(new Error("boom"))
      .mockResolvedValueOnce(ok(CURSOR_1, ["in_b"], null));
    const user = userEvent.setup();
    render(<InvoiceHistoryList initial={page(["in_a"], CURSOR_1)} />);

    await user.click(loadMoreButton()!);
    await screen.findByRole("alert");
    await user.click(loadMoreButton()!);

    // The message is cleared as the retry starts; the rows follow when it succeeds.
    await waitFor(() => expect(rowNumbers()).toEqual(["INV-A", "INV-B"]));
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
  });
});

describe("InvoiceHistoryList – with filters (multi-page searches)", () => {
  it("says how far it looked from the start, and offers to keep going", () => {
    render(<InvoiceHistoryList initial={page(["in_a"], CURSOR_1, 250)} filtersActive />);

    expect(status()).toHaveTextContent(checkedSoFar(250));
    expect(loadMoreButton()).toBeEnabled();
  });

  it("reads a number search as searching older invoices, including while pending", async () => {
    const request = deferred<LoadMoreInvoicesResult>();
    action.loadMoreInvoices.mockReturnValue(request.promise);
    const user = userEvent.setup();
    render(
      <InvoiceHistoryList initial={page(["in_a"], CURSOR_1)} filtersActive searching />,
    );

    const button = screen.getByRole("button", { name: SEARCH_MORE_LABEL });
    expect(
      screen.queryByRole("button", { name: LOAD_MORE_LABEL }),
    ).not.toBeInTheDocument();

    await user.click(button);

    expect(
      await screen.findByRole("button", { name: SEARCH_MORE_PENDING_LABEL }),
    ).toHaveAttribute("aria-disabled", "true");
    expect(status()).toHaveTextContent(SEARCH_MORE_PENDING_LABEL);
    await act(async () => request.resolve(ok(CURSOR_1, [], null)));
  });

  it("announces each instalment of a search: what was found and how far it got", async () => {
    action.loadMoreInvoices
      .mockResolvedValueOnce(ok(CURSOR_1, [], CURSOR_2, 1000))
      .mockResolvedValueOnce(ok(CURSOR_2, ["in_b"], null, 400));
    const user = userEvent.setup();
    render(
      <InvoiceHistoryList
        initial={page(["in_a"], CURSOR_1, 1000)}
        filtersActive
        searching
      />,
    );

    await user.click(screen.getByRole("button", { name: SEARCH_MORE_LABEL }));

    await waitFor(() =>
      expect(status()).toHaveTextContent(
        `${loadedAnnouncement(0, 1)} ${checkedSoFar(2000)}`,
      ),
    );
    expect(status()).toHaveTextContent(
      "No new invoices. 1 invoice shown. Checked 2,000 invoices so far.",
    );

    await user.click(screen.getByRole("button", { name: SEARCH_MORE_LABEL }));

    await waitFor(() => expect(status()).toHaveTextContent(endAnnouncement(true, 2400)));
    expect(status()).toHaveTextContent(
      `${END_OF_MATCHES_TEXT} Checked all 2,400 invoices.`,
    );
    expect(status()).toHaveFocus();
    expect(rowNumbers()).toEqual(["INV-A", "INV-B"]);
  });

  it("says 'no more matches' at the end of a filtered listing, never 'that's all of your invoices'", async () => {
    action.loadMoreInvoices.mockResolvedValue(ok(CURSOR_1, [], null, 50));
    const user = userEvent.setup();
    render(<InvoiceHistoryList initial={page(["in_a"], CURSOR_1, 100)} filtersActive />);

    await user.click(loadMoreButton()!);

    await waitFor(() => expect(status()).toHaveTextContent(END_OF_MATCHES_TEXT));
    expect(screen.queryByText(END_OF_LIST_TEXT)).not.toBeInTheDocument();
  });

  it("reports an empty filtered scan honestly: 'no matches among N checked' while more remains, 'no matches' at the end", async () => {
    action.loadMoreInvoices.mockResolvedValue(ok(CURSOR_1, [], null, 200));
    const user = userEvent.setup();
    const { container } = render(
      <InvoiceHistoryList initial={page([], CURSOR_1, 1000)} filtersActive searching />,
    );

    expect(
      container.querySelector('[data-invoice-page="empty-with-more"]'),
    ).toHaveTextContent(/No matching invoices among the 1,000 checked so far/);
    expect(screen.queryByText(/No invoices have been issued/)).not.toBeInTheDocument();

    await user.click(screen.getByRole("button", { name: SEARCH_MORE_LABEL }));

    await waitFor(() =>
      expect(container.querySelector('[data-invoice-page="empty"]')).toHaveTextContent(
        NO_MATCHES_TEXT,
      ),
    );
    expect(screen.queryByRole("button")).not.toBeInTheDocument();
    expect(status()).toHaveTextContent(endAnnouncement(true, 1200));
  });

  it("keeps document links in a filtered listing", () => {
    render(<InvoiceHistoryList initial={page(["in_a"], null)} filtersActive />);

    expect(docLink(table(), "PDF")).toHaveAttribute(
      "href",
      `/billing/invoices/${encodeInvoiceKey("in_a")}/pdf`,
    );
  });
});
