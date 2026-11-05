// @vitest-environment node
import path from "node:path";
import { describe, expect, it } from "vitest";

import { classCandidatesFromSource, compileTailwind } from "@/shared/test/tailwind";

const ROOT = path.resolve(__dirname, "../../../..");

/**
 * Tailwind v4 silently drops unknown utilities (e.g. a token the theme does not
 * define). Compile the real theme against the classes used by the billing UI and
 * assert the ones that carry the loading / error / success / responsive behaviour.
 */
describe("billing UI styles compile against the project theme", () => {
  const files = [
    path.join(__dirname, "pricing-card.tsx"),
    path.join(__dirname, "subscribe-button.tsx"),
    path.join(__dirname, "checkout-status-banner.tsx"),
    path.join(ROOT, "src/app/(protected)/pricing/page.tsx"),
    path.join(ROOT, "src/app/(protected)/pricing/error.tsx"),
  ];

  it("emits CSS for every state-bearing and responsive class", async () => {
    const candidates = (await Promise.all(files.map(classCandidatesFromSource))).flat();
    const css = (await compileTailwind(candidates)).replace(/\s+/g, " ");

    const required = [
      // pending / disabled states
      "disabled:opacity-70",
      "disabled:cursor-wait",
      "cursor-not-allowed",
      // inline error (no `destructive` token exists in this theme — palette colours are used)
      "text-red-600",
      "dark:text-red-400",
      // unavailable button + canceled banner
      "bg-muted",
      "text-muted-foreground",
      "border-border",
      // return-from-checkout banner is intentionally neutral (no "success" colour)
      "text-foreground",
      // responsive layout: one column on phones, two from `sm`, three from `lg`
      "sm:grid-cols-2",
      "lg:grid-cols-3",
      "sm:flex-row",
      "sm:justify-center",
    ];

    for (const cls of required) {
      const escaped = cls.replace(/[:/.]/g, (c) => `\\${c}`);
      expect(css, `expected a rule for .${cls}`).toContain(`.${escaped}`);
    }
  });

  it("does not use theme tokens that are not defined (would be dropped silently)", async () => {
    const candidates = (await Promise.all(files.map(classCandidatesFromSource))).flat();

    expect(
      candidates.filter((c) =>
        /^(?:[a-z]+:)*(?:text|bg|border|ring)-(?:destructive|success|warning)\b/.test(c),
      ),
    ).toEqual([]);
  });
});
