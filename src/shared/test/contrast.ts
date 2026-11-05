import { readFile } from "node:fs/promises";
import path from "node:path";

/** sRGB triplet, each channel 0..1. */
export type Rgb = readonly [number, number, number];

export function hslToRgb(h: number, s: number, l: number): Rgb {
  const sat = s / 100;
  const light = l / 100;
  const c = (1 - Math.abs(2 * light - 1)) * sat;
  const x = c * (1 - Math.abs(((h / 60) % 2) - 1));
  const m = light - c / 2;
  const sector = Math.floor((h % 360) / 60);
  const [r, g, b] = [
    [c, x, 0],
    [x, c, 0],
    [0, c, x],
    [0, x, c],
    [x, 0, c],
    [c, 0, x],
  ][sector];

  return [r + m, g + m, b + m];
}

/** Composites `fg` at `alpha` over an opaque `bg`. */
export function blend(fg: Rgb, alpha: number, bg: Rgb): Rgb {
  return [0, 1, 2].map((i) => fg[i] * alpha + bg[i] * (1 - alpha)) as unknown as Rgb;
}

function relativeLuminance([r, g, b]: Rgb) {
  const lin = (v: number) => (v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4);

  return 0.2126 * lin(r) + 0.7152 * lin(g) + 0.0722 * lin(b);
}

/** WCAG 2.x contrast ratio (1..21). */
export function contrastRatio(a: Rgb, b: Rgb) {
  const la = relativeLuminance(a);
  const lb = relativeLuminance(b);

  return (Math.max(la, lb) + 0.05) / (Math.min(la, lb) + 0.05);
}

export type ThemeTokens = Record<string, Rgb>;

/**
 * Reads the `--token: H S% L%` custom properties from a selector block in
 * `globals.css` (e.g. `:root` or `.dark`) and resolves them to RGB.
 */
export async function loadThemeTokens(selector: ":root" | ".dark"): Promise<ThemeTokens> {
  const css = await readFile(path.resolve(__dirname, "../../app/globals.css"), "utf8");
  const block = css.match(
    new RegExp(`${selector.replace(".", "\\.")}\\s*{([^}]*)}`),
  )?.[1];

  if (!block) throw new Error(`No ${selector} block found in globals.css`);

  const tokens: ThemeTokens = {};

  for (const match of block.matchAll(/--([\w-]+):\s*([\d.]+)\s+([\d.]+)%\s+([\d.]+)%/g)) {
    tokens[match[1]] = hslToRgb(Number(match[2]), Number(match[3]), Number(match[4]));
  }

  return tokens;
}
