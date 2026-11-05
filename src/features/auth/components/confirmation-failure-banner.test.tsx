import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";

import { CONFIRMATION_FAILURES } from "../services/email-confirmation-errors";

import { ConfirmationFailureBanner } from "./confirmation-failure-banner";

describe("ConfirmationFailureBanner", () => {
  it("renders nothing without a failure", () => {
    const { container } = render(<ConfirmationFailureBanner failure={null} />);

    expect(container).toBeEmptyDOMElement();
  });

  it("explains an expired link and how to get a new one", () => {
    render(<ConfirmationFailureBanner failure={CONFIRMATION_FAILURES.expired} />);

    const alert = screen.getByRole("alert");
    expect(alert).toHaveTextContent(
      "That confirmation link has expired or was already used",
    );
    expect(alert).toHaveTextContent(/request a new link/i);
    expect(alert).toHaveTextContent(/within the hour/i);
  });

  it("explains an invalid/reused link, including the different-browser case", () => {
    render(<ConfirmationFailureBanner failure={CONFIRMATION_FAILURES.invalid} />);

    const alert = screen.getByRole("alert");
    expect(alert).toHaveTextContent("That confirmation link didn't work");
    expect(alert).toHaveTextContent(/already used/i);
    expect(alert).toHaveTextContent(/different browser/i);
    expect(alert).toHaveTextContent(/request a new link/i);
  });

  it("explains a temporary outage without blaming the link", () => {
    render(<ConfirmationFailureBanner failure={CONFIRMATION_FAILURES.unavailable} />);

    const alert = screen.getByRole("alert");
    expect(alert).toHaveTextContent("We couldn't confirm your email");
    expect(alert).toHaveTextContent(/try the link again/i);
  });

  it("always tells an already-confirmed user to just sign in (a used link is the usual reason)", () => {
    for (const failure of Object.values(CONFIRMATION_FAILURES)) {
      const { unmount } = render(<ConfirmationFailureBanner failure={failure} />);

      expect(screen.getByRole("alert")).toHaveTextContent(/just sign in/i);
      unmount();
    }
  });

  it("never echoes anything other than its own static copy (no raw query text)", () => {
    for (const failure of Object.values(CONFIRMATION_FAILURES)) {
      const { unmount } = render(<ConfirmationFailureBanner failure={failure} />);

      expect(screen.getByRole("alert").textContent).not.toContain("<");
      unmount();
    }
  });
});
