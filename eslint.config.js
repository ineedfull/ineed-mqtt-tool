import js from "@eslint/js";
import globals from "globals";
import { builtinModules } from "node:module";

const restrictedBuiltinImports = [...new Set(
  builtinModules.map((name) => name.replace(/^node:/, "")),
)].sort();

export default [
  {
    ignores: [
      "**/node_modules/**",
      "**/dist/**",
      "**/release/**",
      "**/artifacts/**",
      "**/target/**",
      "**/test-results/**",
      "**/playwright-report/**",
      "packages/workbench/e2e/fixtures/reference-renderer/**",
    ],
  },
  {
    ...js.configs.recommended,
    files: ["**/*.{js,mjs,cjs}"],
  },
  {
    files: [
      "eslint.config.js",
      "scripts/**/*.{js,mjs,cjs}",
      "tooling/**/*.{js,mjs,cjs}",
      "**/*.{test,spec}.{js,mjs,cjs}",
      "**/{test,tests}/**/*.{js,mjs,cjs}",
      "apps/electron/electron/**/*.cjs",
    ],
    languageOptions: {
      globals: globals.node,
    },
  },
  {
    files: [
      "apps/*/renderer/**/*.js",
      "packages/workbench/src/**/*.js",
    ],
    languageOptions: {
      globals: globals.browser,
    },
  },
  {
    files: ["packages/codecs/src/**/*.js"],
    languageOptions: {
      globals: {
        TextDecoder: "readonly",
        TextEncoder: "readonly",
      },
    },
  },
  {
    files: [
      "packages/domain/src/**/*.js",
      "packages/codecs/src/**/*.js",
    ],
    rules: {
      "no-restricted-imports": [
        "error",
        {
          paths: restrictedBuiltinImports,
          patterns: [
            {
              group: ["node:*"],
              message: "Node built-ins are unavailable in runtime-neutral shared packages.",
            },
          ],
        },
      ],
      "no-restricted-syntax": [
        "error",
        {
          selector: "ImportExpression",
          message: "Dynamic imports are unavailable in runtime-neutral shared packages.",
        },
      ],
    },
  },
  {
    files: ["**/*.cjs"],
    languageOptions: {
      sourceType: "commonjs",
    },
  },
];
