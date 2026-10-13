/**
 * Tests for the reporter server and the free-port finder, over real loopback.
 *
 * @module
 */

import { afterEach, describe, expect, test } from "vitest";

import type { LocalMessage } from "../local/protocol.ts";
import { freePorts } from "./ports.ts";
import { type ReporterServer, startReporterServer } from "./reporterServer.ts";

let server: ReporterServer;

afterEach(async () => {
  await server.close();
});

const post = (body: string): Promise<Response> => {
  return fetch(server.url, { method: "POST", body });
};

describe("startReporterServer", () => {
  test("hands messages to listeners and resolves the manifest", async () => {
    server = await startReporterServer();

    const seen: LocalMessage[] = [];

    server.onMessage((message) => {
      seen.push(message);
    });

    const manifest = { pipelines: [], jobs: [], matrices: [] };

    expect(
      (await post(JSON.stringify({ kind: "manifest", manifest }))).status,
    ).toBe(204);
    expect(await server.manifest).toEqual(manifest);
    expect(seen).toHaveLength(1);
    expect(seen[0]?.kind).toBe("manifest");
  });

  test("rejects what isn't a message", async () => {
    server = await startReporterServer();

    expect((await post("nope")).status).toBe(400);
    expect((await post("{}")).status).toBe(400);
  });
});

describe("freePorts", () => {
  test("gives distinct ports", async () => {
    server = await startReporterServer();

    const ports = await freePorts(6);

    expect(new Set(ports).size).toBe(6);
  });
});
