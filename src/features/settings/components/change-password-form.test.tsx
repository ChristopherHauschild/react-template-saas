import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { PASSWORD_MAX_LENGTH, PASSWORD_MIN_LENGTH } from "@/config/passwordPolicy";

import type { ChangePasswordActionResult } from "../actions/change-password";

import {
  CHANGE_PASSWORD_LABEL,
  CHANGE_PASSWORD_PENDING_LABEL,
  ChangePasswordForm,
  OTHER_SESSIONS_NOT_SIGNED_OUT_MESSAGE,
  OTHER_SESSIONS_SIGNED_OUT_MESSAGE,
  PASSWORD_CHANGED_MESSAGE,
} from "./change-password-form";

// The form submits the server action; replace it with a controllable fake that
// keeps the `(prevState, formData)` signature React uses with useActionState.
const action = vi.hoisted(() => ({
  changePassword:
    vi.fn<
      (
        prev: ChangePasswordActionResult,
        formData: FormData,
      ) => Promise<ChangePasswordActionResult>
    >(),
}));
vi.mock("../actions/change-password", () => ({ changePassword: action.changePassword }));

const EMAIL = "jane@example.com";
const CURRENT = "old-correct-horse";
const NEXT = "new-battery-staple";

const CHANGED: ChangePasswordActionResult = {
  status: "changed",
  otherSessionsSignedOut: true,
};
const CHANGED_OTHERS_KEPT: ChangePasswordActionResult = {
  status: "changed",
  otherSessionsSignedOut: false,
};

const WRONG_CURRENT: ChangePasswordActionResult = {
  status: "error",
  error: "Your current password is incorrect.",
  field: "currentPassword",
};

const BREACHED: ChangePasswordActionResult = {
  status: "error",
  error:
    "This password has appeared in a data breach and can't be used. Choose a different one.",
  field: "newPassword",
};

const MISMATCH: ChangePasswordActionResult = {
  status: "error",
  error: "New passwords do not match.",
  field: "confirmPassword",
};

const UNFIELDED: ChangePasswordActionResult = {
  status: "error",
  error: "We couldn't change your password right now. Please try again in a moment.",
};

const current = () => screen.getByLabelText("Current password");
const next = () => screen.getByLabelText("New password");
const confirm = () => screen.getByLabelText("Confirm new password");
const submit = () => screen.getByRole("button", { name: CHANGE_PASSWORD_LABEL });

const fillAndSubmit = async (
  user: ReturnType<typeof userEvent.setup>,
  { currentPassword = CURRENT, newPassword = NEXT, confirmPassword = NEXT } = {},
) => {
  if (currentPassword) await user.type(current(), currentPassword);
  if (newPassword) await user.type(next(), newPassword);
  if (confirmPassword) await user.type(confirm(), confirmPassword);
  await user.click(submit());
};

beforeEach(() => {
  action.changePassword.mockReset();
  action.changePassword.mockResolvedValue(null);
});

describe("ChangePasswordForm – markup", () => {
  it("has three empty password fields with the right autofill hints and limits", () => {
    render(<ChangePasswordForm email={EMAIL} />);

    expect(current()).toHaveAttribute("type", "password");
    expect(current()).toHaveAttribute("name", "currentPassword");
    expect(current()).toHaveAttribute("autocomplete", "current-password");
    expect(current()).toBeRequired();
    expect(current()).toHaveValue("");

    expect(next()).toHaveAttribute("type", "password");
    expect(next()).toHaveAttribute("name", "newPassword");
    expect(next()).toHaveAttribute("autocomplete", "new-password");
    expect(next()).toBeRequired();
    expect(next()).toHaveAttribute("minlength", String(PASSWORD_MIN_LENGTH));
    expect(next()).toHaveAttribute("maxlength", String(PASSWORD_MAX_LENGTH));
    expect(next()).toHaveAccessibleDescription(
      new RegExp(`At least ${PASSWORD_MIN_LENGTH} characters`),
    );

    expect(confirm()).toHaveAttribute("type", "password");
    expect(confirm()).toHaveAttribute("name", "confirmPassword");
    expect(confirm()).toHaveAttribute("autocomplete", "new-password");
    expect(confirm()).toBeRequired();

    expect(submit()).toHaveAttribute("type", "submit");
    expect(submit()).toBeEnabled();
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
    expect(screen.queryByRole("status")).not.toBeInTheDocument();
  });

  it("exposes the account's email to password managers as a hidden, unsubmitted username", () => {
    const { container } = render(<ChangePasswordForm email={EMAIL} />);

    const username = container.querySelector('input[autocomplete="username"]');
    expect(username).not.toBeNull();
    expect(username).toHaveValue(EMAIL);
    expect(username).toHaveAttribute("hidden");
    expect(username).not.toHaveAttribute("name");
    expect(username).not.toBeVisible();
  });

  it("omits the username helper when the account has no email", () => {
    const { container } = render(<ChangePasswordForm email={null} />);

    expect(container.querySelector('input[autocomplete="username"]')).toBeNull();
  });

  it("is a labelled form inside the password card", () => {
    render(<ChangePasswordForm email={EMAIL} />);

    const form = screen.getByRole("form", { name: "Password" });
    expect(form.closest("[data-settings-section='password']")).not.toBeNull();
    expect(
      within(form).getByRole("button", { name: CHANGE_PASSWORD_LABEL }),
    ).toBeInTheDocument();
  });
});

describe("ChangePasswordForm – submission", () => {
  it("submits exactly the three password fields to the action", async () => {
    const user = userEvent.setup();
    render(<ChangePasswordForm email={EMAIL} />);

    await fillAndSubmit(user);

    await waitFor(() => expect(action.changePassword).toHaveBeenCalledTimes(1));
    const [prev, formData] = action.changePassword.mock.calls[0];
    expect(prev).toBeNull();
    expect(formData.get("currentPassword")).toBe(CURRENT);
    expect(formData.get("newPassword")).toBe(NEXT);
    expect(formData.get("confirmPassword")).toBe(NEXT);
    expect([...formData.keys()].sort()).toEqual([
      "confirmPassword",
      "currentPassword",
      "newPassword",
    ]);
  });

  it("lets the browser's required check stop an empty field before the action runs", async () => {
    // (`minlength` is enforced by real browsers too, but jsdom does not implement
    // it; the length rule is covered server-side in change-password.test.ts.)
    const user = userEvent.setup();
    render(<ChangePasswordForm email={EMAIL} />);

    await fillAndSubmit(user, { currentPassword: "" });

    expect(current()).toBeInvalid();
    expect(action.changePassword).not.toHaveBeenCalled();
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
  });

  it("shows a pending state and blocks double submission while the action runs", async () => {
    const user = userEvent.setup();
    let finish!: (value: ChangePasswordActionResult) => void;
    action.changePassword.mockReturnValue(
      new Promise<ChangePasswordActionResult>((resolve) => (finish = resolve)),
    );
    render(<ChangePasswordForm email={EMAIL} />);

    await fillAndSubmit(user);

    const pendingButton = await screen.findByRole("button", {
      name: CHANGE_PASSWORD_PENDING_LABEL,
    });
    expect(pendingButton).toBeDisabled();
    expect(pendingButton).toHaveAttribute("aria-busy", "true");
    expect(screen.getByRole("form", { name: "Password" })).toHaveAttribute(
      "aria-busy",
      "true",
    );

    await user.click(pendingButton);
    expect(action.changePassword).toHaveBeenCalledTimes(1);

    finish(CHANGED);
    await screen.findByRole("status");
    expect(screen.getByRole("form", { name: "Password" })).toHaveAttribute(
      "aria-busy",
      "false",
    );
    expect(submit()).toBeEnabled();
  });
});

describe("ChangePasswordForm – success", () => {
  it("confirms in a live region and clears every password field", async () => {
    const user = userEvent.setup();
    action.changePassword.mockResolvedValue(CHANGED);
    render(<ChangePasswordForm email={EMAIL} />);

    await fillAndSubmit(user);

    const status = await screen.findByRole("status");
    expect(status).toHaveTextContent(PASSWORD_CHANGED_MESSAGE);
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();

    expect(current()).toHaveValue("");
    expect(next()).toHaveValue("");
    expect(confirm()).toHaveValue("");
    for (const field of [current(), next(), confirm()]) {
      expect(field).not.toHaveAttribute("aria-invalid");
    }
  });

  it("says other devices were signed out only when they actually were", async () => {
    const user = userEvent.setup();
    action.changePassword
      .mockResolvedValueOnce(CHANGED)
      .mockResolvedValueOnce(CHANGED_OTHERS_KEPT);
    render(<ChangePasswordForm email={EMAIL} />);

    await fillAndSubmit(user);
    expect(await screen.findByRole("status")).toHaveTextContent(
      OTHER_SESSIONS_SIGNED_OUT_MESSAGE,
    );

    await fillAndSubmit(user);
    await waitFor(() =>
      expect(screen.getByRole("status")).toHaveTextContent(
        OTHER_SESSIONS_NOT_SIGNED_OUT_MESSAGE,
      ),
    );
    expect(screen.getByRole("status")).toHaveTextContent(PASSWORD_CHANGED_MESSAGE);
    expect(screen.getByRole("status")).not.toHaveTextContent(
      OTHER_SESSIONS_SIGNED_OUT_MESSAGE,
    );
    // The fallback points at the explicit control.
    expect(screen.getByRole("status")).toHaveTextContent(/Sign out other sessions/);
  });

  it("REGRESSION: states what revocation cannot do — tokens already issued live until they expire", async () => {
    const user = userEvent.setup();
    action.changePassword.mockResolvedValue(CHANGED);
    render(<ChangePasswordForm email={EMAIL} accessTokenLifetimeSeconds={3600} />);

    await fillAndSubmit(user);

    const status = await screen.findByRole("status");
    expect(status).toHaveTextContent(/can no longer use this app or renew their sign-in/);
    expect(status).toHaveTextContent(
      /can still be used directly with our backend until it expires — at most 60 minutes/,
    );
    // Nothing suggests instant, total revocation.
    expect(status).not.toHaveTextContent(/immediately|everywhere|all access/i);
  });

  it("keeps the caveat, without a number, when the lifetime is unknown", async () => {
    const user = userEvent.setup();
    action.changePassword.mockResolvedValue(CHANGED);
    render(<ChangePasswordForm email={EMAIL} />);

    await fillAndSubmit(user);

    expect(await screen.findByRole("status")).toHaveTextContent(/until it expires\.$/);
  });

  it("never leaves a password in the DOM after the attempt", async () => {
    const user = userEvent.setup();
    action.changePassword.mockResolvedValue(CHANGED);
    const { container } = render(<ChangePasswordForm email={EMAIL} />);

    await fillAndSubmit(user);
    await screen.findByRole("status");

    expect(container.innerHTML).not.toContain(CURRENT);
    expect(container.innerHTML).not.toContain(NEXT);
  });
});

describe("ChangePasswordForm – error states", () => {
  it("pins a wrong current password to its field and clears all fields", async () => {
    const user = userEvent.setup();
    action.changePassword.mockResolvedValue(WRONG_CURRENT);
    render(<ChangePasswordForm email={EMAIL} />);

    await fillAndSubmit(user);

    const alert = await screen.findByRole("alert");
    expect(alert).toHaveTextContent(WRONG_CURRENT.error);
    expect(current()).toHaveAttribute("aria-invalid", "true");
    expect(current()).toHaveAttribute("aria-describedby", alert.id);
    expect(current()).toHaveAccessibleDescription(WRONG_CURRENT.error);
    expect(next()).not.toHaveAttribute("aria-invalid");
    expect(confirm()).not.toHaveAttribute("aria-invalid");

    // Passwords are never echoed: the user types again.
    expect(current()).toHaveValue("");
    expect(next()).toHaveValue("");
    expect(confirm()).toHaveValue("");
    expect(screen.queryByRole("status")).not.toBeInTheDocument();
  });

  it("pins a refused new password to its field, keeping the policy hint in its description", async () => {
    const user = userEvent.setup();
    action.changePassword.mockResolvedValue(BREACHED);
    render(<ChangePasswordForm email={EMAIL} />);

    await fillAndSubmit(user);

    const alert = await screen.findByRole("alert");
    expect(next()).toHaveAttribute("aria-invalid", "true");
    expect(next().getAttribute("aria-describedby")!.split(" ")).toContain(alert.id);
    expect(next()).toHaveAccessibleDescription(
      new RegExp(`At least ${PASSWORD_MIN_LENGTH}`),
    );
    expect(next()).toHaveAccessibleDescription(/data breach/);
    expect(current()).not.toHaveAttribute("aria-invalid");
  });

  it("pins a mismatch to the confirmation field", async () => {
    const user = userEvent.setup();
    action.changePassword.mockResolvedValue(MISMATCH);
    render(<ChangePasswordForm email={EMAIL} />);

    await fillAndSubmit(user, { confirmPassword: `${NEXT}x` });

    const alert = await screen.findByRole("alert");
    expect(confirm()).toHaveAttribute("aria-invalid", "true");
    expect(confirm()).toHaveAttribute("aria-describedby", alert.id);
    expect(next()).not.toHaveAttribute("aria-invalid");
  });

  it("shows an error that is not about one field without flagging any input", async () => {
    const user = userEvent.setup();
    action.changePassword.mockResolvedValue(UNFIELDED);
    render(<ChangePasswordForm email={EMAIL} />);

    await fillAndSubmit(user);

    const alert = await screen.findByRole("alert");
    expect(alert).toHaveTextContent(/couldn't change your password/);
    for (const field of [current(), next(), confirm()]) {
      expect(field).not.toHaveAttribute("aria-invalid");
    }
    expect(current()).not.toHaveAttribute("aria-describedby");
    expect(submit()).toBeEnabled();
  });

  it("replaces an error with the confirmation once a retry succeeds, and vice versa", async () => {
    const user = userEvent.setup();
    action.changePassword
      .mockResolvedValueOnce(WRONG_CURRENT)
      .mockResolvedValueOnce(CHANGED)
      .mockResolvedValueOnce(UNFIELDED);
    render(<ChangePasswordForm email={EMAIL} />);

    await fillAndSubmit(user);
    await screen.findByRole("alert");

    await fillAndSubmit(user);
    await screen.findByRole("status");
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
    expect(current()).not.toHaveAttribute("aria-invalid");

    await fillAndSubmit(user);
    await screen.findByRole("alert");
    expect(screen.queryByRole("status")).not.toBeInTheDocument();
  });
});
