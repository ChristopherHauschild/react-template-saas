// @vitest-environment node
import { AuthApiError, AuthSessionMissingError } from "@supabase/supabase-js";
import { beforeEach, describe, expect, it, vi } from "vitest";

const supabase = vi.hoisted(() => ({
  getUser: vi.fn<() => Promise<{ data: { user: unknown }; error: unknown }>>(),
}));
vi.mock("../supabase/server", () => ({
  createClient: vi.fn(async () => ({ auth: { getUser: supabase.getUser } })),
}));

import { getCurrentUser } from "./get-current-user";

const USER = { id: "u1", email: "jane@example.com" };

beforeEach(() => {
  vi.clearAllMocks();
});

describe("getCurrentUser", () => {
  it("returns the user when the session is valid (or was refreshed)", async () => {
    supabase.getUser.mockResolvedValue({ data: { user: USER }, error: null });

    await expect(getCurrentUser()).resolves.toEqual(USER);
  });

  it("returns null when there is no session", async () => {
    supabase.getUser.mockResolvedValue({
      data: { user: null },
      error: new AuthSessionMissingError(),
    });

    await expect(getCurrentUser()).resolves.toBeNull();
  });

  it("returns null when the session cannot be refreshed (expired, revoked, server says no)", async () => {
    supabase.getUser.mockResolvedValue({
      data: { user: null },
      error: new AuthApiError("Invalid Refresh Token", 400, "refresh_token_not_found"),
    });

    // Guards turn null into a redirect to /login instead of a crash.
    await expect(getCurrentUser()).resolves.toBeNull();
  });

  it("does not hide unexpected failures (they are not a 'logged out' state)", async () => {
    supabase.getUser.mockRejectedValue(new TypeError("cookie store is broken"));

    await expect(getCurrentUser()).rejects.toThrow("cookie store is broken");
  });
});
