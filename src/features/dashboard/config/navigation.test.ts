import { describe, expect, it } from "vitest";

import {
  createDashboardNavItems,
  DASHBOARD_NAV_ITEMS,
  getActiveNavItem,
  isActivePath,
} from "./navigation";

describe("DASHBOARD_NAV_ITEMS", () => {
  it("has unique hrefs and labels", () => {
    const hrefs = DASHBOARD_NAV_ITEMS.map((item) => item.href);
    const labels = DASHBOARD_NAV_ITEMS.map((item) => item.label);

    expect(new Set(hrefs).size).toBe(hrefs.length);
    expect(new Set(labels).size).toBe(labels.length);
  });

  it("only contains absolute paths", () => {
    for (const item of DASHBOARD_NAV_ITEMS) {
      expect(item.href.startsWith("/")).toBe(true);
    }
  });
});

describe("availability", () => {
  it("always lists every destination, regardless of flags", () => {
    const none = createDashboardNavItems({
      billing: false,
      settings: false,
      exports: false,
      support: false,
    });
    const all = createDashboardNavItems({
      billing: true,
      settings: true,
      exports: true,
      support: true,
    });

    expect(none.map((item) => item.label)).toEqual(all.map((item) => item.label));
  });

  it("derives availability from the feature flags", () => {
    const items = createDashboardNavItems({
      billing: true,
      settings: false,
      exports: false,
      support: true,
    });
    const byLabel = Object.fromEntries(items.map((item) => [item.label, item.available]));

    expect(byLabel).toEqual({
      Dashboard: true,
      Billing: true,
      Exports: false,
      Settings: false,
      Support: true,
    });
  });

  it("marks all shipped destinations available", () => {
    // Regression: unavailable items used to be plain links to 404 pages. Billing
    // joined the available ones when /billing shipped, Settings when /settings did.
    // If something is unavailable again, `(dashboard)/routes.test.ts` checks that
    // no page exists for it.
    const unavailable = DASHBOARD_NAV_ITEMS.filter((item) => !item.available).map(
      (item) => item.label,
    );

    expect(unavailable).toEqual([]);
    expect(
      DASHBOARD_NAV_ITEMS.find((item) => item.label === "Dashboard")?.available,
    ).toBe(true);
    expect(DASHBOARD_NAV_ITEMS.find((item) => item.label === "Billing")).toMatchObject({
      href: "/billing",
      available: true,
    });
    expect(DASHBOARD_NAV_ITEMS.find((item) => item.label === "Settings")).toMatchObject({
      href: "/settings",
      available: true,
    });
    expect(DASHBOARD_NAV_ITEMS.find((item) => item.label === "Exports")).toMatchObject({
      href: "/exports",
      available: true,
    });
    expect(DASHBOARD_NAV_ITEMS.find((item) => item.label === "Support")).toMatchObject({
      href: "/support",
      available: true,
    });
  });
});

describe("isActivePath", () => {
  it("matches the exact path", () => {
    expect(isActivePath("/dashboard", "/dashboard")).toBe(true);
  });

  it("matches nested routes", () => {
    expect(isActivePath("/dashboard/reports/2024", "/dashboard")).toBe(true);
  });

  it("does not match a sibling route that shares a prefix", () => {
    expect(isActivePath("/dashboards", "/dashboard")).toBe(false);
    expect(isActivePath("/billing-history", "/billing")).toBe(false);
  });

  it("handles a missing pathname", () => {
    expect(isActivePath(null, "/dashboard")).toBe(false);
    expect(isActivePath(undefined, "/dashboard")).toBe(false);
  });

  it("treats the root path as exact-match only", () => {
    expect(isActivePath("/", "/")).toBe(true);
    expect(isActivePath("/dashboard", "/")).toBe(false);
  });
});

describe("getActiveNavItem", () => {
  it("returns the nav item for the current route", () => {
    expect(getActiveNavItem("/billing")?.label).toBe("Billing");
    expect(getActiveNavItem("/settings/profile")?.label).toBe("Settings");
    expect(getActiveNavItem("/support")?.label).toBe("Support");
  });

  it("returns undefined for unknown routes", () => {
    expect(getActiveNavItem("/nope")).toBeUndefined();
  });
});
