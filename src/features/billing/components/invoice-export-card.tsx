"use client";

import { ROUTES } from "@/config/routes";
import {
  CSV_EXPORT_COMMON_COPY,
  CsvExportCard,
  type CsvExportCopy,
  downloadedCountText,
} from "@/shared/components/csv-export-card";

import { INVOICE_DOWNLOAD_PATH } from "../services/invoice-download-path";

/** What the status line says once the invoice file has been handed to the browser. */
export function downloadedText(fileName: string, rowCount: number | null): string {
  return downloadedCountText(fileName, rowCount, {
    one: "invoice",
    other: "invoices",
    none: "There are no invoices in this period.",
  });
}

export const INVOICE_EXPORT_COPY = {
  ...CSV_EXPORT_COMMON_COPY,
  title: "Invoices",
  description:
    "A CSV file of your issued invoices — date, number, status, total and currency — that opens in any spreadsheet. Drafts are not included.",
  formLabel: "Export invoices",
  datesHint:
    "Dates are UTC days and both are included. Leave them empty to export all of your invoices.",
  progress:
    "Preparing your invoice export. This can take a little while if you have many invoices.",
  downloaded: downloadedText,
} satisfies CsvExportCopy;

/**
 * The invoice export on the exports page, backed by
 * `GET /billing/export/invoices`. All behaviour — date checks, loading,
 * cancelling, errors in place, saving the file — is the shared
 * `CsvExportCard`'s; this only says what is exported and where from.
 */
export function InvoiceExportCard() {
  return (
    <CsvExportCard
      path={INVOICE_DOWNLOAD_PATH}
      copy={INVOICE_EXPORT_COPY}
      idPrefix="invoice-export"
      exportName="invoices"
      signInHref={ROUTES.login}
    />
  );
}
