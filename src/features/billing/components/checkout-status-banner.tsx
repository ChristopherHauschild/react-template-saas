import type { ReactNode } from "react";

/** Values of the `?checkout=` query parameter Stripe sends the user back with. */
export type CheckoutStatus = "success" | "canceled";

export function parseCheckoutStatus(
  value: string | string[] | undefined,
): CheckoutStatus | null {
  return value === "success" || value === "canceled" ? value : null;
}

const CONTENT: Record<CheckoutStatus, { title: string; body: ReactNode; tone: string }> =
  {
    success: {
      title: "Thanks, you're back from checkout",
      body: "We're waiting for Stripe to confirm your payment. Once it does, your subscription will be activated automatically. If it doesn't appear after a while, contact support.",
      tone: "border-border bg-muted text-foreground",
    },
    canceled: {
      title: "Checkout canceled",
      body: "No charges were made. You can pick a plan whenever you're ready.",
      tone: "border-border bg-muted text-foreground",
    },
  };

/**
 * Shown after returning from Stripe Checkout. The status comes from an UNTRUSTED
 * query parameter (anyone can type `?checkout=success`), so the copy must never
 * confirm a payment or an active subscription. Confirmation comes only from the
 * Stripe webhook, which writes the authoritative state afterwards — usually
 * promptly, but it may be delayed or failing, so no timing is promised.
 */
export function CheckoutStatusBanner({ status }: { status: CheckoutStatus | null }) {
  if (!status) return null;

  const { title, body, tone } = CONTENT[status];

  return (
    <div
      role="status"
      aria-live="polite"
      className={`rounded-xl border px-4 py-3 text-sm ${tone}`}
    >
      <p className="font-medium">{title}</p>
      <p className="mt-1 opacity-90">{body}</p>
    </div>
  );
}
