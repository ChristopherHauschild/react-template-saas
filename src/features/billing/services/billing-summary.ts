import {
  isSubscriptionStatus,
  type SubscriptionOverview,
  type SubscriptionStatus,
} from "./get-subscription-overview";

/**
 * What the billing page shows about the user's subscription — and nothing more.
 * Derived from `SubscriptionOverview` on the server; it crosses into components,
 * so it carries no Stripe identifiers (customer or subscription ids).
 */
/** Statuses the page can display: Stripe's, plus two for records we cannot trust. */
export type DisplayStatus = SubscriptionStatus | "unknown" | "conflicting";

export type BillingSummary =
  /** The rows could not be read. The page must say so, never "no subscription". */
  | { ok: false }
  | {
      ok: true;
      /**
       * Status of the current subscription. `null` when the user has none (the
       * free plan); `"unknown"` when the stored value is not a Stripe status;
       * `"conflicting"` when our own records for it disagree.
       */
      status: DisplayStatus | null;
      /**
       * Whether the records point at one Stripe customer (`single`), none, or
       * several / an unidentifiable one (`ambiguous`). The portal opens only for
       * `single`; `ambiguous` is explained, never guessed around.
       */
      customerState: "single" | "none" | "ambiguous";
      /** Shorthand for `customerState === "single"`. */
      canManage: boolean;
      /**
       * Starting a checkout is allowed: no subscription at all is still being
       * serviced by Stripe. Mirrors the checkout action's own guard (which looks
       * at every row), so the page never offers a plan the action would refuse.
       */
      canSubscribe: boolean;
    };

export function toBillingSummary(overview: SubscriptionOverview): BillingSummary {
  if (!overview.ok) {
    return { ok: false };
  }

  const { current, customerResolution } = overview;

  return {
    ok: true,
    status:
      current === null
        ? null
        : current.statusConflict
          ? "conflicting"
          : isSubscriptionStatus(current.status)
            ? current.status
            : "unknown",
    customerState: customerResolution.kind,
    canManage: customerResolution.kind === "single",
    canSubscribe: !overview.isServicing,
  };
}

export type SubscriptionStatusContent = {
  /** Short label for the status pill. */
  label: string;
  /** One or two sentences telling the user what it means and what to do. */
  description: string;
  /** `attention` = the user should act (a payment problem); `neutral` otherwise. */
  tone: "neutral" | "attention";
};

/**
 * Copy per Stripe subscription status. Only the status is stored, so each
 * description states what that status means and nothing more: whether an
 * active subscription renews or is set to cancel at period end, what a trial
 * turns into, when an incomplete one expires, or what dunning will do next is
 * known to Stripe alone — the billing portal shows it. A unit test guards
 * against such claims creeping back in.
 */
export const SUBSCRIPTION_STATUS_CONTENT: Record<
  DisplayStatus,
  SubscriptionStatusContent
> = {
  active: {
    label: "Active",
    description:
      "Your subscription is active. Billing details and upcoming charges are shown in the billing portal.",
    tone: "neutral",
  },
  trialing: {
    label: "Trial",
    description:
      "You're on a trial. What happens when it ends is shown in the billing portal.",
    tone: "neutral",
  },
  past_due: {
    label: "Payment past due",
    description:
      "A payment is overdue. Update your payment method in the billing portal.",
    tone: "attention",
  },
  unpaid: {
    label: "Unpaid",
    description:
      "Payments have failed and the subscription is unpaid. Update your payment method in the billing portal.",
    tone: "attention",
  },
  paused: {
    label: "Paused",
    description:
      "Your subscription is paused and isn't being billed. The billing portal has the details.",
    tone: "neutral",
  },
  incomplete: {
    label: "Awaiting payment",
    description:
      "The first payment hasn't completed, so the subscription isn't active yet. The billing portal has the details.",
    tone: "attention",
  },
  incomplete_expired: {
    label: "Expired",
    description:
      "The first payment was never completed, so this subscription expired. You can choose a plan again.",
    tone: "neutral",
  },
  canceled: {
    label: "Canceled",
    description: "Your subscription has ended. You can choose a plan again.",
    tone: "neutral",
  },
  unknown: {
    label: "Unknown",
    description:
      "We couldn't interpret the status Stripe reported. The billing portal has the details.",
    tone: "attention",
  },
  conflicting: {
    label: "Needs review",
    description:
      "Our records for this subscription disagree with each other. The billing portal has the current details; if something looks wrong, contact support.",
    tone: "attention",
  },
};
