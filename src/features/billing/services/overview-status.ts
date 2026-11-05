import type { BillingSummary, DisplayStatus } from "./billing-summary";
import type { CurrentPlan } from "./current-plan";

/**
 * Which status the dashboard and the billing page show for a subscription,
 * and where it came from.
 *
 * Two sources can describe the same subscription: our records (written by the
 * webhook; what the checkout guard and the billing page go by) and Stripe's
 * own object (read for the plan). After a change in the Customer Portal —
 * cancel now, cancel at period end, pause — Stripe is right immediately and
 * our records only once the webhook has applied it — usually promptly, but
 * possibly late or not at all. Showing the records' status in between would
 * contradict what the user just did; so Stripe's status is shown whenever it
 * was read, and the lag is said out loud rather than hidden (without
 * promising when, or whether, the records will follow).
 *
 * What may be DONE is still decided by the records: `canSubscribe` is the
 * checkout action's guard, which reads the records — offering a plan on the
 * strength of Stripe's status would be refused by the action.
 */
export type OverviewStatus = {
  status: DisplayStatus;
  source: "stripe" | "records";
  /**
   * Stripe's status was read and differs from our records': the webhook has
   * not applied the change yet (or our records are wrong). The card explains.
   */
  recordsLag: boolean;
};

export function reconcileOverviewStatus(
  summary: Extract<BillingSummary, { ok: true }> & { status: DisplayStatus },
  currentPlan: CurrentPlan,
): OverviewStatus {
  const live =
    currentPlan.kind === "ok" || currentPlan.kind === "unrecognized"
      ? currentPlan.subscription.status
      : null;

  if (live === null || live === "unknown") {
    return { status: summary.status, source: "records", recordsLag: false };
  }

  return { status: live, source: "stripe", recordsLag: live !== summary.status };
}
