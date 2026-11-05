/**
 * Unavailable ("coming soon") destinations must be readable, fully inert and
 * visually distinct from working links — in the sidebar, the collapsed rail,
 * the mobile drawer and the command palette.
 *
 * Every destination has shipped in production, so the flags are mocked below to
 * keep one unavailable fixture (Settings); flipping a flag back off must still
 * render correctly.
 *
 * Colours: jsdom has no layout/paint, so contrast is computed from the real
 * theme tokens in globals.css against the real surfaces. Markup: the elements
 * must use those tokens and carry no hover/opacity styles.
 */
import { act, render, screen, within } from "@testing-library/react";
import path from "node:path";
import { beforeEach, describe, expect, it, vi } from "vitest";

import {
  blend,
  contrastRatio,
  loadThemeTokens,
  type ThemeTokens,
} from "@/shared/test/contrast";
import { classCandidatesFromSource, compileTailwind } from "@/shared/test/tailwind";

import { DASHBOARD_NAV_ITEMS } from "../config/navigation";
import { useCommandPalette } from "../store/useCommandPalette";
import { useSidebar } from "../store/useSidebar";

import { DashboardCommandPalette } from "./dashboard-command-palette";
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

const AA_NORMAL_TEXT = 4.5;

/** The backgrounds an unavailable entry can sit on. */
function surfaces(t: ThemeTokens) {
  return {
    "sidebar (background + primary/10)": blend(t.primary, 0.1, t.background),
    "mobile drawer (background)": t.background,
    "command palette (card)": t.card,
  };
}

describe.each([":root", ".dark"] as const)("unavailable item colours (%s)", (theme) => {
  it("label/icon colour (muted-foreground) meets WCAG AA on every surface", async () => {
    const t = await loadThemeTokens(theme);

    for (const [name, surface] of Object.entries(surfaces(t))) {
      const ratio = contrastRatio(t["muted-foreground"], surface);
      expect(ratio, `${name}: ${ratio.toFixed(2)}:1`).toBeGreaterThanOrEqual(
        AA_NORMAL_TEXT,
      );
    }
  });

  it("badge text (foreground/80 on muted) meets WCAG AA", async () => {
    const t = await loadThemeTokens(theme);
    const ratio = contrastRatio(blend(t.foreground, 0.8, t.muted), t.muted);

    expect(ratio).toBeGreaterThanOrEqual(AA_NORMAL_TEXT);
  });

  it("is visibly lighter than an available (foreground/70) link but not faint", async () => {
    const t = await loadThemeTokens(theme);
    const sidebar = surfaces(t)["sidebar (background + primary/10)"];

    const available = contrastRatio(blend(t.foreground, 0.7, sidebar), sidebar);
    const unavailable = contrastRatio(t["muted-foreground"], sidebar);

    expect(unavailable).toBeLessThan(available);
    expect(available - unavailable).toBeGreaterThanOrEqual(1);
  });
});

const unavailableItems = DASHBOARD_NAV_ITEMS.filter((item) => !item.available);
const hasNo = (el: Element, pattern: RegExp) =>
  Array.from(el.classList).every((cls) => !pattern.test(cls));

function expectInertSidebarEntry(entry: HTMLElement) {
  const cls = Array.from(entry.classList);

  expect(entry).toHaveAttribute("aria-disabled", "true");
  expect(entry).toHaveAttribute("data-unavailable", "true");
  expect(cls).toEqual(
    expect.arrayContaining([
      "text-muted-foreground",
      "cursor-not-allowed",
      "select-none",
    ]),
  );
  // No interactive affordances and no washed-out opacity.
  expect(hasNo(entry, /^(hover|focus|focus-visible|active):/)).toBe(true);
  expect(hasNo(entry, /opacity|\/\d+$/)).toBe(true);
  expect(entry).not.toHaveAttribute("href");
  expect(entry).not.toHaveAttribute("tabindex");

  const badge = entry.querySelector("[data-slot='badge']");
  expect(badge).not.toBeNull();
  expect(badge).toHaveTextContent(/soon/i);
}

describe("unavailable entries markup", () => {
  beforeEach(() => {
    nav.reset("/dashboard");
    useSidebar.setState({ collapsed: false, mobileOpen: false });
    useCommandPalette.setState({ open: false });
  });

  it("there is at least one unavailable destination to cover", () => {
    expect(unavailableItems.length).toBeGreaterThan(0);
  });

  it("sidebar: readable muted label, badge, no hover/opacity", () => {
    nav.setPathname("/pricing"); // nothing active, so available links show hover styles
    render(<DashboardSidebar />);
    const aside = document.getElementById(DESKTOP_SIDEBAR_ID)!;

    for (const item of unavailableItems) {
      const entry = within(aside).getByRole("link", {
        name: new RegExp(`^${item.label}`),
      });
      expectInertSidebarEntry(entry);
      expect(entry.querySelector("[data-slot='badge']")).not.toHaveClass("sr-only");
    }

    // Available links keep their interactive styling and a different colour.
    const dashboard = within(aside).getByRole("link", { name: "Dashboard" });
    expect(Array.from(dashboard.classList).some((c) => c.startsWith("hover:"))).toBe(
      true,
    );
    expect(dashboard).not.toHaveClass("text-muted-foreground");
  });

  it("collapsed rail: same treatment, badge + label go screen-reader-only, title keeps the hint", () => {
    useSidebar.setState({ collapsed: true });
    render(<DashboardSidebar />);
    const aside = document.getElementById(DESKTOP_SIDEBAR_ID)!;

    for (const item of unavailableItems) {
      const entry = within(aside).getByRole("link", {
        name: new RegExp(`^${item.label}`),
      });
      expectInertSidebarEntry(entry);
      expect(entry.querySelector("[data-slot='badge']")).toHaveClass("sr-only");
      expect(within(entry).getByText(item.label)).toHaveClass("sr-only");
      expect(entry).toHaveAttribute("title", `${item.label} – Coming soon`);
    }
  });

  it("mobile drawer: same treatment", async () => {
    render(<DashboardSidebar />);
    act(() => useSidebar.getState().openMobile());
    const drawer = await screen.findByRole("dialog", { name: /navigation menu/i });

    for (const item of unavailableItems) {
      const entry = within(drawer).getByRole("link", {
        name: new RegExp(`^${item.label}`),
      });
      expectInertSidebarEntry(entry);
    }
  });

  it("command palette: muted (not transparent) item with a high-contrast badge", async () => {
    render(<DashboardCommandPalette />);
    act(() => useCommandPalette.getState().openPalette());
    const dialog = await screen.findByRole("dialog", { name: /command palette/i });

    for (const item of unavailableItems) {
      const option = within(dialog).getByRole("option", {
        name: new RegExp(`^${item.label}`),
      });

      expect(option).toHaveAttribute("aria-disabled", "true");
      expect(option).toHaveAttribute("data-disabled", "true");
      expect(option).not.toHaveAttribute("aria-selected", "true");
      expect(Array.from(option.classList)).toEqual(
        expect.arrayContaining([
          "data-[disabled=true]:text-muted-foreground",
          "data-[disabled=true]:cursor-not-allowed",
        ]),
      );
      expect(hasNo(option, /opacity|pointer-events-none/)).toBe(true);

      const hint = option.querySelector("[data-slot='command-item-hint']");
      expect(hint).not.toBeNull();
      expect(hint).toHaveTextContent(/coming soon/i);
      expect(hint).toHaveClass("bg-muted", "text-foreground/80");
    }
  });
});

describe("unavailable entries CSS", () => {
  it("Tailwind emits the muted/disabled rules the entries rely on", async () => {
    const files = [
      path.resolve(__dirname, "./dashboard-sidebar.tsx"),
      path.resolve(__dirname, "../../../shared/components/ui/command.tsx"),
      path.resolve(__dirname, "../../../shared/components/ui/badge.tsx"),
    ];
    const candidates = (await Promise.all(files.map(classCandidatesFromSource))).flat();
    const css = (await compileTailwind(candidates)).replace(/\s+/g, " ");

    for (const cls of [
      "text-muted-foreground",
      "cursor-not-allowed",
      "select-none",
      "data-[disabled=true]:text-muted-foreground",
      "data-[disabled=true]:cursor-not-allowed",
      "bg-muted",
      "text-foreground/80",
    ]) {
      const selector = "." + cls.replace(/[[\]:/=]/g, (c) => `\\${c}`);
      expect(css, `expected a rule for "${cls}"`).toContain(selector);
    }
    expect(css).toContain('[data-disabled="true"]');
  }, 20_000);
});
