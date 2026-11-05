import { Badge } from "@/shared/components/ui/badge";
import { cn } from "@/shared/utils/cn";

import { SUBSCRIPTION_STATUS_CONTENT } from "../services/billing-summary";
import {
  type CurrentPlan,
  formatSubscriptionDate,
  type PlanCancellation,
  type SubscriptionFacts,
} from "../services/current-plan";
import { isServicingStatus } from "../services/get-subscription-overview";
import type { OverviewStatus } from "../services/overview-status";

/** Badge classes per tone: neutral, or attention (a payment problem, money owed). */
export const STATUS_TONE_CLASS = {
  neutral: "border-border bg-muted text-foreground",
  attention: "border-red-400/40 bg-red-500/10 text-red-600 dark:text-red-400",
} as const;

type Props = {
  /** The status to show and where it came from (see `reconcileOverviewStatus`). */
  shown: OverviewStatus;
  /** What Stripe said about the subscription, when it was read; `null` otherwise. */
  facts: SubscriptionFacts | null;
  /** Whether the checkout guard (which reads the records) would allow a new plan. */
  canSubscribe: boolean;
};

/**
 * The status of a subscription, as both the dashboard and the billing page
 * show it — one component, so the two pages cannot disagree: Stripe's status
 * when it was read, our records' otherwise; what Stripe says about the
 * subscription ending or pausing; and, when Stripe and the records differ, a
 * note saying so. That note promises nothing about when (or whether) the
 * records will follow: they depend on the webhook, which may be delayed or
 * failing, so the user is told what is known and whom to ask if it persists.
 */
export function SubscriptionStatusBlock({ shown, facts, canSubscribe }: Props) {
  const { status, recordsLag } = shown;
  const { label, description, tone } = SUBSCRIPTION_STATUS_CONTENT[status];

  return (
    <div className="space-y-4">
      {facts && <SubscriptionNotes facts={facts} status={status} />}

      <div className="space-y-3">
        <div className="flex items-center gap-3">
          <span className="text-sm text-muted-foreground">Status</span>
          <Badge className={cn("text-xs", STATUS_TONE_CLASS[tone])}>{label}</Badge>
        </div>

        <p
          className={cn(
            "text-sm",
            tone === "attention"
              ? "text-red-600 dark:text-red-400"
              : "text-muted-foreground",
          )}
        >
          {description}
        </p>

        {recordsLag && (
          <p role="status" data-records-lag className="text-sm text-muted-foreground">
            This is Stripe&apos;s current status; our records don&apos;t reflect it yet.
            {!isServicingStatus(status) && !canSubscribe
              ? " Choosing a new plan isn't available until they do."
              : ""}{" "}
            If this persists, contact support.
          </p>
        )}
      </div>
    </div>
  );
}

/**
 * What Stripe says about the subscription ending or pausing, shown with the
 * status it belongs to (which, when these facts were read, is Stripe's own —
 * so they never contradict it): "set to cancel" and "paused" for a serviced
 * subscription, "ended" for a canceled one.
 */
function SubscriptionNotes({
  facts,
  status,
}: {
  facts: SubscriptionFacts;
  status: OverviewStatus["status"];
}) {
  const cancellation = shownCancellation(facts.cancellation, status);
  const paused = isServicingStatus(status) ? facts.collectionPaused : null;

  if (cancellation === null && paused === null) return null;

  return (
    <div className="space-y-1">
      {cancellation && (
        <p
          data-plan-cancellation={cancellation.kind}
          className={cn(
            "text-sm",
            cancellation.kind === "scheduled"
              ? "font-medium text-foreground"
              : "text-muted-foreground",
          )}
        >
          {cancellationCopy(cancellation)}
        </p>
      )}

      {paused && (
        <p data-plan-collection="paused" className="text-sm font-medium text-foreground">
          {paused.resumesAt === null
            ? "Payments are paused until you resume them."
            : `Payments are paused until ${formatSubscriptionDate(paused.resumesAt)}.`}
        </p>
      )}
    </div>
  );
}

function shownCancellation(
  cancellation: PlanCancellation | null,
  status: OverviewStatus["status"],
): PlanCancellation | null {
  if (cancellation === null) return null;
  if (cancellation.kind === "scheduled") {
    return isServicingStatus(status) ? cancellation : null;
  }
  return status === "canceled" ? cancellation : null;
}

function cancellationCopy(cancellation: PlanCancellation): string {
  const date = cancellation.at === null ? null : formatSubscriptionDate(cancellation.at);

  if (cancellation.kind === "scheduled") {
    return date === null
      ? "Set to cancel at the end of the current billing period."
      : `Set to cancel on ${date}.`;
  }

  return date === null ? "Ended." : `Ended on ${date}.`;
}

/** The facts Stripe gave, if the plan read got that far. */
export function subscriptionFactsOf(currentPlan: CurrentPlan): SubscriptionFacts | null {
  return currentPlan.kind === "ok" || currentPlan.kind === "unrecognized"
    ? currentPlan.subscription
    : null;
}
