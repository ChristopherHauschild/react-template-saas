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
  // The status banner's dismiss button is a client component using the router
  // hooks; a static render only needs them to exist.
  useRouter: () => ({ replace: vi.fn(), push: vi.fn() }),
  usePathname: () => "/",
  useSearchParams: () => new URLSearchParams(),
}));

const jar = vi.hoisted(() => ({ values: new Map<string, string>() }));
vi.mock("next/headers", () => ({
  cookies: async () => ({
    get: (name: string) =>
      jar.values.has(name) ? { name, value: jar.values.get(name)! } : undefined,
    getAll: () => [...jar.values].map(([name, value]) => ({ name, value })),
  }),
}));

vi.mock("@/config/env.server", () => ({
  serverEnv: {
    NODE_ENV: "test",
    SUPABASE_SERVICE_ROLE_KEY: "service-role-key-for-tests",
    APP_SECRET: undefined,
  },
}));

const session = vi.hoisted(() => ({ getCurrentUser: vi.fn() }));
vi.mock("@/infrastructure/auth/session/get-current-user", () => session);

// The form submits a real server action; keep the page test focused on the
// page's own logic (the guard and the confirmation banner). The action itself
// is covered by sign-in.test.ts.
vi.mock("@/features/auth/actions/sign-in", () => ({ signIn: vi.fn() }));

vi.mock("@/features/auth/actions/resend-confirmation", () => ({
  resendConfirmation: vi.fn(),
}));

import {
  EMAIL_CHANGE_FLASH_KEY_PURPOSE,
  serializeEmailChangeFlash,
} from "@/features/auth/services/email-change-flash";
import { signingKeyFor } from "@/infrastructure/auth/signed-cookie";

import LoginPage from "./page";

/** What /auth/callback leaves in a browser without a session. */
const setFlash = (
  status: string,
  userId: string | null = null,
  issuedAt = Math.floor(Date.now() / 1000),
  key: Uint8Array = signingKeyFor(EMAIL_CHANGE_FLASH_KEY_PURPOSE),
) =>
  jar.values.set(
    "app-email-change",
    serializeEmailChangeFlash({ status: status as "confirmed", userId, issuedAt }, key),
  );

const render = async (
  confirmation?: string | string[],
  emailChange?: string | string[],
) =>
  renderToStaticMarkup(
    await LoginPage({ searchParams: Promise.resolve({ confirmation, emailChange }) }),
  );

beforeEach(() => {
  jar.values.clear();
  session.getCurrentUser.mockReset();
  session.getCurrentUser.mockResolvedValue(null); // guest by default
});

describe("/login page", () => {
  it("redirects a signed-in visitor to the dashboard instead of rendering", async () => {
    session.getCurrentUser.mockResolvedValue({ id: "u1", email: "jane@example.com" });

    await expect(render()).rejects.toMatchObject({ url: "/dashboard" });
  });

  it("renders the sign-in form for a guest", async () => {
    const html = await render();

    expect(html).toContain('name="email"');
    expect(html).toContain('name="password"');
    expect(html).toContain(">Sign in<");
  });

  it("renders a single form initially (the resend form appears only after an unconfirmed sign-in)", async () => {
    const html = await render();

    expect(html.match(/<form/g)).toHaveLength(1);
    expect(html).not.toContain("Request a new confirmation link");
  });

  it("links to the sign-up page", async () => {
    expect(await render()).toContain('href="/signup"');
  });

  it("shows no banner without a ?confirmation= parameter", async () => {
    const html = await render();

    expect(html).not.toContain('role="alert"');
  });

  it.each([
    ["expired", "has expired"],
    ["invalid", "didn&#x27;t work"],
    ["unavailable", "couldn&#x27;t confirm your email"],
  ])("shows the %s confirmation-failure banner", async (value, expectedText) => {
    const html = await render(value);

    expect(html).toContain('role="alert"');
    expect(html).toContain(expectedText);
  });

  it.each(["expired", "invalid"])(
    "offers a resend form below the %s banner (email typed, not prefilled)",
    async (value) => {
      const html = await render(value);

      expect(html).toContain("Request a new confirmation link");
      expect(html).toMatch(/<input[^>]*type="email"[^>]*name="email"[^>]*value=""/);
      expect(html).not.toContain('type="hidden"');
    },
  );

  it("offers no resend form for an outage (the link is probably fine) or without a failure", async () => {
    expect(await render("unavailable")).not.toContain("Request a new confirmation link");
    expect(await render()).not.toContain("Request a new confirmation link");
  });

  it("ignores an unrecognised ?confirmation= value (no banner, no crash)", async () => {
    const html = await render("<script>alert(1)</script>");

    expect(html).not.toContain('role="alert"');
    // Not reflected anywhere (React's own form-replay boilerplate script is
    // expected and unrelated to this, hence checking the payload, not the tag).
    expect(html).not.toContain("alert(1)");
  });

  it("ignores a repeated ?confirmation= query key (Next passes it as string[])", async () => {
    const html = await render(["expired", "invalid"]);

    expect(html).not.toContain('role="alert"');
  });
});

describe("/login page – email-change outcome for a browser without a session", () => {
  it("shows no email-change banner by default or for unknown values", async () => {
    setFlash("confirmed");
    expect(await render()).not.toMatch(/data-email-change-status/);
    expect(await render(undefined, "changed")).not.toMatch(/data-email-change-status/);
  });

  it("REGRESSION: a typed /login?emailChange=confirmed without the callback's cookie shows nothing", async () => {
    for (const status of ["confirmed", "awaiting_other", "expired"]) {
      expect(await render(undefined, status), status).not.toMatch(
        /data-email-change-status/,
      );
    }
  });

  it("ignores a forged (wrong key), an expired and an unsigned cookie", async () => {
    setFlash("confirmed", null, undefined, Buffer.alloc(32, 0x42));
    expect(await render(undefined, "confirmed")).not.toMatch(/data-email-change-status/);

    setFlash("confirmed", null, Math.floor(Date.now() / 1000) - 3600);
    expect(await render(undefined, "confirmed")).not.toMatch(/data-email-change-status/);

    jar.values.set("app-email-change", `v1.confirmed.-.${Math.floor(Date.now() / 1000)}`);
    expect(await render(undefined, "confirmed")).not.toMatch(/data-email-change-status/);
  });

  it("ignores a flash cookie that was bound to a signed-in user (that one belongs on /settings)", async () => {
    setFlash("confirmed", "11111111-1111-4111-8111-111111111111");

    expect(await render(undefined, "confirmed")).not.toMatch(/data-email-change-status/);
  });

  it("explains a half-confirmed change and tells the user which address still signs in", async () => {
    setFlash("awaiting_other");
    const html = await render(undefined, "awaiting_other");

    expect(html).toMatch(/data-email-change-status="awaiting_other"/);
    expect(html).toMatch(/one more to go/);
    expect(html).toMatch(/sign in with your current address/);
    expect(html).not.toMatch(/has been changed/);
  });

  it("reports a dead link as 'changed nothing' with the way to a new one", async () => {
    for (const status of ["expired", "invalid"]) {
      setFlash(status);
      const html = await render(undefined, status);
      expect(html).toMatch(new RegExp(`data-email-change-status="${status}"`));
      expect(html).toMatch(/changed nothing/);
      expect(html).toMatch(/request a new link from Settings/);
    }
  });

  it("confirms a completed change only for 'confirmed' with its cookie", async () => {
    setFlash("confirmed");
    expect(await render(undefined, "confirmed")).toMatch(/has been changed/);
  });

  it("does not mix the two banners: a sign-up failure and an email-change status are independent", async () => {
    setFlash("confirmed");
    const html = await render("expired", "confirmed");

    expect(html).toMatch(/confirmation link has expired/);
    expect(html).toMatch(/data-email-change-status="confirmed"/);
  });
});
