// @vitest-environment node
/**
 * The route's own contract, with the download service replaced: the session
 * comes first and its redirect is never swallowed, the service gets the
 * session's user id and the raw query string, and if the service breaks its
 * never-throws contract the answer is still no file.
 */
import { NextRequest } from "next/server";

import { beforeEach, describe, expect, it, vi } from "vitest";

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

const auth = vi.hoisted(() => ({
  getCurrentUser: vi.fn<() => Promise<{ id: string; email?: string | null } | null>>(),
}));
vi.mock("@/infrastructure/auth/session/get-current-user", () => auth);

const service = vi.hoisted(() => ({ prepareInvoiceDownload: vi.fn() }));
vi.mock("@/features/billing/services/invoice-download", () => ({
  prepareInvoiceDownload: service.prepareInvoiceDownload,
}));

import { GET } from "./route";

const USER = { id: "11111111-1111-4111-8111-111111111111", email: "jane@example.com" };

const download = (query = "") =>
  GET(new NextRequest(`https://app.example.com/billing/export/invoices${query}`));

beforeEach(() => {
  vi.clearAllMocks();
  vi.spyOn(console, "error").mockImplementation(() => {});
  auth.getCurrentUser.mockResolvedValue(USER);
  service.prepareInvoiceDownload.mockResolvedValue({
    ok: true,
    fileName: "x.csv",
    body: "A\r\n",
  });
});

describe("GET /billing/export/invoices – route contract", () => {
  it("passes the session's user id and the query string, nothing else", async () => {
    await download("?from=2026-03-01&userId=someone-else");

    expect(service.prepareInvoiceDownload).toHaveBeenCalledTimes(1);
    const [userId, searchParams] = service.prepareInvoiceDownload.mock.calls[0];
    expect(userId).toBe(USER.id);
    expect(searchParams).toBeInstanceOf(URLSearchParams);
    expect(searchParams.get("from")).toBe("2026-03-01");
  });

  it("lets the sign-in redirect through instead of turning it into an error", async () => {
    auth.getCurrentUser.mockResolvedValue(null);

    await expect(download()).rejects.toBeInstanceOf(RedirectSignal);
    expect(service.prepareInvoiceDownload).not.toHaveBeenCalled();
  });

  it("answers no file when the service throws, logging only the error's class", async () => {
    service.prepareInvoiceDownload.mockRejectedValue(
      new TypeError("boom: SECRET row content"),
    );

    const response = await download();

    expect(response.status).toBe(500);
    expect(response.headers.get("x-export-error")).toBe("internal_error");
    expect(response.headers.get("content-disposition")).toBeNull();
    expect(response.headers.get("content-type")).toBe("text/plain; charset=utf-8");
    expect(await response.text()).not.toContain("SECRET");
    expect(console.error).toHaveBeenCalledWith(
      "[billing] invoice download threw unexpectedly",
      {
        userId: USER.id,
        error: { name: "TypeError" },
      },
    );
    expect(JSON.stringify(vi.mocked(console.error).mock.calls)).not.toContain("SECRET");
  });

  it("answers no file when the outcome cannot be answered safely (a bad file name)", async () => {
    service.prepareInvoiceDownload.mockResolvedValue({
      ok: true,
      fileName: 'x".csv',
      body: "A\r\n",
      rowCount: 0,
    });

    const response = await download();

    expect(response.status).toBe(500);
    expect(response.headers.get("x-export-error")).toBe("internal_error");
    expect(response.headers.get("content-disposition")).toBeNull();
    expect(await response.text()).not.toContain("A\r\n");
  });

  it("answers failures as JSON when the request accepts it (the exports page)", async () => {
    service.prepareInvoiceDownload.mockResolvedValue({
      ok: false,
      code: "invalid_range",
      message: "Check the dates of your export.",
      fields: { from: "That day does not exist." },
    });

    const response = await GET(
      new NextRequest(`https://app.example.com/x?from=2026-02-30`, {
        headers: { accept: "application/json" },
      }),
    );

    expect(response.status).toBe(400);
    expect(await response.json()).toEqual({
      error: {
        code: "invalid_range",
        message: "Check the dates of your export.",
        fields: { from: "That day does not exist." },
      },
    });
  });

  it("answers an unexpected failure as JSON too, when accepted", async () => {
    service.prepareInvoiceDownload.mockRejectedValue(new Error("boom"));

    const response = await GET(
      new NextRequest("https://app.example.com/x", {
        headers: { accept: "application/json" },
      }),
    );

    expect(response.status).toBe(500);
    expect((await response.json()).error.code).toBe("internal_error");
  });
});
