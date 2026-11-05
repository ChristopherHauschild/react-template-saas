// @vitest-environment node
import { isValidElement, type ReactElement, type ReactNode } from "react";

import { beforeEach, describe, expect, it, vi } from "vitest";

// The real server action pulls in Supabase/env; a sentinel is enough to prove the wiring.
const auth = vi.hoisted(() => ({ signOut: vi.fn(async () => {}) }));
vi.mock("@/features/auth/actions/sign-out", () => auth);

// Per-request cached user lookup (the (protected) layout's guard already called it).
const session = vi.hoisted(() => ({ getCurrentUser: vi.fn() }));
vi.mock("@/infrastructure/auth/session/get-current-user", () => session);

// Guard: the layout must not build its own Supabase client.
const infra = vi.hoisted(() => ({ createClient: vi.fn() }));
vi.mock("@/infrastructure/auth/supabase/server", () => infra);

vi.mock("@/features/dashboard", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/features/dashboard")>()),
  DashboardCommandPalette: () => null,
  DashboardHeader: () => null,
  DashboardSidebar: () => null,
}));

import { DashboardHeader } from "@/features/dashboard";

import DashboardLayout from "./layout";

/** Depth-first search for the first element of a given component type. */
function findElement(node: ReactNode, type: unknown): ReactElement | null {
  if (!isValidElement(node)) return null;
  if (node.type === type) return node;

  const children = (node.props as { children?: ReactNode }).children;
  for (const child of Array.isArray(children) ? children : [children]) {
    const found = findElement(child, type);
    if (found) return found;
  }
  return null;
}

const SUPABASE_USER = {
  id: "11111111-1111-4111-8111-111111111111",
  aud: "authenticated",
  role: "authenticated",
  email: "jane@example.com",
  app_metadata: { provider: "email", providers: ["email"] },
  user_metadata: { full_name: "Jane Doe", avatar_url: "https://cdn.example.com/x.png" },
  created_at: "2026-01-01T00:00:00Z",
};

const headerProps = async () => {
  const tree = await DashboardLayout({ children: "page" });
  const header = findElement(tree, DashboardHeader);
  expect(header).not.toBeNull();
  return header!.props as { user: unknown; signOutAction: unknown };
};

beforeEach(() => {
  vi.clearAllMocks();
  session.getCurrentUser.mockResolvedValue(SUPABASE_USER);
});

describe("dashboard layout", () => {
  it("hands the auth feature's signOut action to the header's account menu", async () => {
    expect((await headerProps()).signOutAction).toBe(auth.signOut);
  });

  it("derives the account menu's user from the cached session lookup", async () => {
    expect((await headerProps()).user).toEqual({
      name: "Jane Doe",
      email: "jane@example.com",
      initials: "JD",
    });
    expect(session.getCurrentUser).toHaveBeenCalledTimes(1);
  });

  it("does not create its own Supabase client (no extra request beyond the guard's)", async () => {
    await headerProps();

    expect(infra.createClient).not.toHaveBeenCalled();
  });

  it("passes only derived display strings to the client component — no id, metadata or tokens", async () => {
    const { user } = await headerProps();

    expect(Object.keys(user as object).sort()).toEqual(["email", "initials", "name"]);
    const serialized = JSON.stringify(user);
    expect(serialized).not.toContain(SUPABASE_USER.id);
    expect(serialized).not.toContain("avatar_url");
    expect(serialized).not.toContain("provider");
  });

  it("still renders when the session yields no user (the guard has already redirected)", async () => {
    session.getCurrentUser.mockResolvedValue(null);

    expect((await headerProps()).user).toEqual({
      name: "Account",
      email: null,
      initials: "A",
    });
  });
});
