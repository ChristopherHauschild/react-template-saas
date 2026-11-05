"use client";

import { type FormEvent, useEffect, useRef, useState, useTransition } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";

import { ROUTES } from "@/config/routes";
import { Button } from "@/shared/components/ui/button";
import { Input } from "@/shared/components/ui/input";
import { Label } from "@/shared/components/ui/label";
import { cn } from "@/shared/utils/cn";

import {
  INVOICE_FILTER_PARAMS,
  INVOICE_NUMBER_MAX_LENGTH,
  INVOICE_STATUS_FILTER_OPTIONS,
  type ParsedInvoiceFilters,
} from "../services/invoice-filters";

export const APPLY_FILTERS_LABEL = "Apply filters";
export const APPLY_FILTERS_PENDING_LABEL = "Applying filters…";
export const CLEAR_FILTERS_LABEL = "Clear filters";
export const CLEAR_FILTERS_PENDING_LABEL = "Clearing filters…";
export const FILTERS_PENDING_TEXT = "Updating the invoice list…";

type FieldName = keyof typeof INVOICE_FILTER_PARAMS;

type Values = Record<FieldName, string>;

type Props = {
  parsed: ParsedInvoiceFilters;
  /**
   * What the listing below shows for these filters (e.g. "10 invoices shown"),
   * announced to screen readers once a filter navigation has completed.
   */
  resultSummary?: string;
};

/** The field values the URL currently stands for — the server's view, which is the truth. */
function valuesOf(parsed: ParsedInvoiceFilters): Values {
  return parsed.ok
    ? {
        status: parsed.filters.status ?? "",
        from: parsed.filters.from ?? "",
        to: parsed.filters.to ?? "",
        number: parsed.filters.number ?? "",
      }
    : parsed.input;
}

/**
 * Builds the destination of a submit: the canonical `/billing?…` for the
 * fields, empty ones left out (a native GET submit would send `from=&to=`).
 */
export function filtersHref(values: Values): string {
  const params = new URLSearchParams();

  for (const name of Object.keys(INVOICE_FILTER_PARAMS) as FieldName[]) {
    const value = values[name].trim();
    if (value !== "") params.set(INVOICE_FILTER_PARAMS[name], value);
  }

  const query = params.toString();

  return query === "" ? ROUTES.billing : `${ROUTES.billing}?${query}`;
}

/**
 * The invoice filters. A GET form whose submit is a client-side navigation to
 * `/billing?status=&from=&to=&q=`: the filters live in the URL, the server
 * renders the first page of the new listing (so changing a filter resets
 * paging by construction; the list is keyed by the filters too), and the
 * scroll position is kept so the results appear right under the form.
 * Without JavaScript it is still a plain GET form.
 *
 * The navigation runs in a transition, which is where the loading feedback
 * comes from: the buttons read "Applying…"/"Clearing…" and are marked busy,
 * a live region says the list is updating, and — once the new page has
 * rendered — what it shows. Focus stays on the button throughout.
 *
 * The fields are controlled and follow the URL: whenever the server renders
 * the form for another URL (Apply, Clear, the browser's back/forward), the
 * values are reset to what that URL says, so what is shown in the fields and
 * what is listed below never disagree. While typing, the user's edits win.
 *
 * Invalid input (typed into the URL, mostly) is shown back with a message per
 * field; nothing was sent to Stripe for it.
 */
export function InvoiceFiltersForm({ parsed, resultSummary }: Props) {
  const router = useRouter();
  const [pending, startTransition] = useTransition();

  // Which button started the navigation (for its label), and what to announce
  // once it has finished. `seenPending` mirrors `pending` so the end of a
  // navigation can be noticed during render — the new page's result summary
  // is in the props by then — without an effect.
  const [nav, setNav] = useState<{
    seenPending: boolean;
    navigating: "apply" | "clear" | null;
    /** Which navigation last finished, so focus can be handed over once it has. */
    finished: "apply" | "clear" | null;
    announcement: string;
  }>({ seenPending: false, navigating: null, finished: null, announcement: "" });

  if (nav.seenPending !== pending) {
    setNav({
      seenPending: pending,
      navigating: pending ? nav.navigating : null,
      finished: pending ? nav.finished : nav.navigating,
      announcement: pending ? "" : (resultSummary ?? "Invoice list updated."),
    });
  }

  const { navigating, announcement } = nav;
  const applyRef = useRef<HTMLButtonElement>(null);

  // Controlled values, reset whenever the URL the server rendered for changes
  // (React's "adjusting state when a prop changes" pattern: no remount, so
  // focus and the pending state survive the navigation).
  const fromUrl = valuesOf(parsed);
  const syncKey = JSON.stringify(fromUrl);
  const [synced, setSynced] = useState({ key: syncKey, values: fromUrl });

  if (synced.key !== syncKey) {
    setSynced({ key: syncKey, values: fromUrl });
  }

  const values = synced.values;
  const setValue = (name: FieldName, value: string) =>
    setSynced((current) => ({
      ...current,
      values: { ...current.values, [name]: value },
    }));

  const navigate = (href: string, kind: "apply" | "clear") => {
    setNav((current) => ({ ...current, navigating: kind, announcement: "" }));
    startTransition(() => {
      router.push(href, { scroll: false });
    });
  };

  const onSubmit = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (pending) return;
    navigate(filtersHref(values), "apply");
  };

  const errors = parsed.ok ? {} : parsed.errors;
  const showClear = !parsed.ok || parsed.active;

  // Clearing removes the very link the user activated: once that navigation
  // has finished and the link is gone, keyboard focus would fall back to the
  // document. Land it on Apply instead — the nearest control that is still here.
  useEffect(() => {
    if (nav.finished === "clear" && !showClear) {
      applyRef.current?.focus({ preventScroll: true });
    }
  }, [nav.finished, showClear]);

  const field = (name: FieldName | "range") => ({
    invalid: errors[name] !== undefined,
    describedBy: errors[name] !== undefined ? `invoice-filter-${name}-error` : undefined,
  });

  return (
    <form
      method="get"
      action={ROUTES.billing}
      onSubmit={onSubmit}
      aria-label="Filter invoices"
      aria-busy={pending || undefined}
      data-invoice-filters={parsed.ok ? (parsed.active ? "active" : "none") : "invalid"}
      className="grid grid-cols-2 gap-3 lg:grid-cols-[1fr_1fr_1fr_1.5fr_auto] lg:items-end"
    >
      <div className="col-span-2 grid gap-1 lg:col-span-1">
        <Label htmlFor="invoice-filter-status">Status</Label>
        <select
          id="invoice-filter-status"
          name={INVOICE_FILTER_PARAMS.status}
          value={values.status}
          onChange={(event) => setValue("status", event.target.value)}
          aria-invalid={field("status").invalid || undefined}
          aria-describedby={field("status").describedBy}
          className={cn(
            "h-8 rounded-lg border border-input bg-background px-2 text-sm outline-none focus-visible:border-ring focus-visible:ring-3 focus-visible:ring-ring/50",
            field("status").invalid && "border-red-400",
          )}
        >
          {INVOICE_STATUS_FILTER_OPTIONS.map((option) => (
            <option key={option.value} value={option.value}>
              {option.label}
            </option>
          ))}
        </select>
        <FieldError id="invoice-filter-status-error" message={errors.status} />
      </div>

      <div className="grid gap-1">
        <Label htmlFor="invoice-filter-from">From</Label>
        <Input
          id="invoice-filter-from"
          type="date"
          name={INVOICE_FILTER_PARAMS.from}
          value={values.from}
          onChange={(event) => setValue("from", event.target.value)}
          aria-invalid={field("from").invalid || field("range").invalid || undefined}
          aria-describedby={field("from").describedBy ?? field("range").describedBy}
        />
        <FieldError id="invoice-filter-from-error" message={errors.from} />
      </div>

      <div className="grid gap-1">
        <Label htmlFor="invoice-filter-to">To</Label>
        <Input
          id="invoice-filter-to"
          type="date"
          name={INVOICE_FILTER_PARAMS.to}
          value={values.to}
          onChange={(event) => setValue("to", event.target.value)}
          aria-invalid={field("to").invalid || field("range").invalid || undefined}
          aria-describedby={field("to").describedBy ?? field("range").describedBy}
        />
        <FieldError id="invoice-filter-to-error" message={errors.to} />
      </div>

      <div className="col-span-2 grid gap-1 lg:col-span-1">
        <Label htmlFor="invoice-filter-number">Invoice number</Label>
        <Input
          id="invoice-filter-number"
          type="search"
          name={INVOICE_FILTER_PARAMS.number}
          value={values.number}
          onChange={(event) => setValue("number", event.target.value)}
          placeholder="e.g. ABCD-0042"
          maxLength={INVOICE_NUMBER_MAX_LENGTH}
          autoComplete="off"
          aria-invalid={field("number").invalid || undefined}
          aria-describedby={field("number").describedBy}
        />
        <FieldError id="invoice-filter-number-error" message={errors.number} />
      </div>

      <div className="col-span-2 flex flex-wrap items-center gap-2 lg:col-span-1">
        <Button
          ref={applyRef}
          type="submit"
          variant="outline"
          aria-disabled={pending || undefined}
          aria-busy={navigating === "apply" || undefined}
          className="min-h-11 flex-1 aria-disabled:cursor-wait aria-disabled:opacity-70 sm:min-h-8 sm:flex-none"
        >
          {navigating === "apply" ? APPLY_FILTERS_PENDING_LABEL : APPLY_FILTERS_LABEL}
        </Button>

        {showClear && (
          <Button
            asChild
            variant="ghost"
            className="min-h-11 flex-1 aria-disabled:cursor-wait aria-disabled:opacity-70 sm:min-h-8 sm:flex-none"
          >
            <Link
              href={ROUTES.billing}
              scroll={false}
              aria-disabled={pending || undefined}
              aria-busy={navigating === "clear" || undefined}
              onClick={(event) => {
                // Same transition as Apply, so clearing has the same feedback;
                // the plain link still works without JavaScript.
                event.preventDefault();
                if (pending) return;
                navigate(ROUTES.billing, "clear");
              }}
            >
              {navigating === "clear" ? CLEAR_FILTERS_PENDING_LABEL : CLEAR_FILTERS_LABEL}
            </Link>
          </Button>
        )}
      </div>

      <FieldError
        id="invoice-filter-range-error"
        message={errors.range}
        className="col-span-2 lg:col-span-5"
      />

      <p
        role="status"
        aria-live="polite"
        aria-atomic="true"
        className={cn(
          "col-span-2 text-xs text-muted-foreground lg:col-span-5",
          !pending && announcement === "" && "sr-only",
        )}
      >
        {pending ? FILTERS_PENDING_TEXT : announcement}
      </p>
    </form>
  );
}

function FieldError({
  id,
  message,
  className,
}: {
  id: string;
  message: string | undefined;
  className?: string;
}) {
  if (!message) return null;

  return (
    <p
      id={id}
      role="alert"
      className={cn("text-xs text-red-600 dark:text-red-400", className)}
    >
      {message}
    </p>
  );
}
