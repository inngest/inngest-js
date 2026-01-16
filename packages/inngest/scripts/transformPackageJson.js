/**
 * Transform package.json for distribution:
 * - Replace `exports` with `publishConfig.exports`
 * - Remove `publishConfig.exports` (keep other publishConfig fields like registry)
 * - Remove `devDependencies`
 * - Remove dev-only scripts
 */

import * as path from "path";
import { fileURLToPath } from "url";

import { transformPackageJson } from "../../../scripts/transformPackageJson.js";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const distDir = path.join(__dirname, "..", "dist");
const packageJsonPath = path.join(distDir, "package.json");

transformPackageJson(packageJsonPath);
