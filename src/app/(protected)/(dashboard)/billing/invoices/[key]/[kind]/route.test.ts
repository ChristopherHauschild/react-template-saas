// @vitest-environment node
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

const billing = vi.hoisted(() => ({
  getInvoiceDocument:
    vi.fn<
      (
        userId: string,
        key: unknown,
        kind: "view" | "pdf",
      ) => Promise<
        import("@/features/billing/services/get-invoice-document").InvoiceDocumentResult
      >
    >(),
}));
vi.mock("@/features/billing/services/get-invoice-document", () => billing);

import { GET } from "./route";

const USER = { id: "11111111-1111-4111-8111-111111111111", email: "jane@example.com" };
const KEY = "aW5fMU5YV1Bu"; // an opaque key; the service decodes it
const PDF_URL = "https://pay.stripe.com/invoice/acct_1/test_abc/pdf?s=ap";

const get = (key: string, kind: string) =>
  GET(new NextRequest(`https://app.example.com/billing/invoices/${key}/${kind}`), {
    params: Promise.resolve({ key, kind }),
  });

beforeEach(() => {
  vi.clearAllMocks();
  vi.spyOn(console, "error").mockImplementation(() => {});
  auth.getCurrentUser.mockResolvedValue(USER);
  billing.getInvoiceDocument.mockResolvedValue({ kind: "ok", url: PDF_URL });
});

describe("GET /billing/invoices/[key]/[kind]", () => {
  it("redirects the signed-in user to the document Stripe currently serves, uncached", async () => {
    const response = await get(KEY, "pdf");

    expect(response.status).toBe(302);
    expect(response.headers.get("location")).toBe(PDF_URL);
    expect(response.headers.get("cache-control")).toBe("no-store");
    expect(billing.getInvoiceDocument).toHaveBeenCalledWith(USER.id, KEY, "pdf");
  });

  it("asks for the hosted page for /view", async () => {
    await get(KEY, "view");

    expect(billing.getInvoiceDocument).toHaveBeenCalledWith(USER.id, KEY, "view");
  });

  it("redirects anonymous visitors to /login without consulting anything", async () => {
    auth.getCurrentUser.mockResolvedValue(null);

    await expect(get(KEY, "pdf")).rejects.toMatchObject({ url: "/login" });
    expect(billing.getInvoiceDocument).not.toHaveBeenCalled();
  });

  it("sends the user back with a RELATIVE location, so the browser stays on the origin its session cookie is scoped to", async () => {
    billing.getInvoiceDocument.mockResolvedValue({
      kind: "missing",
      reason: "not_found",
    });

    const response = await GET(
      new NextRequest(`http://localhost:3000/billing/invoices/${KEY}/pdf`), // what Next reports in dev
      { params: Promise.resolve({ key: KEY, kind: "pdf" }) },
    );

    expect(response.headers.get("location")).toBe("/billing?document=missing");
    expect(response.headers.get("location")).not.toMatch(/localhost|https?:/);
  });

  it("sends a document that does not exist for the user back to billing with a 'missing' notice", async () => {
    for (const reason of [
      "invalid_key",
      "not_found",
      "foreign_invoice",
      "draft",
      "no_document",
      "invalid_url",
    ] as const) {
      billing.getInvoiceDocument.mockResolvedValue({ kind: "missing", reason });

      const response = await get(KEY, "pdf");

      expect(response.status).toBe(303);
      expect(response.headers.get("location")).toBe("/billing?document=missing");
      expect(response.headers.get("cache-control")).toBe("no-store");
    }
  });

  it("sends a refused or unavailable document back to billing with an 'unavailable' notice, and logs it", async () => {
    billing.getInvoiceDocument.mockResolvedValue({
      kind: "refused",
      reason: "ambiguous",
    });

    let response = await get(KEY, "view");

    expect(response.status).toBe(303);
    expect(response.headers.get("location")).toBe("/billing?document=unavailable");
    expect(console.error).toHaveBeenCalledWith(expect.stringMatching(/not opened/), {
      userId: USER.id,
      kind: "view",
      outcome: "refused",
      reason: "ambiguous",
    });

    billing.getInvoiceDocument.mockResolvedValue({
      kind: "unavailable",
      reason: "stripe_error",
    });

    response = await get(KEY, "pdf");

    expect(response.headers.get("location")).toBe("/billing?document=unavailable");
  });

  it("treats an unknown document kind as missing without consulting the service", async () => {
    for (const kind of ["html", "PDF", "hosted_invoice_url", "..", ""]) {
      const response = await get(KEY, kind);

      expect(response.status).toBe(303);
      expect(response.headers.get("location")).toBe("/billing?document=missing");
    }

    expect(billing.getInvoiceDocument).not.toHaveBeenCalled();
  });

  it("hands the key to the service untouched; validating it is the service's job", async () => {
    await get("../../etc/passwd", "pdf");

    expect(billing.getInvoiceDocument).toHaveBeenCalledWith(
      USER.id,
      "../../etc/passwd",
      "pdf",
    );
  });

  it("lets an unexpected failure reach Next's error handling", async () => {
    billing.getInvoiceDocument.mockRejectedValue(new Error("cookies unavailable"));

    await expect(get(KEY, "pdf")).rejects.toThrow("cookies unavailable");
  });
});
