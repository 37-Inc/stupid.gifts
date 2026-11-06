import { defineConfig, globalIgnores } from "eslint/config";
import nextVitals from "eslint-config-next/core-web-vitals";
import nextTs from "eslint-config-next/typescript";

const eslintConfig = defineConfig([
  ...nextVitals,
  ...nextTs,
  {
    files: ["static-site/**/*.tsx"],
    // Native navigation must reach the Worker's content-expiry guard.
    rules: { "@next/next/no-html-link-for-pages": "off" },
  },
  globalIgnores([
    "**/.next/**",
    "**/node_modules/**",
    "**/out/**",
    "build/**",
    "output/**",
    "**/dist/**",
    "prototypes/chatgpt/evidence/**",
    "*.config.js",
    "*.config.mjs",
    "test-amazon-api.js",
    "test-amazon-getitems.js",
    "next-env.d.ts",
  ]),
]);

export default eslintConfig;
