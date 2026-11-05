// @vitest-environment node
import { describe, expect, it } from "vitest";

import {
  appendRequests,
  categoryLabel,
  firstPageKey,
  formatSentAt,
  loadedAnnouncement,
  statusLabel,
  SUPPORT_HISTORY_COPY,
  supportHistoryState,
} from "./support-request-history";
import type { SupportRequest } from "./support-request-row";

const request = (n: number, overrides: Partial<SupportRequest> = {}): SupportRequest => ({
  id: `3f2504e0-4f89-41d3-9a0c-0305e82c33${String(n).padStart(2, "0")}`,
  createdAt: `2026-03-${String(n).padStart(2, "0")}T10:00:00+00:00`,
  category: "billing",
  status: "open",
  subject: `Request ${n}`,
  message: "Details.",
  ...overrides,
});

describe("supportHistoryState", () => {
  it("is unavailable when the first page could not be read", () => {
    expect(supportHistoryState({ ok: false, failure: "unavailable" })).toBe(
      "unavailable",
    );
    expect(supportHistoryState({ ok: false, failure: "sessionExpired" })).toBe(
      "unavailable",
    );
  });

  it("is empty only when nothing was returned AND nothing older exists", () => {
    expect(supportHistoryState({ ok: true, requests: [], nextCursor: null })).toBe(
      "empty",
    );
    // A page of unreadable rows with more behind it is not "nothing sent".
    expect(supportHistoryState({ ok: true, requests: [], nextCursor: "abc" })).toBe(
      "list",
    );
  });

  it("is a list when there are requests", () => {
    expect(
      supportHistoryState({ ok: true, requests: [request(1)], nextCursor: null }),
    ).toBe("list");
  });
});

describe("firstPageKey", () => {
  it("is stable for the same page", () => {
    expect(firstPageKey([request(2), request(1)], "c")).toBe(
      firstPageKey([request(2), request(1)], "c"),
    );
  });

  it("changes when a request is added", () => {
    expect(firstPageKey([request(3), request(2)], "c")).not.toBe(
      firstPageKey([request(2), request(1)], "c"),
    );
  });

  it("changes when a request's status changes (support closed it)", () => {
    expect(firstPageKey([request(1, { status: "closed" })], null)).not.toBe(
      firstPageKey([request(1)], null),
    );
  });

  it("changes when only the cursor changes", () => {
    expect(firstPageKey([request(1)], null)).not.toBe(firstPageKey([request(1)], "c"));
  });
});

describe("appendRequests", () => {
  it("appends a page in order", () => {
    const merged = appendRequests([request(3)], [request(2), request(1)]);

    expect(merged.map((r) => r.subject)).toEqual(["Request 3", "Request 2", "Request 1"]);
  });

  it("ignores requests already shown (a response applied twice adds nothing)", () => {
    const current = [request(3), request(2)];

    expect(
      appendRequests(current, [request(2), request(1)]).map((r) => r.subject),
    ).toEqual(["Request 3", "Request 2", "Request 1"]);
    expect(appendRequests(current, [request(2)])).toBe(current);
  });

  it("drops duplicates within a page too", () => {
    expect(appendRequests([], [request(1), request(1)])).toHaveLength(1);
  });
});

describe("loadedAnnouncement", () => {
  it("says what was added and how many are shown", () => {
    expect(loadedAnnouncement(2, 12, false)).toBe(
      "Loaded 2 older requests. 12 requests shown.",
    );
    expect(loadedAnnouncement(1, 1, false)).toBe(
      "Loaded 1 older request. 1 request shown.",
    );
  });

  it("says when nothing new came back", () => {
    expect(loadedAnnouncement(0, 10, false)).toBe("No new requests. 10 requests shown.");
  });

  it("says when the end was reached", () => {
    expect(loadedAnnouncement(3, 13, true)).toBe(
      `Loaded 3 older requests. 13 requests shown. ${SUPPORT_HISTORY_COPY.end}`,
    );
  });
});

describe("labels", () => {
  it("labels known categories and statuses, and never shows a raw unknown value", () => {
    expect(categoryLabel("billing")).toBe("Billing");
    expect(categoryLabel(null)).toBe("General");
    expect(statusLabel("open")).toBe("Open");
    expect(statusLabel("closed")).toBe("Closed");
    expect(statusLabel(null)).toBe("Unknown");
  });
});

describe("formatSentAt", () => {
  it("formats in UTC, the same on server and client", () => {
    expect(formatSentAt("2026-03-01T10:00:00+00:00")).toBe("1 Mar 2026, 10:00 UTC");
    expect(formatSentAt("2026-03-01T23:30:00-02:00")).toBe("2 Mar 2026, 01:30 UTC");
  });

  it("returns null for an unparsable timestamp", () => {
    expect(formatSentAt("yesterday")).toBeNull();
  });
});
