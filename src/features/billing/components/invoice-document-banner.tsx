import {
  INVOICE_DOCUMENT_NOTICE_CONTENT,
  type InvoiceDocumentNotice,
} from "../services/invoice-document-notice";

/**
 * Shown when the invoice-document route sent the user back because a document
 * could not be opened. The notice comes from an UNTRUSTED query parameter, so
 * the copy states only that a document was not opened.
 */
export function InvoiceDocumentBanner({
  notice,
}: {
  notice: InvoiceDocumentNotice | null;
}) {
  if (!notice) return null;

  const { title, body } = INVOICE_DOCUMENT_NOTICE_CONTENT[notice];

  return (
    <div
      role="status"
      aria-live="polite"
      data-invoice-document-notice={notice}
      className="rounded-xl border border-border bg-muted px-4 py-3 text-sm text-foreground"
    >
      <p className="font-medium">{title}</p>
      <p className="mt-1 opacity-90">{body}</p>
    </div>
  );
}
