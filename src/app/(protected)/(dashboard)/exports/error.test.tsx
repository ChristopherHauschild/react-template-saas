import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";

import ExportsError from "./error";

describe("exports error boundary", () => {
  afterEach(() => vi.restoreAllMocks());

  it("explains, shows the digest, and offers retry and a way out — never the internal message", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    const reset = vi.fn();
    const user = userEvent.setup();

    render(
      <ExportsError
        error={Object.assign(new Error("boom"), { digest: "abc123" })}
        reset={reset}
      />,
    );

    const alert = screen.getByRole("alert");
    expect(alert).toHaveTextContent("Exports are temporarily unavailable");
    expect(alert).toHaveTextContent(/abc123/);
    expect(alert).not.toHaveTextContent("boom");

    await user.click(screen.getByRole("button", { name: "Try again" }));
    expect(reset).toHaveBeenCalledTimes(1);
    expect(screen.getByRole("link", { name: "Back to dashboard" })).toHaveAttribute(
      "href",
      "/dashboard",
    );
  });

  it("logs the failure for operators (message and digest only)", () => {
    const error = vi.spyOn(console, "error").mockImplementation(() => {});

    render(
      <ExportsError
        error={Object.assign(new Error("render failed"), { digest: "d1" })}
        reset={() => {}}
      />,
    );

    expect(error).toHaveBeenCalledWith("[exports] unexpected error", {
      message: "render failed",
      digest: "d1",
    });
  });
});
