import Link from "next/link";

import { ROUTES } from "@/config/routes";
import { Button } from "@/shared/components/ui/button";
import {
  Card,
  CardContent,
  CardDescription,
  CardFooter,
  CardHeader,
  CardTitle,
} from "@/shared/components/ui/card";

import type { BillingSummary } from "../services/billing-summary";
import type { CurrentPlan } from "../services/current-plan";
import { reconcileOverviewStatus } from "../services/overview-status";

import { ManageBillingButton } from "./manage-billing-button";
import {
  subscriptionFactsOf,
  SubscriptionStatusBlock,
} from "./subscription-status-block";

/** Where "Choose a plan" goes; the pricing page is where checkouts start. */
export const PRICING_PATH = "/pricing";

type Props = {
  summary: BillingSummary;
  /**
   * The subscription as Stripe holds it (see `getCurrentPlan`), read for the
   * same rows as `summary`. Its status, when read, is the one shown — the same
   * rule as the dashboard, so the two pages never disagree.
   */
  currentPlan: CurrentPlan;
};

/**
 * The billing page's main card: what we know about the user's subscription
 * (its status, from our own records) and what they can do about it.
 *
 * Three shapes, which must never be confused with each other:
 * - the records could not be read → "unavailable", no actions that depend on
 *   them (the portal action would refuse anyway);
 * - no subscription → the free plan, with a way to the pricing page;
 * - a subscription → its status (Stripe's when it was read, our records'
 *   otherwise — `reconcileOverviewStatus`), with the portal when the records
 *   point at exactly one Stripe customer; an explanation (never a guess) when
 *   they point at several or at none.
 */
export function SubscriptionStatusCard({ summary, currentPlan }: Props) {
  if (!summary.ok) {
    return (
      <Card data-billing-state="unavailable">
        <CardHeader>
          <CardTitle>Subscription</CardTitle>
          <CardDescription>Billing information is unavailable right now.</CardDescription>
        </CardHeader>

        <CardContent>
          <p role="alert" className="text-sm text-red-600 dark:text-red-400">
            We couldn&apos;t load your subscription details. Please try again in a moment;
            if this keeps happening, contact support.
          </p>
        </CardContent>

        <CardFooter>
          <Button asChild variant="outline">
            <Link href={ROUTES.billing}>Try again</Link>
          </Button>
        </CardFooter>
      </Card>
    );
  }

  if (summary.status === null) {
    return (
      <Card data-billing-state="none">
        <CardHeader>
          <CardTitle>Subscription</CardTitle>
          <CardDescription>You&apos;re on the free Starter plan.</CardDescription>
        </CardHeader>

        <CardContent className="space-y-2">
          <p className="text-sm text-muted-foreground">
            Choose a paid plan to unlock more. If you just completed a checkout, your
            subscription may not appear here yet.
          </p>
        </CardContent>

        <CardFooter className="flex-wrap gap-4">
          <Button asChild>
            <Link href={PRICING_PATH}>Choose a plan</Link>
          </Button>

          {summary.canManage && <ManageBillingButton />}
        </CardFooter>
      </Card>
    );
  }

  const shown = reconcileOverviewStatus(
    { ...summary, status: summary.status },
    currentPlan,
  );

  return (
    <Card
      data-billing-state="subscription"
      data-subscription-status={shown.status}
      data-status-source={shown.source}
    >
      <CardHeader>
        <CardTitle>Subscription</CardTitle>
        <CardDescription>
          {shown.source === "records"
            ? "Status of your current subscription, from our records."
            : "Status of your current subscription."}
        </CardDescription>
      </CardHeader>

      <CardContent>
        <SubscriptionStatusBlock
          shown={shown}
          facts={subscriptionFactsOf(currentPlan)}
          canSubscribe={summary.canSubscribe}
        />
      </CardContent>

      <CardFooter className="flex-wrap gap-4">
        {summary.customerState === "single" && <ManageBillingButton />}

        {summary.customerState === "none" && (
          <p className="text-sm text-muted-foreground">
            This subscription isn&apos;t linked to a billing account yet, so there is
            nothing to manage here. If that seems wrong, contact support.
          </p>
        )}

        {summary.customerState === "ambiguous" && (
          <p
            role="alert"
            data-billing-customer="ambiguous"
            className="text-sm text-red-600 dark:text-red-400"
          >
            Your records point at more than one billing account, or at one we can&apos;t
            identify, so the billing portal can&apos;t be opened safely. Please contact
            support.
          </p>
        )}

        {summary.canSubscribe && (
          <Button asChild variant="outline">
            <Link href={PRICING_PATH}>Choose a plan</Link>
          </Button>
        )}
      </CardFooter>
    </Card>
  );
}
