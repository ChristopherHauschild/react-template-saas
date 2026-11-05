"use client";

import { create } from "zustand";

type SidebarState = {
  /** Desktop: sidebar shrinks to an icon rail. */
  collapsed: boolean;
  /** Mobile: off-canvas drawer visibility. */
  mobileOpen: boolean;
  toggleCollapsed: () => void;
  setCollapsed: (collapsed: boolean) => void;
  openMobile: () => void;
  closeMobile: () => void;
  setMobileOpen: (open: boolean) => void;
};

export const useSidebar = create<SidebarState>((set) => ({
  collapsed: false,
  mobileOpen: false,
  toggleCollapsed: () => set((state) => ({ collapsed: !state.collapsed })),
  setCollapsed: (collapsed) => set({ collapsed }),
  openMobile: () => set({ mobileOpen: true }),
  closeMobile: () => set({ mobileOpen: false }),
  setMobileOpen: (mobileOpen) => set({ mobileOpen }),
}));
