import { InvoiceDocumentBanner } from "@/features/billing/components/invoice-document-banner";
import { InvoiceHistoryCard } from "@/features/billing/components/invoice-history-card";
import { SubscriptionStatusCard } from "@/features/billing/components/subscription-status-card";
import { toBillingSummary } from "@/features/billing/services/billing-summary";
import { getCurrentPlan } from "@/features/billing/services/get-current-plan";
import { getInvoiceHistory } from "@/features/billing/services/get-invoice-history";
import { getSubscriptionOverview } from "@/features/billing/services/get-subscription-overview";
import {
  INVOICE_DOCUMENT_NOTICE_PARAM,
  parseInvoiceDocumentNotice,
} from "@/features/billing/services/invoice-document-notice";
import { parseInvoiceFilters } from "@/features/billing/services/invoice-filters";
import { requireAuth } from "@/infrastructure/auth/guards/require-auth";

type Props = {
  /**
   * `?status=&from=&to=&q=` are the invoice filters (a GET form, so a change
   * is a navigation and paging starts over); `?document=` is set by the
   * invoice-document route when a document could not be opened.
   */
  searchParams?: Promise<Record<string, string | string[] | undefined>>;
};

/**
 * Subscription status from our own records (written by the Stripe webhook),
 * the way into the Stripe Customer Portal, and the user's invoice history.
 *
 * The subscription card shows Stripe's status for the current subscription
 * when it could be read (the same rule as the dashboard, so the two pages
 * never disagree — notably right after a change in the Customer Portal, which
 * returns here before the webhook has updated our records) and our records'
 * otherwise. The invoice card calls Stripe for the one customer the records
 * point at. One read of the records feeds everything, so the cards never
 * disagree about which subscription and billing account are the user's.
 */
export default async function BillingPage({ searchParams }: Props) {
  // Same per-request cached lookup the (protected) layout's guard already made.
  const user = await requireAuth();

  const params = await searchParams;
  const filters = parseInvoiceFilters(params);
  const notice = parseInvoiceDocumentNotice(params?.[INVOICE_DOCUMENT_NOTICE_PARAM]);

  const overview = await getSubscriptionOverview(user.id);
  const summary = toBillingSummary(overview);
  // Two independent Stripe reads off the same records, side by side. Invalid
  // filters list nothing: the card shows what to fix instead.
  const [currentPlan, invoices] = await Promise.all([
    getCurrentPlan(user.id, { overview }),
    filters.ok
      ? getInvoiceHistory(user.id, { overview, filters: filters.filters })
      : null,
  ]);

  return (
    <div className="space-y-8">
      <div>
        <h2 className="text-2xl font-bold">Billing</h2>

        <p className="text-muted-foreground text-sm">
          Your subscription, how to manage it, and your invoices.
        </p>
      </div>

      <SubscriptionStatusCard summary={summary} currentPlan={currentPlan} />

      <InvoiceDocumentBanner notice={notice} />

      <InvoiceHistoryCard history={invoices} filters={filters} />
    </div>
  );
}
