// @vitest-environment node
import { AuthApiError, AuthRetryableFetchError } from "@supabase/supabase-js";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { CHANGE_EMAIL_ERRORS } from "../services/change-email-errors";

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

const cache = vi.hoisted(() => ({ revalidatePath: vi.fn() }));
vi.mock("next/cache", () => cache);

vi.mock("@/config/env.client", () => ({
  clientEnv: {
    NEXT_PUBLIC_APP_URL: "https://app.example.com",
    NEXT_PUBLIC_SUPABASE_URL: "https://project.supabase.co",
    NEXT_PUBLIC_SUPABASE_ANON_KEY: "anon-key",
  },
}));

const session = vi.hoisted(() => ({
  getCurrentUser:
    vi.fn<
      () => Promise<{ id: string; email?: string | null; new_email?: string } | null>
    >(),
}));
vi.mock("@/infrastructure/auth/session/get-current-user", () => session);

// The activity history writer (service role). Its own behaviour is covered by
// record-account-activity.test.ts; here only WHEN and WITH WHAT it is called.
const activity = vi.hoisted(() => ({
  recordAccountActivity: vi.fn<() => Promise<{ ok: true; id: number } | { ok: false }>>(),
}));
vi.mock("@/infrastructure/account-activity/record-account-activity", () => activity);

type UpdateUserArgs = { email?: string; password?: string; data?: unknown };
type UpdateUserOptions = { emailRedirectTo?: string };
type UpdateUserResponse = {
  data: { user: { id: string; new_email?: string } | null };
  error: { name: string; code?: string; status?: number } | null;
};

const supabase = vi.hoisted(() => ({
  updateUser:
    vi.fn<
      (
        attributes: UpdateUserArgs,
        options?: UpdateUserOptions,
      ) => Promise<UpdateUserResponse>
    >(),
}));
const infra = vi.hoisted(() => ({ createClient: vi.fn<() => Promise<unknown>>() }));
vi.mock("@/infrastructure/auth/supabase/server", () => infra);

import { changeEmail } from "./change-email";

// ------------------------------------------------------------------------------

const form = (fields: Record<string, string | Blob>) => {
  const data = new FormData();
  for (const [name, value] of Object.entries(fields)) data.append(name, value);
  return data;
};

const USER = { id: "11111111-1111-4111-8111-111111111111", email: "jane@example.com" };
const NEW_EMAIL = "jane.new@example.com";

/** What Supabase answers when it accepted the address and sent the email(s): the user is unchanged, with `new_email` recorded. */
const ACCEPTED: UpdateUserResponse = {
  data: { user: { id: USER.id, new_email: NEW_EMAIL } },
  error: null,
};

const failure = (error: UpdateUserResponse["error"]): UpdateUserResponse => ({
  data: { user: null },
  error,
});

const loggedText = () =>
  JSON.stringify([
    ...vi.mocked(console.error).mock.calls,
    ...vi.mocked(console.warn).mock.calls,
  ]);

beforeEach(() => {
  vi.clearAllMocks();
  session.getCurrentUser.mockResolvedValue(USER);
  infra.createClient.mockResolvedValue({ auth: { updateUser: supabase.updateUser } });
  supabase.updateUser.mockResolvedValue(ACCEPTED);
  activity.recordAccountActivity.mockResolvedValue({ ok: true, id: 1 });
  vi.spyOn(console, "error").mockImplementation(() => {});
  vi.spyOn(console, "warn").mockImplementation(() => {});
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe("changeEmail – a request only sends confirmation, it never changes the address", () => {
  it("asks Supabase to start the change and reports that confirmation was sent", async () => {
    await expect(changeEmail(null, form({ email: NEW_EMAIL }))).resolves.toEqual({
      status: "confirmation_sent",
      email: NEW_EMAIL,
    });

    expect(supabase.updateUser).toHaveBeenCalledTimes(1);
    expect(supabase.updateUser.mock.calls[0][0]).toEqual({ email: NEW_EMAIL });
    expect(console.error).not.toHaveBeenCalled();
  });

  it("points the confirmation link(s) at this app's auth callback (absolute URL)", async () => {
    await changeEmail(null, form({ email: NEW_EMAIL }));

    expect(supabase.updateUser.mock.calls[0][1]).toEqual({
      emailRedirectTo: "https://app.example.com/auth/callback",
    });
  });

  it("touches only the email: no password or metadata", async () => {
    await changeEmail(
      null,
      form({ email: NEW_EMAIL, password: "x", fullName: "Mallory" }),
    );

    expect(Object.keys(supabase.updateUser.mock.calls[0][0])).toEqual(["email"]);
  });

  it("revalidates the settings route so the re-render shows the change as pending", async () => {
    await changeEmail(null, form({ email: NEW_EMAIL }));

    expect(cache.revalidatePath).toHaveBeenCalledWith("/settings");
  });

  it("trims the address", async () => {
    await expect(changeEmail(null, form({ email: `  ${NEW_EMAIL} ` }))).resolves.toEqual({
      status: "confirmation_sent",
      email: NEW_EMAIL,
    });
    expect(supabase.updateUser.mock.calls[0][0]).toEqual({ email: NEW_EMAIL });
  });

  it("does not redirect", async () => {
    await expect(changeEmail(null, form({ email: NEW_EMAIL }))).resolves.not.toBeNull();
  });

  it("accepts the address of an already pending change again (that is the resend)", async () => {
    session.getCurrentUser.mockResolvedValue({ ...USER });

    await expect(changeEmail(null, form({ email: NEW_EMAIL }))).resolves.toMatchObject({
      status: "confirmation_sent",
    });
    expect(supabase.updateUser).toHaveBeenCalledTimes(1);
  });
});

describe("changeEmail – unauthorized access", () => {
  it("redirects an anonymous caller to /login before doing anything else", async () => {
    session.getCurrentUser.mockResolvedValue(null);

    await expect(changeEmail(null, form({ email: NEW_EMAIL }))).rejects.toMatchObject({
      url: "/login",
    });
    expect(infra.createClient).not.toHaveBeenCalled();
    expect(supabase.updateUser).not.toHaveBeenCalled();
    expect(cache.revalidatePath).not.toHaveBeenCalled();
  });

  it("does not validate the input for an anonymous caller", async () => {
    session.getCurrentUser.mockResolvedValue(null);

    await expect(changeEmail(null, form({ email: "nope" }))).rejects.toBeInstanceOf(
      RedirectSignal,
    );
  });
});

describe("changeEmail – input validation (before contacting Supabase)", () => {
  it.each([
    ["missing", {}, ""],
    ["empty", { email: "" }, ""],
    ["whitespace-only", { email: "   " }, ""],
    ["malformed", { email: "not-an-email" }, "not-an-email"],
    ["with spaces inside", { email: "jane doe@example.com" }, "jane doe@example.com"],
  ])(
    "rejects a %s address with a field error and echoes the trimmed input",
    async (_l, fields, echoed) => {
      await expect(changeEmail(null, form(fields))).resolves.toEqual({
        status: "error",
        error: CHANGE_EMAIL_ERRORS.invalidEmail,
        field: "email",
        email: echoed,
      });
      expect(infra.createClient).not.toHaveBeenCalled();
      expect(cache.revalidatePath).not.toHaveBeenCalled();
    },
  );

  it("treats a non-string value (a file) as missing", async () => {
    await expect(
      changeEmail(null, form({ email: new Blob(["x"]) })),
    ).resolves.toMatchObject({
      status: "error",
      field: "email",
      email: "",
    });
  });

  it("refuses the account's current address, ignoring case, without contacting Supabase", async () => {
    for (const same of [USER.email, "Jane@Example.COM", `  ${USER.email}  `]) {
      await expect(changeEmail(null, form({ email: same }))).resolves.toEqual({
        status: "error",
        error: CHANGE_EMAIL_ERRORS.sameEmail,
        field: "email",
        email: same.trim(),
      });
    }
    expect(supabase.updateUser).not.toHaveBeenCalled();
  });

  it("lets an account without an email set one (nothing to compare against)", async () => {
    session.getCurrentUser.mockResolvedValue({ id: USER.id, email: null });

    await expect(changeEmail(null, form({ email: NEW_EMAIL }))).resolves.toMatchObject({
      status: "confirmation_sent",
    });
  });
});

describe("changeEmail – Supabase refuses the address", () => {
  it("reports an address another account uses, on the field, without logging", async () => {
    supabase.updateUser.mockResolvedValue(
      failure(
        new AuthApiError(
          "A user with this email address has already been registered",
          422,
          "email_exists",
        ),
      ),
    );

    await expect(changeEmail(null, form({ email: NEW_EMAIL }))).resolves.toEqual({
      status: "error",
      error: CHANGE_EMAIL_ERRORS.emailTaken,
      field: "email",
      email: NEW_EMAIL,
    });
    expect(cache.revalidatePath).not.toHaveBeenCalled();
    expect(console.error).not.toHaveBeenCalled();
  });

  it("reports an address Supabase considers invalid", async () => {
    supabase.updateUser.mockResolvedValue(
      failure(
        new AuthApiError(
          "Unable to validate email address",
          400,
          "email_address_invalid",
        ),
      ),
    );

    await expect(changeEmail(null, form({ email: NEW_EMAIL }))).resolves.toMatchObject({
      error: CHANGE_EMAIL_ERRORS.invalidEmail,
      field: "email",
    });
  });

  it("reports a confirmation sent too recently (per-address limit) as 'wait a minute'", async () => {
    supabase.updateUser.mockResolvedValue(
      failure(
        new AuthApiError(
          "For security purposes, you can only request this once every 60 seconds",
          429,
          "over_email_send_rate_limit",
        ),
      ),
    );

    await expect(changeEmail(null, form({ email: NEW_EMAIL }))).resolves.toEqual({
      status: "error",
      error: CHANGE_EMAIL_ERRORS.tooSoon,
      email: NEW_EMAIL,
    });
    expect(console.error).not.toHaveBeenCalled();
  });

  it.each([
    ["session_expired", 401],
    ["session_not_found", 403],
    [undefined, 401],
  ])(
    "asks the user to sign in again when the session is gone (code %s, status %s)",
    async (code, status) => {
      supabase.updateUser.mockResolvedValue(failure(new AuthApiError("x", status, code)));

      await expect(changeEmail(null, form({ email: NEW_EMAIL }))).resolves.toMatchObject({
        error: CHANGE_EMAIL_ERRORS.sessionExpired,
      });
    },
  );

  it("reports the SMTP allow-list refusal as temporary and WARNS operators (misconfiguration, not an outage)", async () => {
    supabase.updateUser.mockResolvedValue(
      failure(
        new AuthApiError(
          `Email address "${NEW_EMAIL}" cannot be used as it is not authorized`,
          403,
          "email_address_not_authorized",
        ),
      ),
    );

    await expect(changeEmail(null, form({ email: NEW_EMAIL }))).resolves.toEqual({
      status: "error",
      error: CHANGE_EMAIL_ERRORS.unavailable,
      email: NEW_EMAIL,
    });
    expect(console.warn).toHaveBeenCalledWith(
      "[settings] email change confirmation could not be sent",
      { name: "AuthApiError", code: "email_address_not_authorized", status: 403 },
    );
    expect(console.error).not.toHaveBeenCalled();
    expect(loggedText()).not.toContain(NEW_EMAIL);
  });

  it("reports an outage as temporary and logs only name/code/status", async () => {
    supabase.updateUser.mockResolvedValue(
      failure(new AuthRetryableFetchError("fetch failed", 0)),
    );

    await expect(changeEmail(null, form({ email: NEW_EMAIL }))).resolves.toMatchObject({
      error: CHANGE_EMAIL_ERRORS.unavailable,
    });
    expect(console.error).toHaveBeenCalledWith(
      "[settings] email change confirmation could not be sent",
      { name: "AuthRetryableFetchError", code: undefined, status: 0 },
    );
    expect(loggedText()).not.toContain(NEW_EMAIL);
    expect(loggedText()).not.toContain(USER.email);
  });

  it("turns a thrown error into a result instead of crashing the page", async () => {
    infra.createClient.mockRejectedValue(
      new TypeError(`cookies unavailable ${NEW_EMAIL}`),
    );

    await expect(changeEmail(null, form({ email: NEW_EMAIL }))).resolves.toEqual({
      status: "error",
      error: CHANGE_EMAIL_ERRORS.unavailable,
      email: NEW_EMAIL,
    });
    expect(console.error).toHaveBeenCalledWith(
      "[settings] email change threw unexpectedly",
      {
        name: "TypeError",
      },
    );
    expect(loggedText()).not.toContain(NEW_EMAIL);
  });

  it("never echoes the raw Supabase message, and never claims success on an error", async () => {
    const raw = "SECRET internal detail";

    for (const code of [
      "email_exists",
      "over_email_send_rate_limit",
      "unexpected_failure",
      undefined,
    ]) {
      supabase.updateUser.mockResolvedValueOnce(
        failure(new AuthApiError(raw, 400, code)),
      );

      const result = await changeEmail(null, form({ email: NEW_EMAIL }));

      expect(JSON.stringify(result)).not.toContain("SECRET");
      expect(result).toMatchObject({ status: "error" });
    }
    expect(cache.revalidatePath).not.toHaveBeenCalled();
    expect(loggedText()).not.toContain("SECRET");
  });
});

describe("changeEmail – activity history", () => {
  it("records the REQUEST (from, to) for the verified user once Supabase accepted it, then refreshes the page", async () => {
    const order: string[] = [];
    supabase.updateUser.mockImplementation(async () => {
      order.push("update");
      return ACCEPTED;
    });
    activity.recordAccountActivity.mockImplementation(async () => {
      order.push("record");
      return { ok: true, id: 1 };
    });

    await expect(changeEmail(null, form({ email: NEW_EMAIL }))).resolves.toEqual({
      status: "confirmation_sent",
      email: NEW_EMAIL,
    });

    expect(order).toEqual(["update", "record"]);
    expect(activity.recordAccountActivity).toHaveBeenCalledTimes(1);
    expect(activity.recordAccountActivity).toHaveBeenCalledWith(USER.id, {
      type: "email.change_requested",
      details: { from: USER.email, to: NEW_EMAIL, resend: false },
    });
    expect(cache.revalidatePath).toHaveBeenCalledWith("/settings");
  });

  it("REGRESSION: never records the address as CHANGED — that happens only when a link completes it", async () => {
    await changeEmail(null, form({ email: NEW_EMAIL }));

    const types = activity.recordAccountActivity.mock.calls.map(
      (call) => (call as unknown as [string, { type: string }])[1].type,
    );
    expect(types).toEqual(["email.change_requested"]);
    expect(types).not.toContain("email.changed");
  });

  it("records a request for the address already pending as a resend", async () => {
    session.getCurrentUser.mockResolvedValue({
      ...USER,
      new_email: NEW_EMAIL.toUpperCase(),
    });

    await changeEmail(null, form({ email: NEW_EMAIL }));

    expect(activity.recordAccountActivity).toHaveBeenCalledWith(USER.id, {
      type: "email.change_requested",
      details: { from: USER.email, to: NEW_EMAIL, resend: true },
    });
  });

  it("records a request for a DIFFERENT address than the pending one as a new request", async () => {
    session.getCurrentUser.mockResolvedValue({ ...USER, new_email: "other@example.com" });

    await changeEmail(null, form({ email: NEW_EMAIL }));

    expect(activity.recordAccountActivity).toHaveBeenCalledWith(
      USER.id,
      expect.objectContaining({ details: expect.objectContaining({ resend: false }) }),
    );
  });

  it("records the trimmed address, and null as the previous one for an account without an email", async () => {
    session.getCurrentUser.mockResolvedValue({ id: USER.id, email: null });

    await changeEmail(null, form({ email: `  ${NEW_EMAIL} ` }));

    expect(activity.recordAccountActivity).toHaveBeenCalledWith(USER.id, {
      type: "email.change_requested",
      details: { from: null, to: NEW_EMAIL, resend: false },
    });
  });

  it("attributes the event to the session's user, never to anything in the form", async () => {
    await changeEmail(
      null,
      form({ email: NEW_EMAIL, userId: "22222222-2222-4222-8222-222222222222" }),
    );

    const [userId] = activity.recordAccountActivity.mock.calls[0] as unknown as [string];
    expect(userId).toBe(USER.id);
  });

  describe("REGRESSION: a request that was not accepted leaves no entry", () => {
    it.each([
      [
        "anonymous caller",
        () => session.getCurrentUser.mockResolvedValue(null),
        NEW_EMAIL,
      ],
      ["invalid address", () => {}, "not-an-email"],
      ["the current address", () => {}, USER.email.toUpperCase()],
      [
        "address taken",
        () =>
          supabase.updateUser.mockResolvedValue(
            failure(new AuthApiError("registered", 422, "email_exists")),
          ),
        NEW_EMAIL,
      ],
      [
        "rate limited",
        () =>
          supabase.updateUser.mockResolvedValue(
            failure(new AuthApiError("x", 429, "over_email_send_rate_limit")),
          ),
        NEW_EMAIL,
      ],
      [
        "session gone",
        () =>
          supabase.updateUser.mockResolvedValue(
            failure(new AuthApiError("x", 401, "session_expired")),
          ),
        NEW_EMAIL,
      ],
      [
        "outage",
        () =>
          supabase.updateUser.mockResolvedValue(
            failure(new AuthRetryableFetchError("fetch failed", 0)),
          ),
        NEW_EMAIL,
      ],
      [
        "the request throws",
        () => infra.createClient.mockRejectedValue(new TypeError("boom")),
        NEW_EMAIL,
      ],
    ])("%s", async (_label, arrange, email) => {
      arrange();

      const outcome = await changeEmail(null, form({ email })).catch((thrown) => thrown);
      expect(outcome).not.toMatchObject({ status: "confirmation_sent" });

      expect(activity.recordAccountActivity).not.toHaveBeenCalled();
      expect(cache.revalidatePath).not.toHaveBeenCalled();
    });
  });

  describe("REGRESSION: a failure to record does not affect the request that was already accepted", () => {
    it("when the recorder reports a failure", async () => {
      activity.recordAccountActivity.mockResolvedValue({ ok: false });

      await expect(changeEmail(null, form({ email: NEW_EMAIL }))).resolves.toEqual({
        status: "confirmation_sent",
        email: NEW_EMAIL,
      });
      expect(cache.revalidatePath).toHaveBeenCalledWith("/settings");
      expect(console.error).not.toHaveBeenCalled(); // the recorder logs; the action adds nothing
    });

    it("when the recorder throws", async () => {
      activity.recordAccountActivity.mockRejectedValue(
        new Error(`activity store down for ${NEW_EMAIL}`),
      );

      await expect(changeEmail(null, form({ email: NEW_EMAIL }))).resolves.toEqual({
        status: "confirmation_sent",
        email: NEW_EMAIL,
      });
      expect(cache.revalidatePath).toHaveBeenCalledWith("/settings");
      expect(supabase.updateUser).toHaveBeenCalledTimes(1); // not retried
      expect(console.error).toHaveBeenCalledTimes(1);
      expect(loggedText()).not.toContain(NEW_EMAIL);
      expect(loggedText()).not.toContain(USER.id);
    });
  });
});
