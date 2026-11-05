"use client";

type Props = { popular?: boolean; pending: boolean };

const BASE = "w-full rounded-lg px-4 py-2 text-sm font-medium transition";
const PENDING = "disabled:cursor-wait disabled:opacity-70";
const POPULAR = "bg-yellow-400 text-black hover:bg-yellow-300";
const DEFAULT = "bg-primary text-primary-foreground hover:opacity-90";

/**
 * Submit button for the checkout form. Reflects the action's pending state so a
 * click gives immediate feedback and cannot be submitted twice while the redirect
 * to Stripe is in flight.
 */
export function SubscribeButton({ popular, pending }: Props) {
  return (
    <button
      type="submit"
      disabled={pending}
      aria-busy={pending}
      className={`${BASE} ${PENDING} ${popular ? POPULAR : DEFAULT}`}
    >
      {pending ? "Redirecting to checkout…" : "Subscribe"}
    </button>
  );
}
