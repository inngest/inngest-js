/**
 * Checks for missing, misplaced, or unused dependencies within the project.
 *
 * Missing dependencies are mostly caught by a TypeScript build anyway, so this
 * is less of an issue. However, unused dependencies are harder to catch.
 *
 * The key value of this script is that it can catch when a package is defined
 * within `devDependencies` but we are using it in exported code. For the most
 * part this will have no impact, but it can cause issues if the consumer uses
 * `skipLibCheck: false` in their TS configuration.
 *
 * We highlight those `devDependencies` that should be moved to `dependencies`.
 *
 * Not that there are some exceptions to this rule, for instance when using
 * `@types/*` packages. We should perform further checks against generated
 * `.d.ts` files to ensure that we are not exporting types that are not
 * available to the consumer.
 */

import chalk from "chalk";
import fs from "fs";
import { builtinModules } from "module";
import path from "path";
import ts from "typescript";

// Define paths to package.json and tsconfig.json
const packagePath = path.join(import.meta.dirname, "..");
const packageJsonPath = path.join(packagePath, "package.json");

// Read and parse package.json
const packageJsonRaw = fs.readFileSync(packageJsonPath, "utf8");
const packageJson = JSON.parse(packageJsonRaw) as {
  dependencies?: Record<string, string>;
  devDependencies?: Record<string, string>;
};

// Extract dependencies and devDependencies, or default to empty objects if not defined
const dependencies = packageJson.dependencies ?? {};
const devDependencies = packageJson.devDependencies ?? {};

// Check if a module is a built-in Node module
function isNodeBuiltin(moduleName: string): boolean {
  return (
    builtinModules.includes(moduleName) ||
    builtinModules.includes(moduleName.replace(/^node:/, ""))
  );
}

// Check if a module is a local file or an aliased path
function isLocalOrAliasedImport(
  moduleName: string,
  tsConfigPaths: Record<string, string[]>,
): boolean {
  return (
    moduleName.startsWith(".") ||
    moduleName.startsWith("/") ||
    Object.keys(tsConfigPaths).some((alias) => moduleName.startsWith(alias))
  );
}

// Check if an import is type-only (either entirely or each individual import)
function isTypeOnlyImport(
  node: ts.ImportDeclaration | ts.ImportSpecifier,
): boolean {
  // Check if the entire import is type-only
  if (
    (ts.isImportDeclaration(node) &&
      node.importClause &&
      node.importClause.isTypeOnly) ||
    (ts.isImportSpecifier(node) && node.isTypeOnly)
  ) {
    return true;
  }

  // Check if all named bindings in the import are type-only
  if (
    ts.isImportDeclaration(node) &&
    node.importClause &&
    node.importClause.namedBindings
  ) {
    const bindings = node.importClause.namedBindings;
    if (ts.isNamedImports(bindings)) {
      return bindings.elements.every((element) => element.isTypeOnly);
    }
  }
  return false;
}

// Parse tsconfig.json to get file names and paths
function parseTsConfig(configFileName: string): {
  fileNames: string[];
  paths: Record<string, string[]>;
} {
  const parseConfigHost: ts.ParseConfigFileHost = {
    useCaseSensitiveFileNames: ts.sys.useCaseSensitiveFileNames,
    readDirectory: ts.sys.readDirectory.bind(ts.sys),
    fileExists: ts.sys.fileExists.bind(ts.sys),
    readFile: ts.sys.readFile.bind(ts.sys),
    getCurrentDirectory: ts.sys.getCurrentDirectory.bind(ts.sys),
    onUnRecoverableConfigFileDiagnostic: (diagnostic) =>
      console.error(
        ts.flattenDiagnosticMessageText(diagnostic.messageText, "\n"),
      ),
  };

  const parsedCommandLine = ts.getParsedCommandLineOfConfigFile(
    configFileName,
    {},
    parseConfigHost,
  );

  if (!parsedCommandLine) {
    throw new Error(`Could not parse ${configFileName}`);
  }

  return {
    fileNames: parsedCommandLine.fileNames,
    paths: parsedCommandLine.options.paths || {},
  };
}

// Get the base package name from a module name (handling scoped packages)
function getBasePackageName(moduleName: string): string {
  if (moduleName.startsWith("@")) {
    return moduleName.split("/", 2).join("/");
  }
  return moduleName.split("/")[0] || moduleName;
}

// Main function to check dependencies
function checkDependencies(
  tsConfigPath: string,
  ignoreFiles: string[] = [],
): void {
  const { fileNames, paths } = parseTsConfig(tsConfigPath);
  const issues: Record<string, { files: string[]; type: string }> = {};
  const importedModules = new Set<string>();
  const importedTypeModules = new Set<string>();

  // Convert ignoreFiles to absolute paths for easy comparison
  const ignoreAbsolutePaths = ignoreFiles.map((file) =>
    path.resolve(packagePath, file),
  );

  // biome-ignore lint/complexity/noForEach: intentional
  fileNames.forEach((file) => {
    const content = fs.readFileSync(file, "utf8");
    const sourceFile = ts.createSourceFile(
      file,
      content,
      ts.ScriptTarget.Latest,
    );

    // Check each import in source files
    sourceFile.forEachChild((node) => {
      if (
        ts.isImportDeclaration(node) &&
        node.moduleSpecifier &&
        ts.isStringLiteral(node.moduleSpecifier)
      ) {
        const fullImportName = node.moduleSpecifier.text;
        const importedModule = getBasePackageName(fullImportName);

        if (isTypeOnlyImport(node)) {
          importedTypeModules.add(importedModule);
        } else {
          importedModules.add(importedModule);
        }

        const typesPackageName = `@types/${importedModule}`;

        if (isTypeOnlyImport(node)) {
          importedModules.add(typesPackageName);
        }

        // Skip files that are in the ignore list
        // Let them still be added to imported modules; they're used somewhere
        if (ignoreAbsolutePaths.includes(path.resolve(file))) {
          return;
        }

        // Add issues for missing or misplaced dependencies
        if (
          !isNodeBuiltin(importedModule) &&
          !isLocalOrAliasedImport(importedModule, paths)
        ) {
          const typeOnlyImport = isTypeOnlyImport(node);
          let issueType = "";

          if (
            !dependencies[importedModule] &&
            !devDependencies[importedModule]
          ) {
            if (typeOnlyImport) {
              if (
                !dependencies[typesPackageName] &&
                !devDependencies[typesPackageName]
              ) {
                issueType = "MissingTypes";
              }
            } else {
              issueType = "Missing";
            }
          } else if (
            !dependencies[importedModule] &&
            devDependencies[importedModule]
          ) {
            issueType = "DevOnly";
          }

          if (issueType) {
            if (!issues[importedModule]) {
              issues[importedModule] = { files: [], type: issueType };
            }
            const line =
              sourceFile.getLineAndCharacterOfPosition(
                node.getStart(sourceFile),
              ).line + 1;
            issues[importedModule]?.files.push(
              `${fullImportName} in ${path.relative(packagePath, file)}:${line}`,
            );
          }
        }
      }
    });
  });

  // Packages that are dynamically imported and should not be flagged as unused
  const dynamicallyImportedPackages = ["ulid"];

  // Check for unused packages in dependencies
  // biome-ignore lint/complexity/noForEach: intentional
  Object.keys(dependencies).forEach((dependency) => {
    if (
      !importedModules.has(dependency) &&
      !dependency.startsWith("@types/") &&
      !dynamicallyImportedPackages.includes(dependency)
    ) {
      const typesPackage = `@types/${dependency}`;
      if (!importedModules.has(typesPackage)) {
        if (!issues[dependency]) {
          issues[dependency] = { files: [], type: "Unused" };
        }
        issues[dependency]?.files.push(`Package '${dependency}' is not used.`);
      }
    }
  });

  // Check for @types packages that should be moved to dependencies
  // biome-ignore lint/complexity/noForEach: intentional
  importedTypeModules.forEach((typeModule) => {
    if (
      importedModules.has(typeModule) &&
      devDependencies[`@types/${typeModule}`]
    ) {
      if (!issues[typeModule]) {
        issues[typeModule] = { files: [], type: "MoveToDependencies" };
      }
      issues[typeModule]?.files.push(
        `@types/${typeModule} should be in dependencies.`,
      );
    }
  });

  // Output issues found
  if (Object.keys(issues).length > 0) {
    console.log(chalk.red("Dependency Issues Found:"));
    Object.entries(issues).forEach(([module, data], index, array) => {
      console.log(chalk.blue(`${module} (${data.type}):`));
      // biome-ignore lint/complexity/noForEach: intentional
      data.files.forEach((file) => console.log(chalk.yellow(`  - ${file}`)));
      if (index < array.length - 1) {
        console.log(""); // Add a line break between modules
      }
    });
    process.exit(1);
  } else {
    console.log(chalk.green("No dependency issues found."));
  }
}

checkDependencies("tsconfig.build.json", [
  "src/astro.ts",
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
  "tsdown.config.ts",
  "vitest.config.ts",
]);
