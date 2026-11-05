import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";

import type { ResendConfirmationActionResult } from "../actions/resend-confirmation";

import {
  RESEND_COOLDOWN_SECONDS,
  ResendConfirmationForm,
} from "./resend-confirmation-form";

const action = vi.hoisted(() => ({
  resendConfirmation:
    vi.fn<
      (
        prev: ResendConfirmationActionResult,
        formData: FormData,
      ) => Promise<ResendConfirmationActionResult>
    >(),
}));
vi.mock("../actions/resend-confirmation", () => ({
  resendConfirmation: action.resendConfirmation,
}));

const EMAIL = "jane@example.com";
const SENT: ResendConfirmationActionResult = { status: "sent", email: EMAIL };
const UNAVAILABLE: ResendConfirmationActionResult = {
  status: "error",
  error: "We couldn't send a new link right now. Please try again in a moment.",
  email: EMAIL,
};
// An address the browser's type=email accepts but Supabase rejects
// (`email_address_invalid`); anything the browser rejects never reaches the action.
const INVALID: ResendConfirmationActionResult = {
  status: "error",
  error: "Enter a valid email address.",
  email: "jane@intranet",
};

const SEND = { name: "Request a new confirmation link" };

beforeEach(() => {
  action.resendConfirmation.mockReset();
  action.resendConfirmation.mockResolvedValue(SENT);
});

describe("ResendConfirmationForm – with a known address (sign-up panel)", () => {
  it("carries the address as a hidden field and shows only the button", () => {
    render(<ResendConfirmationForm email={EMAIL} />);

    expect(screen.queryByLabelText("Email")).not.toBeInTheDocument();
    expect(document.querySelector('input[type="hidden"][name="email"]')).toHaveValue(
      EMAIL,
    );
    expect(screen.getByRole("button", SEND)).toHaveAttribute("type", "submit");
    expect(screen.queryByRole("status")).not.toBeInTheDocument();
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
  });

  it("submits that address to the action", async () => {
    const user = userEvent.setup();
    render(<ResendConfirmationForm email={EMAIL} />);

    await user.click(screen.getByRole("button", SEND));

    await waitFor(() => expect(action.resendConfirmation).toHaveBeenCalledTimes(1));
    const [prev, formData] = action.resendConfirmation.mock.calls[0];
    expect(prev).toBeNull();
    expect(formData.get("email")).toBe(EMAIL);
  });
});

describe("ResendConfirmationForm – without an address (login page after a dead link)", () => {
  it("asks for the email with an accessible, autofillable field", () => {
    render(<ResendConfirmationForm />);

    const email = screen.getByLabelText("Email");
    expect(email).toHaveAttribute("type", "email");
    expect(email).toHaveAttribute("name", "email");
    expect(email).toHaveAttribute("autocomplete", "email");
    expect(email).toBeRequired();
  });

  it("submits the typed address", async () => {
    const user = userEvent.setup();
    render(<ResendConfirmationForm />);

    await user.type(screen.getByLabelText("Email"), EMAIL);
    await user.click(screen.getByRole("button", SEND));

    await waitFor(() => expect(action.resendConfirmation).toHaveBeenCalledTimes(1));
    expect(action.resendConfirmation.mock.calls[0][1].get("email")).toBe(EMAIL);
  });

  it("on an invalid email, flags the field, links it to the message and keeps what was typed", async () => {
    action.resendConfirmation.mockResolvedValue(INVALID);
    const user = userEvent.setup();
    render(<ResendConfirmationForm />);

    await user.type(screen.getByLabelText("Email"), "jane@intranet");
    await user.click(screen.getByRole("button", SEND));

    const alert = await screen.findByRole("alert");
    expect(alert).toHaveTextContent("Enter a valid email address.");
    const email = screen.getByLabelText("Email");
    expect(email).toHaveAttribute("aria-invalid", "true");
    expect(email).toHaveAccessibleDescription("Enter a valid email address.");
    expect(email).toHaveValue("jane@intranet");
    expect(screen.getByRole("button", SEND)).toBeEnabled(); // no cool-down: nothing was accepted
  });
});

describe("ResendConfirmationForm – outcome copy is neutral", () => {
  it("after an accepted request, acknowledges it without promising delivery or describing the account", async () => {
    const user = userEvent.setup();
    render(<ResendConfirmationForm email={EMAIL} cooldownSeconds={1} />);

    await user.click(screen.getByRole("button", SEND));

    const status = await screen.findByRole("status");
    // Acknowledges the request, conditions delivery on the address, and points an
    // already-confirmed user at sign-in — without saying which case applies.
    expect(status).toHaveTextContent(/^Request received\./);
    expect(status).toHaveTextContent(/If jane@example\.com can still be confirmed/);
    expect(status).toHaveTextContent(/may arrive/);
    expect(status).toHaveTextContent(/spam/i);
    expect(status).toHaveTextContent(/Already confirmed\? Just sign in\./);
    for (const claim of [
      /\bsent\b/i, // any form of "sent": delivery may have been suppressed
      /\bsending\b/i,
      /on its way/i,
      /will arrive/i,
      /success/i,
      /check your inbox for the email/i,
      /account (exists|found|not found)/i,
      /no account/i,
      /registered/i,
    ]) {
      expect(status).not.toHaveTextContent(claim);
    }
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
  });

  it("reports an outage as an alert, not as sent, so the user knows to retry", async () => {
    action.resendConfirmation.mockResolvedValue(UNAVAILABLE);
    const user = userEvent.setup();
    render(<ResendConfirmationForm email={EMAIL} />);

    await user.click(screen.getByRole("button", SEND));

    expect(await screen.findByRole("alert")).toHaveTextContent(
      /couldn't send a new link/,
    );
    expect(screen.queryByRole("status")).not.toBeInTheDocument();
    expect(screen.getByRole("button", SEND)).toBeEnabled();
  });

  it("keeps exactly one live region, so a later result replaces the earlier one", async () => {
    action.resendConfirmation
      .mockResolvedValueOnce(UNAVAILABLE)
      .mockResolvedValueOnce(SENT);
    const user = userEvent.setup();
    render(<ResendConfirmationForm email={EMAIL} cooldownSeconds={1} />);

    await user.click(screen.getByRole("button", SEND));
    await screen.findByRole("alert");

    await user.click(screen.getByRole("button", SEND));
    await screen.findByRole("status");

    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
    expect(screen.getAllByRole("status")).toHaveLength(1);
  });
});

describe("ResendConfirmationForm – repeated submissions", () => {
  it("shows a busy state while sending and blocks a second submit", async () => {
    let finish!: (value: ResendConfirmationActionResult) => void;
    action.resendConfirmation.mockReturnValue(
      new Promise((resolve) => (finish = resolve)),
    );
    const user = userEvent.setup();
    render(<ResendConfirmationForm email={EMAIL} cooldownSeconds={1} />);

    await user.click(screen.getByRole("button", SEND));

    const busy = await screen.findByRole("button", { name: "Requesting…" });
    expect(busy).toBeDisabled();
    expect(busy).toHaveAttribute("aria-busy", "true");

    await user.click(busy);
    expect(action.resendConfirmation).toHaveBeenCalledTimes(1);

    finish(SENT);
    await screen.findByRole("status");
  });

  it("after an accepted request, disables the button for the cool-down with a visible countdown, then re-enables it as 'Request another link'", async () => {
    const user = userEvent.setup();
    render(<ResendConfirmationForm email={EMAIL} cooldownSeconds={1} />);

    await user.click(screen.getByRole("button", SEND));

    const cooling = await screen.findByRole("button", {
      name: /^Request again in \d+s$/,
    });
    expect(cooling).toBeDisabled();
    expect(cooling).toHaveAttribute("aria-disabled", "true");

    // Clicking during the cool-down does nothing.
    await user.click(cooling);
    expect(action.resendConfirmation).toHaveBeenCalledTimes(1);

    const again = await screen.findByRole(
      "button",
      { name: "Request another link" },
      { timeout: 3000 },
    );
    expect(again).toBeEnabled();
    expect(again).not.toHaveAttribute("aria-disabled");

    await user.click(again);
    await waitFor(() => expect(action.resendConfirmation).toHaveBeenCalledTimes(2));
    expect(action.resendConfirmation.mock.calls[1][0]).toEqual(SENT); // previous state passed along
  });

  it("applies the cool-down after EVERY accepted request, so it reveals nothing about the account", async () => {
    // The action answers `sent` for unknown, confirmed and rate-limited addresses
    // alike (see resend-confirmation.test.ts); the form cannot tell them apart and
    // must not behave differently.
    const user = userEvent.setup();
    render(<ResendConfirmationForm email="nobody@example.com" cooldownSeconds={1} />);

    await user.click(screen.getByRole("button", SEND));

    expect(
      await screen.findByRole("button", { name: /^Request again in \d+s$/ }),
    ).toBeDisabled();
  });

  it("never labels the button with 'send'/'sent' in any state (the request may be suppressed)", async () => {
    let finish!: (value: ResendConfirmationActionResult) => void;
    action.resendConfirmation.mockReturnValue(
      new Promise((resolve) => (finish = resolve)),
    );
    const user = userEvent.setup();
    render(<ResendConfirmationForm email={EMAIL} cooldownSeconds={1} />);

    const labels = [screen.getByRole("button").textContent];
    await user.click(screen.getByRole("button", SEND));
    labels.push((await screen.findByRole("button", { name: "Requesting…" })).textContent);
    finish(SENT);
    labels.push(
      (await screen.findByRole("button", { name: /^Request again in/ })).textContent,
    );
    labels.push(
      (
        await screen.findByRole(
          "button",
          { name: "Request another link" },
          { timeout: 3000 },
        )
      ).textContent,
    );

    for (const label of labels) expect(label).not.toMatch(/\bsen[dt]\b/i);
  });

  it("defaults to a cool-down matching Supabase's per-address limit (60s)", () => {
    expect(RESEND_COOLDOWN_SECONDS).toBe(60);
  });
});
