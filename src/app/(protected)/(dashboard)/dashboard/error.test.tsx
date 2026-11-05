import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";

import DashboardError from "./error";

describe("dashboard error boundary", () => {
  afterEach(() => vi.restoreAllMocks());

  it("says nothing changed, shows the digest, and offers retry + a way out", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    const reset = vi.fn();
    const user = userEvent.setup();

    render(
      <DashboardError
        error={Object.assign(new Error("boom"), { digest: "abc123" })}
        reset={reset}
      />,
    );

    const alert = screen.getByRole("alert");
    expect(alert).toHaveTextContent("Your dashboard is temporarily unavailable");
    // A failed load says nothing about the account's state: no such claim.
    expect(alert).not.toHaveTextContent(/changed/i);
    expect(alert).toHaveTextContent(/try again/);
    expect(alert).toHaveTextContent(/abc123/);
    expect(alert).not.toHaveTextContent("boom"); // internal message is not shown to users

    await user.click(screen.getByRole("button", { name: "Try again" }));
    expect(reset).toHaveBeenCalledTimes(1);

    expect(screen.getByRole("link", { name: "Go to billing" })).toHaveAttribute(
      "href",
      "/billing",
    );
  });

  it("omits the reference when there is no digest", () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    render(<DashboardError error={new Error("boom")} reset={() => {}} />);

    expect(screen.getByRole("alert")).not.toHaveTextContent(/reference/);
  });

  it("logs the failure for operators (message and digest only)", () => {
    const error = vi.spyOn(console, "error").mockImplementation(() => {});

    render(
      <DashboardError
        error={Object.assign(new Error("cookies unavailable"), { digest: "d1" })}
        reset={() => {}}
      />,
    );

    expect(error).toHaveBeenCalledWith("[dashboard] unexpected error", {
      message: "cookies unavailable",
      digest: "d1",
    });
  });

  it("is not a full-screen page: it renders inside the dashboard shell", () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    const { container } = render(
      <DashboardError error={new Error("x")} reset={() => {}} />,
    );

    expect(container.querySelector("main")).toBeNull();
    expect(container.firstElementChild?.className).not.toMatch(/min-h-screen/);
  });
});
