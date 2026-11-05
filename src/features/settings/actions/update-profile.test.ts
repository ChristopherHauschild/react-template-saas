// @vitest-environment node
import { AuthApiError, AuthRetryableFetchError } from "@supabase/supabase-js";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { PROFILE_NAME_MAX_LENGTH } from "../services/profile";
import { UPDATE_PROFILE_ERRORS } from "../services/update-profile-errors";

// --- boundaries ---------------------------------------------------------------

/** Next's redirect() throws; model that so tests can assert the destination. */
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

const cache = vi.hoisted(() => ({ revalidatePath: vi.fn() }));
vi.mock("next/cache", () => cache);

// The guard's per-request user lookup; null models an anonymous caller.
const session = vi.hoisted(() => ({
  getCurrentUser: vi.fn<
    () => Promise<{
      id: string;
      email?: string;
      user_metadata?: Record<string, unknown>;
    } | null>
  >(),
}));
vi.mock("@/infrastructure/auth/session/get-current-user", () => session);

type UpdateUserArgs = {
  data?: Record<string, unknown>;
  email?: string;
  password?: string;
};

/** The subset of supabase-js's UserResponse the action reads. */
type UpdateUserResponse = {
  data: { user: { id: string } | null };
  error: { name: string; code?: string; status?: number } | null;
};

const supabase = vi.hoisted(() => ({
  updateUser: vi.fn<(attributes: UpdateUserArgs) => Promise<UpdateUserResponse>>(),
}));
const infra = vi.hoisted(() => ({
  createClient: vi.fn<() => Promise<unknown>>(),
}));
vi.mock("@/infrastructure/auth/supabase/server", () => infra);

// The activity history writer (service role). Its own behaviour is covered by
// record-account-activity.test.ts; here only WHEN and WITH WHAT it is called.
const activity = vi.hoisted(() => ({
  recordAccountActivity: vi.fn<() => Promise<{ ok: true; id: number } | { ok: false }>>(),
}));
vi.mock("@/infrastructure/account-activity/record-account-activity", () => activity);

import { updateProfile } from "./update-profile";

// ------------------------------------------------------------------------------

const form = (fields: Record<string, string | Blob>) => {
  const data = new FormData();
  for (const [name, value] of Object.entries(fields)) data.append(name, value);
  return data;
};

const USER = {
  id: "11111111-1111-4111-8111-111111111111",
  email: "jane@example.com",
  user_metadata: { full_name: "Jane" },
};
const NAME = "Jane Doe";

const UPDATED: UpdateUserResponse = { data: { user: { id: USER.id } }, error: null };

const failure = (error: UpdateUserResponse["error"]): UpdateUserResponse => ({
  data: { user: null },
  error,
});

const loggedText = () =>
  JSON.stringify([
    ...vi.mocked(console.error).mock.calls,
    ...vi.mocked(console.warn).mock.calls,
    ...vi.mocked(console.info).mock.calls,
    ...vi.mocked(console.log).mock.calls,
  ]);

beforeEach(() => {
  vi.clearAllMocks();
  session.getCurrentUser.mockResolvedValue(USER);
  infra.createClient.mockResolvedValue({ auth: { updateUser: supabase.updateUser } });
  supabase.updateUser.mockResolvedValue(UPDATED);
  activity.recordAccountActivity.mockResolvedValue({ ok: true, id: 1 });
  vi.spyOn(console, "error").mockImplementation(() => {});
  vi.spyOn(console, "warn").mockImplementation(() => {});
  vi.spyOn(console, "info").mockImplementation(() => {});
  vi.spyOn(console, "log").mockImplementation(() => {});
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe("updateProfile – unauthorized access", () => {
  it("redirects an anonymous caller to /login before doing anything else", async () => {
    session.getCurrentUser.mockResolvedValue(null);

    await expect(updateProfile(null, form({ fullName: NAME }))).rejects.toMatchObject({
      url: "/login",
    });

    expect(infra.createClient).not.toHaveBeenCalled();
    expect(supabase.updateUser).not.toHaveBeenCalled();
    expect(cache.revalidatePath).not.toHaveBeenCalled();
    expect(activity.recordAccountActivity).not.toHaveBeenCalled();
  });

  it("does not even validate the input for an anonymous caller (nothing to learn)", async () => {
    session.getCurrentUser.mockResolvedValue(null);

    // Invalid input would otherwise produce a validation error result.
    await expect(updateProfile(null, form({ fullName: "" }))).rejects.toBeInstanceOf(
      RedirectSignal,
    );
  });

  it("does not swallow the redirect, which Next implements by throwing", async () => {
    session.getCurrentUser.mockResolvedValue(null);

    await expect(updateProfile(null, form({ fullName: NAME }))).rejects.toBeInstanceOf(
      RedirectSignal,
    );
    expect(console.error).not.toHaveBeenCalled();
  });
});

describe("updateProfile – saving", () => {
  it("writes the name to user_metadata.full_name and confirms, without redirecting", async () => {
    await expect(updateProfile(null, form({ fullName: NAME }))).resolves.toEqual({
      status: "saved",
      fullName: NAME,
    });

    expect(supabase.updateUser).toHaveBeenCalledTimes(1);
    expect(supabase.updateUser).toHaveBeenCalledWith({ data: { full_name: NAME } });
    expect(console.error).not.toHaveBeenCalled();
  });

  it("touches only the display name: no email, password or other metadata keys", async () => {
    await updateProfile(null, form({ fullName: NAME, email: "x@y.z", password: "pw" }));

    const [attributes] = supabase.updateUser.mock.calls[0];
    expect(Object.keys(attributes)).toEqual(["data"]);
    expect(Object.keys(attributes.data!)).toEqual(["full_name"]);
  });

  it("uses the cookie-based server client, so the write runs as the signed-in user", async () => {
    await updateProfile(null, form({ fullName: NAME }));

    expect(infra.createClient).toHaveBeenCalledTimes(1);
  });

  it("revalidates the settings route so the re-render (page + header) shows the new name", async () => {
    await updateProfile(null, form({ fullName: NAME }));

    expect(cache.revalidatePath).toHaveBeenCalledTimes(1);
    expect(cache.revalidatePath).toHaveBeenCalledWith("/settings");
  });

  it("trims surrounding whitespace and saves the trimmed name", async () => {
    await expect(
      updateProfile(null, form({ fullName: `  ${NAME}\u00a0 ` })),
    ).resolves.toEqual({ status: "saved", fullName: NAME });

    expect(supabase.updateUser).toHaveBeenCalledWith({ data: { full_name: NAME } });
  });

  it("keeps inner spacing and non-ASCII names as typed", async () => {
    const name = "Zoë  O'Neil-Đặng 李";

    await updateProfile(null, form({ fullName: name }));

    expect(supabase.updateUser).toHaveBeenCalledWith({ data: { full_name: name } });
  });

  it("accepts a name of exactly the maximum length", async () => {
    const name = "x".repeat(PROFILE_NAME_MAX_LENGTH);

    await expect(updateProfile(null, form({ fullName: name }))).resolves.toMatchObject({
      status: "saved",
    });
  });
});

describe("updateProfile – input validation (before contacting Supabase)", () => {
  it.each([
    ["missing name", {}, UPDATE_PROFILE_ERRORS.nameRequired, ""],
    ["empty name", { fullName: "" }, UPDATE_PROFILE_ERRORS.nameRequired, ""],
    [
      "whitespace-only name",
      { fullName: " \t " },
      UPDATE_PROFILE_ERRORS.nameRequired,
      "",
    ],
    [
      `name of ${PROFILE_NAME_MAX_LENGTH + 1} characters`,
      { fullName: "x".repeat(PROFILE_NAME_MAX_LENGTH + 1) },
      UPDATE_PROFILE_ERRORS.nameTooLong,
      "x".repeat(PROFILE_NAME_MAX_LENGTH + 1),
    ],
    [
      "name with a line break",
      { fullName: "Jane\nDoe" },
      UPDATE_PROFILE_ERRORS.nameInvalid,
      "Jane\nDoe",
    ],
    [
      "name with a control character",
      { fullName: "Jane\u0000Doe" },
      UPDATE_PROFILE_ERRORS.nameInvalid,
      "Jane\u0000Doe",
    ],
  ])(
    "rejects %s with a field error and echoes the (trimmed) input",
    async (_label, fields, message, echoed) => {
      await expect(updateProfile(null, form(fields))).resolves.toEqual({
        status: "error",
        error: message,
        field: "fullName",
        fullName: echoed,
      });

      expect(infra.createClient).not.toHaveBeenCalled();
      expect(supabase.updateUser).not.toHaveBeenCalled();
      expect(cache.revalidatePath).not.toHaveBeenCalled();
      expect(activity.recordAccountActivity).not.toHaveBeenCalled();
    },
  );

  it("reports whitespace padding around an over-long name as too long, not as required", async () => {
    // Trim first, then measure: the padding does not count, the content does.
    const content = "x".repeat(PROFILE_NAME_MAX_LENGTH + 1);

    await expect(
      updateProfile(null, form({ fullName: ` ${content} ` })),
    ).resolves.toMatchObject({
      error: UPDATE_PROFILE_ERRORS.nameTooLong,
      fullName: content,
    });
  });

  it("treats a non-string field value (a file) as missing", async () => {
    await expect(
      updateProfile(null, form({ fullName: new Blob(["Jane"]) })),
    ).resolves.toEqual({
      status: "error",
      error: UPDATE_PROFILE_ERRORS.nameRequired,
      field: "fullName",
      fullName: "",
    });
  });
});

describe("updateProfile – failures are returned, never thrown", () => {
  it.each([
    ["session_expired", 401],
    ["session_not_found", 403],
    ["refresh_token_not_found", 400],
    ["bad_jwt", 401],
    ["user_not_found", 403],
    [undefined, 401],
  ])(
    "asks the user to sign in again when the session is gone (code %s, status %s)",
    async (code, status) => {
      supabase.updateUser.mockResolvedValue(
        failure(new AuthApiError("Session expired", status, code)),
      );

      await expect(updateProfile(null, form({ fullName: NAME }))).resolves.toEqual({
        status: "error",
        error: UPDATE_PROFILE_ERRORS.sessionExpired,
        fullName: NAME,
      });
      expect(cache.revalidatePath).not.toHaveBeenCalled();
      expect(console.error).not.toHaveBeenCalled();
    },
  );

  it("asks the user to sign in again when supabase-js itself finds no session", async () => {
    // What `updateUser` returns when the cookies hold no session at all.
    const sessionMissing = Object.assign(new Error("Auth session missing!"), {
      __isAuthError: true,
      name: "AuthSessionMissingError",
      status: 400,
      code: undefined,
    });
    supabase.updateUser.mockResolvedValue(failure(sessionMissing));

    await expect(updateProfile(null, form({ fullName: NAME }))).resolves.toMatchObject({
      status: "error",
      error: UPDATE_PROFILE_ERRORS.sessionExpired,
    });
  });

  it.each([
    ["over_request_rate_limit", 429],
    [undefined, 429],
  ])("reports rate limiting (code %s, status %s)", async (code, status) => {
    supabase.updateUser.mockResolvedValue(
      failure(new AuthApiError("Rate limit exceeded", status, code)),
    );

    await expect(updateProfile(null, form({ fullName: NAME }))).resolves.toMatchObject({
      status: "error",
      error: UPDATE_PROFILE_ERRORS.rateLimited,
    });
    expect(console.error).not.toHaveBeenCalled();
  });

  it("reports a Supabase outage as temporary and logs it without profile data", async () => {
    supabase.updateUser.mockResolvedValue(
      failure(new AuthRetryableFetchError("fetch failed", 0)),
    );

    await expect(updateProfile(null, form({ fullName: NAME }))).resolves.toEqual({
      status: "error",
      error: UPDATE_PROFILE_ERRORS.unavailable,
      fullName: NAME,
    });

    expect(console.error).toHaveBeenCalledTimes(1);
    expect(console.error).toHaveBeenCalledWith(
      "[settings] profile update failed unexpectedly",
      { name: "AuthRetryableFetchError", code: undefined, status: 0 },
    );
    expect(loggedText()).not.toContain(NAME);
    expect(loggedText()).not.toContain(USER.email);
    expect(loggedText()).not.toContain(USER.id);
  });

  it("reports an unrecognised auth error as temporary and logs only its name/code/status", async () => {
    supabase.updateUser.mockResolvedValue(
      failure(
        new AuthApiError(
          `Database error updating user ${USER.email}`,
          500,
          "unexpected_failure",
        ),
      ),
    );

    await expect(updateProfile(null, form({ fullName: NAME }))).resolves.toMatchObject({
      status: "error",
      error: UPDATE_PROFILE_ERRORS.unavailable,
    });
    expect(console.error).toHaveBeenCalledWith(
      "[settings] profile update failed unexpectedly",
      { name: "AuthApiError", code: "unexpected_failure", status: 500 },
    );
    expect(loggedText()).not.toContain(USER.email);
    expect(loggedText()).not.toContain("Database error");
  });

  it("turns a thrown error (client construction) into a result instead of crashing the page", async () => {
    infra.createClient.mockRejectedValue(
      new TypeError(`cookies unavailable for ${NAME}`),
    );

    await expect(updateProfile(null, form({ fullName: NAME }))).resolves.toEqual({
      status: "error",
      error: UPDATE_PROFILE_ERRORS.unavailable,
      fullName: NAME,
    });
    expect(console.error).toHaveBeenCalledWith(
      "[settings] profile update threw unexpectedly",
      { name: "TypeError" },
    );
    expect(loggedText()).not.toContain(NAME);
  });

  it("turns a rejection from supabase-js into a result as well", async () => {
    supabase.updateUser.mockRejectedValue(new Error("boom"));

    await expect(updateProfile(null, form({ fullName: NAME }))).resolves.toMatchObject({
      status: "error",
      error: UPDATE_PROFILE_ERRORS.unavailable,
    });
    expect(cache.revalidatePath).not.toHaveBeenCalled();
  });

  it("never echoes the raw Supabase message for any error", async () => {
    const raw = "SECRET internal detail from GoTrue";
    for (const code of [
      "session_expired",
      "over_request_rate_limit",
      "unexpected_failure",
      "validation_failed",
      undefined,
    ]) {
      supabase.updateUser.mockResolvedValueOnce(
        failure(new AuthApiError(raw, 400, code)),
      );

      expect(
        JSON.stringify(await updateProfile(null, form({ fullName: NAME }))),
      ).not.toContain("SECRET");
    }
    expect(loggedText()).not.toContain("SECRET");
  });
});

describe("updateProfile – activity history", () => {
  it("records a profile.updated event with the previous and new name after a successful save", async () => {
    await expect(updateProfile(null, form({ fullName: NAME }))).resolves.toEqual({
      status: "saved",
      fullName: NAME,
    });

    expect(activity.recordAccountActivity).toHaveBeenCalledTimes(1);
    expect(activity.recordAccountActivity).toHaveBeenCalledWith(USER.id, {
      type: "profile.updated",
      details: { changes: { fullName: { from: "Jane", to: NAME } } },
    });
  });

  it("attributes the event to the verified session's user, never to anything in the form", async () => {
    await updateProfile(
      null,
      form({ fullName: NAME, userId: "22222222-2222-4222-8222-222222222222" }),
    );

    const [userId] = activity.recordAccountActivity.mock.calls[0] as unknown as [string];
    expect(userId).toBe(USER.id);
  });

  it("records only after Supabase confirmed the write (never before, never on failure)", async () => {
    const order: string[] = [];
    supabase.updateUser.mockImplementation(async () => {
      order.push("updateUser");
      return UPDATED;
    });
    activity.recordAccountActivity.mockImplementation(async () => {
      order.push("record");
      return { ok: true, id: 1 };
    });

    await updateProfile(null, form({ fullName: NAME }));
    expect(order).toEqual(["updateUser", "record"]);

    for (const outcome of [
      failure(new AuthApiError("Session expired", 401, "session_expired")),
      failure(new AuthApiError("Rate limit exceeded", 429, "over_request_rate_limit")),
      failure(new AuthRetryableFetchError("fetch failed", 0)),
    ]) {
      activity.recordAccountActivity.mockClear();
      supabase.updateUser.mockResolvedValueOnce(outcome);

      await expect(updateProfile(null, form({ fullName: NAME }))).resolves.toMatchObject({
        status: "error",
      });
      expect(activity.recordAccountActivity).not.toHaveBeenCalled();
    }

    activity.recordAccountActivity.mockClear();
    supabase.updateUser.mockRejectedValueOnce(new Error("boom"));
    await updateProfile(null, form({ fullName: NAME }));
    expect(activity.recordAccountActivity).not.toHaveBeenCalled();
  });

  it("reports no previous name (null) when the account had none", async () => {
    session.getCurrentUser.mockResolvedValue({ ...USER, user_metadata: {} });

    await updateProfile(null, form({ fullName: NAME }));

    expect(activity.recordAccountActivity).toHaveBeenCalledWith(USER.id, {
      type: "profile.updated",
      details: { changes: { fullName: { from: null, to: NAME } } },
    });
  });

  it("takes the previous name from the same place the form showed it (full_name, then name, then display_name)", async () => {
    session.getCurrentUser.mockResolvedValue({
      ...USER,
      user_metadata: { name: "J. Doe", display_name: "jd" },
    });

    await updateProfile(null, form({ fullName: NAME }));

    expect(activity.recordAccountActivity).toHaveBeenCalledWith(USER.id, {
      type: "profile.updated",
      details: { changes: { fullName: { from: "J. Doe", to: NAME } } },
    });
  });

  it("does not record an entry when the saved name is the same as before", async () => {
    await expect(updateProfile(null, form({ fullName: "  Jane " }))).resolves.toEqual({
      status: "saved",
      fullName: "Jane",
    });

    expect(supabase.updateUser).toHaveBeenCalledTimes(1); // still written, as before
    expect(activity.recordAccountActivity).not.toHaveBeenCalled();
  });

  it("REGRESSION: a recorder that THROWS does not undo or hide the save", async () => {
    activity.recordAccountActivity.mockRejectedValue(new Error("activity store down"));

    await expect(updateProfile(null, form({ fullName: NAME }))).resolves.toEqual({
      status: "saved",
      fullName: NAME,
    });

    expect(supabase.updateUser).toHaveBeenCalledTimes(1);
    expect(cache.revalidatePath).toHaveBeenCalledWith("/settings");
    // Logged (by the guard), but nothing of the user's in it.
    expect(console.error).toHaveBeenCalledTimes(1);
    expect(loggedText()).not.toContain(NAME);
    expect(loggedText()).not.toContain(USER.id);
  });

  it("still confirms the save, without logging anything of its own, when recording fails", async () => {
    // The recorder has logged the failure itself; the name IS saved.
    activity.recordAccountActivity.mockResolvedValue({ ok: false });

    await expect(updateProfile(null, form({ fullName: NAME }))).resolves.toEqual({
      status: "saved",
      fullName: NAME,
    });

    expect(cache.revalidatePath).toHaveBeenCalledWith("/settings");
    expect(console.error).not.toHaveBeenCalled();
    expect(console.warn).not.toHaveBeenCalled();
  });
});
