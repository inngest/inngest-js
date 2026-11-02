/**
 * @module
 * The site's Format call: what the editor gets back when the server cannot
 * format.
 */
import assert from "node:assert/strict";
import { afterEach, describe, it } from "node:test";
import { api } from "../site/src/api.ts";

const realFetch = globalThis.fetch;

const answer = (status: number, body: unknown) => {
  globalThis.fetch = (async () => {
    return new Response(JSON.stringify(body), {
      status,
      headers: { "content-type": "application/json" },
    });
  }) as typeof fetch;
};

describe("formatting from the site", () => {
  afterEach(() => {
    globalThis.fetch = realFetch;
  });

  it("returns the formatted code", async () => {
    answer(200, { content: "export const a = 1;\n", ok: true });

    assert.equal(
      await api.format("agent.ts", "export const a=1"),
      "export const a = 1;\n",
    );
  });

  it("leaves the code as it was when the server answers with an error", async () => {
    answer(500, { error: "Biome is not installed" });

    assert.equal(
      await api.format("agent.ts", "export const a=1"),
      "export const a=1",
    );
  });

  it("leaves the code as it was when the server cannot be reached", async () => {
    globalThis.fetch = (async () => {
      throw new Error("connection refused");
    }) as typeof fetch;

    assert.equal(
      await api.format("agent.ts", "export const a=1"),
      "export const a=1",
    );
  });
});
