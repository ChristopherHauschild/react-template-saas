import { CheckoutStatusBanner, parseCheckoutStatus } from "@/features/billing";
import { AccountOverview } from "@/features/billing/components/account-overview";
import { toBillingSummary } from "@/features/billing/services/billing-summary";
import { getCurrentPlan } from "@/features/billing/services/get-current-plan";
import { getLatestInvoice } from "@/features/billing/services/get-latest-invoice";
import { getPlans } from "@/features/billing/services/get-plans";
import { getSubscriptionOverview } from "@/features/billing/services/get-subscription-overview";
import { findFreePlan } from "@/features/billing/services/plan-catalog";
import { requireAuth } from "@/infrastructure/auth/guards/require-auth";

type Props = { searchParams: Promise<{ checkout?: string | string[] }> };

/**
 * The signed-in user's account overview: the plan they are on and the state of
 * their billing account, from the same records the billing page shows (written
 * by the Stripe webhook, read as the user under RLS). The subscription's status
 * comes from those rows, so it is as current as the last webhook that was
 * applied; which plan the subscription is for is read from Stripe, for that one
 * subscription, and the newest issued invoice for the one customer the records
 * name — a user without a billing account costs no Stripe call. The invoice
 * history and the Customer Portal live on the billing page.
 *
 * `?checkout=` is where Stripe Checkout sends the user back; it is untrusted and
 * only ever acknowledged, never taken as confirmation of a payment.
 */
export default async function DashboardPage({ searchParams }: Props) {
  // Same per-request cached lookup the (protected) layout's guard already made.
  const [user, { checkout }] = await Promise.all([requireAuth(), searchParams]);

  const [overview, plans] = await Promise.all([
    getSubscriptionOverview(user.id),
    getPlans(),
  ]);
  const summary = toBillingSummary(overview);
  // The same read of the records decides which subscription's plan, and which
  // customer's invoices, are asked about — two independent Stripe reads, side by side.
  const [currentPlan, latestInvoice] = await Promise.all([
    getCurrentPlan(user.id, { overview }),
    getLatestInvoice(user.id, { overview }),
  ]);

  return (
    <div className="space-y-8">
      <CheckoutStatusBanner status={parseCheckoutStatus(checkout)} />

      <div>
        <h2 className="text-2xl font-bold">Welcome back 👋</h2>

        <p className="text-muted-foreground text-sm break-words">
          Logged in as {user.email}
        </p>
      </div>

      <AccountOverview
        summary={summary}
        freePlan={findFreePlan(plans)}
        currentPlan={currentPlan}
        latestInvoice={latestInvoice}
      />
    </div>
  );
}
