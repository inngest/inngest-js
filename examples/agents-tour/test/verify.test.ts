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
    assert.deepEqual(await verifyPages(base, "good", { waitMs: 15_000 }), []);
  });

  it("names every kind of broken page, and only those", async () => {
    const problems = await verifyPages(base, "bad", { waitMs: 3000 });
    const about = (page: string) => {
      return problems.filter((problem) => {
        return problem.startsWith(`bad/${page}: `);
      });
    };

    assert.equal(problems.length, 8, problems.join("\n"));
    assert.match(about("broken")[0] ?? "", /did not start/);
    assert.match(about("wrong")[0] ?? "", /echo returned "HI", not "NOPE"/);
    assert.match(about("stub-passes")[0] ?? "", /the stub passes its check/);
    assert.match(
      about("solution-fails")[0] ?? "",
      /the solution fails its check/,
    );
    assert.match(about("fails")[0] ?? "", /the run of boom failed/);
    assert.match(
      about("default-fails")[0] ?? "",
      /boom ran but its status is FAILED, not a good one/,
    );
    assert.match(
      about("check-broken")[0] ?? "",
      /the check is broken: .*the check is wrong/,
    );
  });

  it("says so when the module is not there, instead of passing", async () => {
    assert.deepEqual(await verifyPages(base, "nope"), ["no module named nope"]);
  });
});
