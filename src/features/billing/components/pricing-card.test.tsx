import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";

import type { Plan } from "../types/plan";

import { PricingCard } from "./pricing-card";

// The card binds and submits the server action; replace it with a controllable
// fake. `.bind` is the real Function.prototype.bind, so the bound plan id is
// observable as the first argument of every call.
const action = vi.hoisted(() => ({
  createCheckoutSession:
    vi.fn<(planId: string, prev: unknown, formData: FormData) => Promise<unknown>>(),
}));
vi.mock("../actions/create-checkout-session", () => ({
  createCheckoutSession: action.createCheckoutSession,
}));

const pro: Plan = {
  id: "pro",
  name: "Pro",
  price: 29,
  popular: true,
  available: true,
  features: ["Everything in Starter", "Unlimited projects"],
};

beforeEach(() => {
  action.createCheckoutSession.mockReset();
  action.createCheckoutSession.mockResolvedValue(null);
});

describe("PricingCard – available plan", () => {
  it("renders the plan exactly as before (name, price, features, badge, button)", () => {
    render(<PricingCard plan={pro} />);

    expect(screen.getByRole("heading", { level: 2 })).toHaveTextContent("Pro");
    expect(screen.getByText(/\$29/)).toBeInTheDocument();
    expect(screen.getByText("/month")).toBeInTheDocument();
    expect(screen.getByText("Most popular")).toBeInTheDocument();
    expect(screen.getByText("• Everything in Starter")).toBeInTheDocument();
    expect(screen.getByText("• Unlimited projects")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Subscribe" })).toBeEnabled();
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
  });

  it("submits the checkout action with the plan id, never a Stripe price", async () => {
    const user = userEvent.setup();
    render(<PricingCard plan={pro} />);

    await user.click(screen.getByRole("button", { name: "Subscribe" }));

    await waitFor(() => expect(action.createCheckoutSession).toHaveBeenCalledTimes(1));
    const [planId, , formData] = action.createCheckoutSession.mock.calls[0];
    expect(planId).toBe("pro");
    expect(formData).toBeInstanceOf(FormData);
    expect(JSON.stringify(action.createCheckoutSession.mock.calls)).not.toMatch(/price_/);
  });

  it("shows a loading state while the action is pending and blocks a second click", async () => {
    let finish!: (value: null) => void;
    action.createCheckoutSession.mockReturnValue(
      new Promise((resolve) => (finish = resolve)),
    );
    const user = userEvent.setup();
    render(<PricingCard plan={pro} />);

    await user.click(screen.getByRole("button", { name: "Subscribe" }));

    const busy = await screen.findByRole("button", { name: "Redirecting to checkout…" });
    expect(busy).toBeDisabled();
    expect(busy).toHaveAttribute("aria-busy", "true");

    await user.click(busy); // disabled: must not submit again
    expect(action.createCheckoutSession).toHaveBeenCalledTimes(1);

    finish(null);
    await screen.findByRole("button", { name: "Subscribe" });
  });

  it("shows an inline, announced error when the action returns one, and lets the user retry", async () => {
    action.createCheckoutSession
      .mockResolvedValueOnce({
        error: "You already have an active subscription. Manage it from your dashboard.",
      })
      .mockResolvedValueOnce(null);
    const user = userEvent.setup();
    render(<PricingCard plan={pro} />);

    await user.click(screen.getByRole("button", { name: "Subscribe" }));

    expect(await screen.findByRole("alert")).toHaveTextContent(
      /already have an active subscription/,
    );
    expect(screen.getByRole("button", { name: "Subscribe" })).toBeEnabled();

    await user.click(screen.getByRole("button", { name: "Subscribe" }));
    await waitFor(() => expect(screen.queryByRole("alert")).not.toBeInTheDocument());
    expect(action.createCheckoutSession).toHaveBeenCalledTimes(2);
  });
});

describe("PricingCard – unavailable plan", () => {
  const unavailable: Plan = { ...pro, available: false };

  it("renders a disabled explanation instead of a checkout form (no server round-trip possible)", async () => {
    const user = userEvent.setup();
    const { container } = render(<PricingCard plan={unavailable} />);

    const button = screen.getByRole("button", { name: "Currently unavailable" });
    expect(button).toBeDisabled();
    expect(button).toHaveAttribute("aria-disabled", "true");
    expect(button).toHaveAttribute("title");
    expect(container.querySelector("form")).toBeNull();
    expect(screen.queryByRole("button", { name: "Subscribe" })).not.toBeInTheDocument();

    await user.click(button);
    expect(action.createCheckoutSession).not.toHaveBeenCalled();
  });

  it("still shows the plan details", () => {
    render(<PricingCard plan={unavailable} />);

    expect(screen.getByRole("heading", { level: 2 })).toHaveTextContent("Pro");
    expect(screen.getByText(/\$29/)).toBeInTheDocument();
    expect(screen.getByText("Most popular")).toBeInTheDocument();
  });
});

describe("PricingCard – free plan", () => {
  it("offers Subscribe for the free plan (the server redirects without a Stripe session)", () => {
    render(
      <PricingCard
        plan={{ id: "starter", name: "Starter", price: 0, available: true }}
      />,
    );

    expect(screen.queryByText("Most popular")).not.toBeInTheDocument();
    expect(screen.getByText(/\$0/)).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Subscribe" })).toBeEnabled();
  });
});
