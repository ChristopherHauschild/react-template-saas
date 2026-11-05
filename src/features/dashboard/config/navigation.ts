import {
  CreditCard,
  Download,
  LayoutDashboard,
  LifeBuoy,
  type LucideIcon,
  Settings,
} from "lucide-react";

import { type FeatureFlags, featureFlags } from "@/config/featureFlags";
import { ROUTES } from "@/config/routes";

export type NavItem = {
  label: string;
  href: string;
  icon: LucideIcon;
  /** Extra search terms for the command palette. */
  keywords?: string[];
  /**
   * Whether the destination exists. Unavailable items are still listed (so users
   * can see what's coming) but are rendered disabled instead of as links.
   */
  available: boolean;
};

export const UNAVAILABLE_HINT = "Coming soon";

/** Builds the navigation for a given set of feature flags (pure, for testing). */
export function createDashboardNavItems(flags: FeatureFlags): readonly NavItem[] {
  return [
    {
      label: "Dashboard",
      href: ROUTES.dashboard,
      icon: LayoutDashboard,
      keywords: ["home", "overview"],
      available: true,
    },
    {
      label: "Billing",
      href: ROUTES.billing,
      icon: CreditCard,
      keywords: ["subscription", "invoices", "plan"],
      available: flags.billing,
    },
    {
      label: "Exports",
      href: ROUTES.exports,
      icon: Download,
      keywords: ["download", "csv"],
      available: flags.exports,
    },
    {
      label: "Settings",
      href: ROUTES.settings,
      icon: Settings,
      keywords: ["preferences", "account"],
      available: flags.settings,
    },
    {
      label: "Support",
      href: ROUTES.support,
      icon: LifeBuoy,
      keywords: ["help", "contact", "question", "problem"],
      available: flags.support,
    },
  ];
}

/**
 * Single source of truth for dashboard navigation.
 * Consumed by the sidebar (desktop + mobile drawer), the header title
 * and the command palette.
 */
export const DASHBOARD_NAV_ITEMS: readonly NavItem[] =
  createDashboardNavItems(featureFlags);

/** `/dashboard` is active for `/dashboard` and `/dashboard/anything`, never for `/dashboards`. */
export function isActivePath(pathname: string | null | undefined, href: string) {
  if (!pathname) return false;
  if (href === "/") return pathname === "/";

  return pathname === href || pathname.startsWith(`${href}/`);
}

export function getActiveNavItem(pathname: string | null | undefined) {
  return DASHBOARD_NAV_ITEMS.find((item) => isActivePath(pathname, item.href));
}
