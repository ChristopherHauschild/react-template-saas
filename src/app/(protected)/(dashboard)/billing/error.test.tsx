import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";

import BillingError from "./error";

describe("billing error boundary", () => {
  afterEach(() => vi.restoreAllMocks());

  it("says nothing changed, shows the digest, and offers retry + a way out", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    const reset = vi.fn();
    const user = userEvent.setup();

    render(
      <BillingError
        error={Object.assign(new Error("boom"), { digest: "abc123" })}
        reset={reset}
      />,
    );

    const alert = screen.getByRole("alert");
    expect(alert).toHaveTextContent("Billing is temporarily unavailable");
    // A failed load says nothing about the subscription's state: no such claim.
    expect(alert).not.toHaveTextContent(/changed/i);
    expect(alert).toHaveTextContent(/try again/);
    expect(alert).toHaveTextContent(/abc123/);
    expect(alert).not.toHaveTextContent("boom"); // internal message is not shown to users

    await user.click(screen.getByRole("button", { name: "Try again" }));
    expect(reset).toHaveBeenCalledTimes(1);

    expect(screen.getByRole("link", { name: "Back to dashboard" })).toHaveAttribute(
      "href",
      "/dashboard",
    );
  });

  it("omits the reference when there is no digest", () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    render(<BillingError error={new Error("boom")} reset={() => {}} />);

    expect(screen.getByRole("alert")).not.toHaveTextContent(/reference/);
  });

  it("logs the failure for operators (message and digest only)", () => {
    const error = vi.spyOn(console, "error").mockImplementation(() => {});

    render(
      <BillingError
        error={Object.assign(new Error("Stripe is down"), { digest: "d1" })}
        reset={() => {}}
      />,
    );

    expect(error).toHaveBeenCalledWith("[billing] unexpected error", {
      message: "Stripe is down",
      digest: "d1",
    });
  });

  it("is not a full-screen page: it renders inside the dashboard shell", () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    const { container } = render(
      <BillingError error={new Error("x")} reset={() => {}} />,
    );

    expect(container.querySelector("main")).toBeNull();
    expect(container.firstElementChild?.className).not.toMatch(/min-h-screen/);
  });
});
