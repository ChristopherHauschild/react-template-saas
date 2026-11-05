/**
 * Flipping a feature flag is all it takes to turn a "coming soon" destination
 * into a working link in the sidebar and a selectable command palette item.
 */
import { act, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { useCommandPalette } from "../store/useCommandPalette";
import { useSidebar } from "../store/useSidebar";

import { DashboardCommandPalette } from "./dashboard-command-palette";
import { DashboardSidebar, DESKTOP_SIDEBAR_ID } from "./dashboard-sidebar";

const nav = await vi.hoisted(async () =>
  (await import("@/shared/test/next-navigation")).createNextNavigationMock("/dashboard"),
);
vi.mock("next/navigation", () => nav.module);
vi.mock("@/config/featureFlags", () => ({
  featureFlags: { billing: true, settings: false, exports: false, support: false },
}));

describe("navigation with the billing flag enabled", () => {
  beforeEach(() => {
    nav.reset("/dashboard");
    useSidebar.setState({ collapsed: false, mobileOpen: false });
    useCommandPalette.setState({ open: false });
  });

  it("sidebar renders Billing as a link and Settings still as coming soon", () => {
    render(<DashboardSidebar />);

    const navEl = within(document.getElementById(DESKTOP_SIDEBAR_ID)!).getByRole(
      "navigation",
    );

    const billing = within(navEl).getByRole("link", { name: "Billing" });
    expect(billing.tagName).toBe("A");
    expect(billing).toHaveAttribute("href", "/billing");

    const settings = within(navEl).getByRole("link", { name: /^Settings/ });
    expect(settings).not.toHaveAttribute("href");
    expect(settings).toHaveAttribute("aria-disabled", "true");
  });

  it("sidebar marks Billing current when on /billing", () => {
    nav.setPathname("/billing/invoices");
    render(<DashboardSidebar />);

    const navEl = within(document.getElementById(DESKTOP_SIDEBAR_ID)!).getByRole(
      "navigation",
    );
    expect(within(navEl).getByRole("link", { name: "Billing" })).toHaveAttribute(
      "aria-current",
      "page",
    );
  });

  it("palette: ArrowDown reaches Billing, skips Settings, Enter navigates", async () => {
    const user = userEvent.setup();
    render(<DashboardCommandPalette />);

    act(() => useCommandPalette.getState().openPalette());
    const dialog = await screen.findByRole("dialog", { name: /command palette/i });
    await waitFor(() =>
      expect(within(dialog).getByPlaceholderText(/search pages/i)).toHaveFocus(),
    );

    await user.keyboard("{ArrowDown}");
    const billing = within(dialog).getByRole("option", { name: "Billing" });
    await waitFor(() => expect(billing).toHaveAttribute("aria-selected", "true"));
    expect(billing).not.toHaveAttribute("aria-disabled", "true");

    // Settings is still disabled, so the next ArrowDown loops back to Dashboard.
    await user.keyboard("{ArrowDown}");
    await waitFor(() =>
      expect(within(dialog).getByRole("option", { name: "Dashboard" })).toHaveAttribute(
        "aria-selected",
        "true",
      ),
    );
    expect(within(dialog).getByRole("option", { name: /^Settings/ })).toHaveAttribute(
      "aria-disabled",
      "true",
    );

    await user.keyboard("{ArrowUp}{Enter}");

    expect(nav.router.push).toHaveBeenCalledWith("/billing");
    await waitFor(() => expect(screen.queryByRole("dialog")).not.toBeInTheDocument());
  });
});
