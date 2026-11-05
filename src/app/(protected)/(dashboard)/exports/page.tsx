import { InvoiceExportCard } from "@/features/billing/components/invoice-export-card";
import { AccountActivityExportCard } from "@/features/settings/components/account-activity-export-card";

/**
 * Exports: the user's own data as CSV files. Each card downloads through its
 * export route (`/billing/export/invoices`, `/settings/export/activity`),
 * which establishes the session, validates the dates, collects everything in
 * them and answers only a complete file — or an error the card shows in
 * place. The cards share their behaviour (`CsvExportCard`) but nothing else:
 * each has its own dates, request and state, so one can be exporting,
 * failing or cancelled while the other is used. The page itself
 * reads nothing, so it cannot fail on the user's data; the (protected)
 * layout's guard has already required a session.
 */
export default function ExportsPage() {
  return (
    <div className="max-w-3xl space-y-8">
      <div>
        <h2 className="text-2xl font-bold">Exports</h2>

        <p className="text-muted-foreground text-sm">
          Download your data as CSV files you can open in any spreadsheet.
        </p>
      </div>

      <InvoiceExportCard />

      <AccountActivityExportCard />
    </div>
  );
}
