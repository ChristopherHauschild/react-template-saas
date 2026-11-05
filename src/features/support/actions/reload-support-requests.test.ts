// @vitest-environment node
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// The action must never redirect (it would navigate away from an unsent draft).
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
    vi.fn<(userId: string, options: { limit: number }) => Promise<unknown>>(),
  SUPPORT_REQUESTS_DEFAULT_LIMIT: 10,
}));
vi.mock("../services/list-support-requests", () => service);

import { reloadSupportRequests } from "./reload-support-requests";

const USER = { id: "11111111-1111-4111-8111-111111111111" };
const OTHER = { id: "22222222-2222-4222-8222-222222222222" };

beforeEach(() => {
  vi.clearAllMocks();
  vi.spyOn(console, "error").mockImplementation(() => {});
  vi.spyOn(console, "warn").mockImplementation(() => {});
  session.getCurrentUser.mockResolvedValue(USER);
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe("reloadSupportRequests", () => {
  it("reads the verified user's first page at the paging size", async () => {
    const page = { ok: true, requests: [], nextCursor: null };
    service.listSupportRequests.mockResolvedValue(page);

    await expect(reloadSupportRequests(USER.id)).resolves.toBe(page);
    expect(service.listSupportRequests).toHaveBeenCalledWith(USER.id, {
      limit: service.SUPPORT_REQUESTS_DEFAULT_LIMIT,
    });
  });

  it("without a session, reads nothing and reports it — never redirects", async () => {
    session.getCurrentUser.mockResolvedValue(null);

    await expect(reloadSupportRequests(USER.id)).resolves.toEqual({
      ok: false,
      failure: "sessionExpired",
    });
    expect(service.listSupportRequests).not.toHaveBeenCalled();
  });

  it("passes the reader's failures on unchanged", async () => {
    service.listSupportRequests.mockResolvedValue({
      ok: false,
      failure: "sessionExpired",
    });

    await expect(reloadSupportRequests(USER.id)).resolves.toEqual({
      ok: false,
      failure: "sessionExpired",
    });
  });

  it.each([
    [
      "the session lookup",
      () => session.getCurrentUser.mockRejectedValue(new TypeError("x")),
    ],
    [
      "the reader",
      () => service.listSupportRequests.mockRejectedValue(new TypeError("x")),
    ],
  ])("never throws when %s does", async (_label, arrange) => {
    arrange();

    await expect(reloadSupportRequests(USER.id)).resolves.toEqual({
      ok: false,
      failure: "unavailable",
    });
    expect(console.error).toHaveBeenCalledWith(
      "[support] reloading requests threw unexpectedly",
      { error: { name: "TypeError" } },
    );
  });

  it("logs only the type of a non-Error throw, never its value", async () => {
    service.listSupportRequests.mockRejectedValue("secret detail");

    await expect(reloadSupportRequests(USER.id)).resolves.toEqual({
      ok: false,
      failure: "unavailable",
    });
    expect(console.error).toHaveBeenCalledWith(
      "[support] reloading requests threw unexpectedly",
      { error: { name: "string" } },
    );
  });

  it("refuses to read when the session now belongs to another account than the list", async () => {
    session.getCurrentUser.mockResolvedValue(OTHER);

    await expect(reloadSupportRequests(USER.id)).resolves.toEqual({
      ok: false,
      failure: "accountChanged",
    });
    expect(service.listSupportRequests).not.toHaveBeenCalled();
  });

  it.each([
    ["missing", undefined],
    ["not a string", 42],
    ["another account's id", OTHER.id],
  ])("refuses when the list's account is %s", async (_label, owner) => {
    await expect(reloadSupportRequests(owner)).resolves.toEqual({
      ok: false,
      failure: "accountChanged",
    });
    expect(service.listSupportRequests).not.toHaveBeenCalled();
  });
});
