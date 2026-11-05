import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";

import PricingError from "./error";

describe("pricing error boundary", () => {
  afterEach(() => vi.restoreAllMocks());

  it("explains that nothing was charged, shows the digest, and offers retry + a way out", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    const reset = vi.fn();
    const user = userEvent.setup();

    render(
      <PricingError
        error={Object.assign(new Error("boom"), { digest: "abc123" })}
        reset={reset}
      />,
    );

    const alert = screen.getByRole("alert");
    expect(alert).toHaveTextContent("We couldn't start your checkout");
    expect(alert).toHaveTextContent(/Nothing was charged/);
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
    render(<PricingError error={new Error("boom")} reset={() => {}} />);

    expect(screen.getByRole("alert")).not.toHaveTextContent(/reference/);
  });
});
