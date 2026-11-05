import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";

import type { SignOutOtherSessionsResult } from "../actions/sign-out-other-sessions";
import type { AccountSecurity } from "../services/account-security";
import { SESSION_ERRORS } from "../services/session-errors";

import {
  SecurityCard,
  SIGN_OUT_OTHERS_LABEL,
  SIGN_OUT_OTHERS_PENDING_LABEL,
} from "./security-card";

const action = vi.hoisted(() => ({
  signOutOtherSessions: vi.fn<() => Promise<SignOutOtherSessionsResult>>(),
}));
vi.mock("../actions/sign-out-other-sessions", () => action);

const SECURITY: AccountSecurity = {
  email: "jane@example.com",
  emailConfirmedAt: "2026-01-01T09:00:00Z",
  lastSignInAt: "2026-03-01T10:00:00Z",
  createdAt: "2026-01-01T08:00:00Z",
  signInMethods: ["Email and password"],
  pendingEmail: null,
};

const button = () => screen.getByRole("button", { name: SIGN_OUT_OTHERS_LABEL });
const fact = (term: string) => screen.getByText(term).nextElementSibling;

beforeEach(() => {
  action.signOutOtherSessions.mockReset();
  action.signOutOtherSessions.mockResolvedValue({
    status: "signed_out",
    at: "2026-03-01T10:05:00.000Z",
  });
});

describe("SecurityCard – review", () => {
  it("lists the account's sign-in facts", () => {
    render(<SecurityCard security={SECURITY} accessTokenLifetimeSeconds={3600} />);

    expect(
      screen.getByRole("heading", { level: 3, name: "Security" }),
    ).toBeInTheDocument();
    expect(fact("Sign-in email")).toHaveTextContent("jane@example.com");
    expect(fact("Email confirmed")).toHaveTextContent("1 Jan 2026, 09:00 UTC");
    expect(fact("Sign-in methods")).toHaveTextContent("Email and password");
    expect(fact("Last sign-in")).toHaveTextContent("1 Mar 2026, 10:00 UTC");
    expect(fact("Account created")).toHaveTextContent("1 Jan 2026, 08:00 UTC");
    expect(fact("Pending email change")).toHaveTextContent("None");
  });

  it("flags what deserves attention: an unconfirmed email, a pending change, unknowns", () => {
    render(
      <SecurityCard
        security={{
          ...SECURITY,
          emailConfirmedAt: null,
          lastSignInAt: null,
          signInMethods: [],
          pendingEmail: "jane.new@example.com",
        }}
        accessTokenLifetimeSeconds={null}
      />,
    );

    expect(fact("Email confirmed")).toHaveTextContent("Not confirmed");
    expect(fact("Pending email change")).toHaveTextContent(
      "To jane.new@example.com (awaiting confirmation)",
    );
    expect(fact("Last sign-in")).toHaveTextContent("Unknown");
    expect(fact("Sign-in methods")).toHaveTextContent("Unknown");
  });

  it("explains exactly what signing out other sessions does — including what it cannot do", () => {
    render(<SecurityCard security={SECURITY} accessTokenLifetimeSeconds={3600} />);

    const explanation = button().getAttribute("aria-describedby")!;
    const text = document.getElementById(explanation)!.textContent!;
    expect(text).toMatch(/this one stays signed in/);
    expect(text).toMatch(/lose access to this app on their next request/);
    expect(text).toMatch(/can still be used directly with our backend until it expires/);
    expect(text).toMatch(/at most 60 minutes/);
  });

  it("states the caveat without a number when the token lifetime is unknown", () => {
    render(<SecurityCard security={SECURITY} accessTokenLifetimeSeconds={null} />);

    expect(button()).toHaveAccessibleDescription(
      /until it expires\. Changing your password/,
    );
  });
});

describe("SecurityCard – signing out other sessions", () => {
  it("runs the action and confirms with the time, never with a number of devices", async () => {
    const user = userEvent.setup();
    render(<SecurityCard security={SECURITY} accessTokenLifetimeSeconds={3600} />);

    await user.click(button());

    const status = await screen.findByRole("status");
    expect(status).toHaveTextContent(
      "Other sessions were signed out (1 Mar 2026, 10:05 UTC). They can no longer use this app or renew their sign-in.",
    );
    expect(status).not.toHaveTextContent(/\d+ (devices|sessions)/);
    expect(action.signOutOtherSessions).toHaveBeenCalledTimes(1);
  });

  it("shows a pending state and blocks double submission", async () => {
    const user = userEvent.setup();
    let finish!: (v: SignOutOtherSessionsResult) => void;
    action.signOutOtherSessions.mockReturnValue(
      new Promise((resolve) => (finish = resolve)),
    );
    render(<SecurityCard security={SECURITY} accessTokenLifetimeSeconds={3600} />);

    await user.click(button());

    const pending = await screen.findByRole("button", {
      name: SIGN_OUT_OTHERS_PENDING_LABEL,
    });
    expect(pending).toBeDisabled();
    expect(pending).toHaveAttribute("aria-busy", "true");
    expect(screen.getByRole("form", { name: "Other sessions" })).toHaveAttribute(
      "aria-busy",
      "true",
    );
    await user.click(pending);
    expect(action.signOutOtherSessions).toHaveBeenCalledTimes(1);

    finish({ status: "signed_out", at: "2026-03-01T10:05:00.000Z" });
    await screen.findByRole("status");
    expect(button()).toBeEnabled();
  });

  it("repeated requests visibly take effect again (new time)", async () => {
    const user = userEvent.setup();
    action.signOutOtherSessions
      .mockResolvedValueOnce({ status: "signed_out", at: "2026-03-01T10:05:00.000Z" })
      .mockResolvedValueOnce({ status: "signed_out", at: "2026-03-01T10:09:00.000Z" });
    render(<SecurityCard security={SECURITY} accessTokenLifetimeSeconds={3600} />);

    await user.click(button());
    await screen.findByText(/10:05 UTC/);
    await user.click(button());

    await waitFor(() =>
      expect(screen.getByRole("status")).toHaveTextContent(/10:09 UTC/),
    );
    expect(screen.getAllByRole("status")).toHaveLength(1);
  });

  it("reports an expired session as an alert and claims nothing", async () => {
    const user = userEvent.setup();
    action.signOutOtherSessions.mockResolvedValue({
      status: "error",
      error: SESSION_ERRORS.sessionExpired,
    });
    render(<SecurityCard security={SECURITY} accessTokenLifetimeSeconds={3600} />);

    await user.click(button());

    const alert = await screen.findByRole("alert");
    expect(alert).toHaveTextContent(/Sign in again, then retry/);
    expect(screen.queryByRole("status")).not.toBeInTheDocument();
    expect(button()).toBeEnabled();
  });

  it("replaces an earlier success with a later failure (no stale 'signed out')", async () => {
    const user = userEvent.setup();
    action.signOutOtherSessions
      .mockResolvedValueOnce({ status: "signed_out", at: "2026-03-01T10:05:00.000Z" })
      .mockResolvedValueOnce({ status: "error", error: SESSION_ERRORS.unavailable });
    render(<SecurityCard security={SECURITY} accessTokenLifetimeSeconds={3600} />);

    await user.click(button());
    await screen.findByRole("status");
    await user.click(button());

    await screen.findByRole("alert");
    expect(screen.queryByRole("status")).not.toBeInTheDocument();
  });

  it("is a named form whose only control is the button (nothing is submitted)", () => {
    render(<SecurityCard security={SECURITY} accessTokenLifetimeSeconds={3600} />);

    const form = screen.getByRole("form", { name: "Other sessions" });
    expect(within(form).queryAllByRole("textbox")).toHaveLength(0);
    expect(form.querySelectorAll("input")).toHaveLength(0);
  });
});
