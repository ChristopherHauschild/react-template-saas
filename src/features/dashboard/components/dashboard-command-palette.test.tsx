import { act, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { DASHBOARD_NAV_ITEMS } from "../config/navigation";
import { useCommandPalette } from "../store/useCommandPalette";

import { DashboardCommandPalette } from "./dashboard-command-palette";

const nav = await vi.hoisted(async () =>
  (await import("@/shared/test/next-navigation")).createNextNavigationMock("/dashboard"),
);
vi.mock("next/navigation", () => nav.module);
// Fixture: one available destination of each kind is needed below (links vs.
// "coming soon" entries), independently of which pages have actually shipped.
// The real flags are covered by navigation.test.ts and dashboard-navigation.test.tsx.
vi.mock("@/config/featureFlags", () => ({
  featureFlags: { billing: true, settings: false, exports: false, support: false },
}));

const labelOf = (option: HTMLElement) =>
  option.querySelector("[data-slot='command-item-label']")?.textContent;

async function openPalette() {
  act(() => useCommandPalette.getState().openPalette());

  return screen.findByRole("dialog", { name: /command palette/i });
}

describe("DashboardCommandPalette", () => {
  beforeEach(() => {
    nav.reset("/dashboard");
    useCommandPalette.setState({ open: false });
  });

  it("is closed by default", () => {
    render(<DashboardCommandPalette />);

    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
  });

  it("toggles with Ctrl+K and Cmd+K (case-insensitive)", async () => {
    const user = userEvent.setup();
    render(<DashboardCommandPalette />);

    await user.keyboard("{Control>}k{/Control}");
    expect(await screen.findByRole("dialog")).toBeInTheDocument();
    expect(useCommandPalette.getState().open).toBe(true);

    await user.keyboard("{Meta>}K{/Meta}");
    await waitFor(() => expect(screen.queryByRole("dialog")).not.toBeInTheDocument());
    expect(useCommandPalette.getState().open).toBe(false);
  });

  it("ignores a bare 'k' keypress", async () => {
    const user = userEvent.setup();
    render(<DashboardCommandPalette />);

    await user.keyboard("k");

    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
  });

  it("moves focus into the search input and lists every navigation item", async () => {
    render(
      <>
        <main>page content</main>
        <DashboardCommandPalette />
      </>,
    );

    const dialog = await openPalette();

    // Modal: page content is hidden from assistive tech while the palette is open.
    expect(
      screen.getByText("page content").closest("[aria-hidden='true']"),
    ).not.toBeNull();

    const input = within(dialog).getByPlaceholderText(/search pages/i);
    await waitFor(() => expect(input).toHaveFocus());

    const options = within(dialog).getAllByRole("option");
    expect(options.map(labelOf)).toEqual(DASHBOARD_NAV_ITEMS.map((item) => item.label));
  });

  it("lists unavailable destinations as disabled items with a hint", async () => {
    render(<DashboardCommandPalette />);

    const dialog = await openPalette();

    for (const item of DASHBOARD_NAV_ITEMS) {
      const option = within(dialog).getByRole("option", {
        name: new RegExp(`^${item.label}`),
      });

      if (item.available) {
        expect(option).not.toHaveAttribute("aria-disabled", "true");
        expect(option.querySelector("[data-slot='command-item-hint']")).toBeNull();
      } else {
        expect(option).toHaveAttribute("aria-disabled", "true");
        expect(option.querySelector("[data-slot='command-item-hint']")).toHaveTextContent(
          /coming soon/i,
        );
      }
    }
  });

  it("filters items (including keywords) and shows an empty state", async () => {
    const user = userEvent.setup();
    render(<DashboardCommandPalette />);

    const dialog = await openPalette();
    const input = within(dialog).getByPlaceholderText(/search pages/i);
    await waitFor(() => expect(input).toHaveFocus());

    await user.keyboard("bill");
    await waitFor(() => {
      const options = within(dialog).getAllByRole("option");
      expect(options.map(labelOf)).toEqual(["Billing"]);
    });

    await user.clear(input);
    await user.keyboard("invoices");
    await waitFor(() => {
      const options = within(dialog).getAllByRole("option");
      expect(options.map(labelOf)).toEqual(["Billing"]);
    });

    await user.clear(input);
    await user.keyboard("zzzz-no-match");
    await waitFor(() => {
      expect(within(dialog).queryAllByRole("option")).toHaveLength(0);
      expect(within(dialog).getByText(/no results/i)).toBeInTheDocument();
    });
  });

  it("keyboard navigation skips unavailable items and Enter navigates to the selected one", async () => {
    const user = userEvent.setup();
    render(<DashboardCommandPalette />);

    const dialog = await openPalette();
    await waitFor(() =>
      expect(within(dialog).getByPlaceholderText(/search pages/i)).toHaveFocus(),
    );

    const dashboard = within(dialog).getByRole("option", { name: "Dashboard" });
    await waitFor(() => expect(dashboard).toHaveAttribute("aria-selected", "true"));

    // Billing is available: the first ArrowDown lands on it.
    await user.keyboard("{ArrowDown}");
    const billing = within(dialog).getByRole("option", { name: "Billing" });
    await waitFor(() => expect(billing).toHaveAttribute("aria-selected", "true"));

    // Settings is disabled: arrowing must never land on it, so the next
    // ArrowDown loops back to Dashboard.
    await user.keyboard("{ArrowDown}");
    await waitFor(() => expect(dashboard).toHaveAttribute("aria-selected", "true"));
    expect(within(dialog).getByRole("option", { name: /^Settings/ })).not.toHaveAttribute(
      "aria-selected",
      "true",
    );

    await user.keyboard("{ArrowUp}{Enter}");

    expect(nav.router.push).toHaveBeenCalledTimes(1);
    expect(nav.router.push).toHaveBeenCalledWith("/billing");
    await waitFor(() => expect(screen.queryByRole("dialog")).not.toBeInTheDocument());
    expect(useCommandPalette.getState().open).toBe(false);
  });

  it("Enter on a filtered-down unavailable item does not navigate to a 404", async () => {
    const user = userEvent.setup();
    render(<DashboardCommandPalette />);

    const dialog = await openPalette();
    await waitFor(() =>
      expect(within(dialog).getByPlaceholderText(/search pages/i)).toHaveFocus(),
    );

    // The full word: a prefix like "sett" also fuzzy-matches Support's keywords.
    await user.keyboard("settings");
    await waitFor(() =>
      expect(within(dialog).getAllByRole("option").map(labelOf)).toEqual(["Settings"]),
    );

    await user.keyboard("{Enter}");

    expect(nav.router.push).not.toHaveBeenCalled();
    expect(screen.getByRole("dialog")).toBeInTheDocument();
    expect(useCommandPalette.getState().open).toBe(true);
  });

  it("navigates on click for available items only", async () => {
    const user = userEvent.setup();
    render(<DashboardCommandPalette />);

    const dialog = await openPalette();

    await user.click(within(dialog).getByRole("option", { name: /^Settings/ }));
    expect(nav.router.push).not.toHaveBeenCalled();
    expect(screen.getByRole("dialog")).toBeInTheDocument();

    await user.click(within(dialog).getByRole("option", { name: "Dashboard" }));
    expect(nav.router.push).toHaveBeenCalledWith("/dashboard");
    await waitFor(() => expect(screen.queryByRole("dialog")).not.toBeInTheDocument());
  });

  it("navigates to /billing on click: Billing is a real destination, without a hint", async () => {
    const user = userEvent.setup();
    render(<DashboardCommandPalette />);

    const dialog = await openPalette();
    const billing = within(dialog).getByRole("option", { name: "Billing" });
    expect(billing).not.toHaveAttribute("aria-disabled", "true");
    expect(billing.querySelector("[data-slot='command-item-hint']")).toBeNull();

    await user.click(billing);

    expect(nav.router.push).toHaveBeenCalledTimes(1);
    expect(nav.router.push).toHaveBeenCalledWith("/billing");
    await waitFor(() => expect(screen.queryByRole("dialog")).not.toBeInTheDocument());
  });

  it("closes on Escape and restores focus to the previously focused element", async () => {
    const user = userEvent.setup();
    render(
      <>
        <button type="button">before</button>
        <DashboardCommandPalette />
      </>,
    );

    const before = screen.getByRole("button", { name: "before" });
    before.focus();

    const dialog = await openPalette();
    await waitFor(() =>
      expect(within(dialog).getByPlaceholderText(/search pages/i)).toHaveFocus(),
    );

    await user.keyboard("{Escape}");

    await waitFor(() => expect(screen.queryByRole("dialog")).not.toBeInTheDocument());
    expect(useCommandPalette.getState().open).toBe(false);
    expect(nav.router.push).not.toHaveBeenCalled();
    await waitFor(() => expect(before).toHaveFocus());
  });
});
