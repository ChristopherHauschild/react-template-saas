// @vitest-environment node
import { describe, expect, it } from "vitest";

import { SUPPORT_REQUEST_CATEGORIES } from "./support-request";
import {
  SUPPORT_REQUEST_CATEGORY_LABELS,
  supportRequestSentMessage,
} from "./support-request-copy";

describe("support request copy", () => {
  it("labels every category, each differently, never as its identifier", () => {
    const labels = SUPPORT_REQUEST_CATEGORIES.map(
      (c) => SUPPORT_REQUEST_CATEGORY_LABELS[c],
    );

    expect(new Set(labels).size).toBe(SUPPORT_REQUEST_CATEGORIES.length);
    for (const category of SUPPORT_REQUEST_CATEGORIES) {
      expect(SUPPORT_REQUEST_CATEGORY_LABELS[category]).not.toBe(category);
    }
  });

  it("names the request in the confirmation when it is known", () => {
    expect(supportRequestSentMessage("Export stuck")).toBe(
      "Your request \u201CExport stuck\u201D has been sent.",
    );
    expect(supportRequestSentMessage(null)).toBe("Your request has been sent.");
  });
});
