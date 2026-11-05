// @vitest-environment node
import path from "node:path";
import { describe, expect, it } from "vitest";

import { classCandidatesFromSource, compileTailwind } from "@/shared/test/tailwind";

const ROOT = path.resolve(__dirname, "../../../..");

/**
 * Tailwind v4 silently drops utilities it does not know. The support form's
 * states are carried by variant classes (`aria-invalid:`, `has-checked:`,
 * `has-focus-visible:`, `disabled:`); compile them against the real theme and
 * assert the rules exist, so a typo cannot leave an invalid field unmarked.
 */
describe("support UI styles compile against the project theme", () => {
  const files = [
    path.join(__dirname, "support-request-form.tsx"),
    path.join(__dirname, "support-request-history.tsx"),
    path.join(__dirname, "support-request-history-skeleton.tsx"),
    path.join(ROOT, "src/shared/components/ui/badge.tsx"),
    path.join(ROOT, "src/shared/components/ui/textarea.tsx"),
    path.join(ROOT, "src/app/(protected)/(dashboard)/support/page.tsx"),
  ];

  it("emits CSS for every state-bearing, error and layout class", async () => {
    const candidates = (await Promise.all(files.map(classCandidatesFromSource))).flat();
    const css = (await compileTailwind(candidates)).replace(/\s+/g, " ");

    const required = [
      // invalid textarea (shared Textarea, same as Input)
      "aria-invalid:border-destructive",
      "aria-invalid:ring-destructive/20",
      "dark:aria-invalid:border-destructive/50",
      // invalid category group
      "border-destructive",
      // chosen / keyboard-focused category option
      "has-checked:border-primary",
      "has-checked:bg-primary/5",
      "has-focus-visible:ring-3",
      "has-focus-visible:ring-ring/50",
      "accent-primary",
      // locked while sending
      "disabled:cursor-not-allowed",
      "disabled:opacity-50",
      // inline field errors and the form-level error banner
      "text-red-600",
      "dark:text-red-400",
      "border-destructive/30",
      "bg-destructive/10",
      "text-destructive",
      // layout: two columns of categories from `sm`, long labels wrap
      "sm:grid-cols-2",
      "[overflow-wrap:anywhere]",
      "field-sizing-content",
      "min-h-24",
      "max-w-3xl",
      // history: divided list, open requests tinted, long text wraps, the
      // message keeps its line breaks
      "divide-y",
      "divide-border",
      "first:pt-0",
      "last:pb-0",
      "border-primary/30",
      "bg-primary/10",
      "whitespace-pre-wrap",
      // a busy (not disabled) paging / retry button reads as waiting
      "aria-disabled:cursor-wait",
      "aria-disabled:opacity-70",
      "min-h-11",
      "sm:min-h-8",
      "sr-only",
      // loading skeleton
      "animate-pulse",
      "bg-muted",
    ];

    for (const cls of required) {
      const escaped = cls.replace(/[:/.[\]]/g, (c) => `\\${c}`);
      expect(css, `expected a rule for .${cls}`).toContain(`.${escaped}`);
    }
  });
});
