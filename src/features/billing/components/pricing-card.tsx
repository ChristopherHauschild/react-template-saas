"use client";

import { createCheckoutSession } from "../actions/create-checkout-session";
import { Plan } from "../types/plan";

type Props = { plan: Plan };

export function PricingCard({ plan }: Props) {
  return (
    <div className="border p-6 rounded-lg">
      <h2 className="text-xl font-bold">{plan.name}</h2>

      <p className="text-3xl mt-2">${plan.price}</p>

      <form action={createCheckoutSession.bind(null, plan.priceId)}>
        <button className="mt-4 bg-black text-white px-4 py-2 rounded">Subscribe</button>
      </form>
    </div>
  );
}
