// @vitest-environment node
import { isValidElement, type ReactElement } from "react";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

class RedirectSignal extends Error {
  constructor(public readonly url: string) {
    super(`NEXT_REDIRECT ${url}`);
  }
}

vi.mock("next/navigation", () => ({
  redirect: vi.fn((url: string) => {
    throw new RedirectSignal(url);
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

import { SupportRequestHistory } from "./support-request-history";
import { SupportRequestHistorySection } from "./support-request-history-section";

const USER = { id: "11111111-1111-4111-8111-111111111111" };

beforeEach(() => {
  vi.clearAllMocks();
  vi.spyOn(console, "error").mockImplementation(() => {});
  session.getCurrentUser.mockResolvedValue(USER);
});

afterEach(() => {
  vi.restoreAllMocks();
});

const renderSection = async () => {
  const element = await SupportRequestHistorySection();
  expect(isValidElement(element)).toBe(true);
  return element as ReactElement<{ initial: unknown }>;
};

describe("SupportRequestHistorySection", () => {
  it("reads the verified user's first page at the paging size, and hands it to the list", async () => {
    const first = { ok: true, requests: [], nextCursor: null };
    service.listSupportRequests.mockResolvedValue(first);

    const element = await renderSection();

    expect(service.listSupportRequests).toHaveBeenCalledWith(USER.id, {
      limit: service.SUPPORT_REQUESTS_DEFAULT_LIMIT,
    });
    expect(element.type).toBe(SupportRequestHistory);
    expect(element.props.initial).toBe(first);
  });

  it("tells the list whose it is, and keys it by that account (a new account → a fresh list)", async () => {
    service.listSupportRequests.mockResolvedValue({
      ok: true,
      requests: [],
      nextCursor: null,
    });

    const element = await renderSection();

    expect((element.props as { ownerId?: string }).ownerId).toBe(USER.id);
    expect(element.key).toBe(USER.id);
  });

  it("passes a failed read on as a value (the list says 'unavailable')", async () => {
    service.listSupportRequests.mockResolvedValue({ ok: false, failure: "unavailable" });

    const element = await renderSection();

    expect(element.props.initial).toEqual({ ok: false, failure: "unavailable" });
  });

  it("holds even if the reader throws, so the form beside it stays up", async () => {
    service.listSupportRequests.mockRejectedValue(new TypeError("boom"));

    const element = await renderSection();

    expect(element.props.initial).toEqual({ ok: false, failure: "unavailable" });
    expect(console.error).toHaveBeenCalledWith(
      "[support] request history could not be loaded for the page",
      { error: { name: "TypeError" } },
    );
  });

  it("logs only the type of a non-Error throw, never its value", async () => {
    service.listSupportRequests.mockRejectedValue("secret detail");

    await renderSection();

    expect(console.error).toHaveBeenCalledWith(
      "[support] request history could not be loaded for the page",
      { error: { name: "string" } },
    );
  });

  it("reads nothing without a session (the guard redirects first)", async () => {
    session.getCurrentUser.mockResolvedValue(null);

    await expect(SupportRequestHistorySection()).rejects.toThrow("NEXT_REDIRECT /login");
    expect(service.listSupportRequests).not.toHaveBeenCalled();
  });
});
