// @vitest-environment node
import path from "node:path";
import { describe, expect, it } from "vitest";

import { classCandidatesFromSource, compileTailwind } from "@/shared/test/tailwind";

const ROOT = path.resolve(__dirname, "../../../..");

/**
 * Same guard as `billing-page.styles.test.ts`, for the dashboard's account
 * overview: Tailwind v4 silently drops unknown utilities, so assert that the
 * classes carrying its states (attention tone, inline error, two-column layout)
 * are actually emitted.
 */
describe("account overview styles compile against the project theme", () => {
  const files = [
    path.join(__dirname, "account-overview.tsx"),
    path.join(__dirname, "subscription-status-block.tsx"),
    path.join(ROOT, "src/app/(protected)/(dashboard)/dashboard/page.tsx"),
    path.join(ROOT, "src/app/(protected)/(dashboard)/dashboard/error.tsx"),
  ];

  it("emits CSS for every state-bearing and responsive class", async () => {
    const candidates = (await Promise.all(files.map(classCandidatesFromSource))).flat();
    const css = (await compileTailwind(candidates)).replace(/\s+/g, " ");

    const required = [
      // attention tone (payment problems) and inline errors — palette colours, as on /billing
      "text-red-600",
      "dark:text-red-400",
      "border-red-400/40",
      "bg-red-500/10",
      // neutral tone + theme surfaces
      "bg-muted",
      "text-muted-foreground",
      "border-border",
      "text-foreground",
      // layout: one column on phones, two cards side by side from `md` — each
      // sized to its own content, not stretched to the taller one
      "md:grid-cols-2",
      "md:items-start",
      "gap-6",
      "items-baseline",
      "gap-x-2",
      "space-y-1",
      "font-medium",
      // latest invoice: amount/date line up, status pill beside them, PDF button
      "tabular-nums",
      "justify-between",
      "gap-x-4",
      "gap-y-1",
      "space-y-0.5",
      "flex-wrap",
      "space-y-8",
      "sm:flex-row",
      "sm:justify-center",
      // badge size override must win over the badge's own text-[10px]
      "text-xs",
      "text-2xl",
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
