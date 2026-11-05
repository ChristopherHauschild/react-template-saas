"use client";

import { type FormEvent, useEffect, useRef, useState } from "react";
import Link from "next/link";

import { Button } from "@/shared/components/ui/button";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/shared/components/ui/card";
import { Input } from "@/shared/components/ui/input";
import { Label } from "@/shared/components/ui/label";
import { cn } from "@/shared/utils/cn";
import { requestCsvDownload, saveCsvFile } from "@/shared/utils/csv-download-client";
import {
  DATE_RANGE_MAX_YEAR,
  DATE_RANGE_MIN_YEAR,
  type DateRangeField,
  parseDateRange,
} from "@/shared/utils/date-range";

/** The words every export card uses, whatever it exports. */
export const CSV_EXPORT_COMMON_COPY = {
  download: "Download CSV",
  downloading: "Preparing download…",
  cancel: "Cancel",
  cancelled: "Export cancelled. Nothing was downloaded.",
  signedOut:
    "Your session has ended, so nothing was downloaded. Sign in again, then retry.",
  signIn: "Sign in again",
  network:
    "We couldn't reach the server, so nothing was downloaded. Check your connection and try again.",
  unexpected:
    "Something went wrong while downloading your export, so nothing was saved. Please try again in a moment; if this keeps happening, contact support.",
  waitCountdown: (clock: string) => `You can export again in ${clock}.`,
  readyAgain: "You can export again now.",
} as const;

/** Seconds as a countdown clock: 5 → "0:05", 125 → "2:05". */
export function countdownClock(seconds: number): string {
  const whole = Math.max(0, Math.ceil(seconds));
  return `${Math.floor(whole / 60)}:${String(whole % 60).padStart(2, "0")}`;
}

/** The words one export card uses for what it exports. */
export type CsvExportCopy = typeof CSV_EXPORT_COMMON_COPY & {
  title: string;
  description: string;
  /** Accessible name of the form, e.g. "Export invoices". */
  formLabel: string;
  datesHint: string;
  /** Shown while the export is being prepared. */
  progress: string;
  /** What the status line says once the file has been handed to the browser. */
  downloaded: (fileName: string, rowCount: number | null) => string;
};

/**
 * "Downloaded x.csv with 25 invoices." — the usual `downloaded` copy, for a
 * record noun (`one`/`other`) and what to say about an empty period.
 */
export function downloadedCountText(
  fileName: string,
  rowCount: number | null,
  words: { one: string; other: string; none: string },
): string {
  if (rowCount === null) return `Downloaded ${fileName}.`;
  if (rowCount === 0) return `Downloaded ${fileName}. ${words.none}`;

  return `Downloaded ${fileName} with ${rowCount.toLocaleString("en-US")} ${rowCount === 1 ? words.one : words.other}.`;
}

export type CsvExportCardProps = {
  /** Same-origin path of the export route, e.g. `/billing/export/invoices`. */
  path: string;
  copy: CsvExportCopy;
  /**
   * Prefix of the card's element ids (`<prefix>-from`, `<prefix>-to`, …).
   * Unique per card, so several cards can share a page.
   */
  idPrefix: string;
  /** `data-export` value, for tests and styling hooks. */
  exportName: string;
  /** Where "Sign in again" leads. */
  signInHref: string;
};

type FieldErrors = Partial<Record<DateRangeField, string>>;

type ExportState =
  | { status: "idle" }
  | { status: "downloading" }
  | { status: "downloaded"; fileName: string; rowCount: number | null }
  | { status: "cancelled" }
  /** A wait the server imposed has ended. */
  | { status: "ready" }
  | {
      status: "failed";
      /** Shown as an alert unless the field messages say it all. */
      message: string | null;
      fields: FieldErrors;
      signedOut: boolean;
      /**
       * Set when the route said "too many exports" (429): when (epoch ms) it
       * will accept another, and the whole seconds left, counted down by a timer.
       */
      wait?: { until: number; secondsLeft: number };
    };

const FIELD_NAMES: readonly DateRangeField[] = ["from", "to", "range"];

/** Only the field messages this form can show, from whatever the server sent. */
function knownFields(fields: Record<string, string>): FieldErrors {
  return Object.fromEntries(
    Object.entries(fields).filter(([name]) =>
      (FIELD_NAMES as readonly string[]).includes(name),
    ),
  );
}

function elementIds(prefix: string) {
  return {
    from: `${prefix}-from`,
    to: `${prefix}-to`,
    hint: `${prefix}-dates-hint`,
    wait: `${prefix}-wait`,
    error: (field: DateRangeField) => `${prefix}-${field}-error`,
  };
}

/**
 * One export on the exports page: a date range and a download button,
 * backed by an export route (see `csvDownloadResponse`). Shared by every
 * export — invoices, account activity — so they all behave the same; each
 * card has its own state, request and ids, so they work independently side
 * by side.
 *
 * The download is a `fetch` (`requestCsvDownload`), not a navigation, so the
 * user stays on the page whatever happens: a finished file is handed to the
 * browser's downloads, and every failure — dates the server refused, a
 * record it cannot resolve, a source being unavailable, a lost connection,
 * an expired session — is shown here, beside the field it is
 * about where there is one. The route only ever answers a complete file, so
 * nothing partial can be saved.
 *
 * The date fields are uncontrolled and read from the form on submit: with
 * controlled fields, a date typed before hydration was reset by React, and
 * the export silently covered another range than the one on screen. (A click
 * before hydration submits the form natively to this page, which just
 * reloads it — it never lands on the route's plain-text answer.)
 *
 * The dates are checked here first with the same rules the route applies
 * (`parseDateRange`), which saves a round trip for an obvious mistake; the
 * route checks them again regardless. While an export is being prepared the
 * button says so and is marked busy, a live region explains the wait, a
 * second submit does nothing, and the request can be cancelled (also when the
 * page is left).
 */
export function CsvExportCard({
  path,
  copy,
  idPrefix,
  exportName,
  signInHref,
}: CsvExportCardProps) {
  const ID = elementIds(idPrefix);
  const [state, setState] = useState<ExportState>({ status: "idle" });

  const inFlight = useRef<AbortController | null>(null);
  const inputs = {
    from: useRef<HTMLInputElement>(null),
    to: useRef<HTMLInputElement>(null),
  };
  const downloadRef = useRef<HTMLButtonElement>(null);

  // Leaving the page cancels an export still being prepared.
  useEffect(() => () => inFlight.current?.abort(), []);

  const downloading = state.status === "downloading";
  const wait = state.status === "failed" ? state.wait : undefined;
  const waitUntil = wait?.until;

  // Count a server-imposed wait down, once a second, until it is over. The
  // clock is read in the timer, never while rendering.
  useEffect(() => {
    if (waitUntil === undefined) return;

    const timer = setInterval(() => {
      const secondsLeft = Math.ceil((waitUntil - Date.now()) / 1000);

      setState((current) => {
        if (current.status !== "failed" || current.wait?.until !== waitUntil)
          return current;
        if (secondsLeft <= 0) return { status: "ready" };
        return { ...current, wait: { until: waitUntil, secondsLeft } };
      });
    }, 1000);

    return () => clearInterval(timer);
  }, [waitUntil]);
  const fieldErrors: FieldErrors = state.status === "failed" ? state.fields : {};

  const onFieldChange = (name: "from" | "to") => {
    // An edited field's message (and the range's, which involves both) no
    // longer describes what is in it.
    setState((current) => {
      if (current.status !== "failed") return current;
      const fields = { ...current.fields };
      delete fields[name];
      delete fields.range;
      return { ...current, fields };
    });
  };

  const onSubmit = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    // One export at a time, and none while the route has asked us to wait.
    if (inFlight.current || wait !== undefined) return;

    // Read from the form itself, not from React state: the fields are
    // uncontrolled, so a date typed before the page finished hydrating is
    // kept — and what is sent is always exactly what is on screen.
    const data = new FormData(event.currentTarget);
    const parsed = parseDateRange({
      from: String(data.get("from") ?? ""),
      to: String(data.get("to") ?? ""),
    });

    if (!parsed.ok) {
      setState({
        status: "failed",
        message: null,
        fields: parsed.errors,
        signedOut: false,
      });
      // To the first field that needs fixing (a range error is about both; start at From).
      const first = parsed.errors.from || parsed.errors.range ? "from" : "to";
      inputs[first].current?.focus();
      return;
    }

    const query = new URLSearchParams();
    if (parsed.range.from) query.set("from", parsed.range.from);
    if (parsed.range.to) query.set("to", parsed.range.to);
    // `toString()`, not `query.size`: older browsers lack `size`, and a range
    // silently dropped would export everything instead of what was asked for.
    const search = query.toString();
    const url = search === "" ? path : `${path}?${search}`;

    const controller = new AbortController();
    inFlight.current = controller;
    setState({ status: "downloading" });

    const result = await requestCsvDownload(url, { signal: controller.signal });

    // Unmounted, or another request took over: this answer is no longer wanted.
    if (inFlight.current !== controller) return;
    inFlight.current = null;

    switch (result.kind) {
      case "file":
        saveCsvFile(result.blob, result.fileName);
        setState({
          status: "downloaded",
          fileName: result.fileName,
          rowCount: result.rowCount,
        });
        return;

      case "rejected": {
        const fields = knownFields(result.fields);
        const seconds =
          result.code === "rate_limited" ? result.retryAfterSeconds : undefined;
        setState({
          status: "failed",
          // With field messages beside the fields, the summary would only repeat them.
          message: Object.keys(fields).length > 0 ? null : result.message,
          fields,
          signedOut: false,
          ...(seconds !== undefined && {
            wait: { until: Date.now() + seconds * 1000, secondsLeft: seconds },
          }),
        });
        return;
      }

      case "signed_out":
        setState({
          status: "failed",
          message: copy.signedOut,
          fields: {},
          signedOut: true,
        });
        return;

      case "network":
        setState({
          status: "failed",
          message: copy.network,
          fields: {},
          signedOut: false,
        });
        return;

      case "unexpected":
        setState({
          status: "failed",
          message: copy.unexpected,
          fields: {},
          signedOut: false,
        });
        return;

      case "aborted":
        setState({ status: "cancelled" });
        return;
    }
  };

  const cancel = () => {
    const controller = inFlight.current;
    if (!controller) return;

    inFlight.current = null;
    controller.abort();
    setState({ status: "cancelled" });
    // The Cancel button is about to disappear; keep focus in the form.
    downloadRef.current?.focus();
  };

  const describedBy = (name: "from" | "to") => {
    const error = fieldErrors[name]
      ? ID.error(name)
      : fieldErrors.range
        ? ID.error("range")
        : null;
    return [ID.hint, error].filter(Boolean).join(" ");
  };

  const status =
    state.status === "downloading"
      ? copy.progress
      : state.status === "downloaded"
        ? copy.downloaded(state.fileName, state.rowCount)
        : state.status === "cancelled"
          ? copy.cancelled
          : state.status === "ready"
            ? copy.readyAgain
            : "";

  return (
    <Card data-export={exportName} data-export-state={state.status}>
      <CardHeader>
        <CardTitle>{copy.title}</CardTitle>
        <CardDescription>{copy.description}</CardDescription>
      </CardHeader>

      <CardContent>
        <form
          onSubmit={onSubmit}
          noValidate
          aria-label={copy.formLabel}
          aria-busy={downloading || undefined}
          className="grid gap-4"
        >
          <div className="grid gap-3 sm:grid-cols-2">
            {(["from", "to"] as const).map((name) => (
              <div key={name} className="grid gap-1">
                <Label htmlFor={ID[name]}>{name === "from" ? "From" : "To"}</Label>
                <Input
                  ref={inputs[name]}
                  id={ID[name]}
                  name={name}
                  type="date"
                  min={`${DATE_RANGE_MIN_YEAR}-01-01`}
                  max={`${DATE_RANGE_MAX_YEAR}-12-31`}
                  defaultValue=""
                  onChange={() => onFieldChange(name)}
                  aria-invalid={
                    fieldErrors[name] !== undefined ||
                    fieldErrors.range !== undefined ||
                    undefined
                  }
                  aria-describedby={describedBy(name)}
                  className="min-h-11 sm:min-h-8"
                />
                <FieldError id={ID.error(name)} message={fieldErrors[name]} />
              </div>
            ))}
          </div>

          <FieldError id={ID.error("range")} message={fieldErrors.range} />

          <p id={ID.hint} className="text-xs text-muted-foreground">
            {copy.datesHint}
          </p>

          <div className="flex flex-wrap items-center gap-2">
            <Button
              ref={downloadRef}
              type="submit"
              aria-disabled={downloading || wait !== undefined || undefined}
              aria-busy={downloading || undefined}
              aria-describedby={wait ? ID.wait : undefined}
              className="min-h-11 flex-1 aria-disabled:cursor-wait aria-disabled:opacity-70 sm:min-h-8 sm:flex-none"
            >
              {downloading ? copy.downloading : copy.download}
            </Button>

            {downloading && (
              <Button
                type="button"
                variant="ghost"
                onClick={cancel}
                className="min-h-11 flex-1 sm:min-h-8 sm:flex-none"
              >
                {copy.cancel}
              </Button>
            )}
          </div>

          {state.status === "failed" && state.message !== null && (
            <div
              role="alert"
              data-export-error
              className="rounded-lg border border-red-200 bg-red-50 p-3 text-sm text-red-700 dark:border-red-900 dark:bg-red-950/40 dark:text-red-300"
            >
              <p>{state.message}</p>
              {state.signedOut && (
                <Link
                  href={signInHref}
                  className="mt-1 inline-block font-medium underline"
                >
                  {copy.signIn}
                </Link>
              )}
            </div>
          )}

          {wait && (
            <p
              id={ID.wait}
              data-export-wait
              // Not live: the alert above said once how long to wait; a
              // region announcing every second would drown everything else.
              aria-live="off"
              className="text-sm font-medium text-foreground tabular-nums"
            >
              {copy.waitCountdown(countdownClock(wait.secondsLeft))}
            </p>
          )}

          <p
            role="status"
            aria-live="polite"
            aria-atomic="true"
            className={cn("text-sm text-muted-foreground", status === "" && "sr-only")}
          >
            {status}
          </p>
        </form>
      </CardContent>
    </Card>
  );
}

function FieldError({ id, message }: { id: string; message: string | undefined }) {
  if (!message) return null;

  return (
    <p id={id} role="alert" className="text-xs text-red-600 dark:text-red-400">
      {message}
    </p>
  );
}
