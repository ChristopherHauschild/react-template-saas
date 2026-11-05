import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";

import type { ChangeEmailActionResult } from "../actions/change-email";

import {
  CHANGE_EMAIL_LABEL,
  CHANGE_EMAIL_PENDING_LABEL,
  ChangeEmailForm,
  RESEND_EMAIL_CHANGE_LABEL,
} from "./change-email-form";

const action = vi.hoisted(() => ({
  changeEmail:
    vi.fn<
      (
        prev: ChangeEmailActionResult,
        formData: FormData,
      ) => Promise<ChangeEmailActionResult>
    >(),
}));
vi.mock("../actions/change-email", () => ({ changeEmail: action.changeEmail }));

const CURRENT = "jane@example.com";
const NEW_EMAIL = "jane.new@example.com";

const NOTHING_PENDING = { email: CURRENT, pendingEmail: null, pendingEmailSentAt: null };
const PENDING = {
  email: CURRENT,
  pendingEmail: NEW_EMAIL,
  pendingEmailSentAt: "2026-03-01T10:00:00Z",
};

const SENT: ChangeEmailActionResult = { status: "confirmation_sent", email: NEW_EMAIL };
const TAKEN: ChangeEmailActionResult = {
  status: "error",
  error:
    "That email address can't be used for this account. If it's yours, you may already have another account with it; otherwise choose a different address.",
  field: "email",
  email: NEW_EMAIL,
};
const TOO_SOON: ChangeEmailActionResult = {
  status: "error",
  error:
    "A confirmation email was sent very recently. Check your inbox (and spam folder), or wait a minute before requesting another.",
  email: NEW_EMAIL,
};

const newEmailInput = () => screen.getByRole("textbox", { name: /address/i });
const sendButton = () => screen.getByRole("button", { name: CHANGE_EMAIL_LABEL });
const mainForm = () => screen.getByRole("form", { name: "Email" });

const typeAndSend = async (
  user: ReturnType<typeof userEvent.setup>,
  email = NEW_EMAIL,
) => {
  await user.clear(newEmailInput());
  if (email) await user.type(newEmailInput(), email);
  await user.click(sendButton());
};

beforeEach(() => {
  action.changeEmail.mockReset();
  action.changeEmail.mockResolvedValue(null);
});

describe("ChangeEmailForm – nothing pending", () => {
  it("shows the current address and an empty, required new-address field", () => {
    render(<ChangeEmailForm profile={NOTHING_PENDING} />);

    expect(screen.getByText("Current address").nextElementSibling).toHaveTextContent(
      CURRENT,
    );

    const input = newEmailInput();
    expect(input).toHaveAccessibleName("New email address");
    expect(input).toHaveAttribute("type", "email");
    expect(input).toHaveAttribute("name", "email");
    expect(input).toHaveAttribute("autocomplete", "email");
    expect(input).toBeRequired();
    expect(input).toHaveValue("");
    expect(input).toHaveAccessibleDescription(/only changes once it has been confirmed/);

    expect(sendButton()).toHaveAttribute("type", "submit");
    expect(screen.queryByRole("status")).not.toBeInTheDocument();
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
    expect(
      screen.queryByRole("button", { name: RESEND_EMAIL_CHANGE_LABEL }),
    ).not.toBeInTheDocument();
  });

  it("copes with an account that has no email yet", () => {
    render(<ChangeEmailForm profile={{ ...NOTHING_PENDING, email: null }} />);

    expect(screen.getByText(/No email on this account/)).toBeInTheDocument();
  });

  it("submits exactly the new address to the action", async () => {
    const user = userEvent.setup();
    render(<ChangeEmailForm profile={NOTHING_PENDING} />);

    await typeAndSend(user);

    await waitFor(() => expect(action.changeEmail).toHaveBeenCalledTimes(1));
    const [prev, formData] = action.changeEmail.mock.calls[0];
    expect(prev).toBeNull();
    expect(formData.get("email")).toBe(NEW_EMAIL);
    expect([...formData.keys()]).toEqual(["email"]);
  });

  it("lets the browser stop an empty or malformed address before the action runs", async () => {
    const user = userEvent.setup();
    render(<ChangeEmailForm profile={NOTHING_PENDING} />);

    await user.click(sendButton());
    expect(newEmailInput()).toBeInvalid();

    await user.type(newEmailInput(), "not-an-email");
    await user.click(sendButton());
    expect(newEmailInput()).toBeInvalid();

    expect(action.changeEmail).not.toHaveBeenCalled();
  });

  it("shows a pending state and blocks double submission while the action runs", async () => {
    const user = userEvent.setup();
    let finish!: (value: ChangeEmailActionResult) => void;
    action.changeEmail.mockReturnValue(
      new Promise<ChangeEmailActionResult>((resolve) => (finish = resolve)),
    );
    render(<ChangeEmailForm profile={NOTHING_PENDING} />);

    await typeAndSend(user);

    const pendingButton = await screen.findByRole("button", {
      name: CHANGE_EMAIL_PENDING_LABEL,
    });
    expect(pendingButton).toBeDisabled();
    expect(mainForm()).toHaveAttribute("aria-busy", "true");

    await user.click(pendingButton);
    expect(action.changeEmail).toHaveBeenCalledTimes(1);

    finish(SENT);
    await screen.findByRole("status");
    expect(mainForm()).toHaveAttribute("aria-busy", "false");
  });
});

describe("ChangeEmailForm – after a confirmation was sent (NOT a completed change)", () => {
  it("says a link was sent, names the new address as pending, and keeps the current one as current", async () => {
    const user = userEvent.setup();
    action.changeEmail.mockResolvedValue(SENT);
    render(<ChangeEmailForm profile={NOTHING_PENDING} />);

    await typeAndSend(user);

    const notice = await screen.findByRole("status");
    expect(notice).toHaveAttribute("data-pending-email", NEW_EMAIL);
    expect(notice).toHaveTextContent(/Confirmation email sent/);
    expect(notice).toHaveTextContent(NEW_EMAIL);
    expect(notice).toHaveTextContent(/open every link you receive/i);
    expect(notice).toHaveTextContent(new RegExp(`keep signing in with ${CURRENT}`));

    // The current address is unchanged and nothing claims otherwise.
    expect(screen.getByText("Current address").nextElementSibling).toHaveTextContent(
      CURRENT,
    );
    expect(document.body.textContent).not.toMatch(/has been changed|is now/);
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
  });

  it("clears the new-address field and offers a resend", async () => {
    const user = userEvent.setup();
    action.changeEmail.mockResolvedValue(SENT);
    render(<ChangeEmailForm profile={NOTHING_PENDING} />);

    await typeAndSend(user);
    await screen.findByRole("status");

    expect(newEmailInput()).toHaveValue("");
    expect(newEmailInput()).toHaveAccessibleName(/different address/i);
    expect(
      screen.getByRole("button", { name: RESEND_EMAIL_CHANGE_LABEL }),
    ).toBeInTheDocument();
  });
});

describe("ChangeEmailForm – a change already pending (from the server)", () => {
  it("shows the pending address, when it was sent, and the unchanged current address", () => {
    render(<ChangeEmailForm profile={PENDING} />);

    const notice = screen.getByRole("status");
    expect(notice).toHaveAttribute("data-pending-email", NEW_EMAIL);
    expect(notice).toHaveTextContent(/Change pending confirmation/);
    expect(notice).toHaveTextContent(NEW_EMAIL);
    expect(notice).toHaveTextContent("1 Mar 2026, 10:00 UTC");
    expect(notice).toHaveTextContent(/nothing changes until a link is opened/);
    expect(screen.getByText("Current address").nextElementSibling).toHaveTextContent(
      CURRENT,
    );
    expect(document.body.textContent).not.toMatch(/has been changed/);
  });

  it("omits the timestamp when it is missing or unparsable", () => {
    const { unmount } = render(
      <ChangeEmailForm profile={{ ...PENDING, pendingEmailSentAt: null }} />,
    );
    expect(screen.getByRole("status")).not.toHaveTextContent(/UTC/);
    unmount();

    render(<ChangeEmailForm profile={{ ...PENDING, pendingEmailSentAt: "garbage" }} />);
    expect(screen.getByRole("status")).not.toHaveTextContent(/UTC|Invalid/);
  });

  it("resends by submitting the pending address from its own form — the empty new-address field does not block it", async () => {
    const user = userEvent.setup();
    action.changeEmail.mockResolvedValue(SENT);
    render(<ChangeEmailForm profile={PENDING} />);

    const resend = screen.getByRole("button", { name: RESEND_EMAIL_CHANGE_LABEL });
    expect(resend.closest("form")).not.toBe(mainForm());
    expect(resend.closest("form")).toHaveAccessibleName("Resend confirmation");
    // The live region is a plain region wrapping the text and the resend form.
    expect(screen.getByRole("status").tagName).toBe("DIV");
    expect(newEmailInput()).toHaveValue("");

    await user.click(resend);

    await waitFor(() => expect(action.changeEmail).toHaveBeenCalledTimes(1));
    const [, formData] = action.changeEmail.mock.calls[0];
    expect(formData.get("email")).toBe(NEW_EMAIL);
    expect(formData.getAll("email")).toEqual([NEW_EMAIL]);
    expect(await screen.findByRole("status")).toHaveTextContent(
      /Confirmation email sent/,
    );
  });

  it("lets the user switch to a different address (the server re-render replaces the pending one)", async () => {
    const user = userEvent.setup();
    const other = "jane.other@example.com";
    action.changeEmail.mockResolvedValue({ status: "confirmation_sent", email: other });
    const { rerender } = render(<ChangeEmailForm profile={PENDING} />);

    await typeAndSend(user, other);
    await waitFor(() => expect(action.changeEmail).toHaveBeenCalledTimes(1));
    // The action revalidates the page; the re-render carries the new pending address.
    rerender(<ChangeEmailForm profile={{ ...PENDING, pendingEmail: other }} />);

    const notice = await screen.findByRole("status");
    expect(notice).toHaveAttribute("data-pending-email", other);
    expect(notice).toHaveTextContent(/Confirmation email sent/);
    expect(within(notice).queryByText(NEW_EMAIL)).not.toBeInTheDocument();
  });

  it("the server's record wins over this tab's result when they disagree", async () => {
    // Stale tab: it got "sent" for one address, but the account now has another
    // change pending (requested elsewhere) — show what the account says.
    const user = userEvent.setup();
    action.changeEmail.mockResolvedValue({
      status: "confirmation_sent",
      email: "a@x.io",
    });
    const { rerender } = render(<ChangeEmailForm profile={NOTHING_PENDING} />);

    await typeAndSend(user, "a@x.io");
    await screen.findByRole("status");
    rerender(<ChangeEmailForm profile={{ ...PENDING, pendingEmail: "b@x.io" }} />);

    const notice = screen.getByRole("status");
    expect(notice).toHaveAttribute("data-pending-email", "b@x.io");
    expect(notice).toHaveTextContent(/Change pending confirmation/);
  });

  it("stops showing a change as pending once the server shows it as the current address (completed in another tab)", async () => {
    const user = userEvent.setup();
    action.changeEmail.mockResolvedValue(SENT);
    const { rerender } = render(<ChangeEmailForm profile={NOTHING_PENDING} />);

    await typeAndSend(user);
    expect(await screen.findByRole("status")).toHaveAttribute(
      "data-pending-email",
      NEW_EMAIL,
    );

    // Meanwhile both links were opened elsewhere; a later render (revalidation,
    // navigation back to the page) reflects the completed change.
    rerender(
      <ChangeEmailForm
        profile={{ email: NEW_EMAIL, pendingEmail: null, pendingEmailSentAt: null }}
      />,
    );

    expect(screen.queryByRole("status")).not.toBeInTheDocument();
    expect(screen.getByText("Current address").nextElementSibling).toHaveTextContent(
      NEW_EMAIL,
    );
    expect(
      screen.queryByRole("button", { name: RESEND_EMAIL_CHANGE_LABEL }),
    ).not.toBeInTheDocument();
    expect(newEmailInput()).toHaveAccessibleName("New email address");
  });
});

describe("ChangeEmailForm – errors", () => {
  it("pins an address that can't be used to the field and keeps it for editing", async () => {
    const user = userEvent.setup();
    action.changeEmail.mockResolvedValue(TAKEN);
    render(<ChangeEmailForm profile={NOTHING_PENDING} />);

    await typeAndSend(user);

    const alert = await screen.findByRole("alert");
    expect(alert).toHaveTextContent(/can't be used for this account/);
    expect(newEmailInput()).toHaveAttribute("aria-invalid", "true");
    expect(newEmailInput().getAttribute("aria-describedby")!.split(" ")).toContain(
      alert.id,
    );
    expect(newEmailInput()).toHaveValue(NEW_EMAIL);
    // Not pending: the request was refused.
    expect(screen.queryByRole("status")).not.toBeInTheDocument();
    expect(
      screen.queryByRole("button", { name: RESEND_EMAIL_CHANGE_LABEL }),
    ).not.toBeInTheDocument();
  });

  it("shows an error that is not about the address without flagging the field", async () => {
    const user = userEvent.setup();
    action.changeEmail.mockResolvedValue(TOO_SOON);
    render(<ChangeEmailForm profile={PENDING} />);

    await user.click(screen.getByRole("button", { name: RESEND_EMAIL_CHANGE_LABEL }));

    const alert = await screen.findByRole("alert");
    expect(alert).toHaveTextContent(/sent very recently/);
    expect(newEmailInput()).not.toHaveAttribute("aria-invalid");
    // The server-known pending change is still shown.
    expect(screen.getByRole("status")).toHaveAttribute("data-pending-email", NEW_EMAIL);
  });

  it("replaces the error once a retry is accepted", async () => {
    const user = userEvent.setup();
    action.changeEmail.mockResolvedValueOnce(TAKEN).mockResolvedValueOnce(SENT);
    render(<ChangeEmailForm profile={NOTHING_PENDING} />);

    await typeAndSend(user);
    await screen.findByRole("alert");

    await typeAndSend(user);

    await screen.findByRole("status");
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
    expect(newEmailInput()).not.toHaveAttribute("aria-invalid");
  });
});
