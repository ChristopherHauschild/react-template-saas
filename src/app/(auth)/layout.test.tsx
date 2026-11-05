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

import AuthLayout from "./layout";

describe("(auth) layout", () => {
  beforeEach(() => session.getCurrentUser.mockReset());

  it("redirects a signed-in visitor to the dashboard before rendering anything", async () => {
    session.getCurrentUser.mockResolvedValue({ id: "u1", email: "jane@example.com" });

    await expect(AuthLayout({ children: "secret" })).rejects.toMatchObject({
      url: "/dashboard",
    });
  });

  it("renders its children for a guest — shared by both /login and /signup", async () => {
    session.getCurrentUser.mockResolvedValue(null);

    const html = renderToStaticMarkup(await AuthLayout({ children: "content" }));

    expect(html).toContain("content");
    expect(html).toContain("Your SaaS"); // the marketing panel shared by both pages
  });

  it("lets the form column scroll instead of clipping (login can stack banner + resend + card)", async () => {
    session.getCurrentUser.mockResolvedValue(null);

    const html = renderToStaticMarkup(await AuthLayout({ children: "content" }));

    expect(html).toMatch(/class="[^"]*overflow-y-auto[^"]*"[^>]*>content/);
    expect(html).not.toContain("overflow-hidden");
  });
});
