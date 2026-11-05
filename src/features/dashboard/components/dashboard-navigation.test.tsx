/**
 * Integration: header + sidebar + command palette wired through the stores,
 * the way the dashboard layout renders them.
 */
import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { DASHBOARD_NAV_ITEMS } from "../config/navigation";
import { useCommandPalette } from "../store/useCommandPalette";
import { useSidebar } from "../store/useSidebar";

import { DashboardCommandPalette } from "./dashboard-command-palette";
import { DashboardHeader } from "./dashboard-header";
import { DashboardSidebar } from "./dashboard-sidebar";

const nav = await vi.hoisted(async () =>
  (await import("@/shared/test/next-navigation")).createNextNavigationMock("/dashboard"),
);
vi.mock("next/navigation", () => nav.module);

// Sign-out is covered in dashboard-header.sign-out.test.tsx; a no-op will do here.
const signOutAction = vi.fn(async () => {});
const account = { name: "Jane Doe", email: "jane@example.com", initials: "JD" };

// Fixtures come from the real navigation config, not from hard-coded labels:
// when a feature flag flips, a destination moves from one list to the other and
// these tests follow it instead of going stale (Billing did exactly that).
const availableItems = DASHBOARD_NAV_ITEMS.filter((item) => item.available);
const unavailableItems = DASHBOARD_NAV_ITEMS.filter((item) => !item.available);
/** Enough of a label to single it out in the palette's search. */
const searchFor = (label: string) => label.slice(0, 4).toLowerCase();

function renderDashboardChrome() {
  return render(
    <>
      <DashboardSidebar />
      <DashboardHeader user={account} signOutAction={signOutAction} />
      <DashboardCommandPalette />
    </>,
  );
}

describe("dashboard navigation (integration)", () => {
  beforeEach(() => {
    nav.reset("/dashboard");
    useSidebar.setState({ collapsed: false, mobileOpen: false });
    useCommandPalette.setState({ open: false });
  });

  it("search trigger -> palette -> select page -> palette closes and focus returns", async () => {
    const user = userEvent.setup();
    renderDashboardChrome();

    const search = screen.getByRole("button", { name: /search/i });
    await user.click(search);

    const dialog = await screen.findByRole("dialog", { name: /command palette/i });
    await waitFor(() =>
      expect(within(dialog).getByPlaceholderText(/search pages/i)).toHaveFocus(),
    );

    await user.keyboard("dash{Enter}");

    expect(nav.router.push).toHaveBeenCalledWith("/dashboard");
    await waitFor(() => expect(screen.queryByRole("dialog")).not.toBeInTheDocument());
    await waitFor(() => expect(search).toHaveFocus());
  });

  it("the fixtures reflect the current flags (Billing, Exports, Settings and Support shipped)", () => {
    // If this fails, the flags changed: update the expectations below knowingly.
    // With nothing unavailable the `it.each(unavailableItems)` block below is
    // empty; the "coming soon" rendering is covered with mocked flags in
    // dashboard-navigation.flags.test.tsx and unavailable-nav.test.tsx.
    expect(availableItems.map((item) => item.href)).toEqual([
      "/dashboard",
      "/billing",
      "/exports",
      "/settings",
      "/support",
    ]);
    expect(unavailableItems.map((item) => item.href)).toEqual([]);
  });

  it.each(availableItems.filter((item) => item.href !== "/dashboard"))(
    "search trigger -> palette -> available page ($label): navigates, palette closes, focus returns",
    async (item) => {
      const user = userEvent.setup();
      renderDashboardChrome();

      const search = screen.getByRole("button", { name: /search/i });
      await user.click(search);
      const dialog = await screen.findByRole("dialog", { name: /command palette/i });
      await waitFor(() =>
        expect(within(dialog).getByPlaceholderText(/search pages/i)).toHaveFocus(),
      );

      await user.keyboard(`${searchFor(item.label)}{Enter}`);

      expect(nav.router.push).toHaveBeenCalledTimes(1);
      expect(nav.router.push).toHaveBeenCalledWith(item.href);
      await waitFor(() => expect(screen.queryByRole("dialog")).not.toBeInTheDocument());
      await waitFor(() => expect(search).toHaveFocus());
    },
  );

  it.each(unavailableItems)(
    "search trigger -> palette -> unavailable page ($label): no navigation, palette stays open",
    async (item) => {
      const user = userEvent.setup();
      renderDashboardChrome();

      await user.click(screen.getByRole("button", { name: /search/i }));
      const dialog = await screen.findByRole("dialog", { name: /command palette/i });
      await waitFor(() =>
        expect(within(dialog).getByPlaceholderText(/search pages/i)).toHaveFocus(),
      );

      await user.keyboard(`${searchFor(item.label)}{Enter}`);

      expect(nav.router.push).not.toHaveBeenCalled();
      expect(screen.getByRole("dialog")).toBeInTheDocument();
    },
  );

  it("sidebar and palette agree with the header on where Billing lives", () => {
    nav.setPathname("/billing");
    renderDashboardChrome();

    const link = screen.getAllByRole("link", { name: "Billing" })[0];
    expect(link).toHaveAttribute("href", "/billing");
    expect(link).toHaveAttribute("aria-current", "page");
    expect(screen.getByRole("heading", { level: 1 })).toHaveTextContent("Billing");
  });

  it("sidebar, account menu and header agree on where Settings lives", async () => {
    const user = userEvent.setup();
    nav.setPathname("/settings");
    renderDashboardChrome();

    const link = screen.getAllByRole("link", { name: "Settings" })[0];
    expect(link).toHaveAttribute("href", "/settings");
    expect(link).toHaveAttribute("aria-current", "page");
    expect(screen.getByRole("heading", { level: 1 })).toHaveTextContent("Settings");

    // The account menu offers the same destination.
    await user.click(screen.getByRole("button", { name: /account menu/i }));
    const menu = await screen.findByRole("menu");
    expect(within(menu).getByRole("menuitem", { name: "Settings" })).toHaveAttribute(
      "href",
      "/settings",
    );
  });

  it("mobile menu button -> drawer -> link click closes the drawer on route change", async () => {
    const user = userEvent.setup();
    const { rerender } = renderDashboardChrome();

    const menu = screen.getByRole("button", { name: /open navigation menu/i });
    await user.click(menu);

    const drawer = await screen.findByRole("dialog", { name: /navigation menu/i });
    const link = within(drawer).getByRole("link", { name: "Dashboard" });
    expect(link).toHaveAttribute("href", "/dashboard");

    // Simulate the app router completing a navigation triggered from the drawer.
    nav.setPathname("/dashboard/reports");
    rerender(
      <>
        <DashboardSidebar />
        <DashboardHeader user={account} signOutAction={signOutAction} />
        <DashboardCommandPalette />
      </>,
    );

    await waitFor(() => expect(screen.queryByRole("dialog")).not.toBeInTheDocument());
    expect(useSidebar.getState().mobileOpen).toBe(false);
    expect(screen.getByRole("heading", { level: 1 })).toHaveTextContent("Dashboard");
    // Focus goes back to the button that opened the drawer.
    await waitFor(() => expect(menu).toHaveFocus());
  });

  it("keyboard shortcut and search trigger share one open state", async () => {
    const user = userEvent.setup();
    renderDashboardChrome();

    await user.click(screen.getByRole("button", { name: /search/i }));
    await screen.findByRole("dialog", { name: /command palette/i });
    expect(useCommandPalette.getState().open).toBe(true);

    await user.keyboard("{Control>}k{/Control}");
    await waitFor(() => expect(screen.queryByRole("dialog")).not.toBeInTheDocument());
    expect(useCommandPalette.getState().open).toBe(false);
  });

  it("the mobile drawer and the command palette never open on top of each other by accident", async () => {
    const user = userEvent.setup();
    renderDashboardChrome();

    await user.click(screen.getByRole("button", { name: /open navigation menu/i }));
    await screen.findByRole("dialog", { name: /navigation menu/i });

    await user.keyboard("{Escape}");
    await waitFor(() => expect(screen.queryByRole("dialog")).not.toBeInTheDocument());

    await user.keyboard("{Control>}k{/Control}");
    const dialogs = await screen.findAllByRole("dialog");
    expect(dialogs).toHaveLength(1);
    expect(dialogs[0]).toHaveAccessibleName(/command palette/i);
  });
});
