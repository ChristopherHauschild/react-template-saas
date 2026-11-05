// @vitest-environment node
import { describe, expect, it } from "vitest";

import { resolveSafeRedirectPath } from "./safe-redirect-path";

const FALLBACK = "/fallback";

/** Resolves the result as a browser would a Location header and reports the host. */
const hostOf = (location: string) => new URL(location, "https://app.example.com").host;

describe("resolveSafeRedirectPath – accepts same-origin paths", () => {
  it.each([
    ["/dashboard", "/dashboard"],
    ["/pricing?checkout=success", "/pricing?checkout=success"],
    ["/docs#install", "/docs#install"],
    ["/a/b/c?x=1&y=2#frag", "/a/b/c?x=1&y=2#frag"],
    ["/", "/"],
    ["/dashboard/", "/dashboard/"],
    ["/?next=//evil.example", "/?next=//evil.example"], // a query value is just data
  ])("keeps %s", (input, expected) => {
    expect(resolveSafeRedirectPath(input, FALLBACK)).toBe(expected);
  });

  it("normalises the path rather than echoing the raw input", () => {
    expect(resolveSafeRedirectPath("/dashboard/../pricing", FALLBACK)).toBe("/pricing");
    expect(resolveSafeRedirectPath("/a b", FALLBACK)).toBe("/a%20b");
  });
});

describe("resolveSafeRedirectPath – rejects anything that leaves the origin", () => {
  it.each([
    ["absolute https URL", "https://evil.example/phish"],
    ["absolute http URL", "http://evil.example"],
    ["scheme-relative", "//evil.example"],
    ["scheme-relative with path", "//evil.example/dashboard"],
    ["backslash (browsers treat as //)", "/\\evil.example"],
    ["double backslash", "/\\\\evil.example"],
    ["mixed slash/backslash", "/\\/evil.example"],
    ["tab inside (browsers strip it)", "/\t/evil.example"],
    ["newlines inside (browsers strip them)", "/\n\n/evil.example"],
    ["carriage return inside", "/\r/evil.example"],
    ["dot-segments that resolve to scheme-relative", "/..//evil.example"],
    ["dot-segments deeper", "/a/../..//evil.example"],
    ["javascript: scheme", "javascript:alert(1)"],
    ["data: scheme", "data:text/html,<script>alert(1)</script>"],
    ["mailto: scheme", "mailto:someone@example.com"],
    ["userinfo trick", "https://app.example.com@evil.example"],
    ["relative reference", "dashboard"],
    ["relative with dots", "../dashboard"],
    ["query only", "?next=/dashboard"],
    ["fragment only", "#frag"],
  ])("rejects %s → fallback", (_label, input) => {
    const result = resolveSafeRedirectPath(input, FALLBACK);

    expect(result).toBe(FALLBACK);
  });

  it("never yields a location that a browser would resolve to another host (fuzz of known shapes)", () => {
    const hosts = ["evil.example", "evil.example:8080", "user@evil.example"];
    const prefixes = [
      "",
      "/",
      "//",
      "/\\",
      "\\\\",
      "/\t",
      "/\n",
      "/..//",
      "/./../",
      "https:",
      "http:",
      "HTTPS://",
      " //",
    ];

    for (const host of hosts) {
      for (const prefix of prefixes) {
        const result = resolveSafeRedirectPath(`${prefix}${host}/x`, FALLBACK);

        expect(hostOf(result)).toBe("app.example.com");
      }
    }
  });
});

describe("resolveSafeRedirectPath – header injection", () => {
  it("strips raw CR/LF (as browsers do) so the result can never split a Location header", () => {
    const result = resolveSafeRedirectPath("/dashboard\r\nSet-Cookie: a=b", FALLBACK);

    expect(result).not.toMatch(/[\r\n]/);
    expect(() => new Headers({ Location: result })).not.toThrow();
  });

  it("leaves percent-encoded CR/LF encoded (harmless in a header, not decoded by browsers)", () => {
    const result = resolveSafeRedirectPath("/dash%0d%0aX: y", FALLBACK);

    expect(result).toBe("/dash%0d%0aX:%20y");
    expect(() => new Headers({ Location: result })).not.toThrow();
  });
});

describe("resolveSafeRedirectPath – non-string or empty input", () => {
  it.each([null, undefined, "", 42, {}, [], true])("falls back for %s", (input) => {
    expect(resolveSafeRedirectPath(input, FALLBACK)).toBe(FALLBACK);
  });

  it("returns the fallback verbatim (it is trusted and not re-validated)", () => {
    expect(resolveSafeRedirectPath(null, "/dashboard?welcome=1")).toBe(
      "/dashboard?welcome=1",
    );
  });
});
