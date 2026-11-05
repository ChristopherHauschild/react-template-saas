// @vitest-environment node
import { AuthApiError } from "@supabase/supabase-js";
import { describe, expect, it } from "vitest";

import { summarizeAuthErrorForLog } from "./auth-error-log";

describe("summarizeAuthErrorForLog", () => {
  it("keeps name, code and status of a Supabase error", () => {
    expect(
      summarizeAuthErrorForLog(
        new AuthApiError("Database error", 500, "unexpected_failure"),
      ),
    ).toEqual({ name: "AuthApiError", code: "unexpected_failure", status: 500 });
  });

  it("keeps only the class name of any other Error", () => {
    const error = new TypeError('fetch failed: body {"password":"hunter22"}');
    error.stack = "TypeError: ... at secretPlace";

    expect(summarizeAuthErrorForLog(error)).toEqual({ name: "TypeError" });
  });

  it("describes non-Error throwables by type", () => {
    expect(summarizeAuthErrorForLog("timeout")).toEqual({ name: "string" });
    expect(summarizeAuthErrorForLog(undefined)).toEqual({ name: "undefined" });
    expect(summarizeAuthErrorForLog({ password: "hunter22" })).toEqual({
      name: "object",
    });
  });

  it("never includes message, stack or cause", () => {
    const error = new Error("outer hunter22", {
      cause: new Error("inner jane@example.com"),
    });

    const text = JSON.stringify(summarizeAuthErrorForLog(error));

    expect(text).not.toMatch(/hunter22|jane@example.com|outer|inner/);
  });
});
