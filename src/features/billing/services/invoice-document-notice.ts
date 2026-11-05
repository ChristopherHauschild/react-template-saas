/**
 * The `?document=` query parameter the invoice-document route sends the user
 * back to the billing page with when a document could not be opened. The value
 * is UNTRUSTED (anyone can type it), so the notices only ever say that a
 * document was not opened — nothing about the account or any invoice.
 */
export const INVOICE_DOCUMENT_NOTICE_PARAM = "document";

export const INVOICE_DOCUMENT_NOTICES = ["missing", "unavailable"] as const;

export type InvoiceDocumentNotice = (typeof INVOICE_DOCUMENT_NOTICES)[number];

export function parseInvoiceDocumentNotice(
  value: string | string[] | undefined,
): InvoiceDocumentNotice | null {
  return typeof value === "string" &&
    (INVOICE_DOCUMENT_NOTICES as readonly string[]).includes(value)
    ? (value as InvoiceDocumentNotice)
    : null;
}

export const INVOICE_DOCUMENT_NOTICE_CONTENT: Record<
  InvoiceDocumentNotice,
  { title: string; body: string }
> = {
  missing: {
    title: "That invoice document isn't available",
    body: "Stripe hasn't issued it yet, or the invoice no longer exists. The list below shows what is currently available.",
  },
  unavailable: {
    title: "The invoice document couldn't be opened",
    body: "Please try again in a moment.",
  },
};
