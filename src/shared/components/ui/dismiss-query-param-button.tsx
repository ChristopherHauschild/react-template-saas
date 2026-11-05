"use client";

import { usePathname, useRouter, useSearchParams } from "next/navigation";

import { X } from "lucide-react";

import { cn } from "@/shared/utils/cn";

type Props = {
  /** Query parameter whose presence shows the thing being dismissed. */
  param: string;
  /** Accessible name; describes what is dismissed ("Dismiss email change notice"). */
  label: string;
  className?: string;
};

/**
 * Closes a notice that is driven by a query parameter by removing that parameter
 * from the URL (a `replace`, so the Back button does not bring it back). Without
 * this, a status that arrived via redirect would outlive the event it reports:
 * it survives every later form submission and reload for as long as the URL is
 * kept.
 */
export function DismissQueryParamButton({ param, label, className }: Props) {
  const router = useRouter();
  const pathname = usePathname();
  const searchParams = useSearchParams();

  const dismiss = () => {
    const next = new URLSearchParams(searchParams);
    next.delete(param);
    const query = next.toString();

    router.replace(query ? `${pathname}?${query}` : pathname, { scroll: false });
  };

  return (
    <button
      type="button"
      onClick={dismiss}
      aria-label={label}
      className={cn(
        "flex h-7 w-7 shrink-0 items-center justify-center rounded-md opacity-70 transition hover:opacity-100 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring",
        className,
      )}
    >
      <X size={16} aria-hidden="true" />
    </button>
  );
}
