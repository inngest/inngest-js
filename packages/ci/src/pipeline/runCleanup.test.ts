/**
 * Tests of the generated cleanup functions deleting the run-scoped snapshots a
 * pipeline run leaves behind when it ends without reaching its own cleanup.
 *
 * @module
 */

import { randomUUID } from "node:crypto";
import { internalEvents } from "inngest";
import { describe, expect, test } from "vitest";
import { createCiTestClient } from "../testing/client.ts";
import { prTrigger } from "../testing/events.ts";
import { createFakeSandboxApi } from "../testing/fakeSandbox.ts";
import { runFunction } from "../testing/runFunction.ts";
import { createCi } from "./createCi.ts";

const setup = () => {
  const api = createFakeSandboxApi();
  const client = createCiTestClient(api);
  const ci = createCi(client);

  ci.pipeline({ id: "pr", on: prTrigger }, async () => {
    return "ok";
  });

  return { api, client, ci };
};

/** Put a ready snapshot with this name in the fake, as a build would. */
const seed = (api: ReturnType<typeof createFakeSandboxApi>, name: string) => {
  const id = randomUUID();

  api.snapshots.set(id, {
    id,
    name,
    status: "READY",
    sandboxId: "sbx",
    createdAt: new Date().toISOString(),
    expiresAt: new Date(Date.now() + 86_400_000).toISOString(),
  });
};

const seedAll = (api: ReturnType<typeof createFakeSandboxApi>) => {
  seed(api, "ci/run:RUN1/install/abc");
  seed(api, "ci/run:RUN1/build/def");
  seed(api, "ci/run:RUN2/install/abc");
  seed(api, "ci/run:RUN10/install/abc");
  seed(api, "ci/main/install/abc");
  seed(api, "ci/global/install/abc");
};

const names = (api: ReturnType<typeof createFakeSandboxApi>) => {
  return [...api.snapshots.values()]
    .map((snapshot) => {
      return snapshot.name;
    })
    .sort();
};

const functionNamed = (ci: ReturnType<typeof setup>["ci"], id: string) => {
  const found = ci.functions().find((fn) => {
    return fn.opts.id === id;
  });

  if (!found) {
    throw new Error(`no function ${id}`);
  }

  return found;
};

const ended = (name: string, functionId: string, runId: string) => {
  return { name, data: { function_id: functionId, run_id: runId } };
};

describe("run snapshot cleanup after a run ends", () => {
  test.each([
    ["fails", internalEvents.FunctionFailed],
    ["is cancelled", internalEvents.FunctionCancelled],
  ])(
    "deletes only the run's snapshots when the pipeline %s",
    async (_, name) => {
      const { api, client, ci } = setup();

      seedAll(api);

      const result = await runFunction(functionNamed(ci, "pr/cleanup"), {
        event: ended(name, `${client.id}-pr`, "RUN1"),
      });

      expect(result.type).toBe("function-resolved");
      expect(result.stepIds).toContain("list-run-snapshots");
      expect(result.stepIds).toContain("delete-run-snapshots");
      expect(names(api)).toEqual([
        "ci/global/install/abc",
        "ci/main/install/abc",
        "ci/run:RUN10/install/abc",
        "ci/run:RUN2/install/abc",
      ]);
    },
  );

  test("tolerates a snapshot that is already gone", async () => {
    const { api, client, ci } = setup();

    seedAll(api);

    const [victim] = [...api.snapshots.values()].filter((snapshot) => {
      return snapshot.name?.startsWith("ci/run:RUN1/");
    });
    const get = api.snapshots.get.bind(api.snapshots);

    // Another cleanup deleted one between listing and deleting.
    api.snapshots.get = (id: string) => {
      if (victim && id === victim.id) {
        api.snapshots.delete(id);
      }

      return get(id);
    };

    const result = await runFunction(functionNamed(ci, "pr/cleanup"), {
      event: ended(internalEvents.FunctionFailed, `${client.id}-pr`, "RUN1"),
    });

    expect(result.type).toBe("function-resolved");
    expect(
      names(api).some((name) => {
        return name?.startsWith("ci/run:RUN1/");
      }),
    ).toBe(false);
  });

  test("a nested build ending leaves the run's snapshots for the root run", async () => {
    const { api, client, ci } = setup();

    seedAll(api);

    const before = names(api);

    for (const name of [
      internalEvents.FunctionFailed,
      internalEvents.FunctionCancelled,
    ]) {
      const result = await runFunction(functionNamed(ci, "ci/build/cleanup"), {
        event: ended(name, `${client.id}-ci/build`, "BUILD1"),
      });

      expect(result.type).toBe("function-resolved");
      expect(result.stepIds).not.toContain("list-run-snapshots");
    }

    // Even a build whose own ID is the root's: only the pipeline cleans up.
    await runFunction(functionNamed(ci, "ci/build/cleanup"), {
      event: ended(
        internalEvents.FunctionFailed,
        `${client.id}-ci/build`,
        "RUN1",
      ),
    });

    expect(names(api)).toEqual(before);
  });

  test("a pipeline's cleanup only reacts to its own function", () => {
    const { client, ci } = setup();
    const triggers = functionNamed(ci, "pr/cleanup").opts.triggers as Array<{
      event: string;
      if: string;
    }>;

    expect(
      triggers.map((trigger) => {
        return trigger.event;
      }),
    ).toEqual([
      internalEvents.FunctionFailed,
      internalEvents.FunctionCancelled,
    ]);

    for (const trigger of triggers) {
      expect(trigger.if).toContain(`${client.id}-pr`);
    }
  });
});
