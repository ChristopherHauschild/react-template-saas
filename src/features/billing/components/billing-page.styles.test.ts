// @vitest-environment node
import path from "node:path";
import { describe, expect, it } from "vitest";

import { classCandidatesFromSource, compileTailwind } from "@/shared/test/tailwind";

const ROOT = path.resolve(__dirname, "../../../..");

/**
 * Same guard as `billing-ui.styles.test.ts`, for the billing page: Tailwind v4
 * silently drops unknown utilities, so assert that the classes carrying the
 * page's states (attention tone, inline error, layout) are actually emitted.
 */
describe("billing page styles compile against the project theme", () => {
  const files = [
    path.join(__dirname, "subscription-status-card.tsx"),
    path.join(__dirname, "subscription-status-block.tsx"),
    path.join(__dirname, "manage-billing-button.tsx"),
    path.join(__dirname, "invoice-history-card.tsx"),
    path.join(__dirname, "invoice-history-list.tsx"),
    path.join(__dirname, "invoice-document-banner.tsx"),
    path.join(__dirname, "invoice-filters-form.tsx"),
    path.join(ROOT, "src/app/(protected)/(dashboard)/billing/page.tsx"),
    path.join(ROOT, "src/app/(protected)/(dashboard)/billing/error.tsx"),
  ];

  it("emits CSS for every state-bearing and responsive class", async () => {
    const candidates = (await Promise.all(files.map(classCandidatesFromSource))).flat();
    const css = (await compileTailwind(candidates)).replace(/\s+/g, " ");

    const required = [
      // attention tone (payment problems) and inline errors — palette colours, as in pricing
      "text-red-600",
      "dark:text-red-400",
      "border-red-400/40",
      "bg-red-500/10",
      // neutral tone + theme surfaces
      "bg-muted",
      "text-muted-foreground",
      "border-border",
      "text-foreground",
      // layout
      "flex-wrap",
      "self-start",
      "space-y-8",
      "sm:flex-row",
      "sm:justify-center",
      // badge size override must win over the badge's own text-[10px]
      "text-xs",
      // invoice table: scrolls on narrow screens, amounts line up, rows separate
      "overflow-x-auto",
      "tabular-nums",
      "whitespace-nowrap",
      "text-right",
      "sr-only",
      "last:border-0",
      "space-y-4",
      // document links
      "text-primary",
      "underline-offset-4",
      "hover:underline",
      "gap-3",
      // filter form: stacked on phones, two columns from `sm`, one row from `lg`
      "grid-cols-2",
      "col-span-2",
      "lg:grid-cols-[1fr_1fr_1fr_1.5fr_auto]",
      "lg:items-end",
      "lg:col-span-1",
      "lg:col-span-5",
      "border-input",
      "border-red-400",
      "bg-background",
      // responsive list: cards below `lg`, table from `lg`; thumb-sized targets on phones
      "lg:hidden",
      "lg:block",
      "divide-y",
      "min-h-11",
      "sm:min-h-8",
      "sm:flex-none",
      "break-all",
      "first:pt-0",
      "last:pb-0",
      "aria-disabled:opacity-70",
      "aria-disabled:cursor-wait",
      "focus-visible:ring-3",
      "focus-visible:ring-ring/50",
    ];

    for (const cls of required) {
      const escaped = cls.replace(/[:/.\[\]]/g, (c) => `\\${c}`);
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
