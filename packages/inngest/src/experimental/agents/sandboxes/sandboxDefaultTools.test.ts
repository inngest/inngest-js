/**
 * @module
 * Tests for the tools a listed sandbox gives the model when its definition
 * has no `tools` option: `run`, as if it had `sandbox.tools.defaults`.
 */
import { describe, expect, test } from "vitest";
import type {
  DurableSandbox,
  DurableSandboxTools,
} from "../../../components/sandbox/types.ts";
import {
  openSandboxes,
  type SandboxRuntime,
  sandbox,
  sandboxTools,
} from "./defs.ts";

const auth = {
  read: () => {
    return "read-token";
  },
  write: () => {
    return "write-token";
  },
};

const environment = () => {
  const runtime = {
    run: async (_id: string, fn: () => Promise<unknown>) => {
      return fn();
    },
  } as SandboxRuntime;
  const sandboxes = {
    create: async () => {
      return {
        commands: {},
        files: {},
        destroy: async () => {},
      } as unknown as DurableSandbox;
    },
  } as unknown as DurableSandboxTools;

  return { runtime, sandboxes };
};

const modelToolNames = (
  definitions: Parameters<typeof openSandboxes>[0],
): string[] => {
  const env = environment();

  return Object.keys(
    sandboxTools(openSandboxes(definitions, env.sandboxes, env.runtime)),
  );
};

describe("a listed sandbox's default tools", () => {
  test("a sandbox with no tools gives the model work_run", () => {
    expect(modelToolNames({ work: sandbox({ id: "work" }) })).toEqual([
      "work_run",
    ]);
  });

  test("with a repo it also gives work_push", () => {
    const work = sandbox({
      id: "work",
      repo: { url: "acme/app", auth },
    });

    expect(modelToolNames({ work })).toEqual(["work_run", "work_push"]);
  });

  test("model: false gives the model nothing", () => {
    const work = sandbox({
      id: "work",
      repo: { url: "acme/app", auth },
    });

    expect(modelToolNames({ work: { sandbox: work, model: false } })).toEqual(
      [],
    );
  });

  test("tools that are set keep exactly what they were given", () => {
    const work = sandbox({
      id: "work",
      tools: { read: sandbox.tools.read },
    });

    expect(modelToolNames({ work })).toEqual(["work_read"]);
  });
});
