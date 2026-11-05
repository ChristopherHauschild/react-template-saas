// @vitest-environment node
/**
 * The dashboard shell (sidebar, header, command palette) is the layout of the
 * `(dashboard)` route group. Route groups do not appear in URLs, so `/dashboard`,
 * `/billing` and `/settings` all render inside it while `/pricing` stays a
 * full-page route.
 * This pins that file structure: a page moved out of the group would silently
 * lose the shell, and a page left at the old location would make two files
 * claim the same URL.
 */
import { readdirSync, statSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

import { DASHBOARD_NAV_ITEMS } from "@/features/dashboard/config/navigation";

const APP_DIR = path.resolve(__dirname, "../..");
const PROTECTED = "(protected)";
const SHELL = "(dashboard)";

type Page = {
  /** Path relative to `src/app`, e.g. `(protected)/(dashboard)/billing/page.tsx`. */
  file: string;
  /** URL the file serves, with route groups removed. */
  url: string;
  /** Layout files that wrap the page, outermost first (relative to `src/app`). */
  layouts: string[];
};

const isRouteGroup = (segment: string) => /^\(.+\)$/.test(segment);

function collectPages(
  dir = APP_DIR,
  segments: string[] = [],
  layouts: string[] = [],
): Page[] {
  const entries = readdirSync(dir);
  const here = entries.includes("layout.tsx")
    ? [...layouts, path.relative(APP_DIR, path.join(dir, "layout.tsx"))]
    : layouts;

  const pages: Page[] = entries.includes("page.tsx")
    ? [
        {
          file: path.relative(APP_DIR, path.join(dir, "page.tsx")),
          url: `/${segments.filter((s) => !isRouteGroup(s)).join("/")}`,
          layouts: here,
        },
      ]
    : [];

  for (const entry of entries) {
    const full = path.join(dir, entry);
    if (statSync(full).isDirectory() && !entry.startsWith("_")) {
      pages.push(...collectPages(full, [...segments, entry], here));
    }
  }

  return pages;
}

const pages = collectPages();
const byUrl = (url: string) => pages.filter((page) => page.url === url);

describe("app routes", () => {
  it("serve every URL from exactly one page file (no leftovers at old locations)", () => {
    const urls = pages.map((page) => page.url);

    expect(new Set(urls).size, urls.join(", ")).toBe(urls.length);
  });

  it("route groups do not change URLs: /dashboard, /billing, /exports, /settings and /support are top-level", () => {
    expect(byUrl("/dashboard")).toHaveLength(1);
    expect(byUrl("/billing")).toHaveLength(1);
    expect(byUrl("/exports")).toHaveLength(1);
    expect(byUrl("/settings")).toHaveLength(1);
    expect(byUrl("/support")).toHaveLength(1);
    expect(byUrl("/(dashboard)/billing")).toHaveLength(0);
    expect(byUrl("/(dashboard)/settings")).toHaveLength(0);
  });
});

describe("dashboard shell", () => {
  const shellLayout = `${PROTECTED}/${SHELL}/layout.tsx`;
  const authLayout = `${PROTECTED}/layout.tsx`;

  it("wraps /dashboard, /billing, /exports, /settings and /support, inside the auth guard and nothing else", () => {
    for (const url of ["/dashboard", "/billing", "/exports", "/settings", "/support"]) {
      const [page] = byUrl(url);

      expect(page, url).toBeDefined();
      expect(page.file, url).toMatch(new RegExp(`^\\(protected\\)/\\(dashboard\\)/`));
      expect(page.layouts, url).toEqual(["layout.tsx", authLayout, shellLayout]);
    }
  });

  it("wraps every destination the navigation offers as a link", () => {
    // A sidebar/palette link must land inside the shell it was clicked from.
    for (const item of DASHBOARD_NAV_ITEMS.filter((i) => i.available)) {
      const [page] = byUrl(item.href);

      expect(page, item.href).toBeDefined();
      expect(page.layouts, item.href).toContain(shellLayout);
    }
  });

  it("has no page for destinations still marked as coming soon", () => {
    for (const item of DASHBOARD_NAV_ITEMS.filter((i) => !i.available)) {
      expect(byUrl(item.href), item.href).toHaveLength(0);
    }
  });

  it("does not wrap /pricing (a full-page route behind the same auth guard)", () => {
    const [pricing] = byUrl("/pricing");

    expect(pricing).toBeDefined();
    expect(pricing.layouts).toEqual(["layout.tsx", authLayout]);
  });

  it.each(["billing", "exports", "settings", "support"])(
    "keeps /%s's error boundary inside the shell",
    (segment) => {
      const dir = path.join(APP_DIR, PROTECTED, SHELL, segment);

      expect(readdirSync(dir)).toContain("error.tsx");
    },
  );
});
