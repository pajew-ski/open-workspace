import { defineConfig, globalIgnores } from "eslint/config";
import nextVitals from "eslint-config-next/core-web-vitals";
import nextTs from "eslint-config-next/typescript";

const eslintConfig = defineConfig([
  ...nextVitals,
  ...nextTs,
  // Override default ignores of eslint-config-next.
  globalIgnores([
    // Default ignores of eslint-config-next:
    ".next/**",
    "out/**",
    "build/**",
    "next-env.d.ts",
    "public/sw.js",
  ]),
  {
    rules: {
      // Prototype legacy: surfaced as warnings while the codebase is
      // migrated to precise types module by module.
      "@typescript-eslint/no-explicit-any": "warn",
    },
  },
  {
    // Graph-Core (SPEC §2, Invariante 9): kein `any` im neuen Graph-Code.
    // Neue Dateien unter src/lib/graph/ erben keine Alt-Warnings.
    files: [
      "src/lib/graph/**/*.ts",
      "src/lib/platform/runtime/**/*.ts",
      "src/app/api/graph/**/*.ts",
    ],
    rules: {
      "@typescript-eslint/no-explicit-any": "error",
    },
  },
]);

export default eslintConfig;
