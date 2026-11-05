// @vitest-environment node
import {
  AuthApiError,
  AuthRetryableFetchError,
  AuthSessionMissingError,
} from "@supabase/supabase-js";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { SESSION_ERRORS } from "../services/session-errors";

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
  getCurrentUser: vi.fn<() => Promise<{ id: string; email?: string } | null>>(),
}));
vi.mock("@/infrastructure/auth/session/get-current-user", () => session);

type Revoked = { ok: true } | { ok: false; error: unknown };
const tokens = vi.hoisted(() => ({
  revokeOtherSessions: vi.fn<() => Promise<Revoked>>(),
}));
vi.mock("@/infrastructure/auth/session/session-tokens", () => tokens);

const cache = vi.hoisted(() => ({ revalidatePath: vi.fn() }));
vi.mock("next/cache", () => cache);

// The activity history writer (service role). Its own behaviour is covered by
// record-account-activity.test.ts; here only WHEN and WITH WHAT it is called.
const activity = vi.hoisted(() => ({
  recordAccountActivity: vi.fn<() => Promise<{ ok: true; id: number } | { ok: false }>>(),
}));
vi.mock("@/infrastructure/account-activity/record-account-activity", () => activity);

import { signOutOtherSessions } from "./sign-out-other-sessions";

const USER = { id: "11111111-1111-4111-8111-111111111111", email: "jane@example.com" };
const run = () =>
  (
    signOutOtherSessions as (
      p: unknown,
      f: FormData,
    ) => ReturnType<typeof signOutOtherSessions>
  )(null, new FormData());

const loggedText = () =>
  JSON.stringify([
    ...vi.mocked(console.error).mock.calls,
    ...vi.mocked(console.warn).mock.calls,
  ]);

beforeEach(() => {
  vi.clearAllMocks();
  session.getCurrentUser.mockResolvedValue(USER);
  tokens.revokeOtherSessions.mockResolvedValue({ ok: true });
  activity.recordAccountActivity.mockResolvedValue({ ok: true, id: 1 });
  vi.spyOn(console, "error").mockImplementation(() => {});
  vi.spyOn(console, "warn").mockImplementation(() => {});
});

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe("signOutOtherSessions – primary flow", () => {
  it("revokes the other sessions and reports when, without redirecting", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date("2026-03-01T10:00:00Z"));

    await expect(run()).resolves.toEqual({
      status: "signed_out",
      at: "2026-03-01T10:00:00.000Z",
    });
    expect(tokens.revokeOtherSessions).toHaveBeenCalledTimes(1);
    expect(console.error).not.toHaveBeenCalled();
  });

  it("ignores whatever the form sends (the action takes no input)", async () => {
    const data = new FormData();
    data.set("scope", "global");
    data.set("userId", "someone-else");

    await (signOutOtherSessions as (p: unknown, f: FormData) => Promise<unknown>)(
      null,
      data,
    );

    expect(tokens.revokeOtherSessions).toHaveBeenCalledWith();
  });

  it("is idempotent: repeated requests each succeed, each with its own time", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date("2026-03-01T10:00:00Z"));
    const first = await run();
    vi.setSystemTime(new Date("2026-03-01T10:05:00Z"));
    const second = await run();

    expect(first).toMatchObject({ status: "signed_out", at: "2026-03-01T10:00:00.000Z" });
    expect(second).toMatchObject({
      status: "signed_out",
      at: "2026-03-01T10:05:00.000Z",
    });
    expect(tokens.revokeOtherSessions).toHaveBeenCalledTimes(2);
  });
});

describe("signOutOtherSessions – expired sessions", () => {
  it("redirects an anonymous caller (session already gone) to /login and revokes nothing", async () => {
    session.getCurrentUser.mockResolvedValue(null);

    await expect(run()).rejects.toMatchObject({ url: "/login" });
    expect(tokens.revokeOtherSessions).not.toHaveBeenCalled();
  });

  it.each([
    ["current session revoked meanwhile", new AuthSessionMissingError()],
    ["access token refused", new AuthApiError("x", 401, "bad_jwt")],
    ["refresh refused", new AuthApiError("x", 400, "refresh_token_not_found")],
  ])("asks to sign in again — and claims nothing — when %s", async (_l, error) => {
    tokens.revokeOtherSessions.mockResolvedValue({ ok: false, error });

    const result = await run();

    expect(result).toEqual({ status: "error", error: SESSION_ERRORS.sessionExpired });
    expect(console.error).not.toHaveBeenCalled(); // routine, not an anomaly
  });
});

describe("signOutOtherSessions – failures", () => {
  it("reports rate limiting", async () => {
    tokens.revokeOtherSessions.mockResolvedValue({
      ok: false,
      error: new AuthApiError("x", 429, "over_request_rate_limit"),
    });

    await expect(run()).resolves.toEqual({
      status: "error",
      error: SESSION_ERRORS.rateLimited,
    });
  });

  it("reports an outage as temporary and logs only name/code/status", async () => {
    tokens.revokeOtherSessions.mockResolvedValue({
      ok: false,
      error: new AuthRetryableFetchError(`fetch failed for ${USER.email}`, 0),
    });

    await expect(run()).resolves.toEqual({
      status: "error",
      error: SESSION_ERRORS.unavailable,
    });
    expect(console.error).toHaveBeenCalledWith(
      "[settings] signing out other sessions failed unexpectedly",
      { name: "AuthRetryableFetchError", code: undefined, status: 0 },
    );
    expect(loggedText()).not.toContain(USER.email);
  });

  it("contains a throw (bug, client construction) as a temporary failure", async () => {
    tokens.revokeOtherSessions.mockRejectedValue(new TypeError(`boom ${USER.id}`));

    await expect(run()).resolves.toEqual({
      status: "error",
      error: SESSION_ERRORS.unavailable,
    });
    expect(console.error).toHaveBeenCalledWith(
      "[settings] signing out other sessions threw unexpectedly",
      { name: "TypeError" },
    );
    expect(loggedText()).not.toContain(USER.id);
  });

  it("never returns Supabase's message or anything about the account", async () => {
    tokens.revokeOtherSessions.mockResolvedValue({
      ok: false,
      error: new AuthApiError(`SECRET ${USER.email}`, 500, "unexpected_failure"),
    });

    const text = JSON.stringify(await run());
    expect(text).not.toMatch(/SECRET|jane@example\.com|11111111/);
  });
});

describe("signOutOtherSessions – activity history", () => {
  it("records a sessions.others_signed_out event for the verified user, after GoTrue confirmed, and refreshes the page", async () => {
    const order: string[] = [];
    tokens.revokeOtherSessions.mockImplementation(async () => {
      order.push("revoke");
      return { ok: true };
    });
    activity.recordAccountActivity.mockImplementation(async () => {
      order.push("record");
      return { ok: true, id: 1 };
    });

    await expect(run()).resolves.toMatchObject({ status: "signed_out" });

    expect(order).toEqual(["revoke", "record"]);
    expect(activity.recordAccountActivity).toHaveBeenCalledTimes(1);
    expect(activity.recordAccountActivity).toHaveBeenCalledWith(USER.id, {
      type: "sessions.others_signed_out",
      details: {},
    });
    expect(cache.revalidatePath).toHaveBeenCalledTimes(1);
    expect(cache.revalidatePath).toHaveBeenCalledWith("/settings");
  });

  it("records each repeated request (each one revoked again)", async () => {
    await run();
    await run();

    expect(activity.recordAccountActivity).toHaveBeenCalledTimes(2);
  });

  it("attributes the event to the session's user, never to anything in the form", async () => {
    const data = new FormData();
    data.set("userId", "22222222-2222-4222-8222-222222222222");

    await (signOutOtherSessions as (p: unknown, f: FormData) => Promise<unknown>)(
      null,
      data,
    );

    const [userId] = activity.recordAccountActivity.mock.calls[0] as unknown as [string];
    expect(userId).toBe(USER.id);
  });

  describe("REGRESSION: a failed revocation leaves no entry", () => {
    it.each([
      ["anonymous caller", () => session.getCurrentUser.mockResolvedValue(null)],
      [
        "session gone meanwhile",
        () =>
          tokens.revokeOtherSessions.mockResolvedValue({
            ok: false,
            error: new AuthSessionMissingError(),
          }),
      ],
      [
        "rate limited",
        () =>
          tokens.revokeOtherSessions.mockResolvedValue({
            ok: false,
            error: new AuthApiError("x", 429, "over_request_rate_limit"),
          }),
      ],
      [
        "outage",
        () =>
          tokens.revokeOtherSessions.mockResolvedValue({
            ok: false,
            error: new AuthRetryableFetchError("fetch failed", 0),
          }),
      ],
      [
        "revocation throws",
        () => tokens.revokeOtherSessions.mockRejectedValue(new Error("boom")),
      ],
    ])("%s", async (_label, arrange) => {
      arrange();

      const outcome = await run().catch((thrown) => thrown);
      expect(outcome).not.toMatchObject({ status: "signed_out" });

      expect(activity.recordAccountActivity).not.toHaveBeenCalled();
      expect(cache.revalidatePath).not.toHaveBeenCalled();
    });
  });

  describe("REGRESSION: a failure to record does not affect the revocation that already happened", () => {
    it("when the recorder reports a failure", async () => {
      activity.recordAccountActivity.mockResolvedValue({ ok: false });

      await expect(run()).resolves.toMatchObject({ status: "signed_out" });
      expect(cache.revalidatePath).toHaveBeenCalledWith("/settings");
      expect(console.error).not.toHaveBeenCalled(); // the recorder logs; the action adds nothing
    });

    it("when the recorder throws", async () => {
      activity.recordAccountActivity.mockRejectedValue(
        new Error(`activity store down for ${USER.email}`),
      );

      await expect(run()).resolves.toMatchObject({ status: "signed_out" });
      expect(cache.revalidatePath).toHaveBeenCalledWith("/settings");
      expect(tokens.revokeOtherSessions).toHaveBeenCalledTimes(1); // not retried
      expect(console.error).toHaveBeenCalledTimes(1);
      expect(loggedText()).not.toContain(USER.email);
      expect(loggedText()).not.toContain(USER.id);
    });
  });
});
