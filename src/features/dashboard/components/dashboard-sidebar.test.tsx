import { act, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { DASHBOARD_NAV_ITEMS } from "../config/navigation";
import { useSidebar } from "../store/useSidebar";

import { DashboardSidebar, DESKTOP_SIDEBAR_ID } from "./dashboard-sidebar";

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

function desktopNav() {
  const aside = document.getElementById(DESKTOP_SIDEBAR_ID);
  if (!aside) throw new Error("desktop sidebar not rendered");

  return within(aside).getByRole("navigation", { name: /main navigation/i });
}

describe("DashboardSidebar (desktop)", () => {
  beforeEach(() => {
    nav.reset("/dashboard");
    useSidebar.setState({ collapsed: false, mobileOpen: false });
  });

  it("lists every item from the navigation config, in order", () => {
    render(<DashboardSidebar />);

    const entries = within(desktopNav()).getAllByRole("link");

    expect(entries.map((entry) => entry.textContent)).toEqual(
      DASHBOARD_NAV_ITEMS.map((item) =>
        item.available ? item.label : `${item.label}Soon(Coming soon)`,
      ),
    );
  });

  it("renders available destinations as real links", () => {
    render(<DashboardSidebar />);

    for (const item of DASHBOARD_NAV_ITEMS.filter((i) => i.available)) {
      const link = within(desktopNav()).getByRole("link", { name: item.label });
      expect(link.tagName).toBe("A");
      expect(link).toHaveAttribute("href", item.href);
      expect(link).not.toHaveAttribute("aria-disabled");
    }
  });

  it("renders unavailable destinations as disabled, non-navigating entries", () => {
    render(<DashboardSidebar />);

    const navEl = desktopNav();
    // Regression: an unavailable item used to be an <a href> to a page that doesn't
    // exist (Settings is the unavailable fixture here, see the flags mock above).
    expect(navEl.querySelector('a[href="/settings"]')).toBeNull();

    for (const item of DASHBOARD_NAV_ITEMS.filter((i) => !i.available)) {
      const entry = within(navEl).getByRole("link", {
        name: new RegExp(`^${item.label}`),
      });

      expect(entry.tagName).not.toBe("A");
      expect(entry).not.toHaveAttribute("href");
      expect(entry).toHaveAttribute("aria-disabled", "true");
      expect(entry).toHaveAccessibleName(/coming soon/i);
      expect(entry).toHaveAttribute("title", expect.stringMatching(/coming soon/i));
      // Not in the tab order: disabled controls shouldn't trap keyboard users.
      expect(entry).not.toHaveAttribute("tabindex");
    }
  });

  it("never marks an unavailable destination as the current page", () => {
    nav.setPathname("/settings");
    render(<DashboardSidebar />);

    const entries = within(desktopNav()).getAllByRole("link");
    expect(entries.some((entry) => entry.hasAttribute("aria-current"))).toBe(false);
  });

  it("links Billing to /billing and marks it current there, including nested routes", () => {
    nav.setPathname("/billing");
    const { unmount } = render(<DashboardSidebar />);

    const billing = within(desktopNav()).getByRole("link", { name: "Billing" });
    expect(billing.tagName).toBe("A");
    expect(billing).toHaveAttribute("href", "/billing");
    expect(billing).toHaveAttribute("aria-current", "page");
    expect(billing).not.toHaveAccessibleName(/coming soon/i);
    expect(
      within(desktopNav()).getByRole("link", { name: "Dashboard" }),
    ).not.toHaveAttribute("aria-current");
    unmount();

    nav.setPathname("/billing/invoices");
    render(<DashboardSidebar />);
    expect(within(desktopNav()).getByRole("link", { name: "Billing" })).toHaveAttribute(
      "aria-current",
      "page",
    );
  });

  it("marks the current route with aria-current, including nested routes", () => {
    nav.setPathname("/dashboard/reports");
    render(<DashboardSidebar />);

    const links = within(desktopNav()).getAllByRole("link");
    const current = links.filter((link) => link.getAttribute("aria-current") === "page");

    expect(current).toHaveLength(1);
    expect(current[0]).toHaveTextContent("Dashboard");
  });

  it("does not mark anything active on an unrelated route", () => {
    nav.setPathname("/pricing");
    render(<DashboardSidebar />);

    const links = within(desktopNav()).getAllByRole("link");
    expect(links.some((link) => link.hasAttribute("aria-current"))).toBe(false);
  });

  it("keeps accessible link names when collapsed to an icon rail", () => {
    useSidebar.setState({ collapsed: true });
    render(<DashboardSidebar />);

    const aside = document.getElementById(DESKTOP_SIDEBAR_ID);
    expect(aside).toHaveAttribute("data-collapsed", "true");

    for (const item of DASHBOARD_NAV_ITEMS) {
      const entry = within(desktopNav()).getByRole("link", {
        name: new RegExp(`^${item.label}`),
      });
      expect(entry).toHaveAttribute("title", expect.stringContaining(item.label));
      // Label text is still in the DOM (screen-reader only), not removed.
      expect(within(entry).getByText(item.label)).toHaveClass("sr-only");
    }
  });
});

describe("DashboardSidebar (mobile drawer)", () => {
  beforeEach(() => {
    nav.reset("/dashboard");
    useSidebar.setState({ collapsed: false, mobileOpen: false });
  });

  it("is not rendered while closed", () => {
    render(<DashboardSidebar />);

    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
  });

  it("opens as an accessible modal dialog containing the same navigation", async () => {
    render(<DashboardSidebar />);

    act(() => useSidebar.getState().openMobile());

    const dialog = await screen.findByRole("dialog", { name: /navigation menu/i });

    // Modal: the rest of the page is hidden from assistive tech while the drawer is open.
    const desktopAside = document.getElementById(DESKTOP_SIDEBAR_ID)!;
    expect(desktopAside.closest("[aria-hidden='true']")).not.toBeNull();

    const links = within(dialog).getAllByRole("link");
    expect(links.map((link) => link.getAttribute("href"))).toEqual(
      DASHBOARD_NAV_ITEMS.map((item) => (item.available ? item.href : null)),
    );

    // Focus is moved inside the dialog (focus trap entry point).
    await waitFor(() => expect(dialog.contains(document.activeElement)).toBe(true));
  });

  it("closes with Escape and syncs the store", async () => {
    const user = userEvent.setup();
    render(<DashboardSidebar />);

    act(() => useSidebar.getState().openMobile());
    await screen.findByRole("dialog");

    await user.keyboard("{Escape}");

    await waitFor(() => expect(screen.queryByRole("dialog")).not.toBeInTheDocument());
    expect(useSidebar.getState().mobileOpen).toBe(false);
  });

  it("closes with the close button", async () => {
    const user = userEvent.setup();
    render(<DashboardSidebar />);

    act(() => useSidebar.getState().openMobile());
    const dialog = await screen.findByRole("dialog");

    await user.click(
      within(dialog).getByRole("button", { name: /close navigation menu/i }),
    );

    await waitFor(() => expect(screen.queryByRole("dialog")).not.toBeInTheDocument());
    expect(useSidebar.getState().mobileOpen).toBe(false);
  });

  it("closes automatically when the route changes", async () => {
    const { rerender } = render(<DashboardSidebar />);

    act(() => useSidebar.getState().openMobile());
    await screen.findByRole("dialog");

    nav.setPathname("/billing");
    rerender(<DashboardSidebar />);

    await waitFor(() => expect(screen.queryByRole("dialog")).not.toBeInTheDocument());
    expect(useSidebar.getState().mobileOpen).toBe(false);
  });

  it("offers Billing as a real link in the drawer and closes when it is activated", async () => {
    const user = userEvent.setup();
    nav.setPathname("/dashboard");
    render(<DashboardSidebar />);

    act(() => useSidebar.getState().openMobile());
    const dialog = await screen.findByRole("dialog");

    const billing = within(dialog).getByRole("link", { name: "Billing" });
    expect(billing.tagName).toBe("A");
    expect(billing).toHaveAttribute("href", "/billing");
    expect(billing).not.toHaveAttribute("aria-disabled");
    expect(billing).not.toHaveAttribute("aria-current");

    await user.click(billing);

    await waitFor(() => expect(screen.queryByRole("dialog")).not.toBeInTheDocument());
    expect(useSidebar.getState().mobileOpen).toBe(false);
  });

  it("closes when the link to the current page is activated (pathname does not change)", async () => {
    const user = userEvent.setup();
    nav.setPathname("/dashboard");
    render(<DashboardSidebar />);

    act(() => useSidebar.getState().openMobile());
    const dialog = await screen.findByRole("dialog");

    const link = within(dialog).getByRole("link", { name: "Dashboard" });
    expect(link).toHaveAttribute("aria-current", "page");
    link.focus();
    await user.keyboard("{Enter}");

    await waitFor(() => expect(screen.queryByRole("dialog")).not.toBeInTheDocument());
    expect(useSidebar.getState().mobileOpen).toBe(false);
  });

  it("closes when the viewport grows to desktop size", async () => {
    let changeHandler: ((event: MediaQueryListEvent) => void) | undefined;

    const matchMedia = vi.spyOn(window, "matchMedia").mockImplementation(
      (query: string) =>
        ({
          matches: false,
          media: query,
          onchange: null,
          addEventListener: (
            _: string,
            handler: (event: MediaQueryListEvent) => void,
          ) => {
            changeHandler = handler;
          },
          removeEventListener: () => {},
          addListener: () => {},
          removeListener: () => {},
          dispatchEvent: () => false,
        }) as MediaQueryList,
    );

    try {
      render(<DashboardSidebar />);
      expect(matchMedia).toHaveBeenCalledWith("(min-width: 768px)");

      act(() => useSidebar.getState().openMobile());
      await screen.findByRole("dialog");

      act(() => changeHandler?.({ matches: true } as MediaQueryListEvent));

      await waitFor(() => expect(screen.queryByRole("dialog")).not.toBeInTheDocument());
      expect(useSidebar.getState().mobileOpen).toBe(false);
    } finally {
      matchMedia.mockRestore();
    }
  });
});
