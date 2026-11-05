// @vitest-environment node
import { describe, expect, it } from "vitest";

import {
  clearAllTabDrafts,
  discardOtherOwnersDrafts,
  readTabDraft,
  writeTabDraft,
} from "./tab-drafts";

/** Server rendering imports the form, and with it these helpers: no `window` there. */
describe("tab drafts on the server", () => {
  it("has no drafts and does nothing, without throwing", () => {
    expect(typeof window).toBe("undefined");

    expect(readTabDraft("support", "u")).toBeNull();
    expect(() => writeTabDraft("support", "u", { a: 1 })).not.toThrow();
    expect(() => discardOtherOwnersDrafts("support", "u")).not.toThrow();
    expect(() => clearAllTabDrafts()).not.toThrow();
  });
});
