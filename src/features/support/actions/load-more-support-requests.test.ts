// @vitest-environment node
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { encodeSupportRequestCursor } from "../services/support-request-cursor";

// --- boundaries ---------------------------------------------------------------

// The action must never redirect (it would navigate away from an unsent
// draft on the page); if it tried, the test fails loudly.
vi.mock("next/navigation", () => ({
  redirect: vi.fn((url: string) => {
    throw new Error(`unexpected redirect to ${url}`);
  }),
}));

const session = vi.hoisted(() => ({
  getCurrentUser: vi.fn<() => Promise<{ id: string } | null>>(),
}));
vi.mock("@/infrastructure/auth/session/get-current-user", () => session);

const service = vi.hoisted(() => ({
  listSupportRequests:
    vi.fn<
      (
        userId: string,
        options: { limit: number; before: { createdAt: string; id: string } },
      ) => Promise<unknown>
    >(),
  SUPPORT_REQUESTS_DEFAULT_LIMIT: 10,
}));
vi.mock("../services/list-support-requests", () => service);

import { SUPPORT_REQUEST_ERRORS } from "../services/support-request-errors";

import { loadMoreSupportRequests } from "./load-more-support-requests";

// ------------------------------------------------------------------------------

const USER = { id: "11111111-1111-4111-8111-111111111111" };
const OTHER = { id: "22222222-2222-4222-8222-222222222222" };
const POSITION = {
  createdAt: "2026-03-01T10:00:00.123456+00:00",
  id: "3f2504e0-4f89-41d3-9a0c-0305e82c3301",
};
const CURSOR = encodeSupportRequestCursor(POSITION);
const REQUEST = {
  id: "3f2504e0-4f89-41d3-9a0c-0305e82c3300",
  createdAt: "2026-02-01T10:00:00+00:00",
  category: "billing" as const,
  status: "open" as const,
  subject: "Older request",
  message: "Details.",
};

beforeEach(() => {
  vi.clearAllMocks();
  vi.spyOn(console, "error").mockImplementation(() => {});
  vi.spyOn(console, "warn").mockImplementation(() => {});
  session.getCurrentUser.mockResolvedValue(USER);
  service.listSupportRequests.mockResolvedValue({
    ok: true,
    requests: [REQUEST],
    nextCursor: null,
  });
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe("loadMoreSupportRequests – one account per list", () => {
  it("refuses a page for a list of another account than the session's; nothing is read", async () => {
    session.getCurrentUser.mockResolvedValue(OTHER);

    await expect(loadMoreSupportRequests(CURSOR, USER.id)).resolves.toEqual({
      ok: false,
      cursor: CURSOR,
      error: SUPPORT_REQUEST_ERRORS.listAccountChanged,
      recovery: "accountChanged",
    });
    expect(service.listSupportRequests).not.toHaveBeenCalled();
  });

  it.each([
    ["missing", undefined],
    ["not a string", 42],
    ["another account's id", OTHER.id],
  ])("refuses when the list's account is %s", async (_label, owner) => {
    await expect(loadMoreSupportRequests(CURSOR, owner)).resolves.toMatchObject({
      recovery: "accountChanged",
    });
    expect(service.listSupportRequests).not.toHaveBeenCalled();
  });

  it("reports an ended session as such, not as an account change", async () => {
    session.getCurrentUser.mockResolvedValue(null);

    await expect(loadMoreSupportRequests(CURSOR, USER.id)).resolves.toMatchObject({
      recovery: "signIn",
    });
  });
});

describe("loadMoreSupportRequests", () => {
  it("without a session, reads nothing and asks to sign in — never redirects", async () => {
    session.getCurrentUser.mockResolvedValue(null);

    await expect(loadMoreSupportRequests(CURSOR, USER.id)).resolves.toEqual({
      ok: false,
      cursor: CURSOR,
      error: SUPPORT_REQUEST_ERRORS.listSessionExpired,
      recovery: "signIn",
    });
    expect(service.listSupportRequests).not.toHaveBeenCalled();
  });

  it("without a session, does not even look at the cursor (nothing is logged about it)", async () => {
    session.getCurrentUser.mockResolvedValue(null);

    await loadMoreSupportRequests("forged", USER.id);

    expect(console.error).not.toHaveBeenCalled();
  });

  it("reads the page older than the cursor, for the verified user, at the page size", async () => {
    await expect(loadMoreSupportRequests(CURSOR, USER.id)).resolves.toEqual({
      ok: true,
      cursor: CURSOR,
      requests: [REQUEST],
      nextCursor: null,
    });

    expect(service.listSupportRequests).toHaveBeenCalledWith(USER.id, {
      limit: service.SUPPORT_REQUESTS_DEFAULT_LIMIT,
      before: POSITION,
    });
  });

  it("passes the next cursor on so the client can keep paging", async () => {
    const next = encodeSupportRequestCursor({ ...POSITION, id: REQUEST.id });
    service.listSupportRequests.mockResolvedValue({
      ok: true,
      requests: [REQUEST],
      nextCursor: next,
    });

    await expect(loadMoreSupportRequests(CURSOR, USER.id)).resolves.toMatchObject({
      nextCursor: next,
    });
  });

  it.each([
    ["a forged token", "not-a-cursor"],
    ["a token for another shape", btoa('{"t":"2026-03-01T10:00:00Z","i":7}')],
    [
      "an id smuggling a filter",
      btoa('{"t":"2026-03-01T10:00:00Z","i":"x,user_id.neq.y"}'),
    ],
    ["a number", 42],
    ["null", null],
    ["undefined", undefined],
    ["an object", { createdAt: POSITION.createdAt, id: POSITION.id }],
  ])("reads nothing for %s and asks for a reload", async (_label, cursor) => {
    const result = await loadMoreSupportRequests(cursor, USER.id);

    expect(result).toEqual({
      ok: false,
      cursor: typeof cursor === "string" ? cursor : "",
      error: SUPPORT_REQUEST_ERRORS.listRestart,
      recovery: "reload",
    });
    expect(service.listSupportRequests).not.toHaveBeenCalled();
  });

  it("logs the shape of a refused cursor, never its value", async () => {
    await loadMoreSupportRequests("AAAA-secret-looking-token", USER.id);

    expect(console.error).toHaveBeenCalledWith(
      "[support] refusing a cursor that is not one of ours",
      { userId: USER.id, received: "string" },
    );
    expect(JSON.stringify(vi.mocked(console.error).mock.calls)).not.toContain("secret");
  });

  it("offers a retry when the read fails", async () => {
    service.listSupportRequests.mockResolvedValue({ ok: false, failure: "unavailable" });

    await expect(loadMoreSupportRequests(CURSOR, USER.id)).resolves.toEqual({
      ok: false,
      cursor: CURSOR,
      error: SUPPORT_REQUEST_ERRORS.listUnavailable,
      recovery: "retry",
    });
  });

  it("asks to sign in when the database says the session ended mid-way", async () => {
    service.listSupportRequests.mockResolvedValue({
      ok: false,
      failure: "sessionExpired",
    });

    await expect(loadMoreSupportRequests(CURSOR, USER.id)).resolves.toEqual({
      ok: false,
      cursor: CURSOR,
      error: SUPPORT_REQUEST_ERRORS.listSessionExpired,
      recovery: "signIn",
    });
  });

  it("echoes the cursor it was asked for, so stale replies can be discarded", async () => {
    const other = encodeSupportRequestCursor({ ...POSITION, id: REQUEST.id });

    const [first, second] = await Promise.all([
      loadMoreSupportRequests(CURSOR, USER.id),
      loadMoreSupportRequests(other, USER.id),
    ]);

    expect(first.cursor).toBe(CURSOR);
    expect(second.cursor).toBe(other);
  });

  it("takes nothing else from the client: no page size, no user id", async () => {
    await loadMoreSupportRequests(CURSOR, USER.id);

    const [userId, options] = service.listSupportRequests.mock.calls[0];
    expect(userId).toBe(USER.id);
    expect(Object.keys(options).sort()).toEqual(["before", "limit"]);
  });
});
