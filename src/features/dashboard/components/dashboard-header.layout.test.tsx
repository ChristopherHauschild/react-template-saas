/**
 * Regression coverage for the header's responsive layout.
 *
 * Bug: at ~800-900px with the sidebar expanded, the page title was squeezed to
 * "D…" because the search trigger had a near-fixed width and the user name was
 * always rendered, leaving the title as the only shrinkable item.
 *
 * jsdom performs no layout, so this file checks the two things that make the
 * layout correct: (1) the markup contract — the right-hand group is a size
 * container that absorbs the free space and its children adapt to *its* width,
 * and (2) Tailwind really emits the container-query CSS for those classes
 * (unknown utilities are dropped silently). The actual pixel behaviour was
 * verified in Chromium at 320-1600px for every sidebar state.
 */
import { render, screen } from "@testing-library/react";
import path from "node:path";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { SEARCH_TRIGGER_EXPANDED_MIN_WIDTH } from "@/shared/components/ui/search-trigger";
import { classCandidatesFromSource, compileTailwind } from "@/shared/test/tailwind";

import { useCommandPalette } from "../store/useCommandPalette";
import { useSidebar } from "../store/useSidebar";

import { DashboardHeader } from "./dashboard-header";

const nav = await vi.hoisted(async () =>
  (await import("@/shared/test/next-navigation")).createNextNavigationMock("/dashboard"),
);
vi.mock("next/navigation", () => nav.module);

const classes = (el: Element) => Array.from(el.classList);

// Sign-out is covered in dashboard-header.sign-out.test.tsx; a no-op will do here.
const signOutAction = vi.fn(async () => {});
const account = { name: "Jane Doe", email: "jane@example.com", initials: "JD" };

describe("DashboardHeader layout contract", () => {
  beforeEach(() => {
    nav.reset("/dashboard");
    useSidebar.setState({ collapsed: false, mobileOpen: false });
    useCommandPalette.setState({ open: false });
  });

  it("gives the free space to the right-hand group, which is a size container", () => {
    render(<DashboardHeader user={account} signOutAction={signOutAction} />);

    const search = screen.getByRole("button", { name: /search/i });
    const accountButton = screen.getByRole("button", { name: /account menu/i });
    const group = search.parentElement!;

    expect(group).toBe(accountButton.parentElement);
    expect(classes(group)).toEqual(
      expect.arrayContaining(["@container", "flex-1", "min-w-0", "justify-end"]),
    );
    // The header itself must not space groups with justify-between; flex-1 does the job.
    expect(classes(group.parentElement!)).not.toContain("justify-between");
  });

  it("keeps the title at its natural width and only truncates as a last resort", () => {
    render(<DashboardHeader user={account} signOutAction={signOutAction} />);

    const title = screen.getByRole("heading", { level: 1 });
    const leftGroup = title.parentElement!;

    expect(classes(title)).toContain("truncate");
    expect(classes(leftGroup)).toContain("min-w-0");
    // Left group has no flex-1: it is sized by its content, not by leftover space.
    expect(classes(leftGroup)).not.toContain("flex-1");
  });

  it("search trigger is icon-only by default and becomes a shrinkable field only with room", () => {
    render(<DashboardHeader user={account} signOutAction={signOutAction} />);

    const search = screen.getByRole("button", { name: /search/i });
    const cls = classes(search);
    const q = `@min-[${SEARCH_TRIGGER_EXPANDED_MIN_WIDTH}]`;

    expect(cls).toEqual(expect.arrayContaining(["w-9", "justify-center"]));
    expect(cls).toEqual(
      expect.arrayContaining([
        `${q}:flex-1`,
        `${q}:min-w-0`,
        `${q}:max-w-[320px]`,
        `${q}:shrink`,
        `${q}:w-auto`,
      ]),
    );
    // No viewport breakpoints: the viewport says nothing about the room next to the sidebar.
    expect(cls.some((c) => /^(sm|md|lg|xl):/.test(c))).toBe(false);

    const label = screen.getByText("Search...");
    expect(classes(label)).toEqual(
      expect.arrayContaining(["hidden", `${q}:inline`, "truncate"]),
    );
  });

  it("user name never wraps and is hidden unless the group is wide enough", () => {
    render(<DashboardHeader user={account} signOutAction={signOutAction} />);

    const name = screen.getByText(account.name);
    const cls = classes(name);

    expect(cls).toEqual(
      expect.arrayContaining(["hidden", "whitespace-nowrap", "truncate"]),
    );
    expect(cls.find((c) => c.startsWith("@min-["))).toMatch(/^@min-\[\d+rem\]:inline$/);
    expect(cls.some((c) => /^(sm|md|lg|xl):/.test(c))).toBe(false);
    expect(classes(name.parentElement!)).toContain("shrink-0");
  });
});

describe("DashboardHeader layout CSS", () => {
  it("Tailwind emits the container-query rules the header and search trigger rely on", async () => {
    const files = [
      path.resolve(__dirname, "./dashboard-header.tsx"),
      path.resolve(__dirname, "../../../shared/components/ui/search-trigger.tsx"),
    ];
    const candidates = (await Promise.all(files.map(classCandidatesFromSource))).flat();
    const css = (await compileTailwind(candidates)).replace(/\s+/g, " ");

    expect(css).toContain(".\\@container { container-type: inline-size; }");
    expect(css).toContain(`@container (width >= ${SEARCH_TRIGGER_EXPANDED_MIN_WIDTH})`);
    expect(css).toContain("@container (width >= 30rem)");

    for (const cls of [
      `@min-[${SEARCH_TRIGGER_EXPANDED_MIN_WIDTH}]:flex-1`,
      `@min-[${SEARCH_TRIGGER_EXPANDED_MIN_WIDTH}]:max-w-[320px]`,
      `@min-[${SEARCH_TRIGGER_EXPANDED_MIN_WIDTH}]:inline`,
      "@min-[30rem]:inline",
      "@min-[30rem]:gap-6",
      "min-w-0",
      "truncate",
      "whitespace-nowrap",
    ]) {
      const selector = "." + cls.replace(/[@[\]:]/g, (c) => `\\${c}`);
      expect(css, `expected a rule for "${cls}"`).toContain(selector);
    }
  }, 20_000);
});
