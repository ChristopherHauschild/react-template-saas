/**
 * The three settings cards side by side, the way the settings page renders them:
 * each owns its action state, and what one does must not leak into another —
 * across errors, session loss, repeated submissions and a "reload" (fresh mount
 * with the server's latest values).
 */
import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";

import type { ChangeEmailActionResult } from "../actions/change-email";
import type { ChangePasswordActionResult } from "../actions/change-password";
import type { UpdateProfileActionResult } from "../actions/update-profile";
import { CHANGE_EMAIL_ERRORS } from "../services/change-email-errors";
import { CHANGE_PASSWORD_ERRORS } from "../services/change-password-errors";
import type { Profile } from "../services/profile";
import { UPDATE_PROFILE_ERRORS } from "../services/update-profile-errors";

import { ChangeEmailForm } from "./change-email-form";
import { ChangePasswordForm } from "./change-password-form";
import { ProfileForm } from "./profile-form";
import { SecurityCard } from "./security-card";

const actions = vi.hoisted(() => ({
  updateProfile:
    vi.fn<
      (p: UpdateProfileActionResult, f: FormData) => Promise<UpdateProfileActionResult>
    >(),
  changePassword:
    vi.fn<
      (p: ChangePasswordActionResult, f: FormData) => Promise<ChangePasswordActionResult>
    >(),
  changeEmail:
    vi.fn<
      (p: ChangeEmailActionResult, f: FormData) => Promise<ChangeEmailActionResult>
    >(),
}));
vi.mock("../actions/update-profile", () => ({ updateProfile: actions.updateProfile }));
vi.mock("../actions/change-password", () => ({ changePassword: actions.changePassword }));
vi.mock("../actions/change-email", () => ({ changeEmail: actions.changeEmail }));
const sessions = vi.hoisted(() => ({ signOutOtherSessions: vi.fn() }));
vi.mock("../actions/sign-out-other-sessions", () => sessions);

const JANE: Profile = {
  fullName: "Jane Doe",
  email: "jane@example.com",
  pendingEmail: null,
  pendingEmailSentAt: null,
};

function SettingsCards({ profile }: { profile: Profile }) {
  return (
    <>
      <ProfileForm fullName={profile.fullName} />
      <ChangeEmailForm profile={profile} />
      <ChangePasswordForm email={profile.email} accessTokenLifetimeSeconds={3600} />
      <SecurityCard
        security={{
          email: profile.email,
          emailConfirmedAt: null,
          lastSignInAt: null,
          createdAt: null,
          signInMethods: ["Email and password"],
          pendingEmail: profile.pendingEmail,
        }}
        accessTokenLifetimeSeconds={3600}
      />
    </>
  );
}

const card = (name: "Profile" | "Email" | "Password" | "Security") =>
  screen
    .getByRole("heading", { level: 3, name })
    .closest<HTMLElement>("[data-settings-section]")!;

const saveProfile = async (user: ReturnType<typeof userEvent.setup>, name: string) => {
  const profile = within(card("Profile"));
  await user.clear(profile.getByLabelText("Full name"));
  await user.type(profile.getByLabelText("Full name"), name);
  await user.click(profile.getByRole("button", { name: "Save changes" }));
};

const changePassword = async (user: ReturnType<typeof userEvent.setup>) => {
  const password = within(card("Password"));
  await user.type(password.getByLabelText("Current password"), "old-password-1");
  await user.type(password.getByLabelText("New password"), "new-password-22");
  await user.type(password.getByLabelText("Confirm new password"), "new-password-22");
  await user.click(password.getByRole("button", { name: "Change password" }));
};

const requestEmail = async (user: ReturnType<typeof userEvent.setup>, email: string) => {
  const emailCard = within(card("Email"));
  await user.type(emailCard.getByRole("textbox", { name: /address/i }), email);
  await user.click(emailCard.getByRole("button", { name: "Send confirmation link" }));
};

beforeEach(() => {
  for (const action of Object.values(actions)) action.mockReset();
  sessions.signOutOtherSessions.mockReset();
  sessions.signOutOtherSessions.mockResolvedValue({
    status: "signed_out",
    at: "2026-03-01T10:05:00.000Z",
  });
  actions.updateProfile.mockResolvedValue({ status: "saved", fullName: "Jane Doe" });
  actions.changePassword.mockResolvedValue({
    status: "changed",
    otherSessionsSignedOut: true,
  });
  actions.changeEmail.mockResolvedValue({
    status: "confirmation_sent",
    email: "jane.new@example.com",
  });
});

describe("settings cards – states are independent", () => {
  it("an error in one card never shows in, or disables, another", async () => {
    const user = userEvent.setup();
    actions.changePassword.mockResolvedValue({
      status: "error",
      error: CHANGE_PASSWORD_ERRORS.currentPasswordIncorrect,
      field: "currentPassword",
    });
    render(<SettingsCards profile={JANE} />);

    await changePassword(user);

    const alerts = await screen.findAllByRole("alert");
    expect(alerts).toHaveLength(1);
    expect(card("Password")).toContainElement(alerts[0]);
    expect(within(card("Profile")).queryByRole("alert")).not.toBeInTheDocument();
    expect(within(card("Email")).queryByRole("alert")).not.toBeInTheDocument();
    expect(
      within(card("Profile")).getByRole("button", { name: "Save changes" }),
    ).toBeEnabled();
    expect(
      within(card("Email")).getByRole("button", { name: "Send confirmation link" }),
    ).toBeEnabled();
  });

  it("success in each card is announced in its own live region, and they coexist", async () => {
    const user = userEvent.setup();
    render(<SettingsCards profile={JANE} />);

    await saveProfile(user, "Jane Q. Doe");
    await changePassword(user);
    await requestEmail(user, "jane.new@example.com");

    await waitFor(() => expect(screen.getAllByRole("status")).toHaveLength(3));
    expect(within(card("Profile")).getByRole("status")).toHaveTextContent(
      /profile has been saved/,
    );
    expect(within(card("Password")).getByRole("status")).toHaveTextContent(
      /password has been changed/,
    );
    expect(within(card("Email")).getByRole("status")).toHaveTextContent(
      /Confirmation email sent/,
    );
    // Three separate actions, each called once with its own fields only.
    expect(actions.updateProfile).toHaveBeenCalledTimes(1);
    expect(actions.changePassword).toHaveBeenCalledTimes(1);
    expect(actions.changeEmail).toHaveBeenCalledTimes(1);
    expect([...actions.changeEmail.mock.calls[0][1].keys()]).toEqual(["email"]);
    expect([...actions.updateProfile.mock.calls[0][1].keys()]).toEqual(["fullName"]);
  });

  it("another card can be submitted while one action is in flight; both results land once it settles", async () => {
    // React 19 entangles concurrent async actions: the profile save's result is
    // committed together with the pending password change, and the profile form
    // shows as busy until then. Nothing is lost, nothing is shown out of order.
    const user = userEvent.setup();
    let finish!: (v: ChangePasswordActionResult) => void;
    actions.changePassword.mockReturnValue(
      new Promise<ChangePasswordActionResult>((resolve) => (finish = resolve)),
    );
    render(<SettingsCards profile={JANE} />);

    try {
      await changePassword(user);
      await screen.findByRole("button", { name: "Changing password…" });

      await saveProfile(user, "Jane While Waiting");
      await waitFor(() => expect(actions.updateProfile).toHaveBeenCalledTimes(1));
      expect(actions.updateProfile.mock.calls[0][1].get("fullName")).toBe(
        "Jane While Waiting",
      );
      expect(within(card("Profile")).getByRole("form")).toHaveAttribute(
        "aria-busy",
        "true",
      );
      expect(screen.queryByRole("status")).not.toBeInTheDocument();
    } finally {
      // Always settle the action: an unresolved one would leak into later tests.
      finish({ status: "changed", otherSessionsSignedOut: true });
    }

    await waitFor(() => expect(screen.getAllByRole("status")).toHaveLength(2));
    expect(within(card("Profile")).getByRole("status")).toHaveTextContent(/saved/);
    expect(within(card("Password")).getByRole("status")).toHaveTextContent(/changed/);
    expect(within(card("Profile")).getByRole("form")).toHaveAttribute(
      "aria-busy",
      "false",
    );
  });
});

describe("settings cards – the session expires mid-way", () => {
  it("each card reports an expired session in place, and the others are untouched", async () => {
    const user = userEvent.setup();
    actions.updateProfile.mockResolvedValue({
      status: "error",
      error: UPDATE_PROFILE_ERRORS.sessionExpired,
      fullName: "Jane Q. Doe",
    });
    actions.changeEmail.mockResolvedValue({
      status: "error",
      error: CHANGE_EMAIL_ERRORS.sessionExpired,
      email: "jane.new@example.com",
    });
    render(<SettingsCards profile={JANE} />);

    await saveProfile(user, "Jane Q. Doe");
    await requestEmail(user, "jane.new@example.com");

    await waitFor(() => expect(screen.getAllByRole("alert")).toHaveLength(2));
    expect(within(card("Profile")).getByRole("alert")).toHaveTextContent(
      /session has expired/,
    );
    expect(within(card("Email")).getByRole("alert")).toHaveTextContent(
      /session has expired/,
    );
    // Nothing claims success, and nothing is shown as pending.
    expect(screen.queryByRole("status")).not.toBeInTheDocument();
    expect(card("Email").querySelector("[data-pending-email]")).toBeNull();
    // The typed values survive so the user can retry after signing in again.
    expect(within(card("Profile")).getByLabelText("Full name")).toHaveValue(
      "Jane Q. Doe",
    );
    expect(within(card("Email")).getByRole("textbox", { name: /address/i })).toHaveValue(
      "jane.new@example.com",
    );
  });

  it("an expired session during a password change clears the password fields all the same", async () => {
    const user = userEvent.setup();
    actions.changePassword.mockResolvedValue({
      status: "error",
      error: CHANGE_PASSWORD_ERRORS.sessionExpired,
    });
    render(<SettingsCards profile={JANE} />);

    await changePassword(user);

    await within(card("Password")).findByRole("alert");
    for (const label of ["Current password", "New password", "Confirm new password"]) {
      expect(within(card("Password")).getByLabelText(label)).toHaveValue("");
    }
  });
});

describe("settings cards – password change and 'sign out other sessions' agree", () => {
  it("a password change whose eviction failed points at the Security card, which can retry it", async () => {
    const user = userEvent.setup();
    actions.changePassword.mockResolvedValue({
      status: "changed",
      otherSessionsSignedOut: false,
    });
    render(<SettingsCards profile={JANE} />);

    await changePassword(user);
    expect(await within(card("Password")).findByRole("status")).toHaveTextContent(
      /Use “Sign out other sessions” in the Security section/,
    );

    await user.click(
      within(card("Security")).getByRole("button", { name: "Sign out other sessions" }),
    );

    expect(await within(card("Security")).findByRole("status")).toHaveTextContent(
      /Other sessions were signed out/,
    );
    expect(sessions.signOutOtherSessions).toHaveBeenCalledTimes(1);
  });

  it("both describe the same limit: existing access tokens live until they expire", async () => {
    const user = userEvent.setup();
    render(<SettingsCards profile={JANE} />);

    await changePassword(user);

    const passwordStatus = await within(card("Password")).findByRole("status");
    const securityExplanation = within(card("Security"))
      .getByRole("button", { name: "Sign out other sessions" })
      .getAttribute("aria-describedby")!;
    for (const text of [
      passwordStatus.textContent!,
      document.getElementById(securityExplanation)!.textContent!,
    ]) {
      expect(text).toMatch(/until it expires — at most 60 minutes/);
    }
  });
});

describe("settings cards – repeated submissions", () => {
  it("re-submitting the password form after a success needs the NEW current password", async () => {
    const user = userEvent.setup();
    actions.changePassword
      .mockResolvedValueOnce({ status: "changed", otherSessionsSignedOut: true })
      .mockResolvedValueOnce({
        status: "error",
        error: CHANGE_PASSWORD_ERRORS.currentPasswordIncorrect,
        field: "currentPassword",
      });
    render(<SettingsCards profile={JANE} />);

    await changePassword(user);
    await within(card("Password")).findByRole("status");

    // Same values again (the old password is no longer the current one).
    await changePassword(user);

    const alert = await within(card("Password")).findByRole("alert");
    expect(alert).toHaveTextContent(/current password is incorrect/);
    expect(within(card("Password")).queryByRole("status")).not.toBeInTheDocument();
    expect(within(card("Password")).getByLabelText("Current password")).toHaveAttribute(
      "aria-invalid",
      "true",
    );
  });

  it("saving the same name twice is harmless and keeps the confirmation", async () => {
    const user = userEvent.setup();
    actions.updateProfile.mockResolvedValue({ status: "saved", fullName: "Jane Q. Doe" });
    render(<SettingsCards profile={JANE} />);

    await saveProfile(user, "Jane Q. Doe");
    await within(card("Profile")).findByRole("status");
    await user.click(
      within(card("Profile")).getByRole("button", { name: "Save changes" }),
    );

    await waitFor(() => expect(actions.updateProfile).toHaveBeenCalledTimes(2));
    expect(within(card("Profile")).getByRole("status")).toBeInTheDocument();
    expect(within(card("Profile")).getByLabelText("Full name")).toHaveValue(
      "Jane Q. Doe",
    );
  });

  it("requesting the same email twice is a resend; a too-soon refusal keeps the change pending", async () => {
    const user = userEvent.setup();
    actions.changeEmail
      .mockResolvedValueOnce({
        status: "confirmation_sent",
        email: "jane.new@example.com",
      })
      .mockResolvedValueOnce({
        status: "error",
        error: CHANGE_EMAIL_ERRORS.tooSoon,
        email: "jane.new@example.com",
      });
    const { rerender } = render(<SettingsCards profile={JANE} />);

    await requestEmail(user, "jane.new@example.com");
    await within(card("Email")).findByRole("status");
    // The server re-render records the pending change.
    rerender(
      <SettingsCards
        profile={{
          ...JANE,
          pendingEmail: "jane.new@example.com",
          pendingEmailSentAt: "2026-03-01T10:00:00Z",
        }}
      />,
    );

    await user.click(
      within(card("Email")).getByRole("button", { name: "Resend confirmation link" }),
    );

    await within(card("Email")).findByRole("alert");
    expect(within(card("Email")).getByRole("alert")).toHaveTextContent(
      /sent very recently/,
    );
    expect(card("Email").querySelector("[data-pending-email]")).toHaveAttribute(
      "data-pending-email",
      "jane.new@example.com",
    );
    expect(actions.changeEmail.mock.calls[1][1].get("email")).toBe(
      "jane.new@example.com",
    );
  });
});

describe("settings cards – a reload shows the server's truth, not leftovers", () => {
  it("after a reload every confirmation is gone and the fields hold the saved values", async () => {
    const user = userEvent.setup();
    actions.updateProfile.mockResolvedValue({ status: "saved", fullName: "Jane Q. Doe" });
    const { unmount } = render(<SettingsCards profile={JANE} />);

    await saveProfile(user, "Jane Q. Doe");
    await changePassword(user);
    await requestEmail(user, "jane.new@example.com");
    await waitFor(() => expect(screen.getAllByRole("status")).toHaveLength(3));

    // Reload: a fresh mount with what the server now knows.
    unmount();
    render(
      <SettingsCards
        profile={{
          fullName: "Jane Q. Doe",
          email: "jane@example.com",
          pendingEmail: "jane.new@example.com",
          pendingEmailSentAt: "2026-03-01T10:00:00Z",
        }}
      />,
    );

    expect(within(card("Profile")).queryByRole("status")).not.toBeInTheDocument();
    expect(within(card("Password")).queryByRole("status")).not.toBeInTheDocument();
    expect(within(card("Profile")).getByLabelText("Full name")).toHaveValue(
      "Jane Q. Doe",
    );
    // The pending email change is server state, so it IS still shown — as pending.
    const pending = within(card("Email")).getByRole("status");
    expect(pending).toHaveTextContent(/Change pending confirmation/);
    expect(pending).toHaveTextContent("1 Mar 2026, 10:00 UTC");
    expect(pending).not.toHaveTextContent(/has been sent/);
    expect(screen.getByText("Current address").nextElementSibling).toHaveTextContent(
      "jane@example.com",
    );
  });
});

describe("settings cards – accessibility", () => {
  it("has one level-3 heading per card, in order, and every form and control is named", () => {
    render(<SettingsCards profile={JANE} />);

    expect(
      screen.getAllByRole("heading", { level: 3 }).map((h) => h.textContent),
    ).toEqual(["Profile", "Email", "Password", "Security"]);

    for (const form of screen.getAllByRole("form")) {
      expect(form).toHaveAccessibleName();
    }
    for (const control of [
      ...screen.getAllByRole("textbox"),
      ...screen.getAllByRole("button"),
    ]) {
      expect(control).toHaveAccessibleName();
    }
    // Password inputs have no ARIA role; check them by label.
    for (const label of ["Current password", "New password", "Confirm new password"]) {
      expect(screen.getByLabelText(label)).toHaveAttribute("type", "password");
    }
  });

  it("generates unique ids for every labelled control (several cards, one page)", () => {
    const { container } = render(<SettingsCards profile={JANE} />);

    const ids = [...container.querySelectorAll("[id]")].map((el) => el.id);
    expect(new Set(ids).size).toBe(ids.length);
    for (const label of container.querySelectorAll("label[for]")) {
      expect(
        container.querySelector(`#${CSS.escape(label.getAttribute("for")!)}`),
      ).not.toBeNull();
    }
  });

  it("has no hidden password manager helper in the tab order and keeps long emails from overflowing", () => {
    const { container } = render(
      <SettingsCards
        profile={{
          ...JANE,
          email:
            "a.very.long.local.part.that.goes.on.and.on@subdomain.example-company.com",
          pendingEmail: "another.extremely.long.address.for.testing.purposes@example.org",
          pendingEmailSentAt: null,
        }}
      />,
    );

    const helper = container.querySelector('input[autocomplete="username"]')!;
    expect(helper).toHaveAttribute("tabindex", "-1");
    expect(helper).toHaveAttribute("aria-hidden", "true");

    expect(screen.getByText("Current address").nextElementSibling).toHaveClass(
      "break-all",
    );
    const pending = screen.getByRole("status");
    expect(
      within(pending).getByText(
        "another.extremely.long.address.for.testing.purposes@example.org",
      ),
    ).toHaveClass("break-all");
  });
});
