import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { expect, test } from "vitest";

const packageJsonPath = fileURLToPath(
  new URL("../package.json", import.meta.url),
);
const packageJson = JSON.parse(readFileSync(packageJsonPath, "utf8")) as {
  files?: unknown;
};

test("package.json publishes Rolldown virtual runtime helpers", () => {
  expect(
    Array.isArray(packageJson.files),
    "`package.json#files` must be an allowlist array.",
  ).toBe(true);
  if (!Array.isArray(packageJson.files)) {
    return;
  }

  // Rolldown can emit shared runtime helpers under `dist/_virtual` for
  // CommonJS output. This package publishes from `dist`, so the package
  // allowlist must include `_virtual/**`; otherwise
  // `node --require @inngest/otel/node` can load a published CJS file that
  // requires a helper missing from the npm tarball.
  expect(
    packageJson.files,
    "`package.json#files` must include `_virtual/**`.",
  ).toContain("_virtual/**");
});
