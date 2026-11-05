import { render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";

import type { AccountMenuUser } from "../services/account-menu-user";
import { useCommandPalette } from "../store/useCommandPalette";
import { useSidebar } from "../store/useSidebar";

import { DashboardHeader } from "./dashboard-header";

const nav = await vi.hoisted(async () =>
  (await import("@/shared/test/next-navigation")).createNextNavigationMock("/dashboard"),
);
vi.mock("next/navigation", () => nav.module);

const signOutAction = vi.fn(async () => {});

const JANE: AccountMenuUser = {
  name: "Jane Doe",
  email: "jane@example.com",
  initials: "JD",
};
const EMAIL_ONLY: AccountMenuUser = {
  name: "sam@example.com",
  email: null,
  initials: "S",
};

const accountButton = () => screen.getByRole("button", { name: /account menu/i });

beforeEach(() => {
  nav.reset("/dashboard");
  useSidebar.setState({ collapsed: false, mobileOpen: false });
  useCommandPalette.setState({ open: false });
});

describe("DashboardHeader – account identity (regression: hard-coded Demo User)", () => {
  it("shows the signed-in user's initials and name in the trigger", () => {
    render(<DashboardHeader user={JANE} signOutAction={signOutAction} />);

    const trigger = accountButton();
    expect(within(trigger).getByText("JD")).toBeInTheDocument();
    expect(within(trigger).getByText("Jane Doe")).toBeInTheDocument();
    expect(screen.queryByText("Demo User")).not.toBeInTheDocument();
    expect(screen.queryByText("DU")).not.toBeInTheDocument();
  });

  it("shows name and email in the menu label", async () => {
    const user = userEvent.setup();
    render(<DashboardHeader user={JANE} signOutAction={signOutAction} />);

    await user.click(accountButton());
    const menu = await screen.findByRole("menu");

    expect(within(menu).getByText("Jane Doe")).toBeInTheDocument();
    expect(within(menu).getByText("jane@example.com")).toBeInTheDocument();
    // The label is not an actionable item.
    expect(
      within(menu)
        .getAllByRole("menuitem")
        .map((el) => el.textContent),
    ).toEqual(["Profile", "Settings", "Sign out"]);
  });

  it("offers Settings and Profile as real links into the settings page", async () => {
    const user = userEvent.setup();
    render(<DashboardHeader user={JANE} signOutAction={signOutAction} />);

    await user.click(accountButton());
    const menu = await screen.findByRole("menu");

    const settings = within(menu).getByRole("menuitem", { name: "Settings" });
    expect(settings.tagName).toBe("A");
    expect(settings).toHaveAttribute("href", "/settings");

    // Regression: "Profile" used to be a menu item that did nothing.
    const profile = within(menu).getByRole("menuitem", { name: "Profile" });
    expect(profile.tagName).toBe("A");
    expect(profile).toHaveAttribute("href", "/settings#profile");
  });

  it("falls back gracefully when only an email is known (no empty line, no duplicate)", async () => {
    const user = userEvent.setup();
    render(<DashboardHeader user={EMAIL_ONLY} signOutAction={signOutAction} />);

    expect(within(accountButton()).getByText("S")).toBeInTheDocument();
    expect(within(accountButton()).getByText("sam@example.com")).toBeInTheDocument();

    await user.click(accountButton());
    const menu = await screen.findByRole("menu");
    expect(within(menu).getAllByText("sam@example.com")).toHaveLength(1);
  });

  it("keeps long names from stretching the header", () => {
    const long: AccountMenuUser = {
      name: "Maximiliana Bartholomew-Featherstonehaugh the Third",
      email: null,
      initials: "MT",
    };
    render(<DashboardHeader user={long} signOutAction={signOutAction} />);

    const name = within(accountButton()).getByText(long.name);
    expect(Array.from(name.classList)).toEqual(
      expect.arrayContaining(["truncate", "max-w-48"]),
    );
  });

  it("keeps the existing markup contract of the trigger (layout tests rely on it)", () => {
    render(<DashboardHeader user={JANE} signOutAction={signOutAction} />);

    const name = within(accountButton()).getByText("Jane Doe");
    expect(Array.from(name.classList)).toEqual(
      expect.arrayContaining(["hidden", "whitespace-nowrap", "@min-[30rem]:inline"]),
    );
    expect(Array.from(accountButton().classList)).toContain("shrink-0");
  });
});
