/**
 * Tests for choosing how to open a URL on each platform, WSL included.
 *
 * @module
 */

import { describe, expect, test } from "vitest";

import { isWsl, type OpenEnv, openerFor } from "./open.ts";

const url = "http://127.0.0.1:8288/run?runID=01ABC";

const linux = (overrides: Partial<OpenEnv> = {}): OpenEnv => {
  return {
    platform: "linux",
    env: {},
    procVersion: "Linux version 6.1 (gcc)",
    onPath: () => {
      return false;
    },
    ...overrides,
  };
};

describe("isWsl", () => {
  test("reads WSL_DISTRO_NAME or Microsoft in /proc/version", () => {
    expect(isWsl({ env: { WSL_DISTRO_NAME: "NixOS" } })).toBe(true);
    expect(
      isWsl({
        env: {},
        procVersion: "Linux version 6.6.87.2-microsoft-standard-WSL2",
      }),
    ).toBe(true);
    expect(isWsl({ env: {}, procVersion: "Linux version 6.1 (gcc)" })).toBe(
      false,
    );
    expect(isWsl({ env: {} })).toBe(false);
  });
});

describe("openerFor", () => {
  test("uses open on macOS and rundll32 on Windows", () => {
    expect(openerFor(url, linux({ platform: "darwin" }))).toEqual({
      command: "open",
      args: [url],
    });
    expect(openerFor(url, linux({ platform: "win32" })).command).toBe(
      "rundll32",
    );
  });

  test("uses xdg-open on Linux", () => {
    expect(openerFor(url, linux())).toEqual({
      command: "xdg-open",
      args: [url],
    });
  });

  test("on WSL prefers wslview, with the URL as localhost", () => {
    expect(
      openerFor(
        url,
        linux({
          env: { WSL_DISTRO_NAME: "NixOS" },
          onPath: (name) => {
            return name === "wslview";
          },
        }),
      ),
    ).toEqual({
      command: "wslview",
      args: ["http://localhost:8288/run?runID=01ABC"],
    });
  });

  test("on WSL falls back to explorer.exe", () => {
    expect(
      openerFor(url, linux({ env: { WSL_DISTRO_NAME: "NixOS" } })),
    ).toEqual({
      command: "explorer.exe",
      args: ["http://localhost:8288/run?runID=01ABC"],
    });
  });
});
