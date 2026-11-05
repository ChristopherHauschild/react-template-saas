// @vitest-environment node
import {
  AuthApiError,
  AuthRetryableFetchError,
  AuthSessionMissingError,
  AuthWeakPasswordError,
} from "@supabase/supabase-js";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { PASSWORD_MAX_LENGTH, PASSWORD_MIN_LENGTH } from "@/config/passwordPolicy";

import { CHANGE_PASSWORD_ERRORS } from "../services/change-password-errors";

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

// The guard's per-request user lookup; null models an anonymous caller.
const session = vi.hoisted(() => ({
  getCurrentUser: vi.fn<() => Promise<{ id: string; email?: string | null } | null>>(),
}));
vi.mock("@/infrastructure/auth/session/get-current-user", () => session);

type AuthError = { name: string; code?: string; status?: number } | null;
type SignInArgs = { email: string; password: string };
type SignInResponse = {
  data: { user: { id: string } | null; session: { access_token: string } | null };
  error: AuthError;
};
type UpdateUserArgs = { password?: string; email?: string; data?: unknown };
type UpdateUserResponse = { data: { user: { id: string } | null }; error: AuthError };

/** The stateless client used for the current-password check. */
const verifier = vi.hoisted(() => ({
  signInWithPassword: vi.fn<(credentials: SignInArgs) => Promise<SignInResponse>>(),
  signOut: vi.fn<(options: { scope: string }) => Promise<{ error: AuthError }>>(),
}));
const stateless = vi.hoisted(() => ({ createStatelessClient: vi.fn<() => unknown>() }));
vi.mock("@/infrastructure/auth/supabase/stateless", () => stateless);

/** The cookie-based client the password is written through. */
const supabase = vi.hoisted(() => ({
  updateUser: vi.fn<(attributes: UpdateUserArgs) => Promise<UpdateUserResponse>>(),
  signOut: vi.fn<(options: { scope: string }) => Promise<{ error: AuthError }>>(),
}));

/** Revocation of the other sessions (GoTrue's real answer; see session-tokens.ts). */
type Revoked = { ok: true } | { ok: false; error: unknown };
const tokens = vi.hoisted(() => ({
  revokeOtherSessions: vi.fn<(client?: unknown) => Promise<Revoked>>(),
}));
vi.mock("@/infrastructure/auth/session/session-tokens", () => tokens);
const infra = vi.hoisted(() => ({ createClient: vi.fn<() => Promise<unknown>>() }));
vi.mock("@/infrastructure/auth/supabase/server", () => infra);

const cache = vi.hoisted(() => ({ revalidatePath: vi.fn() }));
vi.mock("next/cache", () => cache);

// The activity history writer (service role). Its own behaviour is covered by
// record-account-activity.test.ts; here only WHEN and WITH WHAT it is called.
const activity = vi.hoisted(() => ({
  recordAccountActivity: vi.fn<() => Promise<{ ok: true; id: number } | { ok: false }>>(),
}));
vi.mock("@/infrastructure/account-activity/record-account-activity", () => activity);

import { changePassword } from "./change-password";

// ------------------------------------------------------------------------------

const form = (fields: Record<string, string | Blob>) => {
  const data = new FormData();
  for (const [name, value] of Object.entries(fields)) data.append(name, value);
  return data;
};

const USER = { id: "11111111-1111-4111-8111-111111111111", email: "jane@example.com" };
const CURRENT = "old-correct-horse";
const NEXT = "new-battery-staple";
const VALID = { currentPassword: CURRENT, newPassword: NEXT, confirmPassword: NEXT };

const SIGNED_IN: SignInResponse = {
  data: { user: { id: USER.id }, session: { access_token: "verification-jwt" } },
  error: null,
};
const UPDATED: UpdateUserResponse = { data: { user: { id: USER.id } }, error: null };

const signInFailure = (error: AuthError): SignInResponse => ({
  data: { user: null, session: null },
  error,
});
const updateFailure = (error: AuthError): UpdateUserResponse => ({
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

/** Neither result nor logs may ever carry a password or the account's identity. */
const expectNoSensitiveData = (result: unknown) => {
  const text = JSON.stringify(result) + loggedText();

  expect(text).not.toContain(CURRENT);
  expect(text).not.toContain(NEXT);
  expect(text).not.toContain(USER.email);
  expect(text).not.toContain(USER.id);
  expect(text).not.toContain("verification-jwt");
};

beforeEach(() => {
  vi.clearAllMocks();
  session.getCurrentUser.mockResolvedValue(USER);
  stateless.createStatelessClient.mockReturnValue({ auth: verifier });
  verifier.signInWithPassword.mockResolvedValue(SIGNED_IN);
  verifier.signOut.mockResolvedValue({ error: null });
  infra.createClient.mockResolvedValue({
    auth: { updateUser: supabase.updateUser, signOut: supabase.signOut },
  });
  supabase.updateUser.mockResolvedValue(UPDATED);
  supabase.signOut.mockResolvedValue({ error: null });
  tokens.revokeOtherSessions.mockResolvedValue({ ok: true });
  activity.recordAccountActivity.mockResolvedValue({ ok: true, id: 1 });
  vi.spyOn(console, "error").mockImplementation(() => {});
  vi.spyOn(console, "warn").mockImplementation(() => {});
  vi.spyOn(console, "info").mockImplementation(() => {});
  vi.spyOn(console, "log").mockImplementation(() => {});
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe("changePassword – primary flow", () => {
  it("verifies the current password, then sets the new one, and confirms", async () => {
    const result = await changePassword(null, form(VALID));

    expect(result).toEqual({ status: "changed", otherSessionsSignedOut: true });

    expect(verifier.signInWithPassword).toHaveBeenCalledTimes(1);
    expect(verifier.signInWithPassword).toHaveBeenCalledWith({
      email: USER.email,
      password: CURRENT,
    });
    expect(supabase.updateUser).toHaveBeenCalledTimes(1);
    expect(supabase.updateUser).toHaveBeenCalledWith({ password: NEXT });
    expect(console.error).not.toHaveBeenCalled();
    expect(console.warn).not.toHaveBeenCalled();
  });

  it("checks the current password before writing anything", async () => {
    const order: string[] = [];
    verifier.signInWithPassword.mockImplementation(async () => {
      order.push("verify");
      return SIGNED_IN;
    });
    supabase.updateUser.mockImplementation(async () => {
      order.push("update");
      return UPDATED;
    });

    await changePassword(null, form(VALID));

    expect(order).toEqual(["verify", "update"]);
  });

  it("verifies with a stateless client and writes with the cookie-based one", async () => {
    await changePassword(null, form(VALID));

    // The check must not run through the cookie client: a sign-in there would
    // replace the browser's session.
    expect(stateless.createStatelessClient).toHaveBeenCalledTimes(1);
    expect(infra.createClient).toHaveBeenCalledTimes(1);
  });

  it("revokes the throwaway session the verification produced", async () => {
    await changePassword(null, form(VALID));

    expect(verifier.signOut).toHaveBeenCalledTimes(1);
    expect(verifier.signOut).toHaveBeenCalledWith({ scope: "local" });
  });

  it("still succeeds, with a warning, when the throwaway session cannot be revoked", async () => {
    verifier.signOut.mockResolvedValue({
      error: new AuthApiError("Session not found", 403, "session_not_found"),
    });

    await expect(changePassword(null, form(VALID))).resolves.toMatchObject({
      status: "changed",
    });

    expect(console.warn).toHaveBeenCalledWith(
      "[settings] could not revoke the password-verification session",
      { name: "AuthApiError", code: "session_not_found", status: 403 },
    );
    expect(console.error).not.toHaveBeenCalled();
  });

  it("writes only the password: no email, metadata or other attributes", async () => {
    await changePassword(null, form({ ...VALID, email: "x@y.z", fullName: "Mallory" }));

    expect(Object.keys(supabase.updateUser.mock.calls[0][0])).toEqual(["password"]);
  });

  it("keeps passwords exactly as typed (no trimming — whitespace is part of them)", async () => {
    const spaced = " pass word 1 ";

    await changePassword(
      null,
      form({ currentPassword: " old ", newPassword: spaced, confirmPassword: spaced }),
    );

    expect(verifier.signInWithPassword).toHaveBeenCalledWith({
      email: USER.email,
      password: " old ",
    });
    expect(supabase.updateUser).toHaveBeenCalledWith({ password: spaced });
  });

  it("does not redirect and does not echo anything back", async () => {
    const result = await changePassword(null, form(VALID));

    expect(Object.keys(result as object).sort()).toEqual([
      "otherSessionsSignedOut",
      "status",
    ]);
    expectNoSensitiveData(result);
  });
});

describe("changePassword – other sessions are evicted once the password is in effect", () => {
  it("revokes every OTHER session after the write, through the same cookie client", async () => {
    const order: string[] = [];
    supabase.updateUser.mockImplementation(async () => {
      order.push("update");
      return UPDATED;
    });
    tokens.revokeOtherSessions.mockImplementation(async () => {
      order.push("revoke-others");
      return { ok: true };
    });

    await changePassword(null, form(VALID));

    expect(order).toEqual(["update", "revoke-others"]);
    expect(tokens.revokeOtherSessions).toHaveBeenCalledTimes(1);
    // Same client as the write: one cookie client per request.
    const [client] = tokens.revokeOtherSessions.mock.calls[0];
    expect(client).toBe(await infra.createClient.mock.results[0].value);
    expect(infra.createClient).toHaveBeenCalledTimes(1);
  });

  it("REGRESSION: never relies on the client sign-out (it reports success on 401/403 without revoking)", async () => {
    await changePassword(null, form(VALID));

    expect(supabase.signOut).not.toHaveBeenCalled();
  });

  it("does not touch other sessions when the write failed", async () => {
    supabase.updateUser.mockResolvedValue(
      updateFailure(new AuthApiError("weak", 422, "weak_password")),
    );

    await changePassword(null, form(VALID));

    expect(tokens.revokeOtherSessions).not.toHaveBeenCalled();
  });

  it("does not touch other sessions when the current password was wrong", async () => {
    verifier.signInWithPassword.mockResolvedValue(
      signInFailure(new AuthApiError("bad", 400, "invalid_credentials")),
    );

    await changePassword(null, form(VALID));

    expect(tokens.revokeOtherSessions).not.toHaveBeenCalled();
  });

  it.each([
    [
      "GoTrue refused (this session is gone)",
      { ok: false as const, error: new AuthApiError("x", 403, "session_not_found") },
    ],
    [
      "the network failed",
      {
        ok: false as const,
        error: new AuthRetryableFetchError(`fetch failed ${NEXT}`, 0),
      },
    ],
  ])(
    "reports otherSessionsSignedOut: false when %s — the password change still stands",
    async (_label, revoked) => {
      tokens.revokeOtherSessions.mockResolvedValue(revoked);

      const result = await changePassword(null, form(VALID));

      expect(result).toEqual({ status: "changed", otherSessionsSignedOut: false });
      expect(console.warn).toHaveBeenCalledWith(
        "[settings] other sessions could not be signed out after a password change",
        expect.objectContaining({ name: expect.any(String) }),
      );
      expect(console.error).not.toHaveBeenCalled();
      expectNoSensitiveData(result);
    },
  );

  it("contains a throwing revocation the same way", async () => {
    tokens.revokeOtherSessions.mockRejectedValue(new TypeError(`boom ${CURRENT}`));

    const result = await changePassword(null, form(VALID));

    expect(result).toEqual({ status: "changed", otherSessionsSignedOut: false });
    expect(console.warn).toHaveBeenCalledWith(
      "[settings] signing out other sessions threw after a password change",
      { name: "TypeError" },
    );
    expectNoSensitiveData(result);
  });
});

describe("changePassword – unauthorized access", () => {
  it("redirects an anonymous caller to /login before doing anything else", async () => {
    session.getCurrentUser.mockResolvedValue(null);

    await expect(changePassword(null, form(VALID))).rejects.toMatchObject({
      url: "/login",
    });

    expect(stateless.createStatelessClient).not.toHaveBeenCalled();
    expect(infra.createClient).not.toHaveBeenCalled();
    expect(supabase.updateUser).not.toHaveBeenCalled();
  });

  it("does not validate the input for an anonymous caller (nothing to learn)", async () => {
    session.getCurrentUser.mockResolvedValue(null);

    await expect(
      changePassword(null, form({ ...VALID, newPassword: "short" })),
    ).rejects.toBeInstanceOf(RedirectSignal);
  });

  it("refuses an account that has no email to verify the password against", async () => {
    session.getCurrentUser.mockResolvedValue({ id: USER.id, email: null });

    await expect(changePassword(null, form(VALID))).resolves.toEqual({
      status: "error",
      error: CHANGE_PASSWORD_ERRORS.noPasswordAccount,
    });
    expect(stateless.createStatelessClient).not.toHaveBeenCalled();
    expect(supabase.updateUser).not.toHaveBeenCalled();
  });
});

describe("changePassword – input validation (before contacting Supabase)", () => {
  const ok = (overrides: Partial<typeof VALID>) => ({ ...VALID, ...overrides });
  const TOO_LONG = "x".repeat(PASSWORD_MAX_LENGTH + 1);
  const JUST_SHORT = "x".repeat(PASSWORD_MIN_LENGTH - 1);

  it.each([
    [
      "missing current password",
      { newPassword: NEXT, confirmPassword: NEXT },
      "currentPassword",
      CHANGE_PASSWORD_ERRORS.currentPasswordRequired,
    ],
    [
      "empty current password",
      ok({ currentPassword: "" }),
      "currentPassword",
      CHANGE_PASSWORD_ERRORS.currentPasswordRequired,
    ],
    [
      "missing new password",
      { currentPassword: CURRENT, confirmPassword: NEXT },
      "newPassword",
      CHANGE_PASSWORD_ERRORS.passwordTooShort,
    ],
    [
      `new password of ${PASSWORD_MIN_LENGTH - 1} characters`,
      ok({ newPassword: JUST_SHORT, confirmPassword: JUST_SHORT }),
      "newPassword",
      CHANGE_PASSWORD_ERRORS.passwordTooShort,
    ],
    [
      `new password of ${PASSWORD_MAX_LENGTH + 1} characters`,
      ok({ newPassword: TOO_LONG, confirmPassword: TOO_LONG }),
      "newPassword",
      CHANGE_PASSWORD_ERRORS.passwordTooLong,
    ],
    [
      "missing confirmation",
      { currentPassword: CURRENT, newPassword: NEXT },
      "confirmPassword",
      CHANGE_PASSWORD_ERRORS.passwordMismatch,
    ],
    [
      "confirmation that differs",
      ok({ confirmPassword: `${NEXT}!` }),
      "confirmPassword",
      CHANGE_PASSWORD_ERRORS.passwordMismatch,
    ],
    [
      "confirmation that differs only in case",
      ok({ confirmPassword: NEXT.toUpperCase() }),
      "confirmPassword",
      CHANGE_PASSWORD_ERRORS.passwordMismatch,
    ],
    [
      "new password equal to the current one",
      ok({ newPassword: CURRENT, confirmPassword: CURRENT }),
      "newPassword",
      CHANGE_PASSWORD_ERRORS.passwordUnchanged,
    ],
  ])("rejects %s with a field error", async (_label, fields, field, message) => {
    const result = await changePassword(null, form(fields));

    expect(result).toEqual({ status: "error", error: message, field });
    expect(stateless.createStatelessClient).not.toHaveBeenCalled();
    expect(infra.createClient).not.toHaveBeenCalled();
    expect(verifier.signInWithPassword).not.toHaveBeenCalled();
    expect(supabase.updateUser).not.toHaveBeenCalled();
    expectNoSensitiveData(result);
  });

  it("reports one problem at a time, current password first", async () => {
    await expect(
      changePassword(
        null,
        form({ currentPassword: "", newPassword: "short", confirmPassword: "other" }),
      ),
    ).resolves.toMatchObject({ field: "currentPassword" });
  });

  it("checks the confirmation before comparing with the current password", async () => {
    await expect(
      changePassword(
        null,
        form({
          currentPassword: CURRENT,
          newPassword: CURRENT,
          confirmPassword: "other-thing",
        }),
      ),
    ).resolves.toMatchObject({ field: "confirmPassword" });
  });

  it("accepts a new password of exactly the minimum and the maximum length", async () => {
    for (const length of [PASSWORD_MIN_LENGTH, PASSWORD_MAX_LENGTH]) {
      const password = "x".repeat(length);

      await expect(
        changePassword(
          null,
          form(ok({ newPassword: password, confirmPassword: password })),
        ),
      ).resolves.toMatchObject({ status: "changed" });
    }
  });

  it("treats a non-string field value (a file) as missing", async () => {
    await expect(
      changePassword(null, form({ ...VALID, newPassword: new Blob(["x"]) })),
    ).resolves.toMatchObject({ status: "error", field: "newPassword" });
  });
});

describe("changePassword – the current password is wrong or cannot be checked", () => {
  it("pins a wrong current password to its field and does not touch the account", async () => {
    verifier.signInWithPassword.mockResolvedValue(
      signInFailure(
        new AuthApiError("Invalid login credentials", 400, "invalid_credentials"),
      ),
    );

    const result = await changePassword(null, form(VALID));

    expect(result).toEqual({
      status: "error",
      error: CHANGE_PASSWORD_ERRORS.currentPasswordIncorrect,
      field: "currentPassword",
    });
    expect(infra.createClient).not.toHaveBeenCalled();
    expect(supabase.updateUser).not.toHaveBeenCalled();
    expect(verifier.signOut).not.toHaveBeenCalled(); // nothing to revoke
    expect(console.error).not.toHaveBeenCalled(); // expected, not logged
    expectNoSensitiveData(result);
  });

  it("reports rate limiting on the check", async () => {
    verifier.signInWithPassword.mockResolvedValue(
      signInFailure(new AuthApiError("Rate limit", 429, "over_request_rate_limit")),
    );

    await expect(changePassword(null, form(VALID))).resolves.toEqual({
      status: "error",
      error: CHANGE_PASSWORD_ERRORS.rateLimited,
    });
    expect(supabase.updateUser).not.toHaveBeenCalled();
  });

  it("reports an outage during the check as temporary and logs it without secrets", async () => {
    verifier.signInWithPassword.mockResolvedValue(
      signInFailure(new AuthRetryableFetchError("fetch failed", 0)),
    );

    const result = await changePassword(null, form(VALID));

    expect(result).toEqual({
      status: "error",
      error: CHANGE_PASSWORD_ERRORS.unavailable,
    });
    expect(console.error).toHaveBeenCalledWith(
      "[settings] current password check failed unexpectedly",
      { name: "AuthRetryableFetchError", code: undefined, status: 0 },
    );
    expect(supabase.updateUser).not.toHaveBeenCalled();
    expectNoSensitiveData(result);
  });

  it("turns a check that throws into a result instead of crashing the page", async () => {
    stateless.createStatelessClient.mockImplementation(() => {
      throw new TypeError(`bad env for ${USER.email} / ${CURRENT}`);
    });

    const result = await changePassword(null, form(VALID));

    expect(result).toEqual({
      status: "error",
      error: CHANGE_PASSWORD_ERRORS.unavailable,
    });
    expect(console.error).toHaveBeenCalledWith(
      "[settings] current password check threw unexpectedly",
      { name: "TypeError" },
    );
    expect(supabase.updateUser).not.toHaveBeenCalled();
    expectNoSensitiveData(result);
  });
});

describe("changePassword – Supabase refuses the new password", () => {
  it("explains a breached password, pinned to the new-password field", async () => {
    supabase.updateUser.mockResolvedValue(
      updateFailure(
        new AuthWeakPasswordError("Password is known to be weak", 422, ["pwned"]),
      ),
    );

    const result = await changePassword(null, form(VALID));

    expect(result).toEqual({
      status: "error",
      error: CHANGE_PASSWORD_ERRORS.weakPasswordBreached,
      field: "newPassword",
    });
    expect(console.error).not.toHaveBeenCalled();
    expectNoSensitiveData(result);
  });

  it("explains a complexity failure without Supabase's wording", async () => {
    supabase.updateUser.mockResolvedValue(
      updateFailure(
        new AuthWeakPasswordError(
          "Password should contain at least one character of each: abc, ABC, 123.",
          422,
          ["characters"],
        ),
      ),
    );

    const result = await changePassword(null, form(VALID));

    expect(result).toMatchObject({
      error: CHANGE_PASSWORD_ERRORS.weakPasswordCharacters,
      field: "newPassword",
    });
    expect(JSON.stringify(result)).not.toContain("abc, ABC, 123");
  });

  it("reports a generically weak password", async () => {
    supabase.updateUser.mockResolvedValue(
      updateFailure(new AuthWeakPasswordError("weak", 422, ["length"])),
    );

    await expect(changePassword(null, form(VALID))).resolves.toEqual({
      status: "error",
      error: CHANGE_PASSWORD_ERRORS.weakPassword,
      field: "newPassword",
    });
  });

  it("reports a new password Supabase considers unchanged", async () => {
    supabase.updateUser.mockResolvedValue(
      updateFailure(
        new AuthApiError(
          "New password should be different from the old password.",
          422,
          "same_password",
        ),
      ),
    );

    await expect(changePassword(null, form(VALID))).resolves.toEqual({
      status: "error",
      error: CHANGE_PASSWORD_ERRORS.passwordUnchanged,
      field: "newPassword",
    });
  });

  it("asks for a fresh sign-in when the project's secure-password-change setting demands it", async () => {
    supabase.updateUser.mockResolvedValue(
      updateFailure(
        new AuthApiError(
          "Password update requires reauthentication",
          400,
          "reauthentication_needed",
        ),
      ),
    );

    await expect(changePassword(null, form(VALID))).resolves.toEqual({
      status: "error",
      error: CHANGE_PASSWORD_ERRORS.reauthenticationRequired,
    });
    expect(console.error).not.toHaveBeenCalled();
  });
});

describe("changePassword – the session ended in the meantime", () => {
  it.each([
    ["session_expired", 401],
    ["session_not_found", 403],
    ["bad_jwt", 401],
    ["user_not_found", 403],
    [undefined, 401],
  ])("asks the user to sign in again (code %s, status %s)", async (code, status) => {
    supabase.updateUser.mockResolvedValue(
      updateFailure(new AuthApiError("Session expired", status, code)),
    );

    await expect(changePassword(null, form(VALID))).resolves.toEqual({
      status: "error",
      error: CHANGE_PASSWORD_ERRORS.sessionExpired,
    });
    expect(console.error).not.toHaveBeenCalled();
  });

  it("asks the user to sign in again when supabase-js itself holds no session", async () => {
    supabase.updateUser.mockResolvedValue(updateFailure(new AuthSessionMissingError()));

    await expect(changePassword(null, form(VALID))).resolves.toMatchObject({
      error: CHANGE_PASSWORD_ERRORS.sessionExpired,
    });
  });
});

describe("changePassword – failures of the write are returned, never thrown", () => {
  it("reports rate limiting on the write", async () => {
    supabase.updateUser.mockResolvedValue(
      updateFailure(new AuthApiError("Rate limit", 429, undefined)),
    );

    await expect(changePassword(null, form(VALID))).resolves.toEqual({
      status: "error",
      error: CHANGE_PASSWORD_ERRORS.rateLimited,
    });
  });

  it("reports an outage as temporary and logs only name/code/status", async () => {
    supabase.updateUser.mockResolvedValue(
      updateFailure(
        new AuthApiError(
          `Database error updating ${USER.email}`,
          500,
          "unexpected_failure",
        ),
      ),
    );

    const result = await changePassword(null, form(VALID));

    expect(result).toEqual({
      status: "error",
      error: CHANGE_PASSWORD_ERRORS.unavailable,
    });
    expect(console.error).toHaveBeenCalledTimes(1);
    expect(console.error).toHaveBeenCalledWith(
      "[settings] password update failed unexpectedly",
      { name: "AuthApiError", code: "unexpected_failure", status: 500 },
    );
    expect(loggedText()).not.toContain("Database error");
    expectNoSensitiveData(result);
  });

  it("turns a thrown error (client construction) into a result", async () => {
    infra.createClient.mockRejectedValue(new TypeError(`cookies unavailable: ${NEXT}`));

    const result = await changePassword(null, form(VALID));

    expect(result).toEqual({
      status: "error",
      error: CHANGE_PASSWORD_ERRORS.unavailable,
    });
    expect(console.error).toHaveBeenCalledWith(
      "[settings] password update threw unexpectedly",
      { name: "TypeError" },
    );
    expectNoSensitiveData(result);
  });

  it("turns a rejection from supabase-js into a result as well", async () => {
    supabase.updateUser.mockRejectedValue(new Error("boom"));

    await expect(changePassword(null, form(VALID))).resolves.toMatchObject({
      status: "error",
      error: CHANGE_PASSWORD_ERRORS.unavailable,
    });
  });

  it("never echoes the raw Supabase message for any error, from either call", async () => {
    const raw = "SECRET internal detail from GoTrue";

    for (const code of [
      "invalid_credentials",
      "over_request_rate_limit",
      "unexpected_failure",
    ]) {
      verifier.signInWithPassword.mockResolvedValueOnce(
        signInFailure(new AuthApiError(raw, 400, code)),
      );
      expect(JSON.stringify(await changePassword(null, form(VALID)))).not.toContain(
        "SECRET",
      );
    }

    for (const code of [
      "weak_password",
      "same_password",
      "reauthentication_needed",
      "session_expired",
      "unexpected_failure",
      undefined,
    ]) {
      supabase.updateUser.mockResolvedValueOnce(
        updateFailure(new AuthApiError(raw, 400, code)),
      );
      expect(JSON.stringify(await changePassword(null, form(VALID)))).not.toContain(
        "SECRET",
      );
    }

    expect(loggedText()).not.toContain("SECRET");
  });
});

describe("changePassword – nothing sensitive ever leaves the action", () => {
  it("keeps passwords, email, id and tokens out of every result and every log line", async () => {
    const scenarios: Array<() => void> = [
      () => {},
      () =>
        verifier.signInWithPassword.mockResolvedValueOnce(
          signInFailure(new AuthApiError(`bad ${CURRENT}`, 400, "invalid_credentials")),
        ),
      () =>
        verifier.signInWithPassword.mockResolvedValueOnce(
          signInFailure(new AuthRetryableFetchError(`down ${USER.email}`, 0)),
        ),
      () =>
        supabase.updateUser.mockResolvedValueOnce(
          updateFailure(new AuthWeakPasswordError(`weak ${NEXT}`, 422, ["pwned"])),
        ),
      () =>
        supabase.updateUser.mockResolvedValueOnce(
          updateFailure(
            new AuthApiError(`500 ${NEXT} ${USER.id}`, 500, "unexpected_failure"),
          ),
        ),
      () => supabase.updateUser.mockRejectedValueOnce(new Error(`thrown ${NEXT}`)),
      () =>
        verifier.signOut.mockResolvedValueOnce({
          error: new AuthApiError(`revoke ${CURRENT}`, 403, "session_not_found"),
        }),
      () =>
        tokens.revokeOtherSessions.mockResolvedValueOnce({
          ok: false,
          error: new AuthApiError(
            `others ${NEXT} ${USER.email}`,
            500,
            "unexpected_failure",
          ),
        }),
    ];

    for (const arrange of scenarios) {
      arrange();
      expectNoSensitiveData(await changePassword(null, form(VALID)));
    }
  });
});

describe("changePassword – activity history", () => {
  const recordedEvents = () =>
    activity.recordAccountActivity.mock.calls as unknown as [string, unknown][];

  it("records a password.changed event — for the verified user, after the change — and refreshes the page", async () => {
    const order: string[] = [];
    supabase.updateUser.mockImplementation(async () => {
      order.push("update");
      return UPDATED;
    });
    tokens.revokeOtherSessions.mockImplementation(async () => {
      order.push("revoke-others");
      return { ok: true };
    });
    activity.recordAccountActivity.mockImplementation(async () => {
      order.push("record");
      return { ok: true, id: 1 };
    });

    await expect(changePassword(null, form(VALID))).resolves.toEqual({
      status: "changed",
      otherSessionsSignedOut: true,
    });

    expect(order).toEqual(["update", "revoke-others", "record"]);
    expect(recordedEvents()).toEqual([
      [USER.id, { type: "password.changed", details: { otherSessionsSignedOut: true } }],
    ]);
    expect(cache.revalidatePath).toHaveBeenCalledTimes(1);
    expect(cache.revalidatePath).toHaveBeenCalledWith("/settings");
  });

  it("records that other sessions were NOT signed out when their revocation failed (the password still changed)", async () => {
    tokens.revokeOtherSessions.mockResolvedValue({ ok: false, error: new Error("x") });

    await expect(changePassword(null, form(VALID))).resolves.toEqual({
      status: "changed",
      otherSessionsSignedOut: false,
    });

    expect(recordedEvents()).toEqual([
      [USER.id, { type: "password.changed", details: { otherSessionsSignedOut: false } }],
    ]);
  });

  it("never passes a password — or anything but the flag — to the recorder", async () => {
    await changePassword(null, form(VALID));

    const [, event] = recordedEvents()[0];
    const text = JSON.stringify(event);
    expect(text).not.toContain(CURRENT);
    expect(text).not.toContain(NEXT);
    expect(text).not.toContain(USER.email);
    expect(Object.keys((event as { details: object }).details)).toEqual([
      "otherSessionsSignedOut",
    ]);
  });

  describe("REGRESSION: a failed change leaves no entry", () => {
    it.each([
      [
        "anonymous caller",
        () => session.getCurrentUser.mockResolvedValue(null),
        form(VALID),
      ],
      [
        "account without an email",
        () => session.getCurrentUser.mockResolvedValue({ id: USER.id, email: null }),
        form(VALID),
      ],
      [
        "invalid input (too short)",
        () => {},
        form({ ...VALID, newPassword: "x", confirmPassword: "x" }),
      ],
      [
        "invalid input (mismatch)",
        () => {},
        form({ ...VALID, confirmPassword: "other" }),
      ],
      [
        "wrong current password",
        () =>
          verifier.signInWithPassword.mockResolvedValue(
            signInFailure(
              new AuthApiError("Invalid login credentials", 400, "invalid_credentials"),
            ),
          ),
        form(VALID),
      ],
      [
        "current password check throws",
        () =>
          stateless.createStatelessClient.mockImplementation(() => {
            throw new Error("boom");
          }),
        form(VALID),
      ],
      [
        "Supabase refuses the new password",
        () =>
          supabase.updateUser.mockResolvedValue(
            updateFailure(new AuthApiError("Password is too weak", 422, "weak_password")),
          ),
        form(VALID),
      ],
      [
        "session gone at the write",
        () =>
          supabase.updateUser.mockResolvedValue(
            updateFailure(new AuthApiError("Session expired", 401, "session_expired")),
          ),
        form(VALID),
      ],
      [
        "the write throws",
        () => supabase.updateUser.mockRejectedValue(new Error("boom")),
        form(VALID),
      ],
      [
        "the write is an outage",
        () =>
          supabase.updateUser.mockResolvedValue(
            updateFailure(new AuthRetryableFetchError("fetch failed", 0)),
          ),
        form(VALID),
      ],
    ])("%s", async (_label, arrange, data) => {
      arrange();

      const outcome = await changePassword(null, data).catch((thrown) => thrown);
      // Every one of these is a non-success (an error result or the redirect).
      expect(outcome).not.toMatchObject({ status: "changed" });

      expect(activity.recordAccountActivity).not.toHaveBeenCalled();
      expect(cache.revalidatePath).not.toHaveBeenCalled();
    });
  });

  describe("REGRESSION: a failure to record does not affect the change that already happened", () => {
    it("when the recorder reports a failure", async () => {
      activity.recordAccountActivity.mockResolvedValue({ ok: false });

      await expect(changePassword(null, form(VALID))).resolves.toEqual({
        status: "changed",
        otherSessionsSignedOut: true,
      });

      expect(supabase.updateUser).toHaveBeenCalledTimes(1);
      expect(cache.revalidatePath).toHaveBeenCalledWith("/settings");
      expect(console.error).not.toHaveBeenCalled(); // the recorder logs; the action adds nothing
    });

    it("when the recorder throws", async () => {
      activity.recordAccountActivity.mockRejectedValue(
        new Error(`activity store down for ${USER.email} ${NEXT}`),
      );

      const result = await changePassword(null, form(VALID));

      expect(result).toEqual({ status: "changed", otherSessionsSignedOut: true });
      expect(cache.revalidatePath).toHaveBeenCalledWith("/settings");
      expect(console.error).toHaveBeenCalledTimes(1);
      expectNoSensitiveData(result);
    });

    it("does not retry the change itself", async () => {
      activity.recordAccountActivity.mockRejectedValue(new Error("boom"));

      await changePassword(null, form(VALID));

      expect(supabase.updateUser).toHaveBeenCalledTimes(1);
      expect(tokens.revokeOtherSessions).toHaveBeenCalledTimes(1);
    });
  });
});
