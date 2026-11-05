// @vitest-environment node
import Stripe from "stripe";
import { describe, expect, it } from "vitest";

import {
  isMissingCustomerError,
  isStripeCustomerId,
  isUsablePortalSession,
  summarizePortalErrorForLog,
} from "./portal-errors";

describe("isStripeCustomerId", () => {
  it.each(["cus_123", "cus_NffrFeUfNV2Hib", "cus_a"])("accepts %s", (id) => {
    expect(isStripeCustomerId(id)).toBe(true);
  });

  it.each([
    "cus_",
    " cus_123",
    "cus_123 ",
    "CUS_123",
    "sub_123",
    "price_123",
    "jane@example.com",
    "cus_123;drop",
    "",
    null,
    undefined,
    42,
    { id: "cus_123" },
  ])("rejects %j", (value) => {
    expect(isStripeCustomerId(value)).toBe(false);
  });
});

describe("isMissingCustomerError", () => {
  it("recognises stripe-node's error for an unknown customer", () => {
    const error = new Stripe.errors.StripeInvalidRequestError({
      type: "invalid_request_error",
      code: "resource_missing",
      param: "customer",
      message: "No such customer: 'cus_x'",
    });

    expect(isMissingCustomerError(error)).toBe(true);
  });

  it("recognises the same shape on a plain object", () => {
    expect(
      isMissingCustomerError({
        type: "StripeInvalidRequestError",
        code: "resource_missing",
        param: "customer",
      }),
    ).toBe(true);
  });

  it.each([
    [
      "another missing resource",
      {
        type: "StripeInvalidRequestError",
        code: "resource_missing",
        param: "configuration",
      },
    ],
    [
      "another invalid-request code",
      {
        type: "StripeInvalidRequestError",
        code: "parameter_invalid_empty",
        param: "customer",
      },
    ],
    [
      "another error type",
      { type: "StripeAPIError", code: "resource_missing", param: "customer" },
    ],
    ["a plain Error", new Error("No such customer")],
    ["null", null],
    ["a string", "resource_missing"],
  ])("does not match %s", (_label, error) => {
    expect(isMissingCustomerError(error)).toBe(false);
  });
});

describe("summarizePortalErrorForLog", () => {
  it("keeps only class, type, code, status and request id of a Stripe error", () => {
    const error = new Stripe.errors.StripeInvalidRequestError({
      type: "invalid_request_error",
      code: "resource_missing",
      param: "customer",
      statusCode: 404,
      requestId: "req_abc",
      message: "No such customer: 'cus_secret'",
    });

    const summary = summarizePortalErrorForLog(error);

    // `type` is stripe-node's stable class name; `name` is whatever the SDK sets.
    expect(summary).toMatchObject({
      type: "StripeInvalidRequestError",
      code: "resource_missing",
      statusCode: 404,
      requestId: "req_abc",
    });
    expect(typeof summary.name).toBe("string");
    expect(Object.keys(summary).sort()).toEqual([
      "code",
      "name",
      "requestId",
      "statusCode",
      "type",
    ]);
    expect(JSON.stringify(summary)).not.toMatch(/cus_secret|No such customer/);
  });

  it("summarises a plain Error to its name only", () => {
    expect(summarizePortalErrorForLog(new TypeError("fetch failed"))).toEqual({
      name: "TypeError",
      type: undefined,
      code: undefined,
      statusCode: undefined,
      requestId: undefined,
    });
  });

  it("copes with non-error values", () => {
    expect(summarizePortalErrorForLog("boom")).toEqual({ name: "string" });
    expect(summarizePortalErrorForLog(null)).toEqual({ name: "object" });
    expect(summarizePortalErrorForLog(undefined)).toEqual({ name: "undefined" });
  });

  it("ignores fields of the wrong type rather than logging them", () => {
    expect(
      summarizePortalErrorForLog({ type: 1, code: {}, statusCode: "404", requestId: [] }),
    ).toEqual({
      name: "object",
      type: undefined,
      code: undefined,
      statusCode: undefined,
      requestId: undefined,
    });
  });
});

describe("isUsablePortalSession", () => {
  const ok = { url: "https://billing.stripe.com/p/session/abc", customer: "cus_1" };

  it("accepts a secure URL for the expected customer", () => {
    expect(isUsablePortalSession(ok, "cus_1")).toBe(true);
  });

  it("accepts a custom portal domain as long as it is https", () => {
    expect(
      isUsablePortalSession(
        { ...ok, url: "https://billing.example.com/p/session/x" },
        "cus_1",
      ),
    ).toBe(true);
  });

  it("rejects a session for another customer, whatever the URL", () => {
    expect(isUsablePortalSession(ok, "cus_2")).toBe(false);
    expect(isUsablePortalSession({ ...ok, customer: undefined }, "cus_1")).toBe(false);
    expect(isUsablePortalSession({ ...ok, customer: { id: "cus_1" } }, "cus_1")).toBe(
      false,
    );
  });

  it.each([
    null,
    "",
    "/p/session/abc",
    "http://billing.stripe.com/p/session/abc",
    "javascript:alert(1)",
    "data:text/html,hi",
    "billing.stripe.com/p/session/abc",
    42,
    undefined,
  ])("rejects the URL %j", (url) => {
    expect(isUsablePortalSession({ ...ok, url }, "cus_1")).toBe(false);
  });

  it("rejects non-objects", () => {
    expect(isUsablePortalSession(null, "cus_1")).toBe(false);
    expect(isUsablePortalSession(undefined, "cus_1")).toBe(false);
    expect(isUsablePortalSession("https://billing.stripe.com/p/x", "cus_1")).toBe(false);
  });
});
