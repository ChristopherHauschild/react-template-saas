import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  clearAllTabDrafts,
  discardOtherOwnersDrafts,
  readTabDraft,
  writeTabDraft,
} from "./tab-drafts";

const ALICE = "11111111-1111-4111-8111-111111111111";
const BOB = "22222222-2222-4222-8222-222222222222";

beforeEach(() => {
  sessionStorage.clear();
  localStorage.clear();
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe("tab drafts", () => {
  it("round-trips a draft for its owner", () => {
    writeTabDraft("support", ALICE, { subject: "Hi" });

    expect(readTabDraft("support", ALICE)).toEqual({ subject: "Hi" });
  });

  it("keeps drafts per owner and per form", () => {
    writeTabDraft("support", ALICE, { who: "alice" });
    writeTabDraft("support", BOB, { who: "bob" });
    writeTabDraft("feedback", ALICE, { who: "alice-feedback" });

    expect(readTabDraft("support", ALICE)).toEqual({ who: "alice" });
    expect(readTabDraft("support", BOB)).toEqual({ who: "bob" });
    expect(readTabDraft("feedback", ALICE)).toEqual({ who: "alice-feedback" });
  });

  it("has nothing for an owner who has no draft", () => {
    expect(readTabDraft("support", ALICE)).toBeNull();
  });

  it("removes a draft when written as null", () => {
    writeTabDraft("support", ALICE, { subject: "Hi" });
    writeTabDraft("support", ALICE, null);

    expect(readTabDraft("support", ALICE)).toBeNull();
    expect(sessionStorage.length).toBe(0);
  });

  it("lives in the tab's sessionStorage, never in localStorage (shared across tabs, kept forever)", () => {
    writeTabDraft("support", ALICE, { subject: "Hi" });

    expect(sessionStorage.length).toBe(1);
    expect(localStorage.length).toBe(0);
  });

  it("treats unreadable stored data as no draft", () => {
    sessionStorage.setItem(`draft:support:${ALICE}`, "{not json");

    expect(readTabDraft("support", ALICE)).toBeNull();
  });

  it("discards other owners' drafts of the same form, keeping the owner's and other forms'", () => {
    writeTabDraft("support", ALICE, { who: "alice" });
    writeTabDraft("support", BOB, { who: "bob" });
    writeTabDraft("feedback", BOB, { who: "bob-feedback" });
    sessionStorage.setItem("unrelated", "keep me");

    discardOtherOwnersDrafts("support", ALICE);

    expect(readTabDraft("support", ALICE)).toEqual({ who: "alice" });
    expect(readTabDraft("support", BOB)).toBeNull();
    expect(readTabDraft("feedback", BOB)).toEqual({ who: "bob-feedback" });
    expect(sessionStorage.getItem("unrelated")).toBe("keep me");
  });

  it("clears every draft of every form and owner (sign-out), and nothing else", () => {
    writeTabDraft("support", ALICE, { who: "alice" });
    writeTabDraft("support", BOB, { who: "bob" });
    writeTabDraft("feedback", ALICE, { who: "alice-feedback" });
    sessionStorage.setItem("unrelated", "keep me");

    clearAllTabDrafts();

    expect(sessionStorage.length).toBe(1);
    expect(sessionStorage.getItem("unrelated")).toBe("keep me");
  });

  describe("when storage misbehaves, nothing throws", () => {
    it("storage blocked entirely (accessing sessionStorage throws)", () => {
      vi.spyOn(window, "sessionStorage", "get").mockImplementation(() => {
        throw new DOMException("blocked", "SecurityError");
      });

      expect(() => writeTabDraft("support", ALICE, { subject: "Hi" })).not.toThrow();
      expect(readTabDraft("support", ALICE)).toBeNull();
      expect(() => discardOtherOwnersDrafts("support", ALICE)).not.toThrow();
      expect(() => clearAllTabDrafts()).not.toThrow();
    });

    it("storage full (setItem throws QuotaExceededError)", () => {
      vi.spyOn(Storage.prototype, "setItem").mockImplementation(() => {
        throw new DOMException("full", "QuotaExceededError");
      });

      expect(() => writeTabDraft("support", ALICE, { subject: "Hi" })).not.toThrow();
      expect(readTabDraft("support", ALICE)).toBeNull();
    });

    it("reads and removals failing", () => {
      writeTabDraft("support", ALICE, { subject: "Hi" });
      vi.spyOn(Storage.prototype, "getItem").mockImplementation(() => {
        throw new Error("boom");
      });
      vi.spyOn(Storage.prototype, "removeItem").mockImplementation(() => {
        throw new Error("boom");
      });

      expect(readTabDraft("support", ALICE)).toBeNull();
      expect(() => writeTabDraft("support", ALICE, null)).not.toThrow();
      expect(() => discardOtherOwnersDrafts("support", BOB)).not.toThrow();
      expect(() => clearAllTabDrafts()).not.toThrow();
    });
  });
});
