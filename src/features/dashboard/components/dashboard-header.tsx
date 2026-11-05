"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";

import { Menu, PanelLeft } from "lucide-react";

import { ROUTES } from "@/config/routes";
import { Avatar, AvatarFallback } from "@/shared/components/ui/avatar";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/shared/components/ui/dropdown-menu";
import { SearchTrigger } from "@/shared/components/ui/search-trigger";

import { getActiveNavItem } from "../config/navigation";
import type { AccountMenuUser } from "../services/account-menu-user";
import { useCommandPalette } from "../store/useCommandPalette";
import { useSidebar } from "../store/useSidebar";

import { DESKTOP_SIDEBAR_ID, MOBILE_SIDEBAR_ID } from "./dashboard-sidebar";
import { SignOutMenuItem } from "./sign-out-menu-item";

const iconButtonClassName =
  "flex h-9 w-9 items-center justify-center rounded-md transition hover:bg-white/10 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-white/60";

type Props = {
  /** Display data of the signed-in user (derived server-side; no tokens or ids). */
  user: AccountMenuUser;
  /**
   * Server action that ends the session and redirects to the login page. Injected
   * by the route layout (features must not import each other), so the header can
   * render "Sign out" as a form submission; the action runs on the server, where
   * the auth cookies live.
   */
  signOutAction: () => Promise<void>;
};

export function DashboardHeader({ user, signOutAction }: Props) {
  const pathname = usePathname();
  const { collapsed, mobileOpen, toggleCollapsed, openMobile } = useSidebar();
  const openPalette = useCommandPalette((state) => state.openPalette);

  const title = getActiveNavItem(pathname)?.label ?? "Dashboard";

  return (
    <header className="flex h-16 items-center gap-3 border-b border-border bg-foreground px-4 text-background md:px-6">
      {/* Left group keeps its natural width; the title only truncates as a last resort
          (when even an icon-only search + avatar can't fit). */}
      <div className="flex min-w-0 items-center gap-3">
        {/* Mobile: opens the off-canvas drawer. Which button is visible is decided by CSS so
            server and client render the same markup (no media-query hydration mismatch). */}
        <button
          type="button"
          onClick={openMobile}
          aria-label="Open navigation menu"
          aria-expanded={mobileOpen}
          aria-controls={MOBILE_SIDEBAR_ID}
          className={`${iconButtonClassName} md:hidden`}
        >
          <Menu size={18} aria-hidden="true" />
        </button>

        {/* Desktop: collapses the persistent sidebar to an icon rail. */}
        <button
          type="button"
          onClick={toggleCollapsed}
          aria-label={collapsed ? "Expand sidebar" : "Collapse sidebar"}
          aria-expanded={!collapsed}
          aria-controls={DESKTOP_SIDEBAR_ID}
          className={`${iconButtonClassName} hidden md:flex`}
        >
          <PanelLeft size={18} aria-hidden="true" />
        </button>

        <h1 className="truncate text-lg font-semibold tracking-tight">{title}</h1>
      </div>

      {/* Right group is a size container that takes whatever room is left next to the
          title. Its children (search width/label, user name) adapt to *that* room via
          container queries, so the layout is correct for any sidebar state + viewport. */}
      <div className="@container flex min-w-0 flex-1 items-center justify-end gap-3 @min-[30rem]:gap-6">
        <SearchTrigger onClick={openPalette} />

        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <button
              type="button"
              aria-label="Account menu"
              className="flex shrink-0 items-center gap-3 rounded-full px-2 py-1 transition hover:bg-white/10 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-white/60"
            >
              <Avatar>
                <AvatarFallback>{user.initials}</AvatarFallback>
              </Avatar>

              <span className="hidden max-w-48 truncate whitespace-nowrap text-sm font-medium @min-[30rem]:inline">
                {user.name}
              </span>
            </button>
          </DropdownMenuTrigger>

          <DropdownMenuContent
            align="end"
            className="w-48 bg-card border border-border shadow-lg"
          >
            <DropdownMenuLabel>
              <span className="block truncate">{user.name}</span>
              {user.email && (
                <span className="block truncate text-xs font-normal text-muted-foreground">
                  {user.email}
                </span>
              )}
            </DropdownMenuLabel>

            <DropdownMenuSeparator />

            {/* Both live on the settings page; "Profile" jumps to its card. */}
            <DropdownMenuItem asChild>
              <Link href={`${ROUTES.settings}#profile`}>Profile</Link>
            </DropdownMenuItem>
            <DropdownMenuItem asChild>
              <Link href={ROUTES.settings}>Settings</Link>
            </DropdownMenuItem>

            <DropdownMenuSeparator />

            <SignOutMenuItem action={signOutAction} />
          </DropdownMenuContent>
        </DropdownMenu>
      </div>
    </header>
  );
}
