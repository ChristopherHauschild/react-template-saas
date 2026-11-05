/**
 * Where the invoice CSV download is served
 * (`src/app/(protected)/(dashboard)/billing/export/invoices/route.ts`). In its
 * own module so client components can link to it: the download service
 * itself is server-only.
 */
export const INVOICE_DOWNLOAD_PATH = "/billing/export/invoices";
