/**
 * The creation flow end to end, short of the network: the real form, the real
 * Server Action, the real service and schema — only the Supabase client (and
 * the session lookup it depends on) is faked. Proves the pieces agree: what
 * the form sends is what the action reads, the schema's messages land under
 * the right field, and database outcomes reach the user as the right message
 * with their draft intact.
 */
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  createFakeSupabase,
  type FakeQueryResponse,
  OK_RESPONSE,
} from "@/shared/test/supabase";

const cache = vi.hoisted(() => ({ revalidatePath: vi.fn() }));
vi.mock("next/cache", () => cache);

vi.mock("next/navigation", () => ({
  redirect: vi.fn((url: string) => {
    throw new Error(`unexpected redirect to ${url}`);
  }),
}));

const session = vi.hoisted(() => ({
  getCurrentUser: vi.fn<() => Promise<{ id: string } | null>>(),
}));
vi.mock("@/infrastructure/auth/session/get-current-user", () => session);

const infra = vi.hoisted(() => ({ createClient: vi.fn<() => Promise<unknown>>() }));
vi.mock("@/infrastructure/auth/supabase/server", () => infra);

vi.mock("@/infrastructure/supabase/admin", () => ({
  createAdminClient: vi.fn(() => {
    throw new Error("the creation flow must not use the service role");
  }),
}));

import { SUPPORT_REQUEST_FIELD_ERRORS } from "../services/support-request";
import {
  SUPPORT_REQUEST_CATEGORY_LABELS,
  SUPPORT_REQUEST_FORM_COPY as COPY,
} from "../services/support-request-copy";
import { SUPPORT_REQUEST_ERRORS } from "../services/support-request-errors";

import { SupportRequestForm } from "./support-request-form";

const USER = { id: "11111111-1111-4111-8111-111111111111" };

const STORED = {
  id: "3f2504e0-4f89-41d3-9a0c-0305e82c3301",
  created_at: "2026-03-01T10:00:00+00:00",
  category: "technical",
  status: "open",
  subject: "Export stuck",
  message: "Since 9am.",
};

let database: ReturnType<typeof createFakeSupabase>;
let respond: () => FakeQueryResponse;

const radio = (label: string) => screen.getByRole("radio", { name: label });
const subjectInput = () => screen.getByLabelText(COPY.subjectLabel);
const messageInput = () => screen.getByLabelText(COPY.messageLabel);
const TECHNICAL = SUPPORT_REQUEST_CATEGORY_LABELS.technical;

async function fillAndSubmit(
  user: ReturnType<typeof userEvent.setup>,
  { subject = "  Export stuck ", message = "Since 9am." } = {},
) {
  await user.click(radio(TECHNICAL));
  await user.type(subjectInput(), subject);
  await user.type(messageInput(), message);
  await user.click(screen.getByRole("button", { name: COPY.submit }));
}

/** The draft is still on screen, exactly as typed. */
function expectDraftKept(subject = "  Export stuck ", message = "Since 9am.") {
  expect(radio(TECHNICAL)).toBeChecked();
  expect(subjectInput()).toHaveValue(subject);
  expect(messageInput()).toHaveValue(message);
}

beforeEach(() => {
  sessionStorage.clear();
  vi.clearAllMocks();
  vi.spyOn(console, "error").mockImplementation(() => {});
  session.getCurrentUser.mockResolvedValue(USER);
  respond = () => ({ ...OK_RESPONSE, status: 201, data: STORED });
  database = createFakeSupabase(() => respond());
  infra.createClient.mockResolvedValue(database.client);
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe("filing a support request", () => {
  it("stores the trimmed request as the user, confirms it and clears the form", async () => {
    const user = userEvent.setup();
    render(<SupportRequestForm ownerId={USER.id} />);

    await fillAndSubmit(user);

    expect(await screen.findByRole("status")).toHaveTextContent(
      "Your request \u201CExport stuck\u201D has been sent.",
    );

    expect(database.queries).toHaveLength(1);
    expect(database.queries[0].table).toBe("support_requests");
    expect(database.argsOf(database.queries[0], "insert")).toEqual([
      { category: "technical", subject: "Export stuck", message: "Since 9am." },
    ]);
    expect(cache.revalidatePath).toHaveBeenCalledWith("/support");

    expect(radio(TECHNICAL)).not.toBeChecked();
    expect(subjectInput()).toHaveValue("");
    expect(messageInput()).toHaveValue("");
  });
});

describe("validation", () => {
  it("refuses a blank subject under the subject, without touching the database", async () => {
    const user = userEvent.setup();
    render(<SupportRequestForm ownerId={USER.id} />);

    await fillAndSubmit(user, { subject: "   " });

    const alert = await screen.findByRole("alert");
    expect(alert).toHaveTextContent(SUPPORT_REQUEST_FIELD_ERRORS.subjectRequired);
    expect(subjectInput()).toHaveAttribute("aria-invalid", "true");
    expect(subjectInput()).toHaveAccessibleDescription(
      SUPPORT_REQUEST_FIELD_ERRORS.subjectRequired,
    );
    await waitFor(() => expect(subjectInput()).toHaveFocus());

    expect(database.queries).toHaveLength(0);
    expect(cache.revalidatePath).not.toHaveBeenCalled();
    expectDraftKept("   ");
  });

  it("refuses a subject with a control character (a pasted tab)", async () => {
    const user = userEvent.setup();
    render(<SupportRequestForm ownerId={USER.id} />);

    await fillAndSubmit(user, { subject: "Export\tstuck" });

    expect(await screen.findByRole("alert")).toHaveTextContent(
      SUPPORT_REQUEST_FIELD_ERRORS.subjectInvalid,
    );
    expect(database.queries).toHaveLength(0);
    expectDraftKept("Export\tstuck");
  });

  it("refuses a blank message under the message", async () => {
    const user = userEvent.setup();
    render(<SupportRequestForm ownerId={USER.id} />);

    await fillAndSubmit(user, { message: "  {Enter}  " });

    expect(await screen.findByRole("alert")).toHaveTextContent(
      SUPPORT_REQUEST_FIELD_ERRORS.messageRequired,
    );
    expect(messageInput()).toHaveAttribute("aria-invalid", "true");
    expect(subjectInput()).not.toHaveAttribute("aria-invalid");
    expect(database.queries).toHaveLength(0);
  });
});

describe("failures after validation", () => {
  it("explains the flood limit and keeps the draft", async () => {
    const user = userEvent.setup();
    respond = () => ({
      ...OK_RESPONSE,
      status: 429,
      data: null,
      error: { message: "Too many support requests; try again later", code: "PT429" },
    });
    render(<SupportRequestForm ownerId={USER.id} />);

    await fillAndSubmit(user);

    expect(await screen.findByRole("alert")).toHaveTextContent(
      SUPPORT_REQUEST_ERRORS.rateLimited,
    );
    expect(subjectInput()).not.toHaveAttribute("aria-invalid");
    expectDraftKept();
    expect(cache.revalidatePath).not.toHaveBeenCalled();
  });

  it("keeps the draft when the session is gone, without contacting the database", async () => {
    const user = userEvent.setup();
    session.getCurrentUser.mockResolvedValue(null);
    render(<SupportRequestForm ownerId={USER.id} />);

    await fillAndSubmit(user);

    const alert = await screen.findByRole("alert");
    expect(alert).toHaveTextContent(SUPPORT_REQUEST_ERRORS.sessionExpired);
    expect(screen.getByRole("link", { name: COPY.signInAgain })).toHaveAttribute(
      "target",
      "_blank",
    );
    expect(infra.createClient).not.toHaveBeenCalled();
    expectDraftKept();
  });

  it("treats a row-level-security refusal as an ended session", async () => {
    const user = userEvent.setup();
    respond = () => ({
      ...OK_RESPONSE,
      status: 403,
      data: null,
      error: { message: "new row violates row-level security policy", code: "42501" },
    });
    render(<SupportRequestForm ownerId={USER.id} />);

    await fillAndSubmit(user);

    expect(await screen.findByRole("alert")).toHaveTextContent(
      SUPPORT_REQUEST_ERRORS.sessionExpired,
    );
    expectDraftKept();
  });

  it("explains an outage without database wording, and a retry can succeed", async () => {
    const user = userEvent.setup();
    respond = () => ({
      ...OK_RESPONSE,
      status: 503,
      data: null,
      error: { message: 'relation "support_requests" is unavailable', code: "57P03" },
    });
    render(<SupportRequestForm ownerId={USER.id} />);

    await fillAndSubmit(user);

    const alert = await screen.findByRole("alert");
    expect(alert).toHaveTextContent(SUPPORT_REQUEST_ERRORS.unavailable);
    expect(alert).not.toHaveTextContent(/relation|support_requests/);
    expectDraftKept();

    respond = () => ({ ...OK_RESPONSE, status: 201, data: STORED });
    await user.click(screen.getByRole("button", { name: COPY.submit }));

    await screen.findByRole("status");
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
    expect(database.queries).toHaveLength(2);
    expect(database.argsOf(database.queries[1], "insert")).toEqual([
      { category: "technical", subject: "Export stuck", message: "Since 9am." },
    ]);
  });
});
