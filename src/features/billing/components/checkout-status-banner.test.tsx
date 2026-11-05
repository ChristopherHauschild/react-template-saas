import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";

import { CheckoutStatusBanner, parseCheckoutStatus } from "./checkout-status-banner";

describe("parseCheckoutStatus", () => {
  it("accepts exactly the two values the checkout redirects with", () => {
    expect(parseCheckoutStatus("success")).toBe("success");
    expect(parseCheckoutStatus("canceled")).toBe("canceled");
  });

  it.each([undefined, "", "active", "SUCCESS", ["success"], "success;drop"])(
    "ignores anything else (%j)",
    (value) => {
      expect(parseCheckoutStatus(value as string | string[] | undefined)).toBeNull();
    },
  );
});

describe("CheckoutStatusBanner", () => {
  it("renders nothing without a status", () => {
    const { container } = render(<CheckoutStatusBanner status={null} />);
    expect(container).toBeEmptyDOMElement();
  });

  it("after returning from checkout, never confirms payment or activation (the status is an untrusted URL parameter)", () => {
    render(<CheckoutStatusBanner status="success" />);

    const banner = screen.getByRole("status");
    expect(banner).toHaveAttribute("aria-live", "polite");
    expect(banner).toHaveTextContent(/waiting for Stripe to confirm/);
    expect(banner).toHaveTextContent(/will be activated/);

    // Regression: must not read as a receipt.
    for (const claim of [
      /payment received/i,
      /payment (was )?successful/i,
      /thank you for your payment/i,
      /is (now )?active/i,
      /you('re| are) subscribed/i,
    ]) {
      expect(banner).not.toHaveTextContent(claim);
    }
  });

  it("after a canceled checkout, reassures that nothing was charged", () => {
    render(<CheckoutStatusBanner status="canceled" />);

    expect(screen.getByRole("status")).toHaveTextContent("Checkout canceled");
    expect(screen.getByRole("status")).toHaveTextContent(/No charges were made/);
  });
});
