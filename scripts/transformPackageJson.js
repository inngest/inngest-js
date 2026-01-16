import * as fs from "fs";

/**
 * Transform the package.json file for distribution.
 * - Replace `exports` with `publishConfig.exports`
 * - Remove `publishConfig.exports` (keep other publishConfig fields like registry)
 * - Remove `devDependencies`
 * - Remove dev-only scripts
 * @param {string} packageJsonPath
 */
export function transformPackageJson(packageJsonPath) {
  const packageJson = JSON.parse(fs.readFileSync(packageJsonPath, "utf-8"));

  // Replace exports with publishConfig.exports
  if (packageJson.publishConfig?.exports) {
    packageJson.exports = packageJson.publishConfig.exports;
    delete packageJson.publishConfig.exports;

    // Remove publishConfig if empty
    if (Object.keys(packageJson.publishConfig).length === 0) {
      delete packageJson.publishConfig;
    }
  }

  // Remove devDependencies - not needed in distributed package
  delete packageJson.devDependencies;

  // Remove dev-only scripts
  delete packageJson.scripts;

  fs.writeFileSync(
    packageJsonPath,
    JSON.stringify(packageJson, null, 2) + "\n"
  );

  console.log("Transformed dist/package.json");
}
