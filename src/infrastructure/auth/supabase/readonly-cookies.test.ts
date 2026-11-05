// @vitest-environment node
import { describe, expect, it } from "vitest";

import { isReadonlyCookiesError } from "./readonly-cookies";

describe("isReadonlyCookiesError", () => {
  it("recognises Next's read-only cookies error by its message", () => {
    const error = new Error(
      "Cookies can only be modified in a Server Action or Route Handler. Read more: https://nextjs.org/docs/app/api-reference/functions/cookies#options",
    );

    expect(isReadonlyCookiesError(error)).toBe(true);
  });

  it("matches the real error thrown by the installed Next version", async () => {
    // Internal module (not a public entry point): used here only to pin the contract.
    // The class exists at runtime but is absent from the shipped type declarations.
    const internals =
      (await import("next/dist/server/web/spec-extension/adapters/request-cookies")) as unknown as {
        ReadonlyRequestCookiesError: new () => Error;
      };

    expect(isReadonlyCookiesError(new internals.ReadonlyRequestCookiesError())).toBe(
      true,
    );
  });

  it.each([
    ["a different Error", new Error("cookie store is broken")],
    ["a TypeError", new TypeError("Cannot read properties of undefined")],
    ["a similar but different message", new Error("Cookies cannot be modified here")],
    ["a string", "Cookies can only be modified in a Server Action or Route Handler"],
    ["null", null],
    ["undefined", undefined],
  ])("does not match %s", (_label, value) => {
    expect(isReadonlyCookiesError(value)).toBe(false);
  });
});
