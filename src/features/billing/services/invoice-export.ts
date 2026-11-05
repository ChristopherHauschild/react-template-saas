/**
 * The invoice history as a CSV download: the column layout and how each
 * invoice becomes a row. Pure — collecting the invoices (every page of the
 * signed-in user's own customer) is the caller's job; this module only
 * formats what it is given, one row per invoice, in the order given.
 *
 * Built from `InvoiceSummary`, the same display model the billing page shows,
 * which by design carries no Stripe identifiers and no document URLs (those
 * embed access tokens and grant access to anyone holding the file). The
 * export therefore contains exactly what the page shows: date, number,
 * status, total and currency — nothing the user could not already see.
 * Drafts are absent for the same reason they are absent from the page.
 */
import {
  CSV_UTF8_BOM,
  type CsvCell,
  csvFileName,
  csvNumeral,
  formatCsv,
} from "@/shared/utils/csv";

import {
  INVOICE_STATUS_CONTENT,
  type InvoiceSummary,
  minorUnitDigits,
} from "./invoice-history";

/** Column headings, in file order. */
export const INVOICE_EXPORT_COLUMNS = [
  "Date (UTC)",
  "Invoice number",
  "Status",
  "Total",
  "Currency",
] as const;

/** `invoices-YYYY-MM-DD.csv`. */
export const INVOICE_EXPORT_FILE_BASE = "invoices";

export function invoiceExportFileName(now: Date): string {
  return csvFileName(INVOICE_EXPORT_FILE_BASE, now);
}

/**
 * An amount in Stripe's minor units as an exact decimal numeral in the
 * currency's major unit: `2900` + `usd` → `29.00`, `-550` + `eur` → `-5.50`,
 * `2900` + `jpy` → `2900`, `1234` + `kwd` → `1.234`. Integer string arithmetic
 * only — no floating point, no grouping separators, no currency symbol — so a
 * spreadsheet reads it as the number it is. The currency is its own column.
 */
export function formatInvoiceExportAmount(total: number, currency: string): string {
  if (!Number.isSafeInteger(total)) {
    throw new Error("formatInvoiceExportAmount: total must be a safe integer");
  }

  const digits = minorUnitDigits(currency);
  const sign = total < 0 ? "-" : "";
  const magnitude = String(Math.abs(total));

  if (digits === 0) return `${sign}${magnitude}`;

  const padded = magnitude.padStart(digits + 1, "0");

  return `${sign}${padded.slice(0, -digits)}.${padded.slice(-digits)}`;
}

/** One invoice as a row, in `INVOICE_EXPORT_COLUMNS` order. */
export function invoiceExportRow(invoice: InvoiceSummary): CsvCell[] {
  return [
    // The UTC calendar day — what the page shows and the date filters use.
    invoice.createdAt.slice(0, 10),
    invoice.number,
    INVOICE_STATUS_CONTENT[invoice.status].label,
    csvNumeral(formatInvoiceExportAmount(invoice.total, invoice.currency)),
    invoice.currency.toUpperCase(),
  ];
}

/**
 * The complete file: UTF-8 BOM, header, and one row per invoice in the order
 * given (newest first, as listed). An empty list is a header-only file.
 *
 * `invoices` must be the user's COMPLETE history. A partial collection (a page
 * failed, the scan stopped early) must not be turned into a file at all:
 * nothing in a CSV could tell the user that rows are missing.
 */
export function buildInvoiceExportCsv(invoices: readonly InvoiceSummary[]): string {
  return CSV_UTF8_BOM + formatCsv(INVOICE_EXPORT_COLUMNS, invoices.map(invoiceExportRow));
}
