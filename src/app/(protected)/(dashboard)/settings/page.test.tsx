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

// The browser's cookies as the page sees them (`next/headers`). The email-change
// banner needs the HttpOnly flash cookie that /auth/callback sets.
const jar = vi.hoisted(() => ({ values: new Map<string, string>() }));
vi.mock("next/headers", () => ({
  cookies: async () => ({
    get: (name: string) =>
      jar.values.has(name) ? { name, value: jar.values.get(name)! } : undefined,
    getAll: () => [...jar.values].map(([name, value]) => ({ name, value })),
  }),
}));

// Key material for the signed flash cookie (pages verify, the callback signs).
vi.mock("@/config/env.server", () => ({
  serverEnv: {
    NODE_ENV: "test",
    SUPABASE_SERVICE_ROLE_KEY: "service-role-key-for-tests",
    APP_SECRET: undefined,
  },
}));

const auth = vi.hoisted(() => ({ getCurrentUser: vi.fn() }));
vi.mock("@/infrastructure/auth/session/get-current-user", () => auth);

// Guard: the page must not build its own Supabase client — the profile comes
// from the session the (protected) guard already loaded.
const infra = vi.hoisted(() => ({ createClient: vi.fn() }));
vi.mock("@/infrastructure/auth/supabase/server", () => infra);

// The form submits a real server action; keep the page test focused on the
// page's own logic. The action itself is covered by update-profile.test.ts.
vi.mock("@/features/settings/actions/update-profile", () => ({
  updateProfile: vi.fn(),
}));
vi.mock("@/features/settings/actions/change-password", () => ({
  changePassword: vi.fn(),
}));
vi.mock("@/features/settings/actions/change-email", () => ({
  changeEmail: vi.fn(),
}));
vi.mock("@/features/settings/actions/sign-out-other-sessions", () => ({
  signOutOtherSessions: vi.fn(),
}));
vi.mock("@/features/settings/actions/load-more-account-activity", () => ({
  loadMoreAccountActivity: vi.fn(),
}));

// The account activity history (the one read beyond the session). Its own
// behaviour is covered by list-account-activity.test.ts; here, what the page
// asks for and how it copes with the answer.
const activity = vi.hoisted(() => ({
  listAccountActivity:
    vi.fn<
      (
        userId: string,
        options?: { limit?: number },
      ) => Promise<
        { ok: true; entries: unknown[]; nextCursor: string | null } | { ok: false }
      >
    >(),
}));
vi.mock("@/infrastructure/account-activity/list-account-activity", () => activity);

// Access-token lifetime for the security copy (reads the session cookies).
const tokens = vi.hoisted(() => ({
  getCurrentSessionInfo: vi.fn(async () => ({
    accessTokenLifetimeSeconds: 3600 as number | null,
  })),
}));
vi.mock("@/infrastructure/auth/session/session-tokens", () => tokens);

import {
  EMAIL_CHANGE_FLASH_KEY_PURPOSE,
  serializeEmailChangeFlash,
} from "@/features/auth/services/email-change-flash";
import { toAccountMenuUser } from "@/features/dashboard";
import { signCookieValue, signingKeyFor } from "@/infrastructure/auth/signed-cookie";

import SettingsPage from "./page";

const SUPABASE_USER = {
  id: "11111111-1111-4111-8111-111111111111",
  aud: "authenticated",
  role: "authenticated",
  email: "jane@example.com",
  app_metadata: { provider: "email", providers: ["email"] },
  user_metadata: { full_name: "Jane Doe", avatar_url: "https://cdn.example.com/x.png" },
  created_at: "2026-01-01T00:00:00Z",
};

const render = async (emailChange?: string | string[]) =>
  renderToStaticMarkup(
    await SettingsPage({ searchParams: Promise.resolve({ emailChange }) }),
  );
const page = (emailChange?: string | string[]) =>
  SettingsPage({ searchParams: Promise.resolve({ emailChange }) });

/** What /auth/callback leaves in the browser after a real email-change link. */
const setFlash = (
  status: string,
  userId: string | null = SUPABASE_USER.id,
  issuedAt = Math.floor(Date.now() / 1000),
  key: Uint8Array = signingKeyFor(EMAIL_CHANGE_FLASH_KEY_PURPOSE),
) =>
  jar.values.set(
    "app-email-change",
    serializeEmailChangeFlash({ status: status as "confirmed", userId, issuedAt }, key),
  );

/** The legitimate flow: the callback redirected here AND set its flash cookie. */
const renderAfterCallback = async (status: string, userId?: string | null) => {
  setFlash(status, userId);
  return render(status);
};

const ENTRY = {
  id: 7,
  occurredAt: "2026-03-01T10:00:00+00:00",
  event: {
    type: "profile.updated",
    details: { changes: { fullName: { from: "Jane", to: "Jane Doe" } } },
  },
};

beforeEach(() => {
  vi.clearAllMocks();
  jar.values.clear();
  auth.getCurrentUser.mockResolvedValue(SUPABASE_USER);
  activity.listAccountActivity.mockResolvedValue({
    ok: true,
    entries: [],
    nextCursor: null,
  });
});

describe("/settings page – access", () => {
  it("redirects anonymous visitors to /login without rendering anything", async () => {
    auth.getCurrentUser.mockResolvedValue(null);

    await expect(page()).rejects.toMatchObject({ url: "/login" });
    expect(infra.createClient).not.toHaveBeenCalled();
    expect(activity.listAccountActivity).not.toHaveBeenCalled();
  });

  it("reads the signed-in user through the cached session lookup only", async () => {
    await render();

    expect(auth.getCurrentUser).toHaveBeenCalledTimes(1);
    expect(infra.createClient).not.toHaveBeenCalled();
  });

  it("lets an unexpected failure of the lookup reach the error boundary", async () => {
    auth.getCurrentUser.mockRejectedValue(new Error("cookies unavailable"));

    await expect(page()).rejects.toThrow("cookies unavailable");
  });
});

describe("/settings page – what is shown", () => {
  it("has a Settings heading inside the dashboard shell's content area", async () => {
    const html = await render();

    expect(html).toMatch(/<h2[^>]*>Settings<\/h2>/);
  });

  it("gives every card a real heading one level below the page title, in order", async () => {
    const html = await render();

    const headings = [...html.matchAll(/<h3[^>]*>([^<]+)<\/h3>/g)].map((m) => m[1]);
    expect(headings).toEqual([
      "Profile",
      "Email",
      "Password",
      "Security",
      "Account activity",
    ]);
    // One sub-heading inside the Security card, nothing deeper.
    expect([...html.matchAll(/<h4[^>]*>([^<]+)<\/h4>/g)].map((m) => m[1])).toEqual([
      "Other sessions",
    ]);
    expect(html).not.toMatch(/<h[5-6]/);
  });

  it("keeps the forms at a readable width instead of stretching across the shell", async () => {
    expect(await render()).toMatch(/<div class="[^"]*max-w-3xl[^"]*space-y-8/);
  });

  it("loads the profile into the form: name editable", async () => {
    const html = await render();

    expect(html).toMatch(/data-settings-section="profile"/);
    expect(html).toMatch(/<input[^>]*name="fullName"[^>]*value="Jane Doe"/);
    expect(html).toMatch(/<button[^>]*type="submit"[^>]*>Save changes<\/button>/);
    expect(html).not.toMatch(/role="alert"/);
  });

  it("shows the current email in the Email card with an empty new-address field", async () => {
    const html = await render();

    expect(html).toMatch(/data-settings-section="email"/);
    expect(html).toMatch(/<dd[^>]*data-current-email[^>]*>jane@example.com<\/dd>/);
    expect(html).toMatch(/<input[^>]*type="email"[^>]*name="email"[^>]*value=""/);
    expect(html).toMatch(
      /<button[^>]*type="submit"[^>]*>Send confirmation link<\/button>/,
    );
    expect(html).not.toMatch(/data-pending-email/);
  });

  it("shows a pending email change as pending — the current address stays the sign-in address", async () => {
    auth.getCurrentUser.mockResolvedValue({
      ...SUPABASE_USER,
      new_email: "jane.new@example.com",
      email_change_sent_at: "2026-03-01T10:00:00Z",
    });

    const html = await render();

    expect(html).toMatch(/<dd[^>]*data-current-email[^>]*>jane@example.com<\/dd>/);
    expect(html).toMatch(/data-pending-email="jane.new@example.com"/);
    expect(html).toMatch(/Change pending confirmation/);
    expect(html).toMatch(/Resend confirmation link/);
    expect(html).toMatch(/1 Mar 2026, 10:00 UTC/);
    expect(html).not.toMatch(/has been changed/);
  });

  it("offers the password change with empty password fields", async () => {
    const html = await render();

    expect(html).toMatch(/data-settings-section="password"/);
    for (const name of ["currentPassword", "newPassword", "confirmPassword"]) {
      expect(html).toMatch(new RegExp(`<input[^>]*type="password"[^>]*name="${name}"`));
      expect(html).not.toMatch(new RegExp(`name="${name}"[^>]*value="[^"]`)); // never pre-filled
    }
    expect(html).toMatch(/<button[^>]*type="submit"[^>]*>Change password<\/button>/);
    // The hidden username helper for password managers carries the email only.
    expect(html).toMatch(
      /<input[^>]*autoComplete="username"[^>]*value="jane@example.com"/i,
    );
  });

  it("starts with an empty name field when the account has none", async () => {
    auth.getCurrentUser.mockResolvedValue({ ...SUPABASE_USER, user_metadata: {} });

    const html = await render();

    expect(html).toMatch(/<input[^>]*name="fullName"[^>]*value=""/);
  });

  it("pre-fills the same name the header's account menu shows", async () => {
    // The two features derive the name independently (they may not import each
    // other); this pins them to the same metadata precedence.
    for (const user_metadata of [
      { full_name: "Full", name: "Name", display_name: "Display" },
      { name: "Name", display_name: "Display" },
      { display_name: "Display" },
      { full_name: "  Padded  " },
      { full_name: 42, name: "Fallback" },
    ]) {
      const user = { ...SUPABASE_USER, user_metadata };
      auth.getCurrentUser.mockResolvedValue(user);

      const html = await render();
      const expected = toAccountMenuUser(user).name;

      expect(html, JSON.stringify(user_metadata)).toMatch(
        new RegExp(`<input[^>]*name="fullName"[^>]*value="${expected}"`),
      );
    }
  });

  describe("the email-change status banner (?emailChange= from /auth/callback)", () => {
    it("is absent without the parameter, or with an unknown / repeated value", async () => {
      setFlash("confirmed");
      for (const value of [undefined, "changed", "CONFIRMED", ["confirmed", "expired"]]) {
        expect(await render(value)).not.toMatch(/data-email-change-status/);
      }
    });

    describe("a URL alone proves nothing (forged, forwarded or stale links)", () => {
      it("REGRESSION: a typed ?emailChange=confirmed with NOTHING pending shows no banner", async () => {
        // No pending change is exactly the state after a real confirmation — and
        // also the state of every account that never requested one.
        const html = await render("confirmed");

        expect(html).not.toMatch(/data-email-change-status/);
        expect(html).not.toMatch(/has been changed/);
      });

      it("shows no status of any kind without the callback's cookie", async () => {
        auth.getCurrentUser.mockResolvedValue({ ...SUPABASE_USER, new_email: "x@y.z" });
        for (const status of [
          "confirmed",
          "awaiting_other",
          "expired",
          "invalid",
          "unavailable",
        ]) {
          expect(await render(status), status).not.toMatch(/data-email-change-status/);
        }
      });

      it("a cookie issued for another account on this browser does not count", async () => {
        setFlash("confirmed", "22222222-2222-4222-8222-222222222222");

        expect(await render("confirmed")).not.toMatch(/data-email-change-status/);
      });

      it("a cookie issued to a browser without a session (login flow) does not count here", async () => {
        setFlash("confirmed", null);

        expect(await render("confirmed")).not.toMatch(/data-email-change-status/);
      });

      it("a cookie for a different outcome does not count (an 'expired' visit cannot become 'confirmed')", async () => {
        setFlash("expired");

        expect(await render("confirmed")).not.toMatch(/data-email-change-status/);
      });

      it("an EXPIRED cookie does not count, even if the browser kept it", async () => {
        setFlash("confirmed", SUPABASE_USER.id, Math.floor(Date.now() / 1000) - 3600);

        expect(await render("confirmed")).not.toMatch(/data-email-change-status/);
      });

      it("a FORGED cookie — right format, wrong key — does not count", async () => {
        setFlash("confirmed", SUPABASE_USER.id, undefined, Buffer.alloc(32, 0x42));

        expect(await render("confirmed")).not.toMatch(/data-email-change-status/);
      });

      it("an unsigned cookie in the old plain format does not count", async () => {
        jar.values.set(
          "app-email-change",
          `v1.confirmed.${SUPABASE_USER.id}.${Math.floor(Date.now() / 1000)}`,
        );

        expect(await render("confirmed")).not.toMatch(/data-email-change-status/);
      });

      it("a genuine 'expired' cookie edited to say 'confirmed' does not count", async () => {
        setFlash("expired");
        const [, tag] = jar.values.get("app-email-change")!.split(".");
        const payload = `v2|confirmed|${SUPABASE_USER.id}|${Math.floor(Date.now() / 1000)}`;
        jar.values.set(
          "app-email-change",
          `${Buffer.from(payload).toString("base64url")}.${tag}`,
        );

        expect(await render("confirmed")).not.toMatch(/data-email-change-status/);
        // The unedited original still works for its own status (sanity).
        setFlash("expired");
        expect(await render("expired")).toMatch(/data-email-change-status="expired"/);
      });

      it("a correctly signed but malformed payload does not count, and does not crash the page", async () => {
        const key = signingKeyFor(EMAIL_CHANGE_FLASH_KEY_PURPOSE);
        for (const payload of [
          "v2|confirmed",
          "garbage",
          `v1|confirmed|${SUPABASE_USER.id}|1`,
        ]) {
          jar.values.set("app-email-change", signCookieValue(payload, key));
          expect(await render("confirmed")).not.toMatch(/data-email-change-status/);
        }
      });
    });

    it("legitimate flow: shows 'changed' after the callback confirmed it for this user", async () => {
      const html = await renderAfterCallback("confirmed");

      expect(html).toMatch(/data-email-change-status="confirmed"/);
      expect(html).toMatch(/Your email address has been changed/);
    });

    it("still refuses to say 'changed' while the account has a change pending, even with a cookie", async () => {
      auth.getCurrentUser.mockResolvedValue({
        ...SUPABASE_USER,
        new_email: "jane.new@example.com",
        email_change_sent_at: "2026-03-01T10:00:00Z",
      });

      const html = await renderAfterCallback("confirmed");

      expect(html).not.toMatch(/data-email-change-status/);
      expect(html).toMatch(/data-pending-email="jane.new@example.com"/); // the truth
    });

    it("shows 'one more to go' only while a change is actually pending", async () => {
      expect(await renderAfterCallback("awaiting_other")).not.toMatch(
        /data-email-change-status/,
      );

      auth.getCurrentUser.mockResolvedValue({ ...SUPABASE_USER, new_email: "x@y.z" });
      const html = await renderAfterCallback("awaiting_other");
      expect(html).toMatch(/data-email-change-status="awaiting_other"/);
      expect(html).toMatch(/one more to go/);
      expect(html).not.toMatch(/has been changed/);
    });

    it("shows link problems (with the cookie) whatever the account state, as 'changed nothing'", async () => {
      for (const pending of [undefined, "x@y.z"]) {
        auth.getCurrentUser.mockResolvedValue({ ...SUPABASE_USER, new_email: pending });
        for (const status of ["expired", "invalid", "unavailable"]) {
          const html = await renderAfterCallback(status);
          expect(html, `${status}/${pending}`).toMatch(
            new RegExp(`role="alert"[^>]*data-email-change-status="${status}"`),
          );
          expect(html).not.toMatch(/has been changed/);
        }
      }
      expect(await renderAfterCallback("expired")).toMatch(/changed nothing/);
    });

    it("offers a way to dismiss the notice", async () => {
      expect(await renderAfterCallback("confirmed")).toMatch(
        /<button[^>]*aria-label="Dismiss email change notice"/,
      );
    });

    it("never echoes the raw query value", async () => {
      expect(await render("<img src=x onerror=alert(1)>")).not.toMatch(/onerror/);
    });
  });

  describe("the Security card", () => {
    it("reviews the account's sign-in facts and offers to sign out other sessions", async () => {
      const html = await render();

      expect(html).toMatch(/data-settings-section="security"/);
      expect(html).toMatch(/Sign-in methods<\/dt><dd[^>]*>Email and password<\/dd>/);
      expect(html).toMatch(
        /<button[^>]*type="submit"[^>]*>Sign out other sessions<\/button>/,
      );
    });

    it("states the real access-token lifetime read from the session", async () => {
      tokens.getCurrentSessionInfo.mockResolvedValueOnce({
        accessTokenLifetimeSeconds: 900,
      });

      expect(await render()).toMatch(/at most 15 minutes after it was issued/);
    });

    it("still states the caveat when the lifetime cannot be read", async () => {
      tokens.getCurrentSessionInfo.mockResolvedValueOnce({
        accessTokenLifetimeSeconds: null,
      });

      const html = await render();
      expect(html).toMatch(/until it expires\./);
      expect(html).not.toMatch(/at most/);
    });

    it("authorizes on the verified user, reading the session only for that lifetime", async () => {
      await render();

      expect(auth.getCurrentUser).toHaveBeenCalledTimes(1);
      expect(tokens.getCurrentSessionInfo).toHaveBeenCalledTimes(1);
      expect(infra.createClient).not.toHaveBeenCalled();
    });
  });

  it("passes nothing but display values to the client: no id, provider or other metadata", async () => {
    const html = await render();

    expect(html).not.toContain(SUPABASE_USER.id);
    expect(html).not.toContain("avatar_url");
    expect(html).not.toContain("cdn.example.com");
    expect(html).not.toContain("provider");
  });
});

describe("/settings page – the Account activity card", () => {
  it("asks for the first page of the verified user's history, one card's worth", async () => {
    await render();

    expect(activity.listAccountActivity).toHaveBeenCalledTimes(1);
    expect(activity.listAccountActivity).toHaveBeenCalledWith(SUPABASE_USER.id, {
      limit: 10,
    });
  });

  it("shows the empty state when nothing has been recorded", async () => {
    const html = await render();

    expect(html).toMatch(
      /data-settings-section="activity"[^>]*data-activity-state="empty"/,
    );
    expect(html).toMatch(/No activity yet\./);
    expect(html).not.toMatch(/Load older activity/);
  });

  it("lists the entries the service returned, in its order, with a way to load older ones", async () => {
    activity.listAccountActivity.mockResolvedValue({
      ok: true,
      entries: [ENTRY, { ...ENTRY, id: 6, occurredAt: "2026-02-01T09:30:00+00:00" }],
      nextCursor: "older",
    });

    const html = await render();

    expect(html).toMatch(/data-activity-state="list"/);
    // A timeline grouped by day: the newer day's heading and entry come first.
    expect(html).toMatch(/data-activity-layout="timeline"/);
    expect(html).toMatch(/<h4[^>]*>1 Mar 2026<\/h4>/);
    expect(html).toMatch(/<h4[^>]*>1 Feb 2026<\/h4>/);
    expect(html.indexOf("1 Mar 2026")).toBeLessThan(html.indexOf("1 Feb 2026"));
    expect(html.indexOf("10:00 UTC")).toBeLessThan(html.indexOf("09:30 UTC"));
    expect(html).toMatch(/Display name changed/);
    expect(html).toMatch(/From “Jane” to “Jane Doe”\./);
    expect(html).toMatch(/<button[^>]*>Load older activity<\/button>/);
  });

  it("says the history is unavailable — and still renders every other card — when it cannot be read", async () => {
    activity.listAccountActivity.mockResolvedValue({ ok: false });

    const html = await render();

    expect(html).toMatch(/data-activity-state="unavailable"/);
    expect(html).toMatch(/role="alert"[^>]*>We couldn&#x27;t load your account activity/);
    expect(html).toMatch(/href="\/settings"[^>]*>Try again</);
    // The rest of the page is intact.
    expect(html).toMatch(/data-settings-section="security"/);
    expect(html).toMatch(/name="fullName"[^>]*value="Jane Doe"/);
    expect(html).toMatch(/name="newPassword"/);
  });

  it("REGRESSION: a history read that throws does not take the settings page down", async () => {
    activity.listAccountActivity.mockRejectedValue(
      new Error(`pool exhausted for ${SUPABASE_USER.id}`),
    );
    const error = vi.spyOn(console, "error").mockImplementation(() => {});

    const html = await render();

    expect(html).toMatch(/data-activity-state="unavailable"/);
    expect(html).toMatch(/data-settings-section="security"/);
    expect(error).toHaveBeenCalledWith(
      "[settings] account activity could not be loaded for the page",
      { error: { name: "Error" } },
    );
    expect(JSON.stringify(error.mock.calls)).not.toContain(SUPABASE_USER.id);
    error.mockRestore();
  });

  it("puts the card last, after Security", async () => {
    const html = await render();

    expect(html.indexOf('data-settings-section="security"')).toBeLessThan(
      html.indexOf('data-settings-section="activity"'),
    );
  });
});
