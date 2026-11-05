// @vitest-environment node
import { describe, expect, it } from "vitest";

import { stripeStandInConfig } from "./index";

describe("stripeStandInConfig – pointing the SDK at a stand-in", () => {
  it("configures nothing by default: the SDK talks to api.stripe.com", () => {
    expect(stripeStandInConfig({})).toEqual({});
    expect(stripeStandInConfig({ STRIPE_API_BASE_URL: "" })).toEqual({});
  });

  it("maps the base URL onto the SDK's host, port and protocol in development", () => {
    expect(
      stripeStandInConfig({
        STRIPE_API_BASE_URL: "http://127.0.0.1:4242",
        NODE_ENV: "development",
      }),
    ).toEqual({ host: "127.0.0.1", port: 4242, protocol: "http" });

    expect(
      stripeStandInConfig({ STRIPE_API_BASE_URL: "https://stripe-mock.internal" }),
    ).toEqual({ host: "stripe-mock.internal", port: 443, protocol: "https" });

    expect(stripeStandInConfig({ STRIPE_API_BASE_URL: "http://localhost" })).toEqual({
      host: "localhost",
      port: 80,
      protocol: "http",
    });
  });

  it("ignores the variable in production so live traffic can never be redirected", () => {
    expect(
      stripeStandInConfig({
        STRIPE_API_BASE_URL: "http://127.0.0.1:4242",
        NODE_ENV: "production",
      }),
    ).toEqual({});
  });

  it("refuses a value that is not an http(s) URL rather than guessing", () => {
    expect(() => stripeStandInConfig({ STRIPE_API_BASE_URL: "127.0.0.1:4242" })).toThrow(
      /valid URL/,
    );
    expect(() => stripeStandInConfig({ STRIPE_API_BASE_URL: "ftp://x" })).toThrow(
      /http\(s\)/,
    );
  });
});
