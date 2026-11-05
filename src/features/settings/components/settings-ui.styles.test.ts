// @vitest-environment node
import path from "node:path";
import { describe, expect, it } from "vitest";

import {
  blend,
  contrastRatio,
  loadThemeTokens,
  type ThemeTokens,
} from "@/shared/test/contrast";
import { classCandidatesFromSource, compileTailwind } from "@/shared/test/tailwind";

const ROOT = path.resolve(__dirname, "../../../..");
const AA_NORMAL_TEXT = 4.5;
const AA_UI_COMPONENT = 3;

/**
 * Tailwind v4 silently drops unknown utilities. The settings UI and the banners
 * it shares with auth lean on the `destructive` token for error text, invalid
 * field borders and the error banner — a token this theme did NOT define until
 * the settings review (so invalid inputs had no red border at all). Compile the
 * real theme against the classes these components use and assert the rules that
 * carry the error / pending / success / responsive behaviour exist.
 */
describe("settings UI styles compile against the project theme", () => {
  const files = [
    path.join(__dirname, "profile-form.tsx"),
    path.join(__dirname, "change-email-form.tsx"),
    path.join(__dirname, "change-password-form.tsx"),
    path.join(__dirname, "security-card.tsx"),
    path.join(__dirname, "account-activity-card.tsx"),
    path.join(ROOT, "src/features/auth/components/email-change-status-banner.tsx"),
    path.join(ROOT, "src/features/auth/components/confirmation-failure-banner.tsx"),
    path.join(ROOT, "src/shared/components/ui/input.tsx"),
    path.join(ROOT, "src/shared/components/ui/dismiss-query-param-button.tsx"),
    path.join(ROOT, "src/app/(protected)/(dashboard)/settings/page.tsx"),
  ];

  it("emits CSS for every state-bearing, error and responsive class", async () => {
    const candidates = (await Promise.all(files.map(classCandidatesFromSource))).flat();
    const css = (await compileTailwind(candidates)).replace(/\s+/g, " ");

    const required = [
      // invalid fields (shared Input) — regression: the token used to be undefined
      "aria-invalid:border-destructive",
      "aria-invalid:ring-destructive/20",
      // error banners
      "border-destructive/30",
      "bg-destructive/10",
      "text-destructive",
      // inline field errors
      "text-red-600",
      "dark:text-red-400",
      // success banner
      "bg-emerald-500/10",
      "text-emerald-800",
      "dark:text-emerald-300",
      // pending notice
      "bg-muted",
      "text-muted-foreground",
      // long emails must wrap on narrow screens
      "break-all",
      // readable form width inside the wide dashboard shell
      "max-w-3xl",
      // banner layout (text shrinks, dismiss button does not)
      "min-w-0",
      "shrink-0",
      // security facts: stacked on phones, two columns from `sm`, values wrap
      "sm:grid-cols-[max-content_1fr]",
      "contents",
      "sm:break-normal",
      "sm:[overflow-wrap:anywhere]",
      "flex-col",
      "items-start",
      // activity timeline: long names wrap, time stays on one line,
      // a busy (not disabled) "load older" button reads as waiting
      "[overflow-wrap:anywhere]",
      "sm:text-right",
      "sm:justify-between",
      "aria-disabled:cursor-wait",
      "aria-disabled:opacity-70",
      "sr-only",
      // activity timeline: the line (pseudo-elements), the nodes, the day markers
      "after:absolute",
      "after:top-8",
      "after:-bottom-4",
      "after:left-4",
      "after:h-4",
      "after:w-px",
      "after:bg-border",
      "after:top-full",
      "before:absolute",
      "before:size-2",
      "before:-translate-x-1/2",
      "before:-translate-y-1/2",
      "before:rounded-full",
      "before:bg-border",
      "size-8",
      "pl-10",
      "pt-1.5",
      "sm:pt-2",
      "uppercase",
      "tracking-wide",
      "leading-4",
    ];

    for (const cls of required) {
      const escaped = cls.replace(/[:/.[\]]/g, (c) => `\\${c}`);
      expect(css, `expected a rule for .${cls}`).toContain(`.${escaped}`);
    }
  });
});

function surfaces(t: ThemeTokens) {
  return {
    page: t.background,
    card: t.card,
    "error banner (background + destructive/10)": blend(t.destructive, 0.1, t.background),
  };
}

describe.each([":root", ".dark"] as const)("error colour contrast (%s)", (theme) => {
  it("destructive text meets WCAG AA on the page, on cards and inside the error banner", async () => {
    const t = await loadThemeTokens(theme);
    expect(t.destructive, "the theme must define --destructive").toBeDefined();

    for (const [name, surface] of Object.entries(surfaces(t))) {
      const ratio = contrastRatio(t.destructive, surface);
      expect(ratio, `${name}: ${ratio.toFixed(2)}:1`).toBeGreaterThanOrEqual(
        AA_NORMAL_TEXT,
      );
    }
  });

  it("an invalid field's red border is distinguishable from the page (non-text contrast)", async () => {
    const t = await loadThemeTokens(theme);
    const ratio = contrastRatio(t.destructive, t.background);

    expect(ratio).toBeGreaterThanOrEqual(AA_UI_COMPONENT);
  });

  it("text on a solid destructive surface (destructive button) is readable", async () => {
    const t = await loadThemeTokens(theme);
    const ratio = contrastRatio(t["destructive-foreground"], t.destructive);

    expect(ratio).toBeGreaterThanOrEqual(AA_NORMAL_TEXT);
  });
});
