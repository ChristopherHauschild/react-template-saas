import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";

import {
  MANAGE_BILLING_LABEL,
  MANAGE_BILLING_PENDING_LABEL,
  ManageBillingButton,
} from "./manage-billing-button";

// The button submits the server action; replace it with a controllable fake.
const action = vi.hoisted(() => ({
  createPortalSession: vi.fn<(...args: unknown[]) => Promise<unknown>>(),
}));
vi.mock("../actions/create-portal-session", () => ({
  createPortalSession: action.createPortalSession,
}));

beforeEach(() => {
  action.createPortalSession.mockReset();
  action.createPortalSession.mockResolvedValue(null);
});

describe("ManageBillingButton – idle", () => {
  it("renders an enabled submit button inside a form, with no error", () => {
    const { container } = render(<ManageBillingButton />);

    const button = screen.getByRole("button", { name: MANAGE_BILLING_LABEL });
    expect(button).toBeEnabled();
    expect(button).toHaveAttribute("type", "submit");
    expect(button).toHaveAttribute("aria-busy", "false");
    expect(button.closest("form")).not.toBeNull();
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
    expect(action.createPortalSession).not.toHaveBeenCalled();

    // The action needs nothing from the client: the form carries no fields.
    expect(container.querySelectorAll("input, select, textarea")).toHaveLength(0);
  });

  it("explains that the portal is Stripe's and what it is for", () => {
    render(<ManageBillingButton />);

    expect(screen.getByText(/Stripe's secure billing portal/)).toBeInTheDocument();
  });
});

describe("ManageBillingButton – submitting", () => {
  it("submits the portal action once per click, with no client-chosen data", async () => {
    const user = userEvent.setup();
    render(<ManageBillingButton />);

    await user.click(screen.getByRole("button", { name: MANAGE_BILLING_LABEL }));

    await waitFor(() => expect(action.createPortalSession).toHaveBeenCalledTimes(1));
    // useActionState passes (prevState, formData); the action ignores both, and
    // the form has nothing a client could use to pick a customer.
    const [prevState, formData] = action.createPortalSession.mock.calls[0];
    expect(prevState).toBeNull();
    expect(formData).toBeInstanceOf(FormData);
    expect([...(formData as FormData).keys()]).toEqual([]);
  });

  it("shows a loading state while the action is pending and blocks a second click", async () => {
    let finish!: (value: null) => void;
    action.createPortalSession.mockReturnValue(
      new Promise((resolve) => (finish = resolve)),
    );
    const user = userEvent.setup();
    render(<ManageBillingButton />);

    await user.click(screen.getByRole("button", { name: MANAGE_BILLING_LABEL }));

    const busy = await screen.findByRole("button", {
      name: MANAGE_BILLING_PENDING_LABEL,
    });
    expect(busy).toBeDisabled();
    expect(busy).toHaveAttribute("aria-busy", "true");

    await user.click(busy); // disabled: must not submit again
    expect(action.createPortalSession).toHaveBeenCalledTimes(1);

    finish(null);
    await screen.findByRole("button", { name: MANAGE_BILLING_LABEL });
  });

  it("shows an inline, announced error when the action returns one, and lets the user retry", async () => {
    action.createPortalSession
      .mockResolvedValueOnce({
        error:
          "You don't have a billing account yet. Choose a plan on the pricing page to get started.",
      })
      .mockResolvedValueOnce(null);
    const user = userEvent.setup();
    render(<ManageBillingButton />);

    await user.click(screen.getByRole("button", { name: MANAGE_BILLING_LABEL }));

    expect(await screen.findByRole("alert")).toHaveTextContent(
      /don't have a billing account/,
    );
    expect(screen.getByRole("button", { name: MANAGE_BILLING_LABEL })).toBeEnabled();

    await user.click(screen.getByRole("button", { name: MANAGE_BILLING_LABEL }));
    await waitFor(() => expect(screen.queryByRole("alert")).not.toBeInTheDocument());
    expect(action.createPortalSession).toHaveBeenCalledTimes(2);
  });

  it("replaces a previous error with the latest one", async () => {
    action.createPortalSession
      .mockResolvedValueOnce({ error: "first problem" })
      .mockResolvedValueOnce({ error: "second problem" });
    const user = userEvent.setup();
    render(<ManageBillingButton />);

    await user.click(screen.getByRole("button", { name: MANAGE_BILLING_LABEL }));
    expect(await screen.findByRole("alert")).toHaveTextContent("first problem");

    await user.click(screen.getByRole("button", { name: MANAGE_BILLING_LABEL }));
    await waitFor(() =>
      expect(screen.getByRole("alert")).toHaveTextContent("second problem"),
    );
    expect(screen.getAllByRole("alert")).toHaveLength(1);
  });
});
