module.exports = {
  extends: [
    "eslint:recommended",
    "plugin:@typescript-eslint/recommended",
    "plugin:@typescript-eslint/recommended-requiring-type-checking",
    "prettier",
    "plugin:prettier/recommended",
  ],
  parser: "@typescript-eslint/parser",
  parserOptions: {
    tsconfigRootDir: __dirname,
    project: ["./tsconfig.json"],
  },
  plugins: ["@typescript-eslint", "@inngest/internal", "import"],
  root: true,
  ignorePatterns: ["dist/", "*.d.ts", "*.js", "test/"],
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
  overrides: [
    {
      files: ["src/**/*.ts", "scripts/**/*.ts"],
      excludedFiles: ["*.d.ts", "*.test.ts", "src/test/**/*", "src/init.ts"],
      rules: {
        "@inngest/internal/process-warn": "warn",
      },
    },
    {
      files: ["src/**/*.test.ts"],
      rules: {
        "import/extensions": "off",
      },
    },
  ],
};
