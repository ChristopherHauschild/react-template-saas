// @vitest-environment node
import { renderToStaticMarkup } from "react-dom/server";

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

const session = vi.hoisted(() => ({ getCurrentUser: vi.fn() }));
vi.mock("@/infrastructure/auth/session/get-current-user", () => session);

// The form submits a real server action; keep the page test focused on the
// page's own logic (the guest guard). The action itself is covered by
// sign-up.test.ts.
vi.mock("@/features/auth/actions/sign-up", () => ({ signUp: vi.fn() }));

vi.mock("@/features/auth/actions/resend-confirmation", () => ({
  resendConfirmation: vi.fn(),
}));

import SignUpPage from "./page";

beforeEach(() => {
  session.getCurrentUser.mockReset();
  session.getCurrentUser.mockResolvedValue(null); // guest by default
});

describe("/signup page", () => {
  it("redirects a signed-in visitor to the dashboard instead of rendering", async () => {
    session.getCurrentUser.mockResolvedValue({ id: "u1", email: "jane@example.com" });

    await expect(SignUpPage()).rejects.toMatchObject({ url: "/dashboard" });
  });

  it("renders the sign-up form for a guest", async () => {
    const html = renderToStaticMarkup(await SignUpPage());

    expect(html).toContain('name="email"');
    expect(html).toContain('name="password"');
    expect(html).toContain('name="confirmPassword"');
    expect(html).toContain(">Create account<");
  });

  it("links back to the login page", async () => {
    const html = renderToStaticMarkup(await SignUpPage());

    expect(html).toContain('href="/login"');
  });
});
