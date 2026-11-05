import { vi } from "vitest";

/**
 * Shared `next/navigation` mock for component tests.
 *
 * Usage (the factory must be imported inside `vi.hoisted`, which runs before static imports):
 *   const nav = await vi.hoisted(async () =>
 *     (await import("@/shared/test/next-navigation")).createNextNavigationMock(),
 *   );
 *   vi.mock("next/navigation", () => nav.module);
 */
export function createNextNavigationMock(initialPathname = "/dashboard") {
  const state = { pathname: initialPathname, search: "" };

  const router = {
    push: vi.fn(),
    replace: vi.fn(),
    back: vi.fn(),
    forward: vi.fn(),
    refresh: vi.fn(),
    prefetch: vi.fn(),
  };

  return {
    router,
    setPathname(pathname: string) {
      state.pathname = pathname;
    },
    /** Query string without the leading `?` (e.g. `"emailChange=confirmed&x=1"`). */
    setSearch(search: string) {
      state.search = search;
    },
    reset(pathname = initialPathname) {
      state.pathname = pathname;
      state.search = "";
      Object.values(router).forEach((fn) => fn.mockReset());
    },
    module: {
      usePathname: () => state.pathname,
      useRouter: () => router,
      useSearchParams: () => new URLSearchParams(state.search),
    },
  };
}
