import { getPlans, PricingCard, PricingHeader } from "@/features/billing";

export default async function PricingPage() {
  const plans = await getPlans();

  return (
    <main className="min-h-screen bg-background">
      <div className="relative flex min-h-screen items-center justify-center px-6 py-20">
        <div
          className="
            absolute inset-0
            bg-[radial-gradient(circle_at_top,_hsl(var(--primary)/0.15)_0%,_transparent_70%)]
          "
        />

        <div className="relative mx-auto w-full max-w-6xl">
          <PricingHeader />

          <div className="mt-16 grid gap-6 sm:grid-cols-2 lg:grid-cols-3">
            {plans.map((plan) => (
              <PricingCard key={plan.priceId} plan={plan} />
            ))}
          </div>
        </div>
      </div>
    </main>
  );
}
