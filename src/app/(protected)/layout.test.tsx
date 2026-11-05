// @vitest-environment node
import { beforeEach, describe, expect, it, vi } from "vitest";

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

const auth = vi.hoisted(() => ({ getCurrentUser: vi.fn() }));
vi.mock("@/infrastructure/auth/session/get-current-user", () => auth);

import ProtectedLayout from "./layout";

describe("(protected) layout", () => {
  beforeEach(() => auth.getCurrentUser.mockReset());

  it("redirects anonymous visitors to /login before rendering anything", async () => {
    auth.getCurrentUser.mockResolvedValue(null);

    await expect(ProtectedLayout({ children: "secret" })).rejects.toMatchObject({
      url: "/login",
    });
  });

  it("renders its children for a signed-in user", async () => {
    auth.getCurrentUser.mockResolvedValue({ id: "u1", email: "jane@example.com" });

    await expect(ProtectedLayout({ children: "content" })).resolves.toMatchObject({
      props: { children: "content" },
    });
  });
});
