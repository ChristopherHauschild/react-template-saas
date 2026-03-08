import { defineConfig, globalIgnores } from "eslint/config";
import nextVitals from "eslint-config-next/core-web-vitals";
import nextTs from "eslint-config-next/typescript";
import boundaries from "eslint-plugin-boundaries";

const eslintConfig = defineConfig([
  ...nextVitals,
  ...nextTs,
  {
    plugins: { boundaries },
    settings: {
      "boundaries/elements": [
        { type: "app", pattern: "src/app/*" },
        { type: "config", pattern: "src/config/*" },
        { type: "features", pattern: "src/features/*" },
        { type: "infrastructure", pattern: "src/infrastructure/*" },
        { type: "shared", pattern: "src/shared/*" },
      ],
    },
    rules: {
      "boundaries/element-types": [
        "error",
        {
          default: "disallow",
          rules: [
            {
              from: "app",
              allow: ["features", "infrastructure", "shared", "config"],
            },
            {
              from: "features",
              allow: ["infrastructure", "shared", "config"],
            },
            {
              from: "infrastructure",
              allow: ["shared", "config"],
            },
            {
              from: "config",
              allow: ["shared"],
            },
            {
              from: "shared",
              allow: ["shared"],
            },
          ],
        },
      ],
      "boundaries/no-private": "error",
    },
  },
  // Override default ignores of eslint-config-next.
  globalIgnores([".next/**", "out/**", "build/**", "next-env.d.ts"]),
]);

export default eslintConfig;
