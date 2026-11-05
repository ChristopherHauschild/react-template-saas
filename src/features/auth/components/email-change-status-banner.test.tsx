import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { EMAIL_CHANGE_STATUSES } from "../services/email-change-status";

import { EmailChangeStatusBanner } from "./email-change-status-banner";

const nav = await vi.hoisted(async () =>
  (await import("@/shared/test/next-navigation")).createNextNavigationMock("/settings"),
);
vi.mock("next/navigation", () => nav.module);

describe("EmailChangeStatusBanner", () => {
  beforeEach(() => nav.reset("/settings"));

  it("renders nothing without a status", () => {
    const { container } = render(
      <EmailChangeStatusBanner status={null} placement="settings" />,
    );

    expect(container).toBeEmptyDOMElement();
  });

  it("announces a completed change as a status, in both placements", () => {
    for (const placement of ["settings", "login"] as const) {
      const { unmount } = render(
        <EmailChangeStatusBanner status="confirmed" placement={placement} />,
      );

      const banner = screen.getByRole("status");
      expect(banner).toHaveTextContent(/has been changed/);
      expect(banner).toHaveAttribute("data-email-change-status", "confirmed");
      unmount();
    }
  });

  it("says the address did NOT change for every other status", () => {
    const others = Object.values(EMAIL_CHANGE_STATUSES).filter((s) => s !== "confirmed");

    for (const status of others) {
      for (const placement of ["settings", "login"] as const) {
        const { unmount } = render(
          <EmailChangeStatusBanner status={status} placement={placement} />,
        );

        const banner = screen.getByRole(status === "awaiting_other" ? "status" : "alert");
        expect(banner, `${status}/${placement}`).not.toHaveTextContent(
          /has been changed/,
        );
        unmount();
      }
    }
  });

  it("treats the half-confirmed state as information, not as an error", () => {
    render(<EmailChangeStatusBanner status="awaiting_other" placement="settings" />);

    const banner = screen.getByRole("status");
    expect(banner).toHaveTextContent(/one more to go/i);
    expect(banner).toHaveTextContent(/other address/);
    expect(banner).toHaveTextContent(/stays as it is/);
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
  });

  it("points at the remedy that fits the page: the card below on settings, signing in on login", () => {
    const { unmount } = render(
      <EmailChangeStatusBanner status="expired" placement="settings" />,
    );
    expect(screen.getByRole("alert")).toHaveTextContent(/Email section below/);
    unmount();

    render(<EmailChangeStatusBanner status="expired" placement="login" />);
    expect(screen.getByRole("alert")).toHaveTextContent(
      /Sign in with your current address/,
    );
  });

  it("can be dismissed: the status leaves the URL (replace, other params kept) so it does not outlive the event", async () => {
    const user = userEvent.setup();
    nav.setSearch("emailChange=confirmed&tab=account");
    render(<EmailChangeStatusBanner status="confirmed" placement="settings" />);

    await user.click(screen.getByRole("button", { name: "Dismiss email change notice" }));

    expect(nav.router.replace).toHaveBeenCalledTimes(1);
    expect(nav.router.replace).toHaveBeenCalledWith("/settings?tab=account", {
      scroll: false,
    });
    expect(nav.router.push).not.toHaveBeenCalled();
  });

  it("dismissing the only parameter leaves a clean path", async () => {
    const user = userEvent.setup();
    nav.setSearch("emailChange=expired");
    render(<EmailChangeStatusBanner status="expired" placement="settings" />);

    await user.click(screen.getByRole("button", { name: /dismiss/i }));

    expect(nav.router.replace).toHaveBeenCalledWith("/settings", { scroll: false });
  });

  it("tells an 'invalid' link apart from an expired one and from an outage", () => {
    const { unmount } = render(
      <EmailChangeStatusBanner status="invalid" placement="settings" />,
    );
    expect(screen.getByRole("alert")).toHaveTextContent(/didn't work/);
    unmount();

    render(<EmailChangeStatusBanner status="unavailable" placement="settings" />);
    expect(screen.getByRole("alert")).toHaveTextContent(/link may still be fine/);
  });
});
