/**
 * @module
 * The tour's MCP server through the tour server's HTTP API, called by the
 * SDK's own `tool.mcp()` the way a lesson's agent calls it.
 */
import assert from "node:assert/strict";
import { join } from "node:path";
import { after, before, describe, it } from "node:test";
import { secret, tool } from "inngest/experimental";
import { freePort } from "../scripts/lib.ts";
import { createTour } from "../server/app.ts";

const root = join(import.meta.dirname, "fixtures");
const ports = { api: 1, gateway: 2, gatewayGrpc: 3, executorGrpc: 4 };

const call = async (entry: unknown, input: unknown) => {
  const run = (entry as { run: (...args: unknown[]) => unknown }).run;

  return run(input, { signal: new AbortController().signal });
};

describe("the tour's MCP server", () => {
  let url = "";
  let stop = async () => {};

  before(async () => {
    const tour = await createTour({
      root,
      lessonsDir: join(root, "lessons"),
      binary: "unused",
      port: await freePort(),
      ports,
    });

    await tour.listen();
    url = `${tour.url}/mcp`;
    stop = tour.stop;
  });

  after(async () => {
    delete process.env.TOUR_MCP_TOKEN;
    await stop();
  });

  const connect = async (auth = false) => {
    const docs = tool.mcp({
      id: "docs",
      url,
      ...(auth && { auth: { bearer: secret("TOUR_MCP_TOKEN") } }),
    });

    return docs["~build"]("docs", await docs["~list"]());
  };

  it("lists its tools and answers a call", async () => {
    const tools = await connect();

    assert.deepEqual(Object.keys(tools), ["docs_search_docs"]);

    const found = JSON.stringify(
      await call(tools.docs_search_docs, { query: "deploy" }),
    );

    assert.match(found, /deploy/i);
  });

  it("refuses a call without the token when auth is on", async () => {
    process.env.TOUR_MCP_TOKEN = "tour-token";

    const bare = await fetch(url, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list" }),
    });

    assert.equal(bare.status, 401);
    assert.equal((await connect(true)).docs_search_docs !== undefined, true);
  });
});
