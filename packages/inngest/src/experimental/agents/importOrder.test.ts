import { spawnSync } from "node:child_process";
import { rmSync } from "node:fs";
import { fileURLToPath, pathToFileURL } from "node:url";
import { build } from "tsdown";
import { afterAll, beforeAll, describe, expect, test } from "vitest";

/**
 * Module-level values read across an import cycle only throw ("Cannot access
 * X before initialization") under real ESM semantics, which vitest's module
 * runner does not have. So the entry points are built the way `dist` is
 * (unbundled ESM) and each order loads them in a fresh Node process.
 */
const entries = {
  inngest: "index.js",
  experimental: "experimental.js",
  agents: "experimental/agents/index.js",
};

const orders: (keyof typeof entries)[][] = [
  ["inngest", "experimental", "agents"],
  ["inngest", "agents", "experimental"],
  ["experimental", "inngest", "agents"],
  ["experimental", "agents", "inngest"],
  ["agents", "inngest", "experimental"],
  ["agents", "experimental", "inngest"],
];

const root = fileURLToPath(new URL("../../..", import.meta.url));
const outDir = fileURLToPath(
  new URL("../../../node_modules/.cache/import-order", import.meta.url),
);

describe("entry point import order", () => {
  beforeAll(async () => {
    await build({
      cwd: root,
      config: false,
      clean: true,
      dts: false,
      entry: [
        "src/index.ts",
        "src/experimental.ts",
        "src/experimental/agents/index.ts",
      ],
      format: ["esm"],
      outDir,
      tsconfig: "tsconfig.build.json",
      target: "node20",
      platform: "neutral",
      unbundle: true,
      skipNodeModulesBundle: true,
      logLevel: "silent",
    });
  }, 120_000);

  afterAll(() => {
    rmSync(outDir, { recursive: true, force: true });
  });

  test.each(orders)(
    "loads cleanly: %s, %s, %s",
    (...order) => {
      const script = `${order
        .map(
          (name) =>
            `await import(${JSON.stringify(pathToFileURL(`${outDir}/${entries[name]}`).href)});`,
        )
        .join("\n")}\nconsole.log("loaded");`;

      const res = spawnSync(
        process.execPath,
        ["--input-type=module", "-e", script],
        { cwd: root, encoding: "utf8" },
      );

      expect(res.stderr).not.toContain("before initialization");
      expect(res.status, res.stderr).toBe(0);
      expect(res.stdout).toContain("loaded");
    },
    60_000,
  );
});
