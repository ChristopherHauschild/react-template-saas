// @vitest-environment node
import { use } from "react";
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

// The one thing the page reads: who is signed in (for the draft's owner).
const session = vi.hoisted(() => ({
  getCurrentUser: vi.fn<() => Promise<{ id: string } | null>>(),
}));
vi.mock("@/infrastructure/auth/session/get-current-user", () => session);

// The form is the real one; its draft owner is what the page passes in.
const form = vi.hoisted(() => ({ props: [] as unknown[] }));
vi.mock("@/features/support/components/support-request-form", async (importOriginal) => {
  const actual =
    await importOriginal<
      typeof import("@/features/support/components/support-request-form")
    >();
  return {
    ...actual,
    SupportRequestForm: (props: Parameters<typeof actual.SupportRequestForm>[0]) => {
      form.props.push(props);
      return actual.SupportRequestForm(props);
    },
  };
});

// The action itself is covered by create-support-request.test.ts.
vi.mock("@/features/support/actions/create-support-request", () => ({
  createSupportRequestAction: vi.fn(),
}));

// The history section reads data (covered by its own test). Here it stands in
// for a read still in flight, so the page's own loading state is what renders.
const never = new Promise<never>(() => {});
vi.mock("@/features/support/components/support-request-history-section", () => ({
  SupportRequestHistorySection: function Pending() {
    use(never);
    return null;
  },
}));

import SupportPage from "./page";

const USER = { id: "11111111-1111-4111-8111-111111111111" };

beforeEach(() => {
  vi.clearAllMocks();
  form.props = [];
  session.getCurrentUser.mockResolvedValue(USER);
});

const renderPage = async () => renderToStaticMarkup(await SupportPage());

type Element = {
  key: string | null;
  props: Record<string, unknown> & { children?: unknown };
};

/** Depth-first search of a React element tree (as returned by the page, unrendered). */
function findElement(node: unknown, match: (el: Element) => boolean): Element | null {
  if (Array.isArray(node)) {
    for (const child of node) {
      const found = findElement(child, match);
      if (found) return found;
    }
    return null;
  }
  if (node === null || typeof node !== "object" || !("props" in node)) return null;

  const el = node as Element;
  return match(el) ? el : findElement(el.props.children, match);
}

describe("support page", () => {
  it("renders a heading and the support request form", async () => {
    const html = await renderPage();

    expect(html).toMatch(/<h2[^>]*>Support<\/h2>/);
    expect(html).toContain('aria-label="Contact support"');
    expect(html).toContain('name="subject"');
    expect(html).toContain('name="message"');
  });

  it("does not hold the form back while the history loads: the skeleton stands in", async () => {
    const html = await renderPage();

    expect(html).toContain('data-history-state="loading"');
    expect(html).toContain('aria-busy="true"');
    // The form comes first, the history below it.
    expect(html.indexOf('aria-label="Contact support"')).toBeLessThan(
      html.indexOf('data-history-state="loading"'),
    );
  });

  it("gives the form the signed-in user's account", async () => {
    await renderPage();

    expect(form.props).toEqual([{ ownerId: USER.id }]);
  });

  it("keys the form by the account, so a re-render for another account mounts a fresh form", async () => {
    const tree = await SupportPage();

    const formElement = findElement(tree, (el) => el.props.ownerId !== undefined);
    expect(formElement?.key).toBe(USER.id);
  });

  it("renders nothing without a session (the guard redirects)", async () => {
    session.getCurrentUser.mockResolvedValue(null);

    await expect(SupportPage()).rejects.toThrow("NEXT_REDIRECT /login");
  });
});
