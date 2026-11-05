import * as React from "react";

import { cn } from "@/shared/utils/cn";

/**
 * Small status pill (e.g. "Soon"). High-contrast by design so it stays legible
 * next to muted/disabled text.
 */
export function Badge({ className, ...props }: React.ComponentProps<"span">) {
  return (
    <span
      data-slot="badge"
      className={cn(
        "inline-flex shrink-0 items-center rounded-full border border-border bg-muted px-1.5 py-0.5 text-[10px] font-semibold uppercase tracking-wide text-foreground/80",
        className,
      )}
      {...props}
    />
  );
}
