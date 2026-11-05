import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { useCommandPalette } from "../store/useCommandPalette";
import { useSidebar } from "../store/useSidebar";

import { DashboardHeader } from "./dashboard-header";

const nav = await vi.hoisted(async () =>
  (await import("@/shared/test/next-navigation")).createNextNavigationMock("/dashboard"),
);
vi.mock("next/navigation", () => nav.module);

const signOutAction = vi.fn<() => Promise<void>>();
const account = { name: "Jane Doe", email: "jane@example.com", initials: "JD" };

const openAccountMenu = async (user: ReturnType<typeof userEvent.setup>) => {
  await user.click(screen.getByRole("button", { name: /account menu/i }));
  return screen.findByRole("menuitem", { name: "Sign out" });
};

beforeEach(() => {
  nav.reset("/dashboard");
  useSidebar.setState({ collapsed: false, mobileOpen: false });
  useCommandPalette.setState({ open: false });
  signOutAction.mockReset();
  signOutAction.mockResolvedValue(undefined);
});

describe("DashboardHeader – account menu sign out", () => {
  it("forgets every unsent form draft kept in the tab, then still signs out", async () => {
    // Drafts survive an EXPIRED session; a deliberate sign-out (possibly on a
    // shared computer) must not leave what the user wrote behind.
    sessionStorage.setItem("draft:support-request:user-1", '{"subject":"secret"}');
    sessionStorage.setItem("draft:other-form:user-1", "{}");
    sessionStorage.setItem("unrelated", "kept");
    const user = userEvent.setup();
    render(<DashboardHeader user={account} signOutAction={signOutAction} />);

    await user.click(await openAccountMenu(user));

    await waitFor(() => expect(signOutAction).toHaveBeenCalledTimes(1));
    expect(sessionStorage.getItem("draft:support-request:user-1")).toBeNull();
    expect(sessionStorage.getItem("draft:other-form:user-1")).toBeNull();
    expect(sessionStorage.getItem("unrelated")).toBe("kept");
    sessionStorage.clear();
  });

  it("only opening the menu does not touch drafts", async () => {
    sessionStorage.setItem("draft:support-request:user-1", "{}");
    const user = userEvent.setup();
    render(<DashboardHeader user={account} signOutAction={signOutAction} />);

    await openAccountMenu(user);

    expect(sessionStorage.getItem("draft:support-request:user-1")).toBe("{}");
    sessionStorage.clear();
  });

  it("renders Sign out as a real submit button of a form bound to the injected action", async () => {
    const user = userEvent.setup();
    render(<DashboardHeader user={account} signOutAction={signOutAction} />);

    const item = await openAccountMenu(user);

    // A <button type="submit"> inside a <form>: works as a plain form post before
    // hydration and does not rely on a client-side click handler.
    expect(item.tagName).toBe("BUTTON");
    expect(item).toHaveAttribute("type", "submit");
    expect(item.closest("form")).not.toBeNull();
    expect(signOutAction).not.toHaveBeenCalled(); // nothing fires on open
  });

  it("clicking Sign out submits the action exactly once", async () => {
    const user = userEvent.setup();
    render(<DashboardHeader user={account} signOutAction={signOutAction} />);

    await user.click(await openAccountMenu(user));

    await waitFor(() => expect(signOutAction).toHaveBeenCalledTimes(1));
  });

  it("keeps the menu open while the action is still running (regression)", async () => {
    // Radix unmounts the menu synchronously on select, before the browser runs the
    // click's default action; an unmounted submit button submits nothing. In a real
    // browser that made Sign out a silent no-op while "submits the action" above still
    // passed in jsdom — so assert the mechanism that prevents it: with the action
    // unresolved, the menu (and the form inside it) is still there.
    //
    // The pending label ("Signing out…", aria-disabled) is not asserted here: under
    // jsdom/act React drops useFormStatus().pending as soon as Radix's typeahead
    // effect sets state. It was verified in Chromium against a 2.5 s sign-out.
    let finish!: () => void;
    signOutAction.mockReturnValue(new Promise<void>((resolve) => (finish = resolve)));
    const user = userEvent.setup();
    render(<DashboardHeader user={account} signOutAction={signOutAction} />);

    await user.click(await openAccountMenu(user));
    await waitFor(() => expect(signOutAction).toHaveBeenCalledTimes(1));

    const item = screen.getByRole("menuitem", { name: /sign(ing)? out/i });
    expect(item).toBeInTheDocument(); // menu did not close
    expect(item.closest("form")).not.toBeNull();
    expect(item).toHaveFocus(); // focus stayed inside the menu (else Radix dismisses it)

    finish();
    await waitFor(() =>
      expect(screen.getByRole("menuitem", { name: "Sign out" })).toBeInTheDocument(),
    );
  });

  it("cancels Radix's close-on-select so the form outlives the click", async () => {
    const user = userEvent.setup();
    render(<DashboardHeader user={account} signOutAction={signOutAction} />);

    const item = await openAccountMenu(user);
    await user.click(item);

    await waitFor(() => expect(signOutAction).toHaveBeenCalledTimes(1));
    // Still mounted after the click has been fully processed.
    expect(screen.getByRole("menuitem", { name: /sign(ing)? out/i })).toBeInTheDocument();
    expect(item.closest("form")).not.toBeNull();
  });

  it("is operable with the keyboard: arrow to the item and press Enter", async () => {
    const user = userEvent.setup();
    render(<DashboardHeader user={account} signOutAction={signOutAction} />);

    await openAccountMenu(user);
    // Items: Profile, Settings, Sign out
    await user.keyboard("{End}");
    expect(screen.getByRole("menuitem", { name: "Sign out" })).toHaveFocus();

    await user.keyboard("{Enter}");

    await waitFor(() => expect(signOutAction).toHaveBeenCalledTimes(1));
  });

  it("the other menu items do not trigger a sign out", async () => {
    const user = userEvent.setup();
    render(<DashboardHeader user={account} signOutAction={signOutAction} />);

    await openAccountMenu(user);
    await user.click(screen.getByRole("menuitem", { name: "Profile" }));
    await openAccountMenu(user);
    await user.click(screen.getByRole("menuitem", { name: "Settings" }));

    expect(signOutAction).not.toHaveBeenCalled();
  });
});
