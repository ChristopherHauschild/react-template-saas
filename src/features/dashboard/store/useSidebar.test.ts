import { beforeEach, describe, expect, it } from "vitest";

import { useSidebar } from "./useSidebar";

describe("useSidebar store", () => {
  beforeEach(() => {
    useSidebar.setState({ collapsed: false, mobileOpen: false });
  });

  it("starts expanded on desktop with the mobile drawer closed", () => {
    expect(useSidebar.getState().collapsed).toBe(false);
    expect(useSidebar.getState().mobileOpen).toBe(false);
  });

  it("toggles and sets the desktop collapsed state", () => {
    useSidebar.getState().toggleCollapsed();
    expect(useSidebar.getState().collapsed).toBe(true);

    useSidebar.getState().toggleCollapsed();
    expect(useSidebar.getState().collapsed).toBe(false);

    useSidebar.getState().setCollapsed(true);
    expect(useSidebar.getState().collapsed).toBe(true);
  });

  it("opens and closes the mobile drawer independently of the desktop state", () => {
    useSidebar.getState().setCollapsed(true);

    useSidebar.getState().openMobile();
    expect(useSidebar.getState().mobileOpen).toBe(true);
    expect(useSidebar.getState().collapsed).toBe(true);

    useSidebar.getState().closeMobile();
    expect(useSidebar.getState().mobileOpen).toBe(false);

    useSidebar.getState().setMobileOpen(true);
    expect(useSidebar.getState().mobileOpen).toBe(true);
  });
});
