// @vitest-environment node
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// --- boundaries ---------------------------------------------------------------

// The action must never redirect (it would discard the draft); if it tried,
// this makes the attempt fail the test loudly.
vi.mock("next/navigation", () => ({
  redirect: vi.fn((url: string) => {
    throw new Error(`unexpected redirect to ${url}`);
  }),
}));

const cache = vi.hoisted(() => ({ revalidatePath: vi.fn() }));
vi.mock("next/cache", () => cache);

const session = vi.hoisted(() => ({
  getCurrentUser: vi.fn<() => Promise<{ id: string } | null>>(),
}));
vi.mock("@/infrastructure/auth/session/get-current-user", () => session);

const service = vi.hoisted(() => ({
  createSupportRequest: vi.fn<(userId: string, input: unknown) => Promise<unknown>>(),
}));
vi.mock("../services/create-support-request", () => service);

import { SUPPORT_REQUEST_FIELD_ERRORS } from "../services/support-request";
import { SUPPORT_REQUEST_ERRORS } from "../services/support-request-errors";

import { createSupportRequestAction } from "./create-support-request";

// ------------------------------------------------------------------------------

const USER = { id: "11111111-1111-4111-8111-111111111111" };
const OTHER = { id: "22222222-2222-4222-8222-222222222222" };

const STORED = {
  id: "3f2504e0-4f89-41d3-9a0c-0305e82c3301",
  createdAt: "2026-03-01T10:00:00+00:00",
  category: "billing" as const,
  status: "open" as const,
  subject: "Charged twice",
  message: "I see two charges for March.",
};

const form = (fields: Record<string, string | Blob> = {}) => {
  const data = new FormData();
  const values = {
    pageOwner: USER.id,
    category: "billing",
    subject: "Charged twice",
    message: "I see two charges for March.",
    ...fields,
  };

  for (const [key, value] of Object.entries(values)) data.append(key, value);

  return data;
};

beforeEach(() => {
  vi.clearAllMocks();
  vi.spyOn(console, "error").mockImplementation(() => {});
  vi.spyOn(console, "warn").mockImplementation(() => {});
  session.getCurrentUser.mockResolvedValue(USER);
  service.createSupportRequest.mockResolvedValue({ ok: true, request: STORED });
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe("createSupportRequestAction – the session", () => {
  it("without a session, keeps the draft and reports it instead of redirecting", async () => {
    session.getCurrentUser.mockResolvedValue(null);

    await expect(
      createSupportRequestAction(
        null,
        form({ subject: "  Locked out  ", message: "A long message I wrote." }),
      ),
    ).resolves.toEqual({
      status: "error",
      error: SUPPORT_REQUEST_ERRORS.sessionExpired,
      reason: "sessionExpired",
    });

    // Nothing is read or written without a user.
    expect(service.createSupportRequest).not.toHaveBeenCalled();
    expect(cache.revalidatePath).not.toHaveBeenCalled();
  });

  it("files the request for the verified user, never for an id from the form", async () => {
    const other = "22222222-2222-4222-8222-222222222222";

    await createSupportRequestAction(null, form({ user_id: other, userId: other }));

    expect(service.createSupportRequest).toHaveBeenCalledWith(USER.id, {
      category: "billing",
      subject: "Charged twice",
      message: "I see two charges for March.",
    });
    // Only the three fields reach the service.
    const [, input] = service.createSupportRequest.mock.calls[0];
    expect(Object.keys(input as object).sort()).toEqual([
      "category",
      "message",
      "subject",
    ]);
  });

  it("ignores a status or created_at smuggled into the form", async () => {
    await createSupportRequestAction(
      null,
      form({ status: "closed", created_at: "2020-01-01T00:00:00Z", id: "forged" }),
    );

    const [, input] = service.createSupportRequest.mock.calls[0];
    expect(input).toEqual({
      category: "billing",
      subject: "Charged twice",
      message: "I see two charges for March.",
    });
  });
});

describe("createSupportRequestAction – one account per page", () => {
  it("refuses to send when the session now belongs to another account; nothing is written", async () => {
    // The page (and its draft) were for USER; someone signed in as OTHER since.
    session.getCurrentUser.mockResolvedValue(OTHER);

    await expect(createSupportRequestAction(null, form())).resolves.toEqual({
      status: "error",
      error: SUPPORT_REQUEST_ERRORS.accountChanged,
      reason: "accountChanged",
    });
    expect(service.createSupportRequest).not.toHaveBeenCalled();
    expect(cache.revalidatePath).not.toHaveBeenCalled();
  });

  it.each([
    ["missing", undefined],
    ["empty", ""],
    ["not text", new Blob([USER.id])],
  ])("refuses when the page's account is %s", async (_label, owner) => {
    const data = form();
    data.delete("pageOwner");
    if (owner !== undefined) data.append("pageOwner", owner);

    await expect(createSupportRequestAction(null, data)).resolves.toMatchObject({
      reason: "accountChanged",
    });
    expect(service.createSupportRequest).not.toHaveBeenCalled();
  });

  it("a page claiming another account cannot act for it: the session still decides", async () => {
    // A forged owner only gets the request refused; it never picks an owner.
    await expect(
      createSupportRequestAction(null, form({ pageOwner: OTHER.id })),
    ).resolves.toMatchObject({ reason: "accountChanged" });
    expect(service.createSupportRequest).not.toHaveBeenCalled();
  });

  it("files under the session's user when the page is theirs — the owner field is not passed on", async () => {
    await createSupportRequestAction(null, form());

    const [userId, input] = service.createSupportRequest.mock.calls[0];
    expect(userId).toBe(USER.id);
    expect(input).not.toHaveProperty("pageOwner");
  });

  it("reports an ended session as such, not as an account change", async () => {
    session.getCurrentUser.mockResolvedValue(null);

    await expect(createSupportRequestAction(null, form())).resolves.toMatchObject({
      reason: "sessionExpired",
    });
  });
});

describe("createSupportRequestAction – success", () => {
  it("reports the stored request and revalidates the support page", async () => {
    await expect(createSupportRequestAction(null, form())).resolves.toEqual({
      status: "sent",
      request: STORED,
    });
    expect(cache.revalidatePath).toHaveBeenCalledWith("/support");
  });

  it("still reports success when the request could not be read back", async () => {
    service.createSupportRequest.mockResolvedValue({ ok: true, request: null });

    await expect(createSupportRequestAction(null, form())).resolves.toEqual({
      status: "sent",
      request: null,
    });
    // The page reloads the list, which is where the request will appear.
    expect(cache.revalidatePath).toHaveBeenCalledWith("/support");
  });
});

describe("createSupportRequestAction – failures", () => {
  it("returns the field and its message for invalid input", async () => {
    service.createSupportRequest.mockResolvedValue({
      ok: false,
      failure: "invalid",
      field: "subject",
      error: SUPPORT_REQUEST_FIELD_ERRORS.subjectRequired,
    });

    await expect(
      createSupportRequestAction(null, form({ subject: "  ", message: "  Help me  " })),
    ).resolves.toEqual({
      status: "error",
      error: SUPPORT_REQUEST_FIELD_ERRORS.subjectRequired,
      reason: "invalid",
      field: "subject",
    });
    expect(cache.revalidatePath).not.toHaveBeenCalled();
  });

  it.each([
    ["rateLimited", SUPPORT_REQUEST_ERRORS.rateLimited],
    ["sessionExpired", SUPPORT_REQUEST_ERRORS.sessionExpired],
    ["unavailable", SUPPORT_REQUEST_ERRORS.unavailable],
    ["invalid", SUPPORT_REQUEST_ERRORS.invalid],
  ])("explains a %s failure without naming a field", async (failure, message) => {
    service.createSupportRequest.mockResolvedValue({ ok: false, failure });

    const result = await createSupportRequestAction(null, form());

    expect(result).toMatchObject({ status: "error", error: message, reason: failure });
    expect(result).not.toHaveProperty("field");
    expect(cache.revalidatePath).not.toHaveBeenCalled();
  });

  it("never echoes what the user wrote (the form keeps its own fields)", async () => {
    service.createSupportRequest.mockResolvedValue({ ok: false, failure: "unavailable" });

    const result = await createSupportRequestAction(
      null,
      form({ subject: "Private subject", message: "Private details" }),
    );

    expect(JSON.stringify(result)).not.toMatch(/Private/);
  });

  it("treats missing or non-text fields as empty rather than crashing", async () => {
    service.createSupportRequest.mockResolvedValue({
      ok: false,
      failure: "invalid",
      field: "subject",
      error: SUPPORT_REQUEST_FIELD_ERRORS.subjectRequired,
    });

    const data = new FormData();
    data.append("pageOwner", USER.id);
    data.append("message", new Blob(["binary"]));

    await createSupportRequestAction(null, data);

    expect(service.createSupportRequest).toHaveBeenCalledWith(USER.id, {
      category: "",
      subject: "",
      message: "",
    });
  });

  it("never throws for a service failure (the page must not be replaced by an error screen)", async () => {
    service.createSupportRequest.mockResolvedValue({ ok: false, failure: "unavailable" });

    await expect(createSupportRequestAction(null, form())).resolves.toMatchObject({
      status: "error",
    });
  });
});
