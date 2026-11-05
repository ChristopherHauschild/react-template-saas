import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";

import type { SignUpActionResult } from "../actions/sign-up";

import { SignUpForm } from "./sign-up-form";

// The form submits the server action; replace it with a controllable fake that
// keeps the `(prevState, formData)` signature React uses with useActionState.
const action = vi.hoisted(() => ({
  signUp:
    vi.fn<
      (prev: SignUpActionResult, formData: FormData) => Promise<SignUpActionResult>
    >(),
}));
vi.mock("../actions/sign-up", () => ({ signUp: action.signUp }));

// The confirmation panel embeds the resend form; its action is covered by
// resend-confirmation.test.ts and resend-confirmation-form.test.tsx.
const resend = vi.hoisted(() => ({ resendConfirmation: vi.fn() }));
vi.mock("../actions/resend-confirmation", () => resend);

const EMAIL = "jane@example.com";
const PASSWORD = "hunter2222";

const FIELD_ERROR: SignUpActionResult = {
  status: "error",
  error: "Passwords do not match.",
  field: "confirmPassword",
  email: EMAIL,
};

const UNFIELDED_ERROR: SignUpActionResult = {
  status: "error",
  error: "Choose a stronger password.",
  email: EMAIL,
};

const CONFIRMATION_REQUIRED: SignUpActionResult = {
  status: "confirmation_required",
  email: EMAIL,
};

const fillAndSubmit = async (
  user: ReturnType<typeof userEvent.setup>,
  { email = EMAIL, password = PASSWORD, confirmPassword = PASSWORD } = {},
) => {
  await user.type(screen.getByLabelText("Email"), email);
  await user.type(screen.getByLabelText("Password"), password);
  await user.type(screen.getByLabelText("Confirm password"), confirmPassword);
  await user.click(screen.getByRole("button", { name: "Create account" }));
};

beforeEach(() => {
  action.signUp.mockReset();
  action.signUp.mockResolvedValue(null);
});

describe("SignUpForm – markup", () => {
  it("associates each label with its input and enables browser autofill", () => {
    render(<SignUpForm />);

    const email = screen.getByLabelText("Email");
    const password = screen.getByLabelText("Password");
    const confirmPassword = screen.getByLabelText("Confirm password");

    expect(email).toHaveAttribute("type", "email");
    expect(email).toHaveAttribute("name", "email");
    expect(email).toHaveAttribute("autocomplete", "email");
    expect(email).toBeRequired();

    expect(password).toHaveAttribute("type", "password");
    expect(password).toHaveAttribute("name", "password");
    expect(password).toHaveAttribute("autocomplete", "new-password");
    expect(password).toBeRequired();
    expect(password).toHaveAttribute("minlength", "8");

    expect(confirmPassword).toHaveAttribute("type", "password");
    expect(confirmPassword).toHaveAttribute("name", "confirmPassword");
    expect(confirmPassword).toHaveAttribute("autocomplete", "new-password");
    expect(confirmPassword).toBeRequired();
    expect(confirmPassword).toHaveAttribute("minlength", "8");

    expect(screen.getByRole("button", { name: "Create account" })).toHaveAttribute(
      "type",
      "submit",
    );
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
  });

  it("links to the login page for people who already have an account", () => {
    render(<SignUpForm />);

    expect(screen.getByRole("link", { name: "Sign in" })).toHaveAttribute(
      "href",
      "/login",
    );
  });
});

describe("SignUpForm – submission", () => {
  it("submits email, password and the confirmation to the action", async () => {
    const user = userEvent.setup();
    render(<SignUpForm />);

    await fillAndSubmit(user, {
      email: EMAIL,
      password: PASSWORD,
      confirmPassword: PASSWORD,
    });

    await waitFor(() => expect(action.signUp).toHaveBeenCalledTimes(1));
    const [prev, formData] = action.signUp.mock.calls[0];
    expect(prev).toBeNull();
    expect(formData).toBeInstanceOf(FormData);
    expect(formData.get("email")).toBe(EMAIL);
    expect(formData.get("password")).toBe(PASSWORD);
    expect(formData.get("confirmPassword")).toBe(PASSWORD);
  });

  it("shows a loading state while submitting and blocks a second submit", async () => {
    let finish!: (value: SignUpActionResult) => void;
    action.signUp.mockReturnValue(new Promise((resolve) => (finish = resolve)));
    const user = userEvent.setup();
    render(<SignUpForm />);

    await fillAndSubmit(user);

    const busy = await screen.findByRole("button", { name: "Creating account…" });
    expect(busy).toBeDisabled();
    expect(busy).toHaveAttribute("aria-busy", "true");

    await user.click(busy); // disabled: must not submit again
    await user.keyboard("{Enter}"); // neither may an implicit submit from a field
    expect(action.signUp).toHaveBeenCalledTimes(1);

    finish(null);
    const idle = await screen.findByRole("button", { name: "Create account" });
    expect(idle).toBeEnabled();
  });
});

describe("SignUpForm – validation / Supabase failures", () => {
  it("shows the error message linked to the offending field only", async () => {
    action.signUp.mockResolvedValue(FIELD_ERROR);
    const user = userEvent.setup();
    render(<SignUpForm />);

    await fillAndSubmit(user);

    const alert = await screen.findByRole("alert");
    expect(alert).toHaveTextContent(FIELD_ERROR.error as string);

    const confirmPassword = screen.getByLabelText("Confirm password");
    expect(confirmPassword).toHaveAttribute("aria-invalid", "true");
    expect(confirmPassword).toHaveAccessibleDescription(FIELD_ERROR.error as string);

    // Unrelated fields are not flagged.
    expect(screen.getByLabelText("Email")).not.toHaveAttribute("aria-invalid");
    expect(screen.getByLabelText("Password")).not.toHaveAttribute("aria-invalid");
  });

  it("still announces an error that isn't tied to one field (e.g. a weak-password response from Supabase)", async () => {
    action.signUp.mockResolvedValue(UNFIELDED_ERROR);
    const user = userEvent.setup();
    render(<SignUpForm />);

    await fillAndSubmit(user);

    expect(await screen.findByRole("alert")).toHaveTextContent(
      UNFIELDED_ERROR.error as string,
    );
    for (const label of ["Email", "Password", "Confirm password"]) {
      expect(screen.getByLabelText(label)).not.toHaveAttribute("aria-invalid");
    }
  });

  it("keeps the email but clears both password fields", async () => {
    action.signUp.mockResolvedValue(FIELD_ERROR);
    const user = userEvent.setup();
    render(<SignUpForm />);

    await fillAndSubmit(user);
    await screen.findByRole("alert");

    expect(screen.getByLabelText("Email")).toHaveValue(EMAIL);
    expect(screen.getByLabelText("Password")).toHaveValue("");
    expect(screen.getByLabelText("Confirm password")).toHaveValue("");
  });

  it("can be retried; the previous result is passed to the action and the alert clears", async () => {
    action.signUp.mockResolvedValueOnce(FIELD_ERROR);
    const user = userEvent.setup();
    render(<SignUpForm />);

    await fillAndSubmit(user);
    await screen.findByRole("alert");

    await user.type(screen.getByLabelText("Password"), PASSWORD);
    await user.type(screen.getByLabelText("Confirm password"), PASSWORD);
    await user.click(screen.getByRole("button", { name: "Create account" }));

    await waitFor(() => expect(action.signUp).toHaveBeenCalledTimes(2));
    expect(action.signUp.mock.calls[1][0]).toEqual(FIELD_ERROR);

    await waitFor(() => expect(screen.queryByRole("alert")).not.toBeInTheDocument());
    expect(screen.getByLabelText("Confirm password")).not.toHaveAttribute("aria-invalid");
  });
});

describe("SignUpForm – confirmation required", () => {
  it("replaces the form with a neutral 'check your email' message, without claiming an account was created", async () => {
    action.signUp.mockResolvedValue(CONFIRMATION_REQUIRED);
    const user = userEvent.setup();
    render(<SignUpForm />);

    await fillAndSubmit(user);

    expect(await screen.findByText("Check your email")).toBeInTheDocument();
    expect(screen.getByText(EMAIL, { exact: false })).toBeInTheDocument();

    // The form is gone: no more inputs, no way to resubmit from this screen.
    expect(screen.queryByLabelText("Email")).not.toBeInTheDocument();
    expect(screen.queryByLabelText("Password")).not.toBeInTheDocument();
    expect(
      screen.queryByRole("button", { name: "Create account" }),
    ).not.toBeInTheDocument();

    const body = document.body.textContent ?? "";
    for (const claim of [
      /account (was |has been )?created/i,
      /welcome/i,
      /you('re| are) (all )?set/i,
      /success(fully)?/i,
      /registered/i,
      /\bsent\b/i, // delivery may be suppressed (duplicate, quota): never promise it
      /on its way/i,
    ]) {
      expect(body).not.toMatch(claim);
    }
  });

  it("offers a way back to sign in and a resend button for the same address", async () => {
    action.signUp.mockResolvedValue(CONFIRMATION_REQUIRED);
    const user = userEvent.setup();
    render(<SignUpForm />);

    await fillAndSubmit(user);
    await screen.findByText("Check your email");

    expect(screen.getByRole("link", { name: "Sign in" })).toHaveAttribute(
      "href",
      "/login",
    );

    // Embedded resend form: the address is carried as a hidden field, not retyped.
    expect(
      screen.getByRole("button", { name: "Request a new confirmation link" }),
    ).toBeInTheDocument();
    expect(document.querySelector('input[type="hidden"][name="email"]')).toHaveValue(
      EMAIL,
    );
    expect(screen.queryByLabelText("Email")).not.toBeInTheDocument();
  });

  it("'Use a different email' resets the form AND the action result (a link to /signup would not: same page, state kept)", async () => {
    action.signUp.mockResolvedValueOnce(CONFIRMATION_REQUIRED);
    const user = userEvent.setup();
    render(<SignUpForm />);

    await fillAndSubmit(user);
    await screen.findByText("Check your email");

    await user.click(screen.getByRole("button", { name: "Use a different email" }));

    // Back to a pristine form: no panel, empty fields, no alert.
    expect(screen.queryByText("Check your email")).not.toBeInTheDocument();
    expect(screen.getByLabelText("Email")).toHaveValue("");
    expect(screen.getByLabelText("Password")).toHaveValue("");
    expect(screen.getByLabelText("Confirm password")).toHaveValue("");
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();

    // The action state was discarded too: the next submission starts from null,
    // not from the previous confirmation_required result.
    await fillAndSubmit(user, { email: "other@example.com" });
    await waitFor(() => expect(action.signUp).toHaveBeenCalledTimes(2));
    const [prev, formData] = action.signUp.mock.calls[1];
    expect(prev).toBeNull();
    expect(formData.get("email")).toBe("other@example.com");
  });

  it("'Use a different email' is a button, not a link back to /signup", async () => {
    action.signUp.mockResolvedValue(CONFIRMATION_REQUIRED);
    const user = userEvent.setup();
    render(<SignUpForm />);

    await fillAndSubmit(user);
    await screen.findByText("Check your email");

    expect(screen.getByRole("button", { name: "Use a different email" })).toHaveAttribute(
      "type",
      "button",
    );
    expect(
      screen.queryByRole("link", { name: /different email/i }),
    ).not.toBeInTheDocument();
  });

  it("shows the identical message whether Supabase reports a fresh sign-up or an existing account (no enumeration)", async () => {
    // The action folds both outcomes into the same `confirmation_required` result
    // (see sign-up.ts); the UI only needs to render it once to be safe either way.
    action.signUp.mockResolvedValue(CONFIRMATION_REQUIRED);
    const user = userEvent.setup();
    render(<SignUpForm />);

    await fillAndSubmit(user);

    expect(
      await screen.findByText(/can be used to sign up, a confirmation link may arrive/i),
    ).toBeInTheDocument();
  });
});
