import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";

import type { SignInActionResult } from "../actions/sign-in";

import { SignInForm } from "./sign-in-form";

// The form submits the server action; replace it with a controllable fake that
// keeps the `(prevState, formData)` signature React uses with useActionState.
const action = vi.hoisted(() => ({
  signIn:
    vi.fn<
      (prev: SignInActionResult, formData: FormData) => Promise<SignInActionResult>
    >(),
}));
vi.mock("../actions/sign-in", () => ({ signIn: action.signIn }));

// The unconfirmed-email state embeds the resend form; its action is covered by
// resend-confirmation.test.ts and resend-confirmation-form.test.tsx.
const resend = vi.hoisted(() => ({ resendConfirmation: vi.fn() }));
vi.mock("../actions/resend-confirmation", () => resend);

const FAILED: SignInActionResult = {
  error: "Invalid email or password.",
  email: "jane@example.com",
};

const UNCONFIRMED: SignInActionResult = {
  error: "Please confirm your email address before signing in.",
  email: "jane@example.com",
  needsConfirmation: true,
};

const RESEND = { name: "Request a new confirmation link" };

const fillAndSubmit = async (
  user: ReturnType<typeof userEvent.setup>,
  email = "jane@example.com",
  password = "hunter22",
) => {
  await user.type(screen.getByLabelText("Email"), email);
  await user.type(screen.getByLabelText("Password"), password);
  await user.click(screen.getByRole("button", { name: "Sign in" }));
};

beforeEach(() => {
  action.signIn.mockReset();
  action.signIn.mockResolvedValue(null);
  resend.resendConfirmation.mockReset();
  resend.resendConfirmation.mockResolvedValue({
    status: "sent",
    email: "jane@example.com",
  });
});

describe("SignInForm – markup", () => {
  it("associates each label with its input and enables browser autofill", () => {
    render(<SignInForm />);

    const email = screen.getByLabelText("Email");
    const password = screen.getByLabelText("Password");

    expect(email).toHaveAttribute("type", "email");
    expect(email).toHaveAttribute("name", "email");
    expect(email).toHaveAttribute("autocomplete", "email");
    expect(email).toBeRequired();

    expect(password).toHaveAttribute("type", "password");
    expect(password).toHaveAttribute("name", "password");
    expect(password).toHaveAttribute("autocomplete", "current-password");
    expect(password).toBeRequired();

    expect(screen.getByRole("button", { name: "Sign in" })).toHaveAttribute(
      "type",
      "submit",
    );
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
  });

  it("links to the sign-up page for people without an account", () => {
    render(<SignInForm />);

    expect(screen.getByRole("link", { name: "Sign up" })).toHaveAttribute(
      "href",
      "/signup",
    );
  });
});

describe("SignInForm – submission", () => {
  it("submits the typed credentials to the action", async () => {
    const user = userEvent.setup();
    render(<SignInForm />);

    await fillAndSubmit(user, "jane@example.com", "hunter22");

    await waitFor(() => expect(action.signIn).toHaveBeenCalledTimes(1));
    const [prev, formData] = action.signIn.mock.calls[0];
    expect(prev).toBeNull();
    expect(formData).toBeInstanceOf(FormData);
    expect(formData.get("email")).toBe("jane@example.com");
    expect(formData.get("password")).toBe("hunter22");
  });

  it("shows a loading state while signing in and blocks a second submit", async () => {
    let finish!: (value: SignInActionResult) => void;
    action.signIn.mockReturnValue(new Promise((resolve) => (finish = resolve)));
    const user = userEvent.setup();
    render(<SignInForm />);

    await fillAndSubmit(user);

    const busy = await screen.findByRole("button", { name: "Signing in…" });
    expect(busy).toBeDisabled();
    expect(busy).toHaveAttribute("aria-busy", "true");

    await user.click(busy); // disabled: must not submit again
    await user.keyboard("{Enter}"); // neither may an implicit submit from a field
    expect(action.signIn).toHaveBeenCalledTimes(1);

    finish(null);
    const idle = await screen.findByRole("button", { name: "Sign in" });
    expect(idle).toBeEnabled();
  });
});

describe("SignInForm – failure", () => {
  it("shows the action's message as an alert, linked to the fields", async () => {
    action.signIn.mockResolvedValue(FAILED);
    const user = userEvent.setup();
    render(<SignInForm />);

    await fillAndSubmit(user);

    const alert = await screen.findByRole("alert");
    expect(alert).toHaveTextContent(FAILED.error);

    const email = screen.getByLabelText("Email");
    const password = screen.getByLabelText("Password");
    expect(email).toHaveAttribute("aria-invalid", "true");
    expect(password).toHaveAttribute("aria-invalid", "true");
    expect(email).toHaveAccessibleDescription(FAILED.error);
    expect(password).toHaveAccessibleDescription(FAILED.error);
  });

  it("keeps the email but clears the password", async () => {
    action.signIn.mockResolvedValue(FAILED);
    const user = userEvent.setup();
    render(<SignInForm />);

    await fillAndSubmit(user, "jane@example.com", "hunter22");
    await screen.findByRole("alert");

    expect(screen.getByLabelText("Email")).toHaveValue("jane@example.com");
    expect(screen.getByLabelText("Password")).toHaveValue("");
  });

  it("can be retried; the previous result is passed to the action and the alert clears", async () => {
    action.signIn.mockResolvedValueOnce(FAILED);
    const user = userEvent.setup();
    render(<SignInForm />);

    await fillAndSubmit(user);
    await screen.findByRole("alert");

    // Email is already kept; only the password needs retyping. (`clear` first:
    // user-event tracks its own value and does not see the form reset React
    // performed — the DOM value is already "", as the previous test asserts.)
    await user.clear(screen.getByLabelText("Password"));
    await user.type(screen.getByLabelText("Password"), "correct-horse");
    await user.click(screen.getByRole("button", { name: "Sign in" }));

    await waitFor(() => expect(action.signIn).toHaveBeenCalledTimes(2));
    const [prev, formData] = action.signIn.mock.calls[1];
    expect(prev).toEqual(FAILED);
    expect(formData.get("email")).toBe("jane@example.com");
    expect(formData.get("password")).toBe("correct-horse");

    await waitFor(() => expect(screen.queryByRole("alert")).not.toBeInTheDocument());
    expect(screen.getByLabelText("Email")).not.toHaveAttribute("aria-invalid");
  });

  it("keeps the alert and the disabled state consistent across rapid resubmits", async () => {
    const results: SignInActionResult[] = [
      { error: "Invalid email or password.", email: "jane@example.com" },
      {
        error: "Too many sign-in attempts. Please wait a moment and try again.",
        email: "jane@example.com",
      },
    ];
    action.signIn.mockImplementation(async () => results.shift() ?? null);
    const user = userEvent.setup();
    render(<SignInForm />);

    await fillAndSubmit(user);
    expect(await screen.findByRole("alert")).toHaveTextContent(
      "Invalid email or password.",
    );

    await user.clear(screen.getByLabelText("Password"));
    await user.type(screen.getByLabelText("Password"), "again");
    await user.click(screen.getByRole("button", { name: "Sign in" }));
    expect(await screen.findByRole("alert")).toHaveTextContent(
      "Too many sign-in attempts",
    );

    expect(screen.getAllByRole("alert")).toHaveLength(1);
    expect(screen.getByRole("button", { name: "Sign in" })).toBeEnabled();
  });
});

describe("SignInForm – recovery after an unexpected server failure", () => {
  it("shows the temporary-problem message, stays usable, and a retry can succeed", async () => {
    const unavailable: SignInActionResult = {
      error: "We couldn't sign you in right now. Please try again in a moment.",
      email: "jane@example.com",
    };
    // The action contains exceptions and returns this message (see sign-in.test.ts);
    // on retry it succeeds (redirect → the action never resolves with state).
    action.signIn.mockResolvedValueOnce(unavailable).mockResolvedValueOnce(null);
    const user = userEvent.setup();
    render(<SignInForm />);

    await fillAndSubmit(user);

    expect(await screen.findByRole("alert")).toHaveTextContent(/couldn't sign you in/);
    expect(screen.getByLabelText("Email")).toHaveValue("jane@example.com");
    expect(screen.getByRole("button", { name: "Sign in" })).toBeEnabled();

    await user.clear(screen.getByLabelText("Password"));
    await user.type(screen.getByLabelText("Password"), "hunter22");
    await user.click(screen.getByRole("button", { name: "Sign in" }));

    await waitFor(() => expect(action.signIn).toHaveBeenCalledTimes(2));
    expect(action.signIn.mock.calls[1][0]).toEqual(unavailable);
    await waitFor(() => expect(screen.queryByRole("alert")).not.toBeInTheDocument());
    expect(screen.getByRole("button", { name: "Sign in" })).toBeEnabled();
  });
});

describe("SignInForm – unconfirmed email", () => {
  it("offers a new confirmation link for the submitted address, without leaving the page", async () => {
    action.signIn.mockResolvedValue(UNCONFIRMED);
    const user = userEvent.setup();
    render(<SignInForm />);

    await fillAndSubmit(user, "  jane@example.com ", "hunter22");

    expect(await screen.findByRole("alert")).toHaveTextContent(/confirm your email/);
    expect(screen.getByRole("button", RESEND)).toBeInTheDocument();
    expect(screen.getByText(/Lost the confirmation email for/)).toHaveTextContent(
      "jane@example.com",
    );

    // The resend form carries the address the action echoed (trimmed), not a
    // second field to retype; the sign-in email field keeps it too.
    expect(document.querySelector('input[type="hidden"][name="email"]')).toHaveValue(
      "jane@example.com",
    );
    expect(screen.getByLabelText("Email")).toHaveValue("jane@example.com");
    expect(screen.queryByRole("link", { name: /sign up/i })).toHaveAttribute(
      "href",
      "/signup",
    ); // still there, just no longer the only way
  });

  it("renders the resend form as a sibling of the sign-in form, never nested inside it", async () => {
    action.signIn.mockResolvedValue(UNCONFIRMED);
    const user = userEvent.setup();
    render(<SignInForm />);

    await fillAndSubmit(user);
    await screen.findByRole("button", RESEND);

    expect(document.querySelectorAll("form")).toHaveLength(2);
    expect(document.querySelectorAll("form form")).toHaveLength(0);
  });

  it("requesting a link calls the resend action with that address and does not re-submit the sign-in", async () => {
    action.signIn.mockResolvedValue(UNCONFIRMED);
    const user = userEvent.setup();
    render(<SignInForm />);

    await fillAndSubmit(user);
    await user.click(await screen.findByRole("button", RESEND));

    await waitFor(() => expect(resend.resendConfirmation).toHaveBeenCalledTimes(1));
    expect(resend.resendConfirmation.mock.calls[0][1].get("email")).toBe(
      "jane@example.com",
    );
    expect(action.signIn).toHaveBeenCalledTimes(1);

    // Neutral acknowledgement, and the sign-in alert is still there.
    expect(await screen.findByRole("status")).toHaveTextContent(/^Request received\./);
    expect(screen.getByRole("alert")).toHaveTextContent(/confirm your email/);
  });

  it("is not offered for other failures", async () => {
    action.signIn.mockResolvedValue(FAILED);
    const user = userEvent.setup();
    render(<SignInForm />);

    await fillAndSubmit(user);
    await screen.findByRole("alert");

    expect(screen.queryByRole("button", RESEND)).not.toBeInTheDocument();
    expect(document.querySelectorAll("form")).toHaveLength(1);
  });

  it("disappears once a later sign-in attempt gets a different answer, and the successful retry still redirects (action never resolves)", async () => {
    action.signIn.mockResolvedValueOnce(UNCONFIRMED).mockResolvedValueOnce(null);
    const user = userEvent.setup();
    render(<SignInForm />);

    await fillAndSubmit(user);
    await screen.findByRole("button", RESEND);

    await user.clear(screen.getByLabelText("Password"));
    await user.type(screen.getByLabelText("Password"), "hunter22");
    await user.click(screen.getByRole("button", { name: "Sign in" }));

    await waitFor(() => expect(action.signIn).toHaveBeenCalledTimes(2));
    expect(action.signIn.mock.calls[1][0]).toEqual(UNCONFIRMED);
    await waitFor(() =>
      expect(screen.queryByRole("button", RESEND)).not.toBeInTheDocument(),
    );
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
  });
});
