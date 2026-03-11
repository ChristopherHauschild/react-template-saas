import { Plan } from "../types/plan";

export async function getPlans(): Promise<Plan[]> {
  return [
    {
      id: "starter",
      name: "Starter",
      price: 9,
      priceId: "price_starter",
    },
    {
      id: "pro",
      name: "Pro",
      price: 29,
      priceId: "price_pro",
    },
  ];
}
