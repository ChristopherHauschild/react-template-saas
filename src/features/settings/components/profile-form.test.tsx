import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";

import type { UpdateProfileActionResult } from "../actions/update-profile";
import { PROFILE_NAME_MAX_LENGTH } from "../services/profile";

import {
  PROFILE_SAVED_MESSAGE,
  ProfileForm,
  SAVE_PROFILE_LABEL,
  SAVE_PROFILE_PENDING_LABEL,
} from "./profile-form";

// The form submits the server action; replace it with a controllable fake that
// keeps the `(prevState, formData)` signature React uses with useActionState.
const action = vi.hoisted(() => ({
  updateProfile:
    vi.fn<
      (
        prev: UpdateProfileActionResult,
        formData: FormData,
      ) => Promise<UpdateProfileActionResult>
    >(),
}));
vi.mock("../actions/update-profile", () => ({ updateProfile: action.updateProfile }));

const JANE = "Jane Doe";
const NEW_NAME = "Jane Q. Doe";

/**
 * A server-side field error. The browser's own `required` check catches an
 * empty name before the action runs (see the test below), so the fixture is a
 * value that passes client constraints and is refused by the server.
 */
const FIELD_ERROR: UpdateProfileActionResult = {
  status: "error",
  error: "Name can't contain line breaks or control characters.",
  field: "fullName",
  fullName: NEW_NAME,
};

const UNFIELDED_ERROR: UpdateProfileActionResult = {
  status: "error",
  error: "We couldn't save your changes right now. Please try again in a moment.",
  fullName: NEW_NAME,
};

const SAVED: UpdateProfileActionResult = { status: "saved", fullName: NEW_NAME };

const nameInput = () => screen.getByLabelText("Full name");
const saveButton = () => screen.getByRole("button", { name: SAVE_PROFILE_LABEL });

const replaceNameAndSubmit = async (
  user: ReturnType<typeof userEvent.setup>,
  name: string,
) => {
  await user.clear(nameInput());
  if (name) await user.type(nameInput(), name);
  await user.click(saveButton());
};

beforeEach(() => {
  action.updateProfile.mockReset();
  action.updateProfile.mockResolvedValue(null);
});

describe("ProfileForm – loading the profile", () => {
  it("pre-fills the name", () => {
    render(<ProfileForm fullName={JANE} />);

    expect(nameInput()).toHaveValue("Jane Doe");
  });

  it("starts blank when the account has no name yet", () => {
    render(<ProfileForm fullName="" />);

    expect(nameInput()).toHaveValue("");
    expect(nameInput()).toBeRequired();
  });

  it("leaves the email to its own card (changing it is a confirmation flow)", () => {
    render(<ProfileForm fullName={JANE} />);

    expect(screen.queryByLabelText(/email/i)).not.toBeInTheDocument();
  });

  it("associates labels with inputs, enables autofill and mirrors the server's length limit", () => {
    render(<ProfileForm fullName={JANE} />);

    const name = nameInput();
    expect(name).toHaveAttribute("name", "fullName");
    expect(name).toHaveAttribute("type", "text");
    expect(name).toHaveAttribute("autocomplete", "name");
    expect(name).toBeRequired();
    expect(name).toHaveAttribute("maxlength", String(PROFILE_NAME_MAX_LENGTH));
    expect(name).not.toHaveAttribute("aria-invalid");

    expect(saveButton()).toHaveAttribute("type", "submit");
    expect(saveButton()).toBeEnabled();
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
    expect(screen.queryByRole("status")).not.toBeInTheDocument();
  });

  it("is a labelled form inside the profile card, which the account menu can link to", () => {
    render(<ProfileForm fullName={JANE} />);

    const form = screen.getByRole("form", { name: "Profile" });
    const cardEl = form.closest("[data-settings-section='profile']");
    expect(cardEl).not.toBeNull();
    expect(cardEl).toHaveAttribute("id", "profile");
    expect(
      within(form).getByRole("button", { name: SAVE_PROFILE_LABEL }),
    ).toBeInTheDocument();
  });
});

describe("ProfileForm – saving", () => {
  it("submits the new name (and nothing else) to the action", async () => {
    const user = userEvent.setup();
    render(<ProfileForm fullName={JANE} />);

    await replaceNameAndSubmit(user, NEW_NAME);

    await waitFor(() => expect(action.updateProfile).toHaveBeenCalledTimes(1));
    const [prev, formData] = action.updateProfile.mock.calls[0];
    expect(prev).toBeNull();
    expect(formData).toBeInstanceOf(FormData);
    expect(formData.get("fullName")).toBe(NEW_NAME);
    expect([...formData.keys()]).toEqual(["fullName"]);
  });

  it("confirms a successful save in a live region and keeps the saved name in the field", async () => {
    const user = userEvent.setup();
    action.updateProfile.mockResolvedValue(SAVED);
    render(<ProfileForm fullName={JANE} />);

    await replaceNameAndSubmit(user, NEW_NAME);

    const status = await screen.findByRole("status");
    expect(status).toHaveTextContent(PROFILE_SAVED_MESSAGE);
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
    expect(nameInput()).toHaveValue(NEW_NAME);
    expect(nameInput()).not.toHaveAttribute("aria-invalid");
    expect(saveButton()).toBeEnabled();
  });

  it("shows a pending state and blocks double submission while the action runs", async () => {
    const user = userEvent.setup();
    let finish!: (value: UpdateProfileActionResult) => void;
    action.updateProfile.mockReturnValue(
      new Promise<UpdateProfileActionResult>((resolve) => (finish = resolve)),
    );
    render(<ProfileForm fullName={JANE} />);

    await replaceNameAndSubmit(user, NEW_NAME);

    const pendingButton = await screen.findByRole("button", {
      name: SAVE_PROFILE_PENDING_LABEL,
    });
    expect(pendingButton).toBeDisabled();
    expect(pendingButton).toHaveAttribute("aria-busy", "true");
    expect(screen.getByRole("form", { name: "Profile" })).toHaveAttribute(
      "aria-busy",
      "true",
    );

    await user.click(pendingButton);
    expect(action.updateProfile).toHaveBeenCalledTimes(1);

    finish(SAVED);
    await screen.findByRole("status");
    expect(screen.getByRole("form", { name: "Profile" })).toHaveAttribute(
      "aria-busy",
      "false",
    );
  });

  it("replaces an earlier confirmation when a later attempt fails", async () => {
    const user = userEvent.setup();
    action.updateProfile
      .mockResolvedValueOnce(SAVED)
      .mockResolvedValueOnce(UNFIELDED_ERROR);
    render(<ProfileForm fullName={JANE} />);

    await replaceNameAndSubmit(user, NEW_NAME);
    await screen.findByRole("status");

    await user.click(saveButton());

    await screen.findByRole("alert");
    expect(screen.queryByRole("status")).not.toBeInTheDocument();
  });
});

describe("ProfileForm – validation errors", () => {
  it("shows a field error as an alert wired to the input via aria-describedby", async () => {
    const user = userEvent.setup();
    action.updateProfile.mockResolvedValue(FIELD_ERROR);
    render(<ProfileForm fullName={JANE} />);

    await replaceNameAndSubmit(user, NEW_NAME);

    const alert = await screen.findByRole("alert");
    expect(alert).toHaveTextContent(FIELD_ERROR.error);

    const name = nameInput();
    expect(name).toHaveAttribute("aria-invalid", "true");
    expect(name).toHaveAttribute("aria-describedby", alert.id);
    expect(name).toHaveAccessibleDescription(FIELD_ERROR.error);
    expect(screen.queryByRole("status")).not.toBeInTheDocument();
  });

  it("lets the browser's required check stop an empty name before the action runs", async () => {
    const user = userEvent.setup();
    render(<ProfileForm fullName={JANE} />);

    await replaceNameAndSubmit(user, "");

    expect(nameInput()).toBeInvalid(); // constraint validation, no round trip
    expect(action.updateProfile).not.toHaveBeenCalled();
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
  });

  it("keeps what the user typed after a failed attempt (React resets the form)", async () => {
    const user = userEvent.setup();
    const tooLong = "x".repeat(PROFILE_NAME_MAX_LENGTH); // client maxLength caps typing here
    action.updateProfile.mockResolvedValue({
      status: "error",
      error: "Name must be at most 100 characters.",
      field: "fullName",
      fullName: tooLong,
    });
    render(<ProfileForm fullName={JANE} />);

    await replaceNameAndSubmit(user, tooLong);

    await screen.findByRole("alert");
    expect(nameInput()).toHaveValue(tooLong);
  });

  it("shows an error that is not about one field without flagging the input", async () => {
    const user = userEvent.setup();
    action.updateProfile.mockResolvedValue(UNFIELDED_ERROR);
    render(<ProfileForm fullName={JANE} />);

    await replaceNameAndSubmit(user, NEW_NAME);

    const alert = await screen.findByRole("alert");
    expect(alert).toHaveTextContent(/couldn't save your changes/);
    expect(nameInput()).not.toHaveAttribute("aria-invalid");
    expect(nameInput()).not.toHaveAttribute("aria-describedby");
    // The typed value survives so the user can simply retry.
    expect(nameInput()).toHaveValue(NEW_NAME);
    expect(saveButton()).toBeEnabled();
  });

  it("clears the error once a retry succeeds", async () => {
    const user = userEvent.setup();
    action.updateProfile.mockResolvedValueOnce(FIELD_ERROR).mockResolvedValueOnce(SAVED);
    render(<ProfileForm fullName={JANE} />);

    await replaceNameAndSubmit(user, NEW_NAME);
    await screen.findByRole("alert");

    await user.clear(nameInput());
    await user.type(nameInput(), "Jane Doe");
    await user.click(saveButton());

    await screen.findByRole("status");
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
    expect(nameInput()).not.toHaveAttribute("aria-invalid");
  });
});
