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
  ignorePatterns: ["dist/", "*.d.ts", "*.js"],
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
    "import/consistent-type-specifier-style": ["error", "prefer-inline"],
    "import/no-duplicates": ["error", { "prefer-inline": true }],
  },
  overrides: [
    {
      files: ["src/**/*.ts"],
      excludedFiles: ["*.d.ts", "*.test.ts", "src/test/**/*", "src/init.ts"],
      rules: {
        "@inngest/internal/process-warn": "warn",
      },
    },
  ],
};
