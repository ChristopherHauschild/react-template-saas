import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";

import SettingsError from "./error";

describe("settings error boundary", () => {
  afterEach(() => vi.restoreAllMocks());

  it("says nothing changed, shows the digest, and offers retry + a way out", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    const reset = vi.fn();
    const user = userEvent.setup();

    render(
      <SettingsError
        error={Object.assign(new Error("boom"), { digest: "abc123" })}
        reset={reset}
      />,
    );

    const alert = screen.getByRole("alert");
    expect(alert).toHaveTextContent("Settings are temporarily unavailable");
    expect(alert).toHaveTextContent(/Nothing about your account was changed/);
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
    render(<SettingsError error={new Error("boom")} reset={() => {}} />);

    expect(screen.getByRole("alert")).not.toHaveTextContent(/reference/);
  });

  it("logs the failure for operators (message + digest only)", () => {
    const log = vi.spyOn(console, "error").mockImplementation(() => {});
    render(
      <SettingsError
        error={Object.assign(new Error("boom"), { digest: "abc123" })}
        reset={() => {}}
      />,
    );

    expect(log).toHaveBeenCalledWith("[settings] unexpected error", {
      message: "boom",
      digest: "abc123",
    });
  });
});
