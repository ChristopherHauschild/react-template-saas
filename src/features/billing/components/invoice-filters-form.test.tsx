import { fireEvent, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { parseInvoiceFilters } from "../services/invoice-filters";

// The form navigates through the app router inside a transition. The router is
// the shared mock; the transition's `pending` flag is put under test control so
// the feedback shown while Next renders the next page can be asserted.
const nav = await vi.hoisted(async () =>
  (await import("@/shared/test/next-navigation")).createNextNavigationMock("/billing"),
);
vi.mock("next/navigation", () => nav.module);

const transition = vi.hoisted(() => ({ pending: false, started: 0 }));
vi.mock("react", async (importOriginal) => {
  const React = await importOriginal<typeof import("react")>();
  return {
    ...React,
    useTransition: () =>
      [
        transition.pending,
        (callback: () => void) => {
          transition.started++;
          callback();
        },
      ] as const,
  };
});

import {
  APPLY_FILTERS_LABEL,
  APPLY_FILTERS_PENDING_LABEL,
  CLEAR_FILTERS_LABEL,
  CLEAR_FILTERS_PENDING_LABEL,
  FILTERS_PENDING_TEXT,
  filtersHref,
  InvoiceFiltersForm,
} from "./invoice-filters-form";

const NONE = parseInvoiceFilters({});
const PAID_ABCD = parseInvoiceFilters({ status: "paid", q: "ABCD" });
const DATES = parseInvoiceFilters({ from: "2026-01-01", to: "2026-06-30" });

const form = () => screen.getByRole("form", { name: "Filter invoices" });
const statusSelect = () =>
  screen.getByRole("combobox", { name: "Status" }) as HTMLSelectElement;
const numberInput = () =>
  screen.getByRole("searchbox", { name: "Invoice number" }) as HTMLInputElement;
const fromInput = () => screen.getByLabelText("From") as HTMLInputElement;
const toInput = () => screen.getByLabelText("To") as HTMLInputElement;
const applyButton = () => screen.getByRole("button", { name: /Apply/ });

beforeEach(() => {
  nav.reset("/billing");
  transition.pending = false;
  transition.started = 0;
});

describe("InvoiceFiltersForm – submitting", () => {
  it("navigates client-side to the canonical URL for the fields, keeping the scroll position", async () => {
    const user = userEvent.setup();
    render(<InvoiceFiltersForm parsed={NONE} />);

    await user.selectOptions(statusSelect(), "paid");
    await user.type(numberInput(), " abcd-0042 ");
    await user.click(applyButton());

    expect(nav.router.push).toHaveBeenCalledTimes(1);
    expect(nav.router.push).toHaveBeenCalledWith("/billing?status=paid&q=abcd-0042", {
      scroll: false,
    });
    expect(transition.started).toBe(1); // inside a transition: that is where `pending` comes from
  });

  it("leaves empty fields out of the URL (a native submit would send from=&to=)", () => {
    expect(filtersHref({ status: "", from: "", to: "", number: "" })).toBe("/billing");
    expect(filtersHref({ status: "void", from: "2026-01-01", to: "", number: "" })).toBe(
      "/billing?status=void&from=2026-01-01",
    );
  });

  it("prevents the native submit, but stays a GET form for browsers without JavaScript", () => {
    render(<InvoiceFiltersForm parsed={NONE} />);

    expect(form()).toHaveAttribute("method", "get");
    expect(form()).toHaveAttribute("action", "/billing");

    const submit = fireEvent.submit(form()); // returns false when preventDefault() was called

    expect(submit).toBe(false);
    expect(nav.router.push).toHaveBeenCalledWith("/billing", { scroll: false });
  });

  it("ignores a second submit while a navigation is pending", async () => {
    transition.pending = true;
    const user = userEvent.setup();
    render(<InvoiceFiltersForm parsed={NONE} />);

    await user.click(applyButton());
    fireEvent.submit(form());

    expect(nav.router.push).not.toHaveBeenCalled();
  });
});

describe("InvoiceFiltersForm – loading feedback during the navigation", () => {
  it("marks the form and the Apply button busy, relabels it, and tells screen readers the list is updating", async () => {
    const user = userEvent.setup();
    const { rerender } = render(<InvoiceFiltersForm parsed={NONE} />);

    await user.click(applyButton());
    expect(nav.router.push).toHaveBeenCalledTimes(1);

    // Next is now rendering the new page: the transition is pending.
    transition.pending = true;
    rerender(<InvoiceFiltersForm parsed={NONE} />);

    const busy = screen.getByRole("button", { name: APPLY_FILTERS_PENDING_LABEL });
    expect(busy).toHaveAttribute("aria-disabled", "true");
    expect(busy).toHaveAttribute("aria-busy", "true");
    expect(busy).not.toBeDisabled(); // focus must not be thrown away
    expect(form()).toHaveAttribute("aria-busy", "true");
    expect(screen.getByRole("status")).toHaveTextContent(FILTERS_PENDING_TEXT);
  });

  it("keeps focus on the button and announces the result once the new page has rendered", async () => {
    const user = userEvent.setup();
    const { rerender } = render(
      <InvoiceFiltersForm
        parsed={NONE}
        resultSummary="25 invoices shown, more available."
      />,
    );

    await user.selectOptions(statusSelect(), "paid");
    await user.type(numberInput(), "ABCD");
    await user.click(applyButton());
    expect(applyButton()).toHaveFocus();

    transition.pending = true;
    rerender(
      <InvoiceFiltersForm
        parsed={NONE}
        resultSummary="25 invoices shown, more available."
      />,
    );
    expect(
      screen.getByRole("button", { name: APPLY_FILTERS_PENDING_LABEL }),
    ).toHaveFocus();

    // The navigation finished: the server rendered the form for the new URL.
    transition.pending = false;
    rerender(
      <InvoiceFiltersForm
        parsed={PAID_ABCD}
        resultSummary="10 invoices shown, more available."
      />,
    );

    expect(screen.getByRole("button", { name: APPLY_FILTERS_LABEL })).toHaveFocus();
    expect(screen.getByRole("status")).toHaveTextContent(
      "10 invoices shown, more available.",
    );
    expect(form()).not.toHaveAttribute("aria-busy");
    expect(statusSelect().value).toBe("paid");
    expect(numberInput().value).toBe("ABCD");
  });

  it("moves focus to Apply once clearing has removed the Clear link (focus never falls to the document)", async () => {
    const user = userEvent.setup();
    const { rerender } = render(<InvoiceFiltersForm parsed={PAID_ABCD} />);

    const clear = screen.getByRole("link", { name: CLEAR_FILTERS_LABEL });
    clear.focus();
    await user.keyboard("{Enter}");
    expect(nav.router.push).toHaveBeenCalledWith("/billing", { scroll: false });

    transition.pending = true;
    rerender(<InvoiceFiltersForm parsed={PAID_ABCD} />);
    expect(screen.getByRole("link", { name: CLEAR_FILTERS_PENDING_LABEL })).toHaveFocus();

    // The navigation finished: no filters, so there is nothing to clear any more.
    transition.pending = false;
    rerender(
      <InvoiceFiltersForm
        parsed={NONE}
        resultSummary="25 invoices shown, more available."
      />,
    );

    expect(screen.queryByRole("link", { name: /Clear/ })).not.toBeInTheDocument();
    expect(applyButton()).toHaveFocus();
    expect(document.activeElement).not.toBe(document.body);
    expect(screen.getByRole("status")).toHaveTextContent(
      "25 invoices shown, more available.",
    );
  });

  it("leaves focus alone when an Apply navigation finishes (the button is still there)", async () => {
    const user = userEvent.setup();
    const { rerender } = render(<InvoiceFiltersForm parsed={NONE} />);

    await user.click(numberInput());
    await user.keyboard("ABCD{Enter}"); // submit from the field
    expect(numberInput()).toHaveFocus();

    transition.pending = true;
    rerender(<InvoiceFiltersForm parsed={NONE} />);
    transition.pending = false;
    rerender(<InvoiceFiltersForm parsed={parseInvoiceFilters({ q: "ABCD" })} />);

    expect(numberInput()).toHaveFocus(); // not yanked to Apply
  });

  it("gives the Clear link the same treatment", async () => {
    const user = userEvent.setup();
    const { rerender } = render(<InvoiceFiltersForm parsed={PAID_ABCD} />);

    await user.click(screen.getByRole("link", { name: CLEAR_FILTERS_LABEL }));

    expect(nav.router.push).toHaveBeenCalledWith("/billing", { scroll: false });

    transition.pending = true;
    rerender(<InvoiceFiltersForm parsed={PAID_ABCD} />);

    const clearing = screen.getByRole("link", { name: CLEAR_FILTERS_PENDING_LABEL });
    expect(clearing).toHaveAttribute("aria-busy", "true");
    expect(clearing).toHaveAttribute("href", "/billing"); // still a real link without JavaScript
    expect(screen.getByRole("status")).toHaveTextContent(FILTERS_PENDING_TEXT);
  });
});

describe("InvoiceFiltersForm – the fields follow the URL", () => {
  it("shows what the URL says on first render", () => {
    render(<InvoiceFiltersForm parsed={PAID_ABCD} />);

    expect(statusSelect().value).toBe("paid");
    expect(numberInput().value).toBe("ABCD");
    expect(fromInput().value).toBe("");
  });

  it("keeps what the user typed while the URL has not changed", async () => {
    const user = userEvent.setup();
    const { rerender } = render(<InvoiceFiltersForm parsed={NONE} />);

    await user.type(numberInput(), "WXYZ");
    await user.selectOptions(statusSelect(), "void");
    rerender(<InvoiceFiltersForm parsed={NONE} resultSummary="unrelated re-render" />);

    expect(numberInput().value).toBe("WXYZ");
    expect(statusSelect().value).toBe("void");
  });

  it("resets to the new URL after Clear, even over something typed meanwhile", async () => {
    const user = userEvent.setup();
    const { rerender } = render(<InvoiceFiltersForm parsed={PAID_ABCD} />);

    await user.clear(numberInput());
    await user.type(numberInput(), "typed-but-not-applied");

    // Clear navigated to /billing; the server rendered the form for it.
    rerender(<InvoiceFiltersForm parsed={NONE} />);

    expect(numberInput().value).toBe("");
    expect(statusSelect().value).toBe("");
    expect(
      screen.queryByRole("link", { name: CLEAR_FILTERS_LABEL }),
    ).not.toBeInTheDocument();
  });

  it("follows the browser's back and forward buttons (each is a render for that URL)", async () => {
    const user = userEvent.setup();
    const { rerender } = render(<InvoiceFiltersForm parsed={NONE} />);

    // Forward through three URLs, then back through them: the fields track each one.
    rerender(<InvoiceFiltersForm parsed={PAID_ABCD} />);
    expect([statusSelect().value, numberInput().value, fromInput().value]).toEqual([
      "paid",
      "ABCD",
      "",
    ]);

    rerender(<InvoiceFiltersForm parsed={DATES} />);
    expect([statusSelect().value, fromInput().value, toInput().value]).toEqual([
      "",
      "2026-01-01",
      "2026-06-30",
    ]);

    await user.type(numberInput(), "edit"); // an edit that was never applied …

    rerender(<InvoiceFiltersForm parsed={PAID_ABCD} />); // … back
    expect([statusSelect().value, numberInput().value, fromInput().value]).toEqual([
      "paid",
      "ABCD",
      "",
    ]);

    rerender(<InvoiceFiltersForm parsed={NONE} />); // … back again
    expect([statusSelect().value, numberInput().value]).toEqual(["", ""]);

    rerender(<InvoiceFiltersForm parsed={DATES} />); // forward
    expect([fromInput().value, toInput().value]).toEqual(["2026-01-01", "2026-06-30"]);
  });

  it("does not remount the fields when the URL changes (focus and pending state survive)", async () => {
    const user = userEvent.setup();
    const { rerender } = render(<InvoiceFiltersForm parsed={NONE} />);
    const input = numberInput();

    await user.click(input);
    rerender(<InvoiceFiltersForm parsed={PAID_ABCD} />);

    expect(numberInput()).toBe(input);
    expect(input).toHaveFocus();
  });

  it("shows invalid input back with its messages", () => {
    render(
      <InvoiceFiltersForm parsed={parseInvoiceFilters({ status: "draft", q: "!!" })} />,
    );

    expect(numberInput().value).toBe("!!");
    expect(statusSelect()).toHaveAttribute("aria-invalid", "true");
    expect(screen.getAllByRole("alert")).toHaveLength(2);
    expect(screen.getByRole("link", { name: CLEAR_FILTERS_LABEL })).toBeInTheDocument();
  });
});
