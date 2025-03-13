/* eslint-disable import/no-unresolved */
/* eslint-disable import/no-extraneous-dependencies */
import pluginJs from "@eslint/js";
import eslintPluginImport from "eslint-plugin-import";
import eslintPluginPrettierRecommended from "eslint-plugin-prettier/recommended";
import globals from "globals";
import tseslint from "typescript-eslint";

/** @type {import('eslint').Linter.Config[]} */
export default [
  {
    ignores: ["*.d.ts", "*.js", "**/test/**", "**/dist/**"],
  },
  {
    files: ["**/*.{js,mjs,cjs,ts}"],
  },
  { languageOptions: { globals: globals.browser } },
  pluginJs.configs.recommended,
  ...tseslint.configs.recommended,
  eslintPluginPrettierRecommended,
  eslintPluginImport.flatConfigs.recommended,
  {
    rules: {
      "prettier/prettier": "warn",
      "@inngest/internal/process-warn": "off",
      "@typescript-eslint/no-unused-vars": [
        "warn",
        { varsIgnorePattern: "^_", argsIgnorePattern: "^_" },
      ],
      "@typescript-eslint/consistent-type-imports": [
        "error",
        { fixStyle: "inline-type-imports" },
      ],
      "@typescript-eslint/no-namespace": "off",
      "import/consistent-type-specifier-style": ["error", "prefer-inline"],
      "import/no-duplicates": ["error", { "prefer-inline": true }],
      "import/no-extraneous-dependencies": [
        "error",
        {
          devDependencies: [
            "**/*.test.ts",
            "**/test/**",
            "**/scripts/**",
            "src/cloudflare.ts",
            "src/digitalocean.ts",
            "src/edge.ts",
            "src/express.ts",
            "src/fastify.ts",
            "src/h3.ts",
            "src/koa.ts",
            "src/hono.ts",
            "src/lambda.ts",
            "src/next.ts",
            "src/nuxt.ts",
            "src/redwood.ts",
            "src/remix.ts",
            "src/sveltekit.ts",
            "src/nitro.ts",
            "src/node.ts",
          ],
          includeInternal: true,
          includeTypes: true,
        },
      ],
      "import/extensions": ["error", "ignorePackages"],
    },
  },
];
