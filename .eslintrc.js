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
    "@typescript-eslint/no-explicit-any": "off",
    "@inngest/process-warn": "warn",
  },
};
