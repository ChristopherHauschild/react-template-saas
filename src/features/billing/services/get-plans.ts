import { Plan } from "../types/plan";

export async function getPlans(): Promise<Plan[]> {
  return [
    {
      name: "Starter",
      price: 0,
      priceId: "price_starter",
      features: ["Basic features", "Up to 3 projects", "Community support"],
    },
    {
      name: "Pro",
      price: 29,
      priceId: "price_pro",
      popular: true,
      features: [
        "Everything in Starter",
        "Unlimited projects",
        "Priority support",
        "Advanced analytics",
      ],
    },
    {
      name: "Enterprise",
      price: 99,
      priceId: "price_enterprise",
      features: [
        "Everything in Pro",
        "Dedicated support",
        "Custom integrations",
        "SLA guarantee",
      ],
    },
  ];
}
