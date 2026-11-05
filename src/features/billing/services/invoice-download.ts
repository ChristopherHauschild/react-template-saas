import "server-only";

import { csvFileNameForRange } from "@/shared/utils/csv";
import type { CsvDownload } from "@/shared/utils/csv-download";
import { dateRangeParamsFrom, parseDateRange } from "@/shared/utils/date-range";

import { collectInvoicesForExport } from "./collect-invoice-export";
import { buildInvoiceExportCsv, INVOICE_EXPORT_FILE_BASE } from "./invoice-export";

export { INVOICE_DOWNLOAD_PATH } from "./invoice-download-path";

/** A wait in words, rounded up: "30 seconds", "a minute", "3 minutes". */
export function waitInWords(seconds: number): string {
  if (seconds <= 1) return "a second";
  if (seconds < 60) return `${seconds} seconds`;

  const minutes = Math.ceil(seconds / 60);

  return minutes === 1 ? "a minute" : `${minutes} minutes`;
}

export const INVOICE_DOWNLOAD_COPY = {
  invalidRange: "Check the dates of your export.",
  tooLarge:
    "You have too many invoices in this period to export in one file. Choose a shorter date range and try again.",
  ambiguous:
    "Your records point at more than one billing account, or at one we can't identify, so your invoices can't be exported safely. Please contact support.",
  unavailable:
    "We couldn't export your invoices right now. Please try again in a moment; if this keeps happening, contact support.",
  rateLimited: (retryAfterSeconds: number) =>
    `You've exported invoices several times in a short while. To avoid overloading our billing provider, please wait ${waitInWords(retryAfterSeconds)} before exporting again.`,
} as const;

export type PrepareInvoiceDownloadOptions = {
  /** The moment the export is made, for the file name (tests). */
  now?: Date;
};

/**
 * Prepares the signed-in user's invoice download from the request's query
 * string: the date range (`?from=YYYY-MM-DD&to=YYYY-MM-DD`, both optional,
 * UTC days) is parsed and validated HERE, on the server, then every issued
 * invoice of the user's own billing account in that range is collected
 * (`collectInvoicesForExport`: the customer resolved from the user's records
 * under RLS, all or nothing) and only then turned into a file.
 *
 * `userId` must come from the verified session (`requireAuth()`); nothing in
 * `searchParams` names a user or a customer. Outcomes:
 * - a complete file — header only when the user has no billing account
 *   (`none`: there are no invoices to list) or nothing in the range;
 * - `invalid_range`: nothing was read;
 * - `ambiguous`: the records point at several accounts; exporting one of them
 *   would be a guess, so nothing is exported (as on the page and the Portal);
 * - `rate_limited`: the user's export allowance is used up; Stripe was not
 *   asked, and the answer says how long to wait;
 * - `too_large` / `unavailable`: no file at all, never a partial one.
 */
export async function prepareInvoiceDownload(
  userId: string,
  searchParams: URLSearchParams,
  options: PrepareInvoiceDownloadOptions = {},
): Promise<CsvDownload> {
  const parsed = parseDateRange(dateRangeParamsFrom(searchParams));

  if (!parsed.ok) {
    return {
      ok: false,
      code: "invalid_range",
      message: INVOICE_DOWNLOAD_COPY.invalidRange,
      fields: parsed.errors,
    };
  }

  const collection = await collectInvoicesForExport(userId, { range: parsed.range });

  // The collector (or the customer resolution) has logged the cause of failures.
  switch (collection.kind) {
    case "ok":
    case "none":
      return {
        ok: true,
        fileName: csvFileNameForRange(
          INVOICE_EXPORT_FILE_BASE,
          parsed.range,
          options.now ?? new Date(),
        ),
        body: buildInvoiceExportCsv(collection.kind === "ok" ? collection.invoices : []),
        rowCount: collection.kind === "ok" ? collection.invoices.length : 0,
      };

    case "invalid_range":
      return {
        ok: false,
        code: "invalid_range",
        message: INVOICE_DOWNLOAD_COPY.invalidRange,
      };

    case "ambiguous":
      return { ok: false, code: "ambiguous", message: INVOICE_DOWNLOAD_COPY.ambiguous };

    case "rate_limited":
      return {
        ok: false,
        code: "rate_limited",
        message: INVOICE_DOWNLOAD_COPY.rateLimited(collection.retryAfterSeconds),
        retryAfterSeconds: collection.retryAfterSeconds,
      };

    case "unavailable":
      return collection.reason === "too_large"
        ? { ok: false, code: "too_large", message: INVOICE_DOWNLOAD_COPY.tooLarge }
        : { ok: false, code: "unavailable", message: INVOICE_DOWNLOAD_COPY.unavailable };
  }
}
