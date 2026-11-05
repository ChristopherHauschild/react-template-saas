"use client";

import * as React from "react";

import { Search } from "lucide-react";

import { cn } from "@/shared/utils/cn";

type SearchTriggerProps = Omit<React.ComponentProps<"button">, "type" | "children"> & {
  label?: string;
  /** Keyboard hint rendered on the right (only when there is room). */
  shortcutHint?: string;
};

/**
 * Container width (of the nearest `@container` ancestor) above which the trigger
 * shows its label and shortcut hint instead of being icon-only.
 */
export const SEARCH_TRIGGER_EXPANDED_MIN_WIDTH = "14rem";

/**
 * Looks like a search field but is a real button: it opens the command palette
 * via `onClick` instead of dispatching synthetic keyboard events.
 *
 * Layout is driven by container queries, so the trigger adapts to the space its
 * parent actually has (which depends on the sidebar state, not just the viewport):
 * icon-only when cramped, otherwise a flexible field capped at 320px. If no ancestor
 * is a `@container`, the queries fall back to the viewport width.
 */
export function SearchTrigger({
  label = "Search...",
  shortcutHint = "⌘K",
  className,
  ...props
}: SearchTriggerProps) {
  return (
    <button
      type="button"
      aria-label="Search"
      aria-keyshortcuts="Meta+K Control+K"
      className={cn(
        "flex h-9 shrink-0 items-center gap-2 rounded-md bg-white/10 text-sm text-white/60 ring-1 ring-white/10 transition hover:bg-white/15 hover:text-white/80 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-white/60",
        // Cramped: icon-only square.
        "w-9 justify-center",
        // Room available: flexible field that shrinks before anything else and caps at 320px.
        "@min-[14rem]:min-w-0 @min-[14rem]:w-auto @min-[14rem]:max-w-[320px] @min-[14rem]:flex-1 @min-[14rem]:shrink @min-[14rem]:justify-start @min-[14rem]:px-3",
        className,
      )}
      {...props}
    >
      <Search size={16} aria-hidden="true" />

      <span className="hidden min-w-0 flex-1 truncate text-left @min-[14rem]:inline">
        {label}
      </span>

      <kbd
        aria-hidden="true"
        className="hidden shrink-0 rounded border border-white/20 px-1.5 py-0.5 font-sans text-[10px] font-medium text-white/70 @min-[14rem]:inline-block"
      >
        {shortcutHint}
      </kbd>
    </button>
  );
}
