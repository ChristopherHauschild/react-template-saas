// @vitest-environment node
import { renderToStaticMarkup } from "react-dom/server";

import { describe, expect, it, vi } from "vitest";

// Server-side env: only Pro is purchasable in this scenario.
vi.mock("@/config/env.server", () => ({
  serverEnv: {
    NODE_ENV: "test",
    SUPABASE_SERVICE_ROLE_KEY: "x",
    STRIPE_PRICE_PRO: "price_1ProAbc123",
    STRIPE_PRICE_ENTERPRISE: undefined,
  },
}));
// The card imports the server action; it is never invoked during a render.
vi.mock("@/features/billing/actions/create-checkout-session", () => ({
  createCheckoutSession: vi.fn(),
}));

import PricingPage from "./page";

const render = async (checkout?: string) =>
  renderToStaticMarkup(
    await PricingPage({ searchParams: Promise.resolve({ checkout }) }),
  );

describe("/pricing page", () => {
  it("offers checkout only for purchasable plans; unavailable ones cannot be submitted", async () => {
    const html = await render();

    expect(html.match(/<form/g)).toHaveLength(2); // Starter (free) + Pro
    expect(html.match(/>Subscribe</g)).toHaveLength(2);
    expect(html.match(/Currently unavailable/g)).toHaveLength(1); // Enterprise
    expect(html).not.toMatch(/price_/); // no Stripe ids in the page
  });

  it("renders all three plans with their prices regardless of availability", async () => {
    const html = await render();

    for (const name of ["Starter", "Pro", "Enterprise"])
      expect(html).toContain(`>${name}<`);
    for (const price of ["$0", "$29", "$99"]) expect(html).toContain(price);
  });

  it("shows the canceled-checkout notice when Stripe sends the user back", async () => {
    expect(await render("canceled")).toMatch(
      /Checkout canceled[\s\S]*No charges were made/,
    );
    expect(await render()).not.toMatch(/Checkout canceled/);
    expect(await render("anything-else")).not.toMatch(/role="status"/);
  });

  it("keeps the responsive grid: 1 column by default, 2 from sm, 3 from lg", async () => {
    expect(await render()).toMatch(/grid gap-6 sm:grid-cols-2 lg:grid-cols-3/);
  });
});
