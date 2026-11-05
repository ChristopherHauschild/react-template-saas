import { hydrateRoot } from "react-dom/client";
import { renderToString } from "react-dom/server";

import { act, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { CreateSupportRequestActionResult } from "../actions/create-support-request";
import {
  SUPPORT_REQUEST_FIELD_ERRORS,
  SUPPORT_REQUEST_MESSAGE_MAX_LENGTH,
  SUPPORT_REQUEST_SUBJECT_MAX_LENGTH,
} from "../services/support-request";
import {
  SUPPORT_REQUEST_CATEGORY_LABELS,
  SUPPORT_REQUEST_FORM_COPY as COPY,
} from "../services/support-request-copy";
import { SUPPORT_REQUEST_ERRORS } from "../services/support-request-errors";

import { SUPPORT_REQUEST_DRAFT, SupportRequestForm } from "./support-request-form";

// The form submits the server action; replace it with a controllable fake that
// keeps the `(prevState, formData)` signature React uses with useActionState.
const action = vi.hoisted(() => ({
  createSupportRequestAction:
    vi.fn<
      (
        prev: CreateSupportRequestActionResult,
        formData: FormData,
      ) => Promise<CreateSupportRequestActionResult>
    >(),
}));
vi.mock("../actions/create-support-request", () => action);

type Result = NonNullable<CreateSupportRequestActionResult>;

/**
 * Makes the fake action fail with `failure`. A fresh object per call, like a
 * real Server Action's deserialised response: the form reacts to each result,
 * including one identical to the last.
 */
const failWith = (failure: Extract<Result, { status: "error" }>) =>
  action.createSupportRequestAction.mockImplementation(async () => ({ ...failure }));

/** The fields the action received on its `n`th call (0-based). */
const sentFields = (n: number) =>
  Object.fromEntries(action.createSupportRequestAction.mock.calls[n][1]);

const SENT: Result = {
  status: "sent",
  request: {
    id: "3f2504e0-4f89-41d3-9a0c-0305e82c3301",
    createdAt: "2026-03-01T10:00:00+00:00",
    category: "billing",
    status: "open",
    subject: "Charged twice",
    message: "I see two charges for March.",
  },
};

const form = () => screen.getByRole("form", { name: COPY.title });
const categoryGroup = () => screen.getByRole("radiogroup", { name: COPY.categoryLegend });
const radio = (label: string) => screen.getByRole("radio", { name: label });
const subjectInput = () => screen.getByLabelText(COPY.subjectLabel);
const messageInput = () => screen.getByLabelText(COPY.messageLabel);
const submitButton = () => screen.getByRole("button", { name: COPY.submit });

const OWNER = "11111111-1111-4111-8111-111111111111";
const SOMEONE_ELSE = "22222222-2222-4222-8222-222222222222";
const draftKey = (owner = OWNER) => `draft:${SUPPORT_REQUEST_DRAFT}:${owner}`;
const storedDraft = (owner = OWNER) => {
  const raw = sessionStorage.getItem(draftKey(owner));
  return raw === null ? null : JSON.parse(raw);
};
const storeDraft = (draft: unknown, owner = OWNER) =>
  sessionStorage.setItem(draftKey(owner), JSON.stringify(draft));

const BILLING = SUPPORT_REQUEST_CATEGORY_LABELS.billing;
const TECHNICAL = SUPPORT_REQUEST_CATEGORY_LABELS.technical;

/** Fills every field and submits. */
async function fillAndSubmit(
  user: ReturnType<typeof userEvent.setup>,
  { category = BILLING, subject = "Charged twice", message = "I see two charges." } = {},
) {
  if (category) await user.click(radio(category));
  await user.clear(subjectInput());
  if (subject) await user.type(subjectInput(), subject);
  await user.clear(messageInput());
  if (message) await user.type(messageInput(), message);
  await user.click(submitButton());
}

afterEach(() => {
  vi.restoreAllMocks();
});

beforeEach(() => {
  // Drafts live in the tab's storage, which outlives a single test.
  sessionStorage.clear();
  action.createSupportRequestAction.mockReset();
  action.createSupportRequestAction.mockResolvedValue(SENT);
});

describe("SupportRequestForm – fields", () => {
  it("is a labelled form with a category group, a subject and a message", () => {
    render(<SupportRequestForm ownerId={OWNER} />);

    expect(form()).toBeInTheDocument();
    expect(
      within(categoryGroup())
        .getAllByRole("radio")
        .map((r) => r.getAttribute("value")),
    ).toEqual(["account", "billing", "technical", "other"]);

    for (const label of Object.values(SUPPORT_REQUEST_CATEGORY_LABELS)) {
      expect(radio(label)).not.toBeChecked();
      expect(radio(label)).toBeRequired();
      expect(radio(label)).toHaveAttribute("name", "category");
    }

    expect(subjectInput()).toHaveAttribute("name", "subject");
    expect(subjectInput()).toHaveValue("");
    expect(messageInput()).toHaveAttribute("name", "message");
    expect(messageInput().tagName).toBe("TEXTAREA");
    expect(messageInput()).toHaveValue("");

    expect(submitButton()).toHaveAttribute("type", "submit");
    expect(submitButton()).toBeEnabled();
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
    expect(screen.queryByRole("status")).not.toBeInTheDocument();
  });

  it("mirrors the server's limits, never looser (browser checks run first)", () => {
    render(<SupportRequestForm ownerId={OWNER} />);

    expect(subjectInput()).toBeRequired();
    expect(subjectInput()).toHaveAttribute(
      "maxlength",
      String(SUPPORT_REQUEST_SUBJECT_MAX_LENGTH),
    );
    expect(messageInput()).toBeRequired();
    expect(messageInput()).toHaveAttribute(
      "maxlength",
      String(SUPPORT_REQUEST_MESSAGE_MAX_LENGTH),
    );
    expect(messageInput()).toHaveAccessibleDescription(/Up to 5,000 characters/);
    expect(categoryGroup()).toHaveAttribute("aria-required", "true");
  });

  it("offers the category as radios, not a select (React would drop a select's choice on reset)", () => {
    render(<SupportRequestForm ownerId={OWNER} />);

    expect(screen.queryByRole("combobox")).not.toBeInTheDocument();
    expect(within(form()).queryAllByRole("listbox")).toHaveLength(0);
  });

  it("flags nothing as invalid before the first attempt", () => {
    render(<SupportRequestForm ownerId={OWNER} />);

    expect(categoryGroup()).not.toHaveAttribute("aria-invalid");
    expect(subjectInput()).not.toHaveAttribute("aria-invalid");
    expect(messageInput()).not.toHaveAttribute("aria-invalid");
  });
});

describe("SupportRequestForm – sending", () => {
  it("submits exactly the category, subject and message — and the page's account — to the action", async () => {
    const user = userEvent.setup();
    render(<SupportRequestForm ownerId={OWNER} />);

    await fillAndSubmit(user);

    await waitFor(() =>
      expect(action.createSupportRequestAction).toHaveBeenCalledTimes(1),
    );
    const [prev, formData] = action.createSupportRequestAction.mock.calls[0];
    expect(prev).toBeNull();
    expect(Object.fromEntries(formData)).toEqual({
      pageOwner: OWNER,
      category: "billing",
      subject: "Charged twice",
      message: "I see two charges.",
    });
  });

  it("confirms in a live region, naming the request, and clears the form for the next one", async () => {
    const user = userEvent.setup();
    render(<SupportRequestForm ownerId={OWNER} />);

    await fillAndSubmit(user);

    const status = await screen.findByRole("status");
    expect(status).toHaveTextContent(
      "Your request \u201CCharged twice\u201D has been sent.",
    );
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();

    // Control for every "keeps the input" test below: the form DOES reset
    // after a success, so input kept after a failure is deliberate.
    expect(radio(BILLING)).not.toBeChecked();
    expect(subjectInput()).toHaveValue("");
    expect(messageInput()).toHaveValue("");
    expect(submitButton()).toBeEnabled();
  });

  it("confirms without naming the request when the server could not echo it", async () => {
    const user = userEvent.setup();
    action.createSupportRequestAction.mockResolvedValue({
      status: "sent",
      request: null,
    });
    render(<SupportRequestForm ownerId={OWNER} />);

    await fillAndSubmit(user);

    expect(await screen.findByRole("status")).toHaveTextContent(
      /^Your request has been sent\.$/,
    );
  });

  it("shows a pending state, locks the fields and blocks a double submission", async () => {
    const user = userEvent.setup();
    let finish!: (value: CreateSupportRequestActionResult) => void;
    action.createSupportRequestAction.mockReturnValue(
      new Promise((resolve) => (finish = resolve)),
    );
    render(<SupportRequestForm ownerId={OWNER} />);

    // React entangles pending async actions: one left unresolved would stall
    // every later test's transitions. Settle it even if an assertion fails.
    try {
      await fillAndSubmit(user);

      const pending = await screen.findByRole("button", { name: COPY.submitPending });
      expect(pending).toBeDisabled();
      expect(pending).toHaveAttribute("aria-busy", "true");
      expect(form()).toHaveAttribute("aria-busy", "true");
      // Anything typed now would be thrown away when the form resets.
      expect(subjectInput()).toBeDisabled();
      expect(messageInput()).toBeDisabled();
      expect(radio(TECHNICAL)).toBeDisabled();

      await user.click(pending);
      expect(action.createSupportRequestAction).toHaveBeenCalledTimes(1);
    } finally {
      finish(SENT);
    }

    await screen.findByRole("status");
    expect(form()).toHaveAttribute("aria-busy", "false");
    expect(subjectInput()).toBeEnabled();
  });
});

describe("SupportRequestForm – before hydration", () => {
  it("renders the submit button disabled on the server (a native submit has no endpoint)", () => {
    const container = document.createElement("div");
    container.innerHTML = renderToString(<SupportRequestForm ownerId={OWNER} />);
    const button = container.querySelector('button[type="submit"]');

    expect(button).not.toBeNull();
    expect(button).toHaveAttribute("disabled");
  });

  it("enables it once running in the browser", () => {
    render(<SupportRequestForm ownerId={OWNER} />);

    expect(submitButton()).toBeEnabled();
  });
});

describe("SupportRequestForm – the browser's own checks", () => {
  it("does not submit without a category", async () => {
    const user = userEvent.setup();
    render(<SupportRequestForm ownerId={OWNER} />);

    await fillAndSubmit(user, { category: "" });

    expect(radio(BILLING)).toBeInvalid();
    expect(action.createSupportRequestAction).not.toHaveBeenCalled();
  });

  it.each([
    ["subject", { subject: "" }],
    ["message", { message: "" }],
  ])("does not submit with an empty %s", async (_field, override) => {
    const user = userEvent.setup();
    render(<SupportRequestForm ownerId={OWNER} />);

    await fillAndSubmit(user, override);

    expect(action.createSupportRequestAction).not.toHaveBeenCalled();
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
  });
});

describe("SupportRequestForm – validation errors from the server", () => {
  it("shows a subject error under the subject, wired to it, and keeps every field", async () => {
    const user = userEvent.setup();
    failWith({
      status: "error",
      reason: "invalid",
      field: "subject",
      error: SUPPORT_REQUEST_FIELD_ERRORS.subjectRequired,
    });
    render(<SupportRequestForm ownerId={OWNER} />);

    // Spaces pass the browser's `required`; the server refuses them.
    await fillAndSubmit(user, {
      category: TECHNICAL,
      subject: "   ",
      message: "The export has been stuck since 9am.",
    });

    const alert = await screen.findByRole("alert");
    expect(alert).toHaveTextContent(SUPPORT_REQUEST_FIELD_ERRORS.subjectRequired);

    expect(subjectInput()).toHaveAttribute("aria-invalid", "true");
    expect(subjectInput()).toHaveAttribute("aria-describedby", alert.id);
    expect(subjectInput()).toHaveAccessibleDescription(
      SUPPORT_REQUEST_FIELD_ERRORS.subjectRequired,
    );
    // The error sits with its field, not in a summary elsewhere.
    expect(subjectInput().parentElement).toContainElement(alert);

    // Only the subject is flagged.
    expect(messageInput()).not.toHaveAttribute("aria-invalid");
    expect(categoryGroup()).not.toHaveAttribute("aria-invalid");

    // Nothing the user entered is lost.
    expect(radio(TECHNICAL)).toBeChecked();
    expect(messageInput()).toHaveValue("The export has been stuck since 9am.");
    expect(screen.queryByRole("status")).not.toBeInTheDocument();
  });

  it("moves focus to the field that needs fixing", async () => {
    const user = userEvent.setup();
    failWith({
      status: "error",
      reason: "invalid",
      field: "message",
      error: SUPPORT_REQUEST_FIELD_ERRORS.messageInvalid,
    });
    render(<SupportRequestForm ownerId={OWNER} />);

    await fillAndSubmit(user);

    await screen.findByRole("alert");
    await waitFor(() => expect(messageInput()).toHaveFocus());
  });

  it("keeps the message's hint in its description next to the error", async () => {
    const user = userEvent.setup();
    failWith({
      status: "error",
      reason: "invalid",
      field: "message",
      error: SUPPORT_REQUEST_FIELD_ERRORS.messageTooLong,
    });
    render(<SupportRequestForm ownerId={OWNER} />);

    await fillAndSubmit(user);

    await screen.findByRole("alert");
    expect(messageInput()).toHaveAttribute("aria-invalid", "true");
    expect(messageInput()).toHaveAccessibleDescription(
      `Up to 5,000 characters. ${SUPPORT_REQUEST_FIELD_ERRORS.messageTooLong}`,
    );
  });

  it("flags the category group (not single radios) and focuses the chosen option", async () => {
    const user = userEvent.setup();
    failWith({
      status: "error",
      reason: "invalid",
      field: "category",
      error: SUPPORT_REQUEST_FIELD_ERRORS.categoryInvalid,
    });
    render(<SupportRequestForm ownerId={OWNER} />);

    await fillAndSubmit(user, { category: TECHNICAL });

    const alert = await screen.findByRole("alert");
    expect(alert).toHaveTextContent(SUPPORT_REQUEST_FIELD_ERRORS.categoryInvalid);
    expect(categoryGroup()).toHaveAttribute("aria-invalid", "true");
    expect(categoryGroup()).toHaveAccessibleDescription(
      SUPPORT_REQUEST_FIELD_ERRORS.categoryInvalid,
    );
    expect(radio(TECHNICAL)).not.toHaveAttribute("aria-invalid");
    await waitFor(() => expect(radio(TECHNICAL)).toHaveFocus());
  });

  it("keeps text exactly as typed after a failure — nothing is trimmed or re-rendered", async () => {
    const user = userEvent.setup();
    failWith({
      status: "error",
      reason: "invalid",
      field: "subject",
      error: SUPPORT_REQUEST_FIELD_ERRORS.subjectInvalid,
    });
    render(<SupportRequestForm ownerId={OWNER} />);

    await fillAndSubmit(user, {
      subject: "  Tab\there  ",
      message: "  Line one{Enter}Line two  ",
    });

    await screen.findByRole("alert");
    expect(subjectInput()).toHaveValue("  Tab\there  ");
    expect(messageInput()).toHaveValue("  Line one\nLine two  ");
  });

  it("sends the category chosen after a failure, not the earlier one", async () => {
    // Regression: with the category restored through `defaultChecked` after
    // React's form reset, changing it afterwards bounced back to the old
    // answer (React re-applies `defaultChecked` to the whole radio group on
    // every change), and the OLD category was sent.
    const user = userEvent.setup();
    failWith({
      status: "error",
      reason: "invalid",
      field: "subject",
      error: SUPPORT_REQUEST_FIELD_ERRORS.subjectInvalid,
    });
    render(<SupportRequestForm ownerId={OWNER} />);

    await fillAndSubmit(user, { category: BILLING, subject: "First try" });
    await screen.findByRole("alert");
    expect(radio(BILLING)).toBeChecked();

    await user.click(radio(TECHNICAL));
    expect(radio(TECHNICAL)).toBeChecked();
    expect(radio(BILLING)).not.toBeChecked();

    await user.clear(subjectInput());
    await user.type(subjectInput(), "Second try");
    await user.click(submitButton());

    await waitFor(() =>
      expect(action.createSupportRequestAction).toHaveBeenCalledTimes(2),
    );
    expect(sentFields(1)).toEqual({
      pageOwner: OWNER,
      category: "technical",
      subject: "Second try",
      message: "I see two charges.",
    });

    // And after the second failure the form still shows the new answers.
    await waitFor(() => expect(subjectInput()).toHaveFocus());
    expect(radio(TECHNICAL)).toBeChecked();
    expect(radio(BILLING)).not.toBeChecked();
    expect(subjectInput()).toHaveValue("Second try");
    expect(screen.getAllByRole("alert")).toHaveLength(1);
  });

  it("moves focus to the invalid field again on a repeated identical failure", async () => {
    const user = userEvent.setup();
    failWith({
      status: "error",
      reason: "invalid",
      field: "subject",
      error: SUPPORT_REQUEST_FIELD_ERRORS.subjectInvalid,
    });
    render(<SupportRequestForm ownerId={OWNER} />);

    await fillAndSubmit(user);
    await waitFor(() => expect(subjectInput()).toHaveFocus());

    await user.click(messageInput());
    await user.click(submitButton());

    await waitFor(() =>
      expect(action.createSupportRequestAction).toHaveBeenCalledTimes(2),
    );
    await waitFor(() => expect(subjectInput()).toHaveFocus());
  });

  it("clears the error and the form once a retry succeeds", async () => {
    const user = userEvent.setup();
    action.createSupportRequestAction
      .mockResolvedValueOnce({
        status: "error",
        reason: "invalid",
        field: "subject",
        error: SUPPORT_REQUEST_FIELD_ERRORS.subjectRequired,
      })
      .mockResolvedValueOnce(SENT);
    render(<SupportRequestForm ownerId={OWNER} />);

    await fillAndSubmit(user);
    await screen.findByRole("alert");

    await user.click(submitButton());

    await screen.findByRole("status");
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
    expect(subjectInput()).not.toHaveAttribute("aria-invalid");
    expect(subjectInput()).toHaveValue("");
  });
});

describe("SupportRequestForm – other failures", () => {
  it.each([
    ["the flood limit", "rateLimited", SUPPORT_REQUEST_ERRORS.rateLimited],
    ["an outage", "unavailable", SUPPORT_REQUEST_ERRORS.unavailable],
    ["a database-side refusal", "invalid", SUPPORT_REQUEST_ERRORS.invalid],
  ] as const)(
    "explains %s without flagging a field, keeping all input",
    async (_label, reason, message) => {
      const user = userEvent.setup();
      failWith({ status: "error", reason, error: message });
      render(<SupportRequestForm ownerId={OWNER} />);

      await fillAndSubmit(user, {
        category: TECHNICAL,
        subject: "Export stuck",
        message: "Since 9am.",
      });

      const alert = await screen.findByRole("alert");
      expect(alert).toHaveTextContent(message);

      expect(categoryGroup()).not.toHaveAttribute("aria-invalid");
      expect(subjectInput()).not.toHaveAttribute("aria-invalid");
      expect(messageInput()).not.toHaveAttribute("aria-invalid");

      expect(radio(TECHNICAL)).toBeChecked();
      expect(subjectInput()).toHaveValue("Export stuck");
      expect(messageInput()).toHaveValue("Since 9am.");
      expect(submitButton()).toBeEnabled();
      expect(within(alert).queryByRole("link")).not.toBeInTheDocument();
    },
  );

  it("on an expired session, keeps the draft and offers to sign in in a new tab", async () => {
    const user = userEvent.setup();
    failWith({
      status: "error",
      reason: "sessionExpired",
      error: SUPPORT_REQUEST_ERRORS.sessionExpired,
    });
    render(<SupportRequestForm ownerId={OWNER} />);

    await fillAndSubmit(user, { message: "A long and careful description." });

    const alert = await screen.findByRole("alert");
    expect(alert).toHaveTextContent(SUPPORT_REQUEST_ERRORS.sessionExpired);

    const link = within(alert).getByRole("link", { name: COPY.signInAgain });
    expect(link).toHaveAttribute("href", "/login");
    // A new tab: following the link here would unload the draft.
    expect(link).toHaveAttribute("target", "_blank");
    expect(link).toHaveAttribute("rel", expect.stringContaining("noopener"));

    expect(messageInput()).toHaveValue("A long and careful description.");
    expect(radio(BILLING)).toBeChecked();
  });

  it("replaces an earlier confirmation when a later attempt fails", async () => {
    const user = userEvent.setup();
    action.createSupportRequestAction.mockResolvedValueOnce(SENT).mockResolvedValueOnce({
      status: "error",
      reason: "rateLimited",
      error: SUPPORT_REQUEST_ERRORS.rateLimited,
    });
    render(<SupportRequestForm ownerId={OWNER} />);

    await fillAndSubmit(user);
    await screen.findByRole("status");

    await fillAndSubmit(user, { subject: "Another one" });

    await screen.findByRole("alert");
    expect(screen.queryByRole("status")).not.toBeInTheDocument();
    expect(subjectInput()).toHaveValue("Another one");
  });
});

describe("SupportRequestForm – keeping the draft in the tab", () => {
  const DRAFT = { category: "technical", subject: "Export stuck", message: "Since 9am." };

  it("keeps what is typed in the tab, for this user", async () => {
    const user = userEvent.setup();
    render(<SupportRequestForm ownerId={OWNER} />);

    await user.click(radio(TECHNICAL));
    await user.type(subjectInput(), "Export stuck");
    await user.type(messageInput(), "Since 9am.");

    expect(storedDraft()).toEqual(DRAFT);
  });

  it("puts a draft back after the page was left (e.g. sent to the login page), and says so", () => {
    storeDraft(DRAFT);

    render(<SupportRequestForm ownerId={OWNER} />);

    expect(radio(TECHNICAL)).toBeChecked();
    expect(subjectInput()).toHaveValue("Export stuck");
    expect(messageInput()).toHaveValue("Since 9am.");
    expect(screen.getByRole("status")).toHaveTextContent(COPY.draftRestored);
  });

  it("sends a restored draft like anything typed", async () => {
    const user = userEvent.setup();
    storeDraft(DRAFT);
    render(<SupportRequestForm ownerId={OWNER} />);

    await user.click(submitButton());

    await waitFor(() => expect(action.createSupportRequestAction).toHaveBeenCalled());
    expect(sentFields(0)).toEqual({ ...DRAFT, pageOwner: OWNER });
  });

  it("forgets the draft once the request is sent", async () => {
    const user = userEvent.setup();
    storeDraft(DRAFT);
    render(<SupportRequestForm ownerId={OWNER} />);

    await user.click(submitButton());

    await screen.findByText(/has been sent/);
    expect(storedDraft()).toBeNull();
    expect(screen.queryByText(COPY.draftRestored)).not.toBeInTheDocument();
  });

  it("never shows the 'put back' note beside the 'sent' confirmation, even for a moment", async () => {
    const user = userEvent.setup();
    storeDraft(DRAFT);
    render(<SupportRequestForm ownerId={OWNER} />);

    // Record every DOM state the user could see, not just the final one.
    let together = false;
    const observer = new MutationObserver(() => {
      const text = form().textContent ?? "";
      if (text.includes("has been sent") && text.includes(COPY.draftRestored))
        together = true;
    });
    observer.observe(form(), { childList: true, subtree: true, characterData: true });

    try {
      await user.click(submitButton());
      await screen.findByText(/has been sent/);
    } finally {
      observer.disconnect();
    }

    expect(together).toBe(false);
  });

  it("keeps the draft when sending fails", async () => {
    const user = userEvent.setup();
    failWith({
      status: "error",
      reason: "sessionExpired",
      error: SUPPORT_REQUEST_ERRORS.sessionExpired,
    });
    render(<SupportRequestForm ownerId={OWNER} />);

    await fillAndSubmit(user, {
      category: TECHNICAL,
      subject: "Export stuck",
      message: "Since 9am.",
    });

    await screen.findByRole("alert");
    expect(storedDraft()).toEqual(DRAFT);
  });

  it("can discard a restored draft", async () => {
    const user = userEvent.setup();
    storeDraft(DRAFT);
    render(<SupportRequestForm ownerId={OWNER} />);

    await user.click(screen.getByRole("button", { name: COPY.discardDraft }));

    expect(subjectInput()).toHaveValue("");
    expect(messageInput()).toHaveValue("");
    expect(radio(TECHNICAL)).not.toBeChecked();
    expect(storedDraft()).toBeNull();
    expect(screen.queryByText(COPY.draftRestored)).not.toBeInTheDocument();
    expect(subjectInput()).toHaveFocus();
  });

  it("keeps the draft current when, after a send, the same answers are entered again", async () => {
    // Regression, found in Chromium: the form is cleared with a native
    // `reset()`, which React's change tracking does not see. React then
    // swallowed `onChange` for a value equal to the one it last tracked —
    // re-picking the same category, or pasting the same text — and the draft
    // silently lost it. Native input (typing, pasting, autofill) is simulated
    // here the way the browser does it: the DOM value changes without going
    // through React's instrumented setter, then an input event fires.
    const user = userEvent.setup();
    render(<SupportRequestForm ownerId={OWNER} />);

    await fillAndSubmit(user, {
      category: BILLING,
      subject: "First",
      message: "Same text",
    });
    await screen.findByText(/has been sent/);
    await waitFor(() => expect(subjectInput()).toHaveValue(""));
    expect(storedDraft()).toBeNull();

    const nativeInput = (el: HTMLInputElement | HTMLTextAreaElement, value: string) => {
      const proto = Object.getPrototypeOf(el) as object;
      Object.getOwnPropertyDescriptor(proto, "value")!.set!.call(el, value);
      el.dispatchEvent(new Event("input", { bubbles: true }));
    };
    const nativeCheck = (el: HTMLInputElement) => {
      Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "checked")!.set!.call(
        el,
        true,
      );
      el.dispatchEvent(new Event("input", { bubbles: true }));
      el.dispatchEvent(new Event("change", { bubbles: true }));
    };

    act(() => nativeCheck(radio(BILLING) as HTMLInputElement));
    expect(storedDraft()).toEqual({ category: "billing", subject: "", message: "" });

    act(() => nativeInput(messageInput() as HTMLTextAreaElement, "Same text"));
    expect(storedDraft()).toEqual({
      category: "billing",
      subject: "",
      message: "Same text",
    });
  });

  it("forgets the draft when the fields are emptied by hand", async () => {
    const user = userEvent.setup();
    render(<SupportRequestForm ownerId={OWNER} />);

    await user.type(subjectInput(), "x");
    expect(storedDraft()).not.toBeNull();

    await user.clear(subjectInput());
    expect(storedDraft()).toBeNull();
  });

  it("never shows another user's draft, and removes it from the tab", () => {
    storeDraft({ ...DRAFT, subject: "Someone else's secret" }, SOMEONE_ELSE);

    render(<SupportRequestForm ownerId={OWNER} />);

    expect(subjectInput()).toHaveValue("");
    expect(screen.queryByText(COPY.draftRestored)).not.toBeInTheDocument();
    expect(storedDraft(SOMEONE_ELSE)).toBeNull();
  });

  it("does not put a draft back over text typed before the page finished loading", async () => {
    // Realistic race: the server-rendered fields accept typing before React
    // has hydrated; the restore runs only afterwards and must not clobber it.
    storeDraft(DRAFT);
    const container = document.createElement("div");
    document.body.appendChild(container);
    container.innerHTML = renderToString(<SupportRequestForm ownerId={OWNER} />);

    const early = container.querySelector<HTMLInputElement>('input[name="subject"]')!;
    early.value = "Typed while loading";

    const root = await act(async () =>
      hydrateRoot(container, <SupportRequestForm ownerId={OWNER} />),
    );

    expect(early).toHaveValue("Typed while loading");
    expect(container.querySelector("textarea")).toHaveValue("");
    expect(within(container).queryByText(COPY.draftRestored)).not.toBeInTheDocument();

    act(() => root.unmount());
    container.remove();
  });

  it.each([
    ["not JSON", "{oops"],
    ["not an object", JSON.stringify("a string")],
    ["a field of the wrong type", JSON.stringify({ ...DRAFT, subject: 42 })],
    ["an unknown category", JSON.stringify({ ...DRAFT, category: "sales" })],
    [
      "a subject longer than the form allows",
      JSON.stringify({
        ...DRAFT,
        subject: "x".repeat(SUPPORT_REQUEST_SUBJECT_MAX_LENGTH + 1),
      }),
    ],
    [
      "a message longer than the form allows",
      JSON.stringify({
        ...DRAFT,
        message: "x".repeat(SUPPORT_REQUEST_MESSAGE_MAX_LENGTH + 1),
      }),
    ],
    ["only blanks", JSON.stringify({ category: "", subject: "  ", message: "\n" })],
  ])("ignores a stored draft that is %s", (_label, raw) => {
    sessionStorage.setItem(draftKey(), raw);

    render(<SupportRequestForm ownerId={OWNER} />);

    expect(subjectInput()).toHaveValue("");
    expect(messageInput()).toHaveValue("");
    expect(screen.queryByText(COPY.draftRestored)).not.toBeInTheDocument();
  });

  it("restores a draft without a category (the user had not chosen one)", () => {
    storeDraft({ ...DRAFT, category: "" });

    render(<SupportRequestForm ownerId={OWNER} />);

    expect(subjectInput()).toHaveValue("Export stuck");
    for (const label of Object.values(SUPPORT_REQUEST_CATEGORY_LABELS)) {
      expect(radio(label)).not.toBeChecked();
    }
  });

  it("still works — without keeping drafts — when the tab's storage is blocked", async () => {
    vi.spyOn(window, "sessionStorage", "get").mockImplementation(() => {
      throw new DOMException("blocked", "SecurityError");
    });
    const user = userEvent.setup();
    render(<SupportRequestForm ownerId={OWNER} />);

    await fillAndSubmit(user);

    await screen.findByText(/has been sent/);
    vi.restoreAllMocks();
  });
});

describe("SupportRequestForm – one account per form", () => {
  it("every submission names the account the form was rendered for", async () => {
    const user = userEvent.setup();
    render(<SupportRequestForm ownerId={SOMEONE_ELSE} />);

    await fillAndSubmit(user);

    await waitFor(() => expect(action.createSupportRequestAction).toHaveBeenCalled());
    expect(sentFields(0).pageOwner).toBe(SOMEONE_ELSE);
  });

  it("the account cannot be smuggled in through a field of the form", async () => {
    // Even a field named like the owner in the DOM is overwritten on submit.
    const user = userEvent.setup();
    const { container } = render(<SupportRequestForm ownerId={OWNER} />);
    const smuggled = document.createElement("input");
    smuggled.type = "hidden";
    smuggled.name = "pageOwner";
    smuggled.value = SOMEONE_ELSE;
    container.querySelector("form")!.appendChild(smuggled);

    await fillAndSubmit(user);

    await waitFor(() => expect(action.createSupportRequestAction).toHaveBeenCalled());
    expect(
      action.createSupportRequestAction.mock.calls[0][1].getAll("pageOwner"),
    ).toEqual([OWNER]);
  });

  it("when sending is refused for another account: explains, offers sign-in, keeps the text here", async () => {
    const user = userEvent.setup();
    failWith({
      status: "error",
      reason: "accountChanged",
      error: SUPPORT_REQUEST_ERRORS.accountChanged,
    });
    render(<SupportRequestForm ownerId={OWNER} />);

    await fillAndSubmit(user, {
      category: TECHNICAL,
      subject: "Export stuck",
      message: "Since 9am.",
    });

    const alert = await screen.findByRole("alert");
    expect(alert).toHaveTextContent(SUPPORT_REQUEST_ERRORS.accountChanged);
    const link = within(alert).getByRole("link", { name: COPY.signInAgain });
    expect(link).toHaveAttribute("target", "_blank");

    // No field is blamed; the text stays for its author, on screen and in the
    // tab — under the form's account, not anyone else's.
    expect(subjectInput()).not.toHaveAttribute("aria-invalid");
    expect(subjectInput()).toHaveValue("Export stuck");
    expect(storedDraft(OWNER)).toMatchObject({ subject: "Export stuck" });
    expect(storedDraft(SOMEONE_ELSE)).toBeNull();
  });
});
