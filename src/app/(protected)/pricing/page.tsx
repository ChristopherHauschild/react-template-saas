import { getPlans, PricingCard } from "@/features/billing";

export default async function PricingPage() {
  const plans = await getPlans();

  return (
    <main className="max-w-4xl mx-auto py-20 grid grid-cols-2 gap-6">
      {plans.map((plan) => (
        <PricingCard key={plan.id} plan={plan} />
      ))}
    </main>
  );
}
