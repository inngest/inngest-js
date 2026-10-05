/**
 * Tests for the Dev Server's version check, flags and binary resolution.
 *
 * @module
 */

import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, test } from "vitest";

import {
  devServerArgs,
  findOnPath,
  isSupportedVersion,
  resolveDevServerBin,
} from "./devServer.ts";

describe("isSupportedVersion", () => {
  test.each([
    ["1.45.1", true],
    ["1.45.2", true],
    ["1.46.0", true],
    ["2.0.0", true],
    ["1.45.0", false],
    ["1.9.9", false],
    ["0.99.0", false],
    ["1.45.1-beta.1", true],
    ["dev-abc123", true],
  ])("%s", (version, supported) => {
    expect(isSupportedVersion(version)).toBe(supported);
  });
});

describe("devServerArgs", () => {
  test("isolates the Dev Server on its own ports", () => {
    const args = devServerArgs({
      ports: {
        main: 1,
        connectGateway: 2,
        connectGatewayGrpc: 3,
        connectExecutorGrpc: 4,
        debugApi: 5,
      },
      appUrl: "http://127.0.0.1:6/api/inngest",
      sqliteDir: "/d",
    });

    expect(args.join(" ")).toBe(
      "dev --no-discovery --host 127.0.0.1 --port 1 --connect-gateway-port 2 --connect-gateway-grpc-port 3 --connect-executor-grpc-port 4 --debug-api-port 5 -u http://127.0.0.1:6/api/inngest --persist --sqlite-dir /d",
    );
  });
});

describe("resolveDevServerBin", () => {
  const withBins = (names: string[]) => {
    const dir = mkdtempSync(join(tmpdir(), "ci-path-"));

    for (const name of names) {
      writeFileSync(join(dir, name), "#!/bin/sh\n", { mode: 0o755 });
    }

    return dir;
  };

  test("prefers the env var, then the config", () => {
    const config = { root: "/nowhere", devServerBin: "/from/config" };
    const env = { INNGEST_CI_DEV_SERVER_BIN: "/from/env" };

    expect(resolveDevServerBin(config, { env })).toBe("/from/env");
    expect(resolveDevServerBin(config, { env: {} })).toBe("/from/config");
  });

  test("prefers the project's package over PATH", () => {
    const root = mkdtempSync(join(tmpdir(), "ci-root-"));
    const pkg = join(root, "node_modules", "inngest-cli");

    mkdirSync(pkg, { recursive: true });
    writeFileSync(
      join(pkg, "package.json"),
      JSON.stringify({ name: "inngest-cli", version: "1.46.0" }),
    );

    const bin = resolveDevServerBin(
      { root },
      { env: { PATH: withBins(["inngest-cli"]) } },
    );

    expect(bin).toBe(join(pkg, "bin", "inngest"));
  });

  test("falls back to inngest-cli, then inngest, on PATH", () => {
    const both = withBins(["inngest", "inngest-cli"]);
    const only = withBins(["inngest"]);
    const deps = { platform: "linux" as const, versionOf: () => "1.46.0" };

    expect(
      resolveDevServerBin(
        { root: "/nowhere" },
        { ...deps, env: { PATH: `${only}:${both}` } },
      ),
    ).toBe(join(both, "inngest-cli"));
    expect(
      resolveDevServerBin(
        { root: "/nowhere" },
        { ...deps, env: { PATH: only } },
      ),
    ).toBe(join(only, "inngest"));
  });

  test("honors PATHEXT on Windows", () => {
    const dir = withBins(["inngest-cli.CMD"]);

    expect(
      findOnPath("inngest-cli", { PATH: dir, PATHEXT: ".EXE;.CMD" }, "win32"),
    ).toBe(join(dir, "inngest-cli.CMD"));
  });

  test("rejects an old PATH binary but accepts a dev build", () => {
    const dir = withBins(["inngest-cli"]);
    const resolve = (version: string) => {
      return resolveDevServerBin(
        { root: "/nowhere" },
        {
          env: { PATH: dir },
          versionOf: () => {
            return version;
          },
        },
      );
    };

    expect(() => resolve("1.40.0")).toThrow(/too old/);
    expect(resolve("dev-abc")).toBe(join(dir, "inngest-cli"));
  });

  test("with nothing found, says how to install one", () => {
    expect(() =>
      resolveDevServerBin({ root: "/nowhere" }, { env: { PATH: "" } }),
    ).toThrow(/Could not find a Dev Server/);
  });
});
