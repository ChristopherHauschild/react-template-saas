"use client";

import { useEffect } from "react";
import Link from "next/link";
import { usePathname } from "next/navigation";

import { X } from "lucide-react";
import { Dialog as DialogPrimitive, VisuallyHidden } from "radix-ui";

import { Badge } from "@/shared/components/ui/badge";
import { useRestoreFocus } from "@/shared/hooks/use-restore-focus";
import { cn } from "@/shared/utils/cn";

import {
  DASHBOARD_NAV_ITEMS,
  isActivePath,
  UNAVAILABLE_HINT,
} from "../config/navigation";
import { useSidebar } from "../store/useSidebar";

export const DESKTOP_SIDEBAR_ID = "dashboard-sidebar";
export const MOBILE_SIDEBAR_ID = "dashboard-mobile-sidebar";

/** Tailwind `md` breakpoint: the drawer is only meaningful below it. */
const DESKTOP_MEDIA_QUERY = "(min-width: 768px)";

const navItemBaseClassName =
  "flex items-center rounded-lg px-3 py-2 text-sm font-medium transition outline-none";

type SidebarNavProps = {
  collapsed?: boolean;
  /** Called when a link is activated (click / Enter), even if it targets the current page. */
  onNavigate?: () => void;
};

function SidebarNav({ collapsed = false, onNavigate }: SidebarNavProps) {
  const pathname = usePathname();

  return (
    <nav aria-label="Main navigation" className="flex flex-col gap-1 px-2 py-4">
      {DASHBOARD_NAV_ITEMS.map((item) => {
        const Icon = item.icon;
        const active = isActivePath(pathname, item.href);

        // Destination doesn't exist yet: keep it visible, but it must not look or act
        // like a link (no href => no navigation to a 404, no prefetch, not in tab order).
        if (!item.available) {
          return (
            <span
              key={item.href}
              role="link"
              aria-disabled="true"
              data-unavailable="true"
              title={`${item.label} – ${UNAVAILABLE_HINT}`}
              className={cn(
                navItemBaseClassName,
                // Readable (muted token meets AA on every surface) but clearly not a link:
                // desaturated colour, no hover/focus styles, not-allowed cursor, no selection.
                "cursor-not-allowed select-none text-muted-foreground",
                collapsed ? "justify-center" : "gap-3",
              )}
            >
              <Icon size={18} aria-hidden="true" />

              <span className={cn("flex-1", collapsed && "sr-only")}>{item.label}</span>

              <Badge className={cn(collapsed && "sr-only")}>
                <span aria-hidden="true">Soon</span>
                <span className="sr-only">({UNAVAILABLE_HINT})</span>
              </Badge>
            </span>
          );
        }

        return (
          <Link
            key={item.href}
            href={item.href}
            aria-current={active ? "page" : undefined}
            title={collapsed ? item.label : undefined}
            onClick={onNavigate}
            className={cn(
              navItemBaseClassName,
              "focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 focus-visible:ring-offset-background",
              active
                ? "bg-primary text-primary-foreground shadow-sm"
                : "text-foreground/70 hover:bg-primary/20",
              collapsed ? "justify-center" : "gap-3",
            )}
          >
            <Icon size={18} aria-hidden="true" />

            {/* Keep the accessible name when the rail is collapsed. */}
            <span className={cn(collapsed && "sr-only")}>{item.label}</span>
          </Link>
        );
      })}
    </nav>
  );
}

function Brand({ collapsed = false }: { collapsed?: boolean }) {
  return (
    <div
      className={cn(
        "flex h-16 items-center font-semibold text-primary",
        collapsed ? "justify-center" : "px-6",
      )}
    >
      <span aria-hidden={collapsed || undefined}>{collapsed ? "S" : "Your SaaS"}</span>
      {collapsed ? <span className="sr-only">Your SaaS</span> : null}
    </div>
  );
}

export function DashboardSidebar() {
  const pathname = usePathname();
  const { collapsed, mobileOpen, setMobileOpen, closeMobile } = useSidebar();
  const restoreFocus = useRestoreFocus();

  // Close the drawer after navigating. Links also close it on activation (see below)
  // because navigating to the *current* page doesn't change the pathname.
  useEffect(() => {
    closeMobile();
  }, [pathname, closeMobile]);

  // If the viewport grows past the breakpoint while the drawer is open, close it so
  // the (now hidden) modal doesn't keep the focus trap and scroll lock active.
  useEffect(() => {
    if (typeof window === "undefined" || typeof window.matchMedia !== "function") return;

    const mql = window.matchMedia(DESKTOP_MEDIA_QUERY);
    const onChange = (event: MediaQueryListEvent) => {
      if (event.matches) closeMobile();
    };

    mql.addEventListener("change", onChange);

    return () => mql.removeEventListener("change", onChange);
  }, [closeMobile]);

  return (
    <>
      {/* Desktop: persistent sidebar that collapses to an icon rail. */}
      <aside
        id={DESKTOP_SIDEBAR_ID}
        data-collapsed={collapsed}
        className={cn(
          "hidden md:flex flex-col border-r border-border bg-primary/10 transition-all duration-300",
          collapsed ? "w-16" : "w-64",
        )}
      >
        <Brand collapsed={collapsed} />
        <SidebarNav collapsed={collapsed} />
      </aside>

      {/* Mobile: off-canvas drawer. Radix Dialog provides the focus trap, Escape / overlay
          dismissal, aria-hidden for the rest of the page and scroll locking; focus return
          is handled by useRestoreFocus because the drawer is opened from the store. */}
      <DialogPrimitive.Root open={mobileOpen} onOpenChange={setMobileOpen}>
        <DialogPrimitive.Portal>
          <DialogPrimitive.Overlay className="fixed inset-0 z-40 bg-black/40 backdrop-blur-sm md:hidden" />

          <DialogPrimitive.Content
            id={MOBILE_SIDEBAR_ID}
            aria-describedby={undefined}
            onOpenAutoFocus={restoreFocus.onOpenAutoFocus}
            onCloseAutoFocus={restoreFocus.onCloseAutoFocus}
            className="fixed inset-y-0 left-0 z-50 flex w-72 max-w-[85vw] flex-col border-r border-border bg-background shadow-xl outline-none md:hidden"
          >
            <VisuallyHidden.Root>
              <DialogPrimitive.Title>Navigation menu</DialogPrimitive.Title>
            </VisuallyHidden.Root>

            <div className="flex h-16 items-center justify-between pr-2">
              <Brand />

              <DialogPrimitive.Close
                type="button"
                aria-label="Close navigation menu"
                className="flex h-9 w-9 items-center justify-center rounded-md text-foreground/70 transition hover:bg-primary/20 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
              >
                <X size={18} aria-hidden="true" />
              </DialogPrimitive.Close>
            </div>

            <SidebarNav onNavigate={closeMobile} />
          </DialogPrimitive.Content>
        </DialogPrimitive.Portal>
      </DialogPrimitive.Root>
    </>
  );
}
