"use client";

import { useActionState } from "react";

import {
  type CheckoutActionResult,
  createCheckoutSession,
} from "../actions/create-checkout-session";
import { Plan } from "../types/plan";

import { SubscribeButton } from "./subscribe-button";

type Props = { plan: Plan };

export function PricingCard({ plan }: Props) {
  const isPopular = plan.popular;

  // Expected problems (unknown/unavailable plan, existing subscription, …) come
  // back as `state.error` and are shown inline; success redirects to Stripe.
  const [state, formAction, pending] = useActionState<CheckoutActionResult, FormData>(
    createCheckoutSession.bind(null, plan.id),
    null,
  );

  return (
    <div
      className={`
        relative flex flex-col justify-between rounded-2xl border p-6 transition-all
        bg-card/80 backdrop-blur-sm
        ${
          isPopular
            ? `
            border-yellow-400/40
            shadow-[0_0_40px_-10px_rgba(250,204,21,0.35)]
            scale-[1.03]
          `
            : "border-border"
        }
      `}
    >
      {isPopular && (
        <div className="absolute -top-3 left-1/2 -translate-x-1/2">
          <span
            className="
            rounded-full px-3 py-1 text-xs font-medium
            bg-yellow-400/10 text-yellow-600
            border border-yellow-400/30
            backdrop-blur-sm
          "
          >
            Most popular
          </span>
        </div>
      )}

      <div>
        <h2 className="text-xl font-semibold text-foreground">{plan.name}</h2>

        <p className="mt-4 text-3xl font-bold text-foreground">
          ${plan.price}
          <span className="text-sm font-normal text-muted-foreground">/month</span>
        </p>

        <ul className="mt-6 space-y-2 text-sm text-muted-foreground">
          {plan.features?.map((feature) => (
            <li key={feature}>• {feature}</li>
          ))}
        </ul>
      </div>

      {plan.available ? (
        <form action={formAction} className="mt-6">
          <SubscribeButton popular={isPopular} pending={pending} />
          {state?.error && (
            <p role="alert" className="mt-3 text-sm text-red-600 dark:text-red-400">
              {state.error}
            </p>
          )}
        </form>
      ) : (
        <div className="mt-6">
          <button
            type="button"
            disabled
            aria-disabled="true"
            title="This plan cannot be purchased right now"
            className="w-full cursor-not-allowed rounded-lg border border-border bg-muted px-4 py-2 text-sm font-medium text-muted-foreground"
          >
            Currently unavailable
          </button>
        </div>
      )}
    </div>
  );
}
