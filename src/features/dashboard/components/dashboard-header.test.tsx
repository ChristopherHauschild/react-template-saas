import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { useCommandPalette } from "../store/useCommandPalette";
import { useSidebar } from "../store/useSidebar";

import { DashboardHeader } from "./dashboard-header";
import { DESKTOP_SIDEBAR_ID, MOBILE_SIDEBAR_ID } from "./dashboard-sidebar";

const nav = await vi.hoisted(async () =>
  (await import("@/shared/test/next-navigation")).createNextNavigationMock("/dashboard"),
);
vi.mock("next/navigation", () => nav.module);

// Sign-out is covered in dashboard-header.sign-out.test.tsx; a no-op will do here.
const signOutAction = vi.fn(async () => {});
const account = { name: "Jane Doe", email: "jane@example.com", initials: "JD" };

describe("DashboardHeader", () => {
  beforeEach(() => {
    nav.reset("/dashboard");
    useSidebar.setState({ collapsed: false, mobileOpen: false });
    useCommandPalette.setState({ open: false });
  });

  it("shows the active navigation item as the page title", () => {
    nav.setPathname("/billing");
    render(<DashboardHeader user={account} signOutAction={signOutAction} />);

    expect(screen.getByRole("heading", { level: 1 })).toHaveTextContent("Billing");
  });

  it("falls back to 'Dashboard' as title on unknown routes", () => {
    nav.setPathname("/somewhere-else");
    render(<DashboardHeader user={account} signOutAction={signOutAction} />);

    expect(screen.getByRole("heading", { level: 1 })).toHaveTextContent("Dashboard");
  });

  it("opens the mobile drawer from the menu button", async () => {
    const user = userEvent.setup();
    render(<DashboardHeader user={account} signOutAction={signOutAction} />);

    const button = screen.getByRole("button", { name: /open navigation menu/i });
    expect(button).toHaveAttribute("type", "button");
    expect(button).toHaveAttribute("aria-controls", MOBILE_SIDEBAR_ID);
    expect(button).toHaveAttribute("aria-expanded", "false");

    await user.click(button);

    expect(useSidebar.getState().mobileOpen).toBe(true);
    expect(useSidebar.getState().collapsed).toBe(false);
    expect(button).toHaveAttribute("aria-expanded", "true");
  });

  it("collapses and expands the desktop sidebar with a labelled toggle", async () => {
    const user = userEvent.setup();
    render(<DashboardHeader user={account} signOutAction={signOutAction} />);

    const collapse = screen.getByRole("button", { name: /collapse sidebar/i });
    expect(collapse).toHaveAttribute("aria-controls", DESKTOP_SIDEBAR_ID);
    expect(collapse).toHaveAttribute("aria-expanded", "true");

    await user.click(collapse);

    expect(useSidebar.getState().collapsed).toBe(true);
    expect(useSidebar.getState().mobileOpen).toBe(false);

    const expand = screen.getByRole("button", { name: /expand sidebar/i });
    expect(expand).toHaveAttribute("aria-expanded", "false");

    await user.click(expand);
    expect(useSidebar.getState().collapsed).toBe(false);
  });

  it("is fully operable with the keyboard", async () => {
    const user = userEvent.setup();
    render(<DashboardHeader user={account} signOutAction={signOutAction} />);

    const collapse = screen.getByRole("button", { name: /collapse sidebar/i });
    collapse.focus();
    await user.keyboard("{Enter}");

    expect(useSidebar.getState().collapsed).toBe(true);
  });

  it("opens the command palette from the search trigger on click, not on focus", async () => {
    const user = userEvent.setup();
    render(<DashboardHeader user={account} signOutAction={signOutAction} />);

    const search = screen.getByRole("button", { name: /search/i });
    expect(search).toHaveAttribute("aria-keyshortcuts", "Meta+K Control+K");

    // Tabbing through the header must not pop the palette open.
    search.focus();
    expect(useCommandPalette.getState().open).toBe(false);

    await user.click(search);
    expect(useCommandPalette.getState().open).toBe(true);
  });
});
