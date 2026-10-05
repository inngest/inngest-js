/**
 * Tests for the Dev Server's version check, flags and binary resolution.
 *
 * @module
 */

import { describe, expect, test } from "vitest";

import {
  devServerArgs,
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
  test("prefers the env var, then the config", () => {
    const config = { root: "/nowhere", devServerBin: "/from/config" };

    expect(
      resolveDevServerBin(config, { INNGEST_CI_DEV_SERVER_BIN: "/from/env" }),
    ).toBe("/from/env");
    expect(resolveDevServerBin(config, {})).toBe("/from/config");
  });

  test("without a binary or inngest-cli, says how to install one", () => {
    expect(() => resolveDevServerBin({ root: "/nowhere" }, {})).toThrow(
      /Could not find a Dev Server/,
    );
  });
});
