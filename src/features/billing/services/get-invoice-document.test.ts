// @vitest-environment node
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// --- boundaries ---------------------------------------------------------------

const stripe = vi.hoisted(() => ({
  invoicesRetrieve: vi.fn<(id: string) => Promise<unknown>>(),
  invoicesList: vi.fn(),
  portalCreate: vi.fn(),
  checkoutCreate: vi.fn(),
}));
vi.mock("@/infrastructure/stripe", () => ({
  getStripe: () => ({
    invoices: { retrieve: stripe.invoicesRetrieve, list: stripe.invoicesList },
    billingPortal: { sessions: { create: stripe.portalCreate } },
    checkout: { sessions: { create: stripe.checkoutCreate } },
  }),
}));

const billing = vi.hoisted(() => ({
  getSubscriptionOverview:
    vi.fn<
      (
        userId: string,
      ) => Promise<import("./get-subscription-overview").SubscriptionOverview>
    >(),
}));
vi.mock("./get-subscription-overview", () => billing);

import { getInvoiceDocument } from "./get-invoice-document";
import { encodeInvoiceKey } from "./invoice-history";

// ------------------------------------------------------------------------------

const USER_ID = "11111111-1111-4111-8111-111111111111";
const CUSTOMER = "cus_existing";
const INVOICE_ID = "in_1NXWPnCRMbs6FrXv";
const KEY = encodeInvoiceKey(INVOICE_ID);
const HOSTED_URL = "https://invoice.stripe.com/i/acct_1/test_YWNjdF8xLF9hYmM?s=ap";
const PDF_URL = "https://pay.stripe.com/invoice/acct_1/test_YWNjdF8xLF9hYmM/pdf?s=ap";

type Overview = import("./get-subscription-overview").SubscriptionOverview;
type OkOverview = Extract<Overview, { ok: true }>;

const withCustomer = (stripeCustomerId: string | null, status = "active"): OkOverview => {
  const current = {
    stripeSubscriptionId: "sub_1",
    stripeCustomerId,
    status,
    rowCount: 1,
    statusConflict: false,
    customerConflict: false,
    isServicing: status === "active",
  };

  return {
    ok: true,
    stripeCustomerId,
    customerResolution:
      stripeCustomerId === null ? { kind: "none" } : { kind: "single", stripeCustomerId },
    current,
    isServicing: current.isServicing,
    subscriptions: [current],
  };
};

const ambiguous = (): OkOverview => ({
  ...withCustomer("cus_A"),
  stripeCustomerId: null,
  customerResolution: { kind: "ambiguous", reason: "multiple_customers", customers: 2 },
});

const stripeInvoice = (overrides: Record<string, unknown> = {}) => ({
  id: INVOICE_ID,
  object: "invoice",
  customer: CUSTOMER,
  status: "paid",
  hosted_invoice_url: HOSTED_URL,
  invoice_pdf: PDF_URL,
  ...overrides,
});

const stripeError = (fields: Record<string, unknown>) =>
  Object.assign(new Error(String(fields.message ?? "stripe error")), fields);

const logged = () =>
  JSON.stringify([
    ...vi.mocked(console.error).mock.calls,
    ...vi.mocked(console.warn).mock.calls,
  ]);

beforeEach(() => {
  vi.clearAllMocks();
  vi.spyOn(console, "error").mockImplementation(() => {});
  vi.spyOn(console, "warn").mockImplementation(() => {});
  billing.getSubscriptionOverview.mockResolvedValue(withCustomer(CUSTOMER));
  stripe.invoicesRetrieve.mockResolvedValue(stripeInvoice());
});

afterEach(() => {
  vi.unstubAllEnvs();
});

describe("getInvoiceDocument – the document is the user's", () => {
  it("fetches the invoice by the decoded key and returns Stripe's current URL for the hosted page", async () => {
    await expect(getInvoiceDocument(USER_ID, KEY, "view")).resolves.toEqual({
      kind: "ok",
      url: HOSTED_URL,
    });
    expect(stripe.invoicesRetrieve).toHaveBeenCalledTimes(1);
    expect(stripe.invoicesRetrieve).toHaveBeenCalledWith(INVOICE_ID);
    expect(console.error).not.toHaveBeenCalled();
  });

  it("returns the PDF URL for the pdf document", async () => {
    await expect(getInvoiceDocument(USER_ID, KEY, "pdf")).resolves.toEqual({
      kind: "ok",
      url: PDF_URL,
    });
  });

  it("resolves the customer from the user's own rows on every call", async () => {
    await getInvoiceDocument(USER_ID, KEY, "view");

    expect(billing.getSubscriptionOverview).toHaveBeenCalledTimes(1);
    expect(billing.getSubscriptionOverview).toHaveBeenCalledWith(USER_ID);
  });

  it("accepts an expanded customer object naming the same customer", async () => {
    stripe.invoicesRetrieve.mockResolvedValue(
      stripeInvoice({ customer: { id: CUSTOMER, object: "customer" } }),
    );

    await expect(getInvoiceDocument(USER_ID, KEY, "view")).resolves.toMatchObject({
      kind: "ok",
    });
  });

  it.each(["open", "void", "uncollectible", "some_future_status"])(
    "opens documents of a %s invoice (anything issued)",
    async (status) => {
      stripe.invoicesRetrieve.mockResolvedValue(stripeInvoice({ status }));

      await expect(getInvoiceDocument(USER_ID, KEY, "view")).resolves.toMatchObject({
        kind: "ok",
      });
    },
  );

  it("opens a document on a configured custom invoice domain", async () => {
    vi.stubEnv(
      "STRIPE_INVOICE_DOCUMENT_HOSTS",
      "invoices.example.com, other.example.com",
    );
    stripe.invoicesRetrieve.mockResolvedValue(
      stripeInvoice({ invoice_pdf: "https://invoices.example.com/i/abc/pdf" }),
    );

    await expect(getInvoiceDocument(USER_ID, KEY, "pdf")).resolves.toEqual({
      kind: "ok",
      url: "https://invoices.example.com/i/abc/pdf",
    });
  });

  it("never touches Checkout, the portal, or the list", async () => {
    await getInvoiceDocument(USER_ID, KEY, "view");

    expect(stripe.checkoutCreate).not.toHaveBeenCalled();
    expect(stripe.portalCreate).not.toHaveBeenCalled();
    expect(stripe.invoicesList).not.toHaveBeenCalled();
  });
});

describe("getInvoiceDocument – ownership", () => {
  it("reports an invoice of another customer as missing, asks Stripe nothing further, and logs it", async () => {
    stripe.invoicesRetrieve.mockResolvedValue(stripeInvoice({ customer: "cus_victim" }));

    await expect(getInvoiceDocument(USER_ID, KEY, "pdf")).resolves.toEqual({
      kind: "missing",
      reason: "foreign_invoice",
    });
    expect(console.error).toHaveBeenCalledWith(
      expect.stringMatching(/another customer/),
      { userId: USER_ID },
    );
    expect(logged()).not.toMatch(/cus_victim|in_1NXW|stripe\.com/);
  });

  it("reports an invoice whose customer is missing or malformed as missing", async () => {
    for (const customer of [null, undefined, "", { id: "cus_other" }, 42]) {
      stripe.invoicesRetrieve.mockResolvedValue(stripeInvoice({ customer }));

      await expect(getInvoiceDocument(USER_ID, KEY, "pdf")).resolves.toEqual({
        kind: "missing",
        reason: "foreign_invoice",
      });
    }
  });

  it("refuses to open anything when the user has no billing account", async () => {
    billing.getSubscriptionOverview.mockResolvedValue(withCustomer(null, "incomplete"));

    await expect(getInvoiceDocument(USER_ID, KEY, "view")).resolves.toEqual({
      kind: "refused",
      reason: "no_customer",
    });
    expect(stripe.invoicesRetrieve).not.toHaveBeenCalled();
  });

  it("refuses to open anything when the customer is ambiguous, logging counts only", async () => {
    billing.getSubscriptionOverview.mockResolvedValue(ambiguous());

    await expect(getInvoiceDocument(USER_ID, KEY, "view")).resolves.toEqual({
      kind: "refused",
      reason: "ambiguous",
    });
    expect(stripe.invoicesRetrieve).not.toHaveBeenCalled();
    expect(console.error).toHaveBeenCalledWith(expect.stringMatching(/ambiguous/), {
      userId: USER_ID,
      reason: "multiple_customers",
      customers: 2,
      subscriptions: 1,
    });
    expect(logged()).not.toMatch(/cus_A/);
  });

  it("refuses when the records cannot be read", async () => {
    billing.getSubscriptionOverview.mockResolvedValue({
      ok: false,
      error: { message: "permission denied", code: "42501" },
    });

    await expect(getInvoiceDocument(USER_ID, KEY, "view")).resolves.toEqual({
      kind: "refused",
      reason: "records_unreadable",
    });
    expect(stripe.invoicesRetrieve).not.toHaveBeenCalled();
  });

  it("refuses a stored customer id that is not a Stripe customer id", async () => {
    billing.getSubscriptionOverview.mockResolvedValue({
      ...withCustomer("x"),
      customerResolution: { kind: "single", stripeCustomerId: "not-a-customer" },
    });

    await expect(getInvoiceDocument(USER_ID, KEY, "view")).resolves.toEqual({
      kind: "refused",
      reason: "invalid_customer_id",
    });
    expect(stripe.invoicesRetrieve).not.toHaveBeenCalled();
  });
});

describe("getInvoiceDocument – keys from the client", () => {
  it.each([
    ["a raw Stripe id", INVOICE_ID],
    ["a customer id in disguise", encodeInvoiceKey("cus_victim")],
    ["garbage", "!!!"],
    ["an empty string", ""],
    ["a number", 42],
    ["null", null],
    ["undefined", undefined],
    ["an object", { key: KEY }],
  ])("refuses %s before reading anything", async (_name, key) => {
    await expect(getInvoiceDocument(USER_ID, key, "view")).resolves.toEqual({
      kind: "missing",
      reason: "invalid_key",
    });
    expect(billing.getSubscriptionOverview).not.toHaveBeenCalled();
    expect(stripe.invoicesRetrieve).not.toHaveBeenCalled();
    expect(logged()).not.toMatch(/victim|!!!/);
  });
});

describe("getInvoiceDocument – what Stripe has (not) made available", () => {
  it("reports a draft as missing: nothing has been issued", async () => {
    stripe.invoicesRetrieve.mockResolvedValue(stripeInvoice({ status: "draft" }));

    await expect(getInvoiceDocument(USER_ID, KEY, "view")).resolves.toEqual({
      kind: "missing",
      reason: "draft",
    });
  });

  it("reports a document Stripe has not provided as missing, per document", async () => {
    stripe.invoicesRetrieve.mockResolvedValue(stripeInvoice({ invoice_pdf: null }));

    await expect(getInvoiceDocument(USER_ID, KEY, "pdf")).resolves.toEqual({
      kind: "missing",
      reason: "no_document",
    });
    await expect(getInvoiceDocument(USER_ID, KEY, "view")).resolves.toMatchObject({
      kind: "ok",
    });

    stripe.invoicesRetrieve.mockResolvedValue(
      stripeInvoice({ hosted_invoice_url: undefined }),
    );

    await expect(getInvoiceDocument(USER_ID, KEY, "view")).resolves.toEqual({
      kind: "missing",
      reason: "no_document",
    });
  });

  it("never follows a URL that is not an invoice document URL, and logs its shape only", async () => {
    for (const invoice_pdf of [
      "http://pay.stripe.com/invoice/x/pdf",
      "https://evil.example/x.pdf",
      "javascript:alert(1)",
      "pay.stripe.com/invoice/x/pdf",
      42,
      {},
    ]) {
      stripe.invoicesRetrieve.mockResolvedValue(stripeInvoice({ invoice_pdf }));

      await expect(getInvoiceDocument(USER_ID, KEY, "pdf")).resolves.toEqual({
        kind: "missing",
        reason: "invalid_url",
      });
    }

    expect(logged()).not.toMatch(/evil|javascript|alert/);
  });

  it("reports a deleted invoice as missing", async () => {
    stripe.invoicesRetrieve.mockResolvedValue({
      id: INVOICE_ID,
      object: "invoice",
      deleted: true,
    });

    await expect(getInvoiceDocument(USER_ID, KEY, "view")).resolves.toEqual({
      kind: "missing",
      reason: "not_found",
    });
  });

  it("reports an invoice Stripe does not know as missing (a warning, not an outage)", async () => {
    stripe.invoicesRetrieve.mockRejectedValue(
      stripeError({
        name: "StripeInvalidRequestError",
        type: "StripeInvalidRequestError",
        code: "resource_missing",
        param: "id",
        statusCode: 404,
        requestId: "req_404",
        message: `No such invoice: '${INVOICE_ID}'`,
      }),
    );

    await expect(getInvoiceDocument(USER_ID, KEY, "view")).resolves.toEqual({
      kind: "missing",
      reason: "not_found",
    });
    expect(console.error).not.toHaveBeenCalled();
    expect(console.warn).toHaveBeenCalledWith(
      expect.stringMatching(/does not know the requested invoice/),
      expect.objectContaining({
        error: expect.objectContaining({ requestId: "req_404" }),
      }),
    );
    expect(logged()).not.toMatch(/No such invoice/);
  });
});

describe("getInvoiceDocument – failing closed", () => {
  it("is unavailable when Stripe does not know the customer", async () => {
    stripe.invoicesRetrieve.mockRejectedValue(
      stripeError({
        type: "StripeInvalidRequestError",
        code: "resource_missing",
        param: "customer",
      }),
    );

    await expect(getInvoiceDocument(USER_ID, KEY, "view")).resolves.toEqual({
      kind: "unavailable",
      reason: "customer_missing",
    });
  });

  it("is unavailable on any other Stripe failure, logging stable fields but never the message", async () => {
    stripe.invoicesRetrieve.mockRejectedValue(
      stripeError({
        name: "StripeAPIError",
        type: "StripeAPIError",
        statusCode: 500,
        requestId: "req_500",
        message: `Something went wrong with ${INVOICE_ID}`,
      }),
    );

    await expect(getInvoiceDocument(USER_ID, KEY, "view")).resolves.toEqual({
      kind: "unavailable",
      reason: "stripe_error",
    });
    expect(logged()).toMatch(/req_500/);
    expect(logged()).not.toMatch(/Something went wrong|in_1NXW/);
  });

  it("is unavailable when the failure is not a Stripe error at all", async () => {
    stripe.invoicesRetrieve.mockRejectedValue(new TypeError("fetch failed"));

    await expect(getInvoiceDocument(USER_ID, KEY, "view")).resolves.toEqual({
      kind: "unavailable",
      reason: "stripe_error",
    });
  });

  it("refuses an answer that is not an invoice object", async () => {
    for (const answer of [null, undefined, "ok", 42]) {
      stripe.invoicesRetrieve.mockResolvedValue(answer);

      await expect(getInvoiceDocument(USER_ID, KEY, "view")).resolves.toEqual({
        kind: "unavailable",
        reason: "unusable_response",
      });
    }
  });

  it("refuses an answer that is a different invoice than the one asked for", async () => {
    stripe.invoicesRetrieve.mockResolvedValue(stripeInvoice({ id: "in_other" }));

    await expect(getInvoiceDocument(USER_ID, KEY, "view")).resolves.toEqual({
      kind: "unavailable",
      reason: "unusable_response",
    });
  });

  it("never returns a URL in any non-ok result", async () => {
    const outcomes: unknown[] = [];

    stripe.invoicesRetrieve.mockResolvedValue(stripeInvoice({ customer: "cus_victim" }));
    outcomes.push(await getInvoiceDocument(USER_ID, KEY, "view"));
    stripe.invoicesRetrieve.mockResolvedValue(stripeInvoice({ status: "draft" }));
    outcomes.push(await getInvoiceDocument(USER_ID, KEY, "view"));
    stripe.invoicesRetrieve.mockRejectedValue(new Error("boom"));
    outcomes.push(await getInvoiceDocument(USER_ID, KEY, "view"));

    expect(JSON.stringify(outcomes)).not.toMatch(/https?:|stripe\.com/);
  });
});
