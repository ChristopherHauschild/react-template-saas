import { readFile } from "node:fs/promises";
import path from "node:path";

import { compile } from "tailwindcss";

const ROOT = path.resolve(__dirname, "../../..");
const GLOBALS_CSS = path.join(ROOT, "src/app/globals.css");

/**
 * Compiles the project's real `globals.css` (theme + tokens) for a set of class
 * candidates and returns the generated CSS. Lets tests assert that the classes a
 * component relies on are actually emitted — Tailwind v4 silently drops unknown
 * utilities, so a typo'd variant or missing token fails *without* any error.
 */
export async function compileTailwind(candidates: string[]) {
  const input = await readFile(GLOBALS_CSS, "utf8");

  const compiler = await compile(input, {
    base: path.dirname(GLOBALS_CSS),
    loadStylesheet: async (id, base) => {
      const file = id.startsWith("tailwindcss")
        ? path.join(
            ROOT,
            "node_modules",
            id === "tailwindcss" ? "tailwindcss/index.css" : id,
          )
        : path.resolve(base, id);

      return {
        path: file,
        base: path.dirname(file),
        content: await readFile(file, "utf8"),
      };
    },
    loadModule: async () => {
      throw new Error("JS modules are not supported in the test compiler");
    },
  });

  return compiler.build(candidates);
}

/** Extracts every class candidate from `className="..."` / template strings in a source file. */
export async function classCandidatesFromSource(file: string) {
  const source = await readFile(file, "utf8");
  const candidates = new Set<string>();

  for (const match of source.matchAll(/"([^"\n]*)"/g)) {
    for (const token of match[1].split(/\s+/)) {
      if (token) candidates.add(token);
    }
  }

  return [...candidates];
}
