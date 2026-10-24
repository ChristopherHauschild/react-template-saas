"use client";

import { createCheckoutSession } from "../actions/create-checkout-session";
import { Plan } from "../types/plan";

type Props = { plan: Plan };

export function PricingCard({ plan }: Props) {
  const isPopular = plan.popular;

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

      <form action={createCheckoutSession.bind(null, plan.priceId)} className="mt-6">
        <button
          className={`
            w-full rounded-lg px-4 py-2 text-sm font-medium transition
            ${
              isPopular
                ? `
                bg-yellow-400 text-black
                hover:bg-yellow-300
              `
                : `
                bg-primary text-primary-foreground
                hover:opacity-90
              `
            }
          `}
        >
          Subscribe
        </button>
      </form>
    </div>
  );
}
