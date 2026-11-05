// @vitest-environment node
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const session = vi.hoisted(() => ({
  getCurrentUser: vi.fn<() => Promise<{ id: string } | null>>(),
}));
vi.mock("@/infrastructure/auth/session/get-current-user", () => session);

import { sessionForPage } from "./page-session";

// Hex letters in it, so a case change really is a different string.
const ALICE = "a1b2c3d4-1111-4111-8111-11111111abcd";
const BOB = "22222222-2222-4222-8222-222222222222";

beforeEach(() => {
  vi.clearAllMocks();
  vi.spyOn(console, "warn").mockImplementation(() => {});
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe("sessionForPage", () => {
  it("acts for the session's user when the page is theirs", async () => {
    session.getCurrentUser.mockResolvedValue({ id: ALICE });

    await expect(sessionForPage(ALICE)).resolves.toEqual({ status: "ok", userId: ALICE });
    expect(console.warn).not.toHaveBeenCalled();
  });

  it("refuses when the session belongs to another account than the page", async () => {
    // The page was rendered for Alice; Bob has signed in since (another tab).
    session.getCurrentUser.mockResolvedValue({ id: BOB });

    await expect(sessionForPage(ALICE)).resolves.toEqual({ status: "accountChanged" });
  });

  it.each([
    ["missing", undefined],
    ["null", null],
    ["empty", ""],
    ["a number", 42],
    ["an object", { id: ALICE }],
    ["the id in different case", ALICE.toUpperCase()],
    ["a prefix of the id", ALICE.slice(0, 8)],
    ["the id with whitespace", ` ${ALICE}`],
  ])(
    "refuses when the page's account is %s (exact match only)",
    async (_label, owner) => {
      session.getCurrentUser.mockResolvedValue({ id: ALICE });

      await expect(sessionForPage(owner)).resolves.toEqual({ status: "accountChanged" });
    },
  );

  it("reports no session as signed out, before comparing anything", async () => {
    session.getCurrentUser.mockResolvedValue(null);

    await expect(sessionForPage(ALICE)).resolves.toEqual({ status: "signedOut" });
    await expect(sessionForPage(undefined)).resolves.toEqual({ status: "signedOut" });
  });

  it("logs a refusal with the session's user and only the TYPE of the claimed owner", async () => {
    session.getCurrentUser.mockResolvedValue({ id: BOB });

    await sessionForPage(ALICE);

    expect(console.warn).toHaveBeenCalledWith(
      "[support] refusing an action for a different account than the session's",
      { sessionUserId: BOB, pageOwner: "string" },
    );
    expect(JSON.stringify(vi.mocked(console.warn).mock.calls)).not.toContain(ALICE);
  });

  it("never returns the claimed owner: the user acted for is always the session's", async () => {
    session.getCurrentUser.mockResolvedValue({ id: ALICE });

    const result = await sessionForPage(ALICE);

    expect(result).toEqual({ status: "ok", userId: ALICE });
  });
});
