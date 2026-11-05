import Link from "next/link";

import { ROUTES } from "@/config/routes";
import { Badge } from "@/shared/components/ui/badge";
import { Button } from "@/shared/components/ui/button";
import {
  Card,
  CardContent,
  CardDescription,
  CardFooter,
  CardHeader,
  CardTitle,
} from "@/shared/components/ui/card";
import { cn } from "@/shared/utils/cn";

import type { BillingSummary } from "../services/billing-summary";
import { type CurrentPlan, formatPlanBilling } from "../services/current-plan";
import type { LatestInvoice } from "../services/get-latest-invoice";
import {
  isServicingStatus,
  isTerminalStatus,
} from "../services/get-subscription-overview";
import {
  formatInvoiceAmount,
  formatInvoiceDate,
  INVOICE_STATUS_CONTENT,
  invoiceDocumentPath,
  type InvoiceSummary,
} from "../services/invoice-history";
import { reconcileOverviewStatus } from "../services/overview-status";
import type { Plan } from "../types/plan";

import {
  STATUS_TONE_CLASS,
  subscriptionFactsOf,
  SubscriptionStatusBlock,
} from "./subscription-status-block";
import { PRICING_PATH } from "./subscription-status-card";

/** Label of the link from the overview to the billing page. */
export const GO_TO_BILLING_LABEL = "Go to billing";

type Props = {
  /** The user's subscription, from our own records (see `toBillingSummary`). */
  summary: BillingSummary;
  /** The catalog's free plan, shown as the current plan when there is no subscription. */
  freePlan: Plan | null;
  /** Which catalog plan the subscription is for, read from Stripe (see `getCurrentPlan`). */
  currentPlan: CurrentPlan;
  /** The newest issued invoice, read from Stripe (see `getLatestInvoice`). */
  latestInvoice: LatestInvoice;
};

/** Labels of the document link on the dashboard's invoice summary. */
export const DOWNLOAD_PDF_LABEL = "Download PDF";

/**
 * The dashboard's account overview: the plan the user is on, the state of
 * their subscription, and their latest invoice — built from the same records
 * the billing page shows, plus two reads of Stripe off those records (the
 * current subscription, the newest issued invoice). A user without a billing
 * account costs no Stripe call. The full invoice history and the Customer
 * Portal stay on the billing page.
 *
 * Three shapes of the whole, which must never be confused with each other:
 * - the records could not be read → "unavailable": no plan is named, nothing
 *   that depends on the records is offered;
 * - no subscription → the catalog's free plan, with the way to pricing;
 * - a subscription → its status (Stripe's when it was read, our records'
 *   otherwise — `reconcileOverviewStatus`), the plan it is for (or, distinctly,
 *   that the plan could not be read / is not in the catalog — never a guess),
 *   and a pointer to the billing page.
 *
 * The billing card shows the newest issued invoice (date, number, amount,
 * status, PDF) — the first row of the billing page's list, found the same way
 * — or, distinctly, that there is none yet, that it could not be read, or that
 * the user has no billing account at all.
 */
export function AccountOverview({
  summary,
  freePlan,
  currentPlan,
  latestInvoice,
}: Props) {
  if (!summary.ok) {
    return (
      <section aria-label="Account overview" data-overview-state="unavailable">
        <Card>
          <CardHeader>
            <CardTitle asChild>
              <h3>Account overview</h3>
            </CardTitle>
            <CardDescription>
              Your account overview is unavailable right now.
            </CardDescription>
          </CardHeader>

          <CardContent>
            <p role="alert" className="text-sm text-red-600 dark:text-red-400">
              We couldn&apos;t load your plan and billing details. Please try again in a
              moment; if this keeps happening, contact support.
            </p>
          </CardContent>

          <CardFooter>
            <Button asChild variant="outline">
              <Link href={ROUTES.dashboard}>Try again</Link>
            </Button>
          </CardFooter>
        </Card>
      </section>
    );
  }

  const shown =
    summary.status === null
      ? null
      : reconcileOverviewStatus({ ...summary, status: summary.status }, currentPlan);

  return (
    <section
      aria-label="Account overview"
      data-overview-state={shown === null ? "none" : "subscription"}
      {...(shown !== null && {
        "data-subscription-status": shown.status,
        "data-status-source": shown.source,
      })}
      className="grid gap-6 md:grid-cols-2 md:items-start"
    >
      {shown === null ? (
        <FreePlanCard plan={freePlan} canSubscribe={summary.canSubscribe} />
      ) : (
        <SubscriptionCard
          shown={shown}
          canSubscribe={summary.canSubscribe}
          currentPlan={currentPlan}
        />
      )}

      <BillingAccountCard
        customerState={summary.customerState}
        latestInvoice={latestInvoice}
      />
    </section>
  );
}

function FreePlanCard({
  plan,
  canSubscribe,
}: {
  plan: Plan | null;
  canSubscribe: boolean;
}) {
  return (
    <Card data-overview-card="plan">
      <CardHeader>
        <CardTitle asChild>
          <h3>Current plan</h3>
        </CardTitle>
        <CardDescription>
          {plan
            ? `You're on the free ${plan.name} plan.`
            : "You don't have a subscription."}
        </CardDescription>
      </CardHeader>

      <CardContent className="space-y-4">
        {plan && (
          <>
            <p className="flex items-baseline gap-2">
              <span className="text-2xl font-semibold">{plan.name}</span>
              <span className="text-sm text-muted-foreground">Free</span>
            </p>

            {plan.features && plan.features.length > 0 && (
              <ul
                aria-label="Included in your plan"
                className="space-y-1 text-sm text-muted-foreground"
              >
                {plan.features.map((feature) => (
                  <li key={feature}>• {feature}</li>
                ))}
              </ul>
            )}
          </>
        )}

        <p className="text-sm text-muted-foreground">
          {canSubscribe
            ? "Choose a paid plan to unlock more. If you just completed a checkout, your subscription may not appear here yet."
            : "If you just completed a checkout, your subscription may not appear here yet."}
        </p>
      </CardContent>

      {canSubscribe && (
        <CardFooter>
          <Button asChild>
            <Link href={PRICING_PATH}>Choose a plan</Link>
          </Button>
        </CardFooter>
      )}
    </Card>
  );
}

type SubscriptionStatus = Exclude<Extract<BillingSummary, { ok: true }>["status"], null>;

type Shown = ReturnType<typeof reconcileOverviewStatus>;

function SubscriptionCard({
  shown,
  canSubscribe,
  currentPlan,
}: {
  shown: Shown;
  canSubscribe: boolean;
  currentPlan: CurrentPlan;
}) {
  const { status, source } = shown;

  return (
    <Card data-overview-card="plan" data-plan-state={currentPlan.kind}>
      <CardHeader>
        <CardTitle asChild>
          <h3>Current plan</h3>
        </CardTitle>
        <CardDescription>
          {currentPlan.kind === "ok"
            ? isTerminalStatus(status)
              ? `You were on the ${currentPlan.plan.name} plan.`
              : `You're on the ${currentPlan.plan.name} plan.`
            : source === "records"
              ? "Status of your subscription, from our records."
              : "Status of your subscription."}
        </CardDescription>
      </CardHeader>

      <CardContent className="space-y-4">
        <PlanDetails currentPlan={currentPlan} status={status} />

        <SubscriptionStatusBlock
          shown={shown}
          facts={subscriptionFactsOf(currentPlan)}
          canSubscribe={canSubscribe}
        />
      </CardContent>

      <CardFooter className="flex-wrap gap-4">
        <Button asChild>
          <Link href={ROUTES.billing}>{GO_TO_BILLING_LABEL}</Link>
        </Button>

        {canSubscribe && (
          <Button asChild variant="outline">
            <Link href={PRICING_PATH}>Choose a plan</Link>
          </Button>
        )}
      </CardFooter>
    </Card>
  );
}

/**
 * The plan block of a subscription card. The recurring price is shown only
 * while Stripe still services the subscription and collects payment: for an
 * ended or paused one, "$29/month" would describe a charge that is not
 * happening. A discounted price is labelled as the price before discounts,
 * never presented as what is charged.
 */
function PlanDetails({
  currentPlan,
  status,
}: {
  currentPlan: CurrentPlan;
  status: SubscriptionStatus;
}) {
  switch (currentPlan.kind) {
    case "ok": {
      const { plan, subscription } = currentPlan;
      const billing =
        isServicingStatus(status) && subscription.collectionPaused === null
          ? plan.billing
          : null;

      return (
        <>
          <p className="flex flex-wrap items-baseline gap-x-2">
            <span className="text-2xl font-semibold">{plan.name}</span>
            {billing && (
              <span className="text-sm text-muted-foreground">
                {formatPlanBilling(billing)}
                {billing.discounted && (
                  <span data-plan-billing="discounted"> before discounts</span>
                )}
              </span>
            )}
          </p>

          {plan.features.length > 0 && (
            <ul
              aria-label="Included in your plan"
              className="space-y-1 text-sm text-muted-foreground"
            >
              {plan.features.map((feature) => (
                <li key={feature}>• {feature}</li>
              ))}
            </ul>
          )}
        </>
      );
    }

    case "unrecognized":
      return (
        <p className="text-sm text-muted-foreground">
          Your subscription is on a plan that isn&apos;t in the current catalog. The
          billing portal has the details.
        </p>
      );

    case "unavailable":
      return (
        <p role="alert" className="text-sm text-red-600 dark:text-red-400">
          We couldn&apos;t load your plan details from Stripe right now. The status below
          is from our records; please try again in a moment.
        </p>
      );

    case "none":
      // Inconsistent with a subscription status; claim nothing about the plan.
      return null;
  }
}

const BILLING_ACCOUNT_COPY = {
  none: {
    description: "No billing account yet.",
    body: "Invoices and payment details appear here once you subscribe to a paid plan.",
  },
  single: {
    description: "Your latest invoice. The full history is on the billing page.",
    body: null,
  },
  ambiguous: {
    description: "Your billing records need attention.",
    body: "Your records point at more than one billing account, or at one we can't identify. The billing page explains what to do.",
  },
} as const satisfies Record<
  Extract<BillingSummary, { ok: true }>["customerState"],
  { description: string; body: string | null }
>;

function BillingAccountCard({
  customerState,
  latestInvoice,
}: {
  customerState: Extract<BillingSummary, { ok: true }>["customerState"];
  latestInvoice: LatestInvoice;
}) {
  const { description, body } = BILLING_ACCOUNT_COPY[customerState];

  return (
    <Card
      data-overview-card="billing"
      data-billing-customer={customerState}
      {...(customerState === "single" && { "data-latest-invoice": latestInvoice.kind })}
    >
      <CardHeader>
        <CardTitle asChild>
          <h3>Billing</h3>
        </CardTitle>
        <CardDescription>{description}</CardDescription>
      </CardHeader>

      <CardContent>
        {customerState === "ambiguous" ? (
          <p role="alert" className="text-sm text-red-600 dark:text-red-400">
            {body}
          </p>
        ) : customerState === "none" ? (
          <p className="text-sm text-muted-foreground">{body}</p>
        ) : (
          <LatestInvoiceSummary latestInvoice={latestInvoice} />
        )}
      </CardContent>

      <CardFooter className="flex-wrap gap-4">
        <Button asChild variant="outline">
          <Link href={ROUTES.billing}>{GO_TO_BILLING_LABEL}</Link>
        </Button>
      </CardFooter>
    </Card>
  );
}

/**
 * One invoice, briefly: date, number, amount, status, and its PDF when Stripe
 * provides one (opened through the same per-user route as on the billing
 * page, which fetches the current URL at click time). Each of the other
 * shapes has its own sentence; none of them claims "no invoices" unless
 * Stripe had nothing further to scan.
 */
function LatestInvoiceSummary({ latestInvoice }: { latestInvoice: LatestInvoice }) {
  switch (latestInvoice.kind) {
    case "ok":
      return <InvoiceLine invoice={latestInvoice.invoice} />;

    case "empty":
      return (
        <p className="text-sm text-muted-foreground">
          No invoices have been issued yet. They will appear here as soon as Stripe issues
          them.
        </p>
      );

    case "undetermined":
      return (
        <p className="text-sm text-muted-foreground">
          We couldn&apos;t find your latest invoice quickly. Your full history is on the
          billing page.
        </p>
      );

    case "unavailable":
      return (
        <p role="alert" className="text-sm text-red-600 dark:text-red-400">
          We couldn&apos;t load your latest invoice. Please try again in a moment; if this
          keeps happening, contact support.
        </p>
      );

    case "none":
    case "ambiguous":
      // Inconsistent with a single billing account; claim nothing about invoices.
      return null;
  }
}

function InvoiceLine({ invoice }: { invoice: InvoiceSummary }) {
  const { label, tone } = INVOICE_STATUS_CONTENT[invoice.status];
  const about = invoice.number ? `invoice ${invoice.number}` : "invoice";

  return (
    <div
      className="space-y-3"
      {...(invoice.number !== null && { "data-invoice-number": invoice.number })}
    >
      <div className="flex flex-wrap items-baseline justify-between gap-x-4 gap-y-1">
        <div className="space-y-0.5">
          <p className="text-sm text-muted-foreground">
            <time dateTime={invoice.createdAt}>
              {formatInvoiceDate(invoice.createdAt)}
            </time>
            {invoice.number && <span className="tabular-nums"> · {invoice.number}</span>}
          </p>
          <p className="text-2xl font-semibold tabular-nums">
            {formatInvoiceAmount(invoice.total, invoice.currency)}
          </p>
        </div>

        <Badge className={cn("text-xs", STATUS_TONE_CLASS[tone])}>{label}</Badge>
      </div>

      {invoice.documents.pdf ? (
        <Button asChild size="sm">
          <a
            href={invoiceDocumentPath(invoice.key, "pdf")}
            target="_blank"
            rel="noopener noreferrer"
            aria-label={`${DOWNLOAD_PDF_LABEL} of ${about} (opens in a new tab)`}
          >
            {DOWNLOAD_PDF_LABEL}
          </a>
        </Button>
      ) : (
        <p className="text-sm text-muted-foreground" data-invoice-documents="none">
          The PDF isn&apos;t available for this invoice.
        </p>
      )}
    </div>
  );
}
