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
  plugins: ["@typescript-eslint", "@inngest"],
  root: true,
  ignorePatterns: ["dist/", "*.d.ts", "*.js", "deno_compat/"],
  rules: {
    "prettier/prettier": "warn",
    "@inngest/process-warn": "off",
    "@typescript-eslint/no-unused-vars": [
      "warn",
      { varsIgnorePattern: "^_", argsIgnorePattern: "^_" },
    ],
  },
  overrides: [
    {
      files: ["src/**/*.ts"],
      excludedFiles: [
        "*.d.ts",
        "*.test.ts",
        "src/test/**/*",
        "src/examples/**/*",
        "src/init.ts",
      ],
      rules: {
        "@inngest/process-warn": "warn",
      },
    },
  ],
};
