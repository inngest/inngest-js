/**
 * @module
 * `tour:verify`'s page driver, through the tour server's HTTP API with a real
 * Dev Server: a good set of pages verifies clean, and each kind of broken page
 * is named. Skipped when the Dev Server binary is not built.
 */
import assert from "node:assert/strict";
import { join } from "node:path";
import { after, before, describe, it } from "node:test";
import { freePort, resolveBinary, root } from "../scripts/lib.ts";
import { verifyPages } from "../scripts/verify-lib.ts";
import { createTour } from "../server/app.ts";

const binary = resolveBinary();

describe("verifying pages", { skip: binary === undefined }, () => {
  let base = "";
  let stop = async () => {};

  before(async () => {
    const tour = await createTour({
      root,
      lessonsDir: join(import.meta.dirname, "fixtures", "verify"),
      dataDir: join(root, ".tour", "test-verify"),
      binary: binary as string,
      scriptedModel: true,
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

  it("passes pages that keep their promise and exercises that behave", async () => {
    assert.deepEqual(await verifyPages(base, "good"), []);
  });

  it("names a page that does not start, one whose promise fails, and exercises whose stub passes or solution fails", async () => {
    const problems = await verifyPages(base, "bad");

    assert.equal(problems.length, 4, problems.join("\n"));
    assert.match(problems[0] as string, /^bad\/broken: .*did not start/);
    assert.match(problems[1] as string, /^bad\/wrong: .*echo/);
    assert.match(problems[2] as string, /^bad\/stub-passes: the stub passes/);
    assert.match(
      problems[3] as string,
      /^bad\/solution-fails: the solution fails/,
    );
  });
});
