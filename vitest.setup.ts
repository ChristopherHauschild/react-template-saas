import "@testing-library/jest-dom/vitest";

import { cleanup } from "@testing-library/react";
import { afterEach, vi } from "vitest";

afterEach(() => {
  cleanup();
});

// jsdom lacks a few browser APIs used by cmdk / Radix. Server-side tests run with
// `// @vitest-environment node` and have no DOM at all, so guard each polyfill.
class ResizeObserverStub {
  observe() {}
  unobserve() {}
  disconnect() {}
}

const hasDom = typeof window !== "undefined" && typeof Element !== "undefined";

if (hasDom && !("ResizeObserver" in globalThis)) {
  vi.stubGlobal("ResizeObserver", ResizeObserverStub);
}

if (hasDom && !Element.prototype.scrollIntoView) {
  Element.prototype.scrollIntoView = () => {};
}

if (hasDom && !window.matchMedia) {
  window.matchMedia = (query: string) =>
    ({
      matches: false,
      media: query,
      onchange: null,
      addEventListener: () => {},
      removeEventListener: () => {},
      addListener: () => {},
      removeListener: () => {},
      dispatchEvent: () => false,
    }) as MediaQueryList;
}
