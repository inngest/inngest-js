/**
 * @module
 * Check, through the tour server's HTTP API with a real Dev Server and app:
 * a stub fails with one sentence and a solution passes. Skipped when the Dev
 * Server binary is not built.
 */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { after, before, describe, it } from "node:test";
import { freePort, resolveBinary, root } from "../scripts/lib.ts";
import { createTour } from "../server/app.ts";

const binary = resolveBinary();
const lessonsDir = join(import.meta.dirname, "fixtures", "exercise");

const post = async (base: string, path: string, body: unknown) => {
  const res = await fetch(base + path, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });

  return { status: res.status, body: (await res.json()) as any };
};

describe("checking an exercise", { skip: binary === undefined }, () => {
  let base = "";
  let stop = async () => {};

  before(async () => {
    const tour = await createTour({
      root,
      lessonsDir,
      dataDir: join(root, ".tour", "test-check"),
      binary: binary as string,
      port: await freePort(),
      ports: {
        api: await freePort(),
        gateway: await freePort(),
        gatewayGrpc: await freePort(),
        executorGrpc: await freePort(),
      },
    });

    await tour.start();
    base = tour.url;
    stop = tour.stop;
  });

  after(async () => {
    await stop();
  });

  it("fails the stub with one sentence saying why", async () => {
    const stub = readFileSync(
      join(lessonsDir, "01-ex/01-greeter/stub/agent.ts"),
      "utf8",
    );
    const answer = await post(base, "/api/check", {
      id: "ex/greeter",
      files: { "agent.ts": stub },
    });

    assert.equal(answer.status, 200);
    assert.equal(answer.body.pass, false);
    assert.equal(
      answer.body.reason,
      'The greeter returned null, not "Hello, Ada!".',
    );
  });

  it("passes the solution", async () => {
    const solution = readFileSync(
      join(lessonsDir, "01-ex/01-greeter/solution/agent.ts"),
      "utf8",
    );
    const answer = await post(base, "/api/check", {
      id: "ex/greeter",
      files: { "agent.ts": solution },
    });

    assert.deepEqual(answer.body, { pass: true });
  });
});
