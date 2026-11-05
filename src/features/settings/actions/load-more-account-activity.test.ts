// @vitest-environment node
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { encodeAccountActivityCursor } from "@/infrastructure/account-activity/cursor";

import {
  ACCOUNT_ACTIVITY_PAGE_SIZE,
  LOAD_MORE_ACTIVITY_COPY,
} from "../services/account-activity-copy";

// --- boundaries ---------------------------------------------------------------

class RedirectSignal extends Error {
  constructor(public readonly url: string) {
    super(`NEXT_REDIRECT ${url}`);
  }
}

vi.mock("next/navigation", () => ({
  redirect: vi.fn((url: string) => {
    throw new RedirectSignal(url);
  }),
}));

const session = vi.hoisted(() => ({
  getCurrentUser: vi.fn<() => Promise<{ id: string } | null>>(),
}));
vi.mock("@/infrastructure/auth/session/get-current-user", () => session);

const activity = vi.hoisted(() => ({
  listAccountActivity:
    vi.fn<
      (
        userId: string,
        options: { limit: number; before: { occurredAt: string; id: number } },
      ) => Promise<
        { ok: true; entries: unknown[]; nextCursor: string | null } | { ok: false }
      >
    >(),
}));
vi.mock("@/infrastructure/account-activity/list-account-activity", () => activity);

import { loadMoreAccountActivity } from "./load-more-account-activity";

// ------------------------------------------------------------------------------

const USER = { id: "11111111-1111-4111-8111-111111111111" };
const POSITION = { occurredAt: "2026-03-01T10:00:00.123456+00:00", id: 42 };
const CURSOR = encodeAccountActivityCursor(POSITION);
const ENTRY = {
  id: 41,
  occurredAt: "2026-02-01T10:00:00+00:00",
  event: {
    type: "profile.updated",
    details: { changes: { fullName: { from: null, to: "Jane" } } },
  },
};

beforeEach(() => {
  vi.clearAllMocks();
  session.getCurrentUser.mockResolvedValue(USER);
  activity.listAccountActivity.mockResolvedValue({
    ok: true,
    entries: [ENTRY],
    nextCursor: "next",
  });
  vi.spyOn(console, "error").mockImplementation(() => {});
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe("loadMoreAccountActivity – access", () => {
  it("redirects an anonymous caller to /login before reading anything", async () => {
    session.getCurrentUser.mockResolvedValue(null);

    await expect(loadMoreAccountActivity(CURSOR)).rejects.toMatchObject({
      url: "/login",
    });
    expect(activity.listAccountActivity).not.toHaveBeenCalled();
  });

  it("reads the page for the verified user — the client supplies the cursor and nothing else", async () => {
    await loadMoreAccountActivity(CURSOR);

    expect(activity.listAccountActivity).toHaveBeenCalledTimes(1);
    expect(activity.listAccountActivity).toHaveBeenCalledWith(USER.id, {
      limit: ACCOUNT_ACTIVITY_PAGE_SIZE,
      before: POSITION,
    });
  });
});

describe("loadMoreAccountActivity – results", () => {
  it("returns the page with the cursor it answers and the one after it", async () => {
    await expect(loadMoreAccountActivity(CURSOR)).resolves.toEqual({
      ok: true,
      cursor: CURSOR,
      entries: [ENTRY],
      nextCursor: "next",
    });
  });

  it("passes the end of the list through (no next cursor)", async () => {
    activity.listAccountActivity.mockResolvedValue({
      ok: true,
      entries: [],
      nextCursor: null,
    });

    await expect(loadMoreAccountActivity(CURSOR)).resolves.toEqual({
      ok: true,
      cursor: CURSOR,
      entries: [],
      nextCursor: null,
    });
  });

  it("reports a failed read as retryable, keeping the cursor", async () => {
    activity.listAccountActivity.mockResolvedValue({ ok: false });

    await expect(loadMoreAccountActivity(CURSOR)).resolves.toEqual({
      ok: false,
      cursor: CURSOR,
      error: LOAD_MORE_ACTIVITY_COPY.retry,
      restart: false,
    });
  });

  it.each([
    ["undefined", undefined, ""],
    ["a number", 42, ""],
    ["an object", { occurredAt: POSITION.occurredAt, id: 42 }, ""],
    ["an empty string", "", ""],
    ["garbage", "not-a-cursor!", "not-a-cursor!"],
    ["a tampered token", `${CURSOR}x`, `${CURSOR}x`],
    [
      "a hand-made token",
      btoa(JSON.stringify({ t: "now", i: 1 })),
      btoa(JSON.stringify({ t: "now", i: 1 })),
    ],
  ])(
    "refuses a cursor that is not one of ours (%s) without reading, and asks for a reload",
    async (_label, cursor, echoed) => {
      await expect(loadMoreAccountActivity(cursor)).resolves.toEqual({
        ok: false,
        cursor: echoed,
        error: LOAD_MORE_ACTIVITY_COPY.restart,
        restart: true,
      });

      expect(activity.listAccountActivity).not.toHaveBeenCalled();
      expect(console.error).toHaveBeenCalledWith(
        "[settings] refusing an activity cursor that is not one of ours",
        { userId: USER.id, received: typeof cursor },
      );
      // The value itself is never logged.
      if (typeof cursor === "string" && cursor !== "") {
        expect(JSON.stringify(vi.mocked(console.error).mock.calls)).not.toContain(cursor);
      }
    },
  );
});
