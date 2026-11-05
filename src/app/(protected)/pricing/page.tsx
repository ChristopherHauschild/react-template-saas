import {
  CheckoutStatusBanner,
  getPlans,
  parseCheckoutStatus,
  PricingCard,
  PricingHeader,
} from "@/features/billing";

type Props = { searchParams: Promise<{ checkout?: string | string[] }> };

export default async function PricingPage({ searchParams }: Props) {
  const [plans, { checkout }] = await Promise.all([getPlans(), searchParams]);
  const checkoutStatus = parseCheckoutStatus(checkout);

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

          {checkoutStatus && (
            <div className="mx-auto mt-8 max-w-2xl">
              <CheckoutStatusBanner status={checkoutStatus} />
            </div>
          )}

          <div className="mt-16 grid gap-6 sm:grid-cols-2 lg:grid-cols-3">
            {plans.map((plan) => (
              <PricingCard key={plan.id} plan={plan} />
            ))}
          </div>
        </div>
      </div>
    </main>
  );
}
