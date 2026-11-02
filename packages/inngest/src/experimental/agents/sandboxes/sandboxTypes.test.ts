/**
 * @module
 * Type tests for an agent's sandboxes: the body knows the names of the
 * sandboxes, each has the core sandbox's commands and files, and the model's
 * tool names come from the sandbox.
 */
import { expectTypeOf } from "vitest";
import { Inngest } from "../../../components/Inngest.ts";
import type { SandboxHandle } from "../../../components/sandbox/types.ts";
import { testClientId } from "../../../test/helpers.ts";
import { createAgents } from "../agent/agents.ts";
import * as agentsEntry from "../index.ts";
import {
  type AgentSandbox,
  type SandboxDefinition,
  type SandboxToolsOf,
  sandbox,
} from "./defs.ts";

const client = new Inngest({ id: testClientId });
const agents = createAgents(client);

const workbench = sandbox({ id: "workbench", tools: sandbox.tools.code() });
const reader = sandbox({
  id: "reader",
  tools: sandbox.tools.code({ only: ["read", "search"] }),
});
const coder = sandbox({
  id: "coder",
  tools: sandbox.tools.code({ only: ["run", "read", "search", "edit"] }),
});
const bare = sandbox({ id: "bare" });

describe("sandbox: the handle runs commands and moves files like the core sandbox", () => {
  test("a listed sandbox has commands, files, recycle and close, and no processes", () => {
    agents.agent(
      {
        id: "typed-1",
        triggers: { cron: "0 * * * *" },
        sandboxes: { work: workbench, bare },
      },
      async ({ sandboxes }) => {
        expectTypeOf(sandboxes.work).toEqualTypeOf<AgentSandbox>();
        expectTypeOf(sandboxes.work.commands).toEqualTypeOf<
          SandboxHandle["commands"]
        >();
        expectTypeOf(sandboxes.work.files).toEqualTypeOf<
          SandboxHandle["files"]
        >();
        expectTypeOf(sandboxes.bare.recycle).toBeFunction();
        expectTypeOf(sandboxes.bare.close).toBeFunction();

        // @ts-expect-error core sandboxes have no processes
        sandboxes.work.processes;

        // @ts-expect-error get() left the public type
        sandboxes.work.get;

        // @ts-expect-error tools left the public type
        sandboxes.work.tools;

        // @ts-expect-error there is no sandbox named typo
        sandboxes.typo;

        return null;
      },
    );
  });

  test("a function-valued config and a start function give the same names", () => {
    agents.agent(
      {
        id: "typed-2",
        triggers: { cron: "0 * * * *" },
        sandboxes: ({ event }) => {
          return event.name ? { work: workbench } : { work: workbench };
        },
      },
      async ({ sandboxes }) => {
        expectTypeOf(sandboxes).toHaveProperty("work");

        return null;
      },
    );
    agents.agent(
      {
        id: "typed-3",
        triggers: { cron: "0 * * * *" },
        sandboxes: {
          work: {
            sandbox: workbench,
            model: false,
            start: ({ event }) => {
              return event.name === "inngest/scheduled.timer"
                ? "eager"
                : "lazy";
            },
          },
        },
      },
      async ({ sandboxes }) => {
        expectTypeOf(sandboxes).toHaveProperty("work");

        return null;
      },
    );
  });

  test("an agent without sandboxes has none", () => {
    agents.agent(
      { id: "typed-4", triggers: { cron: "0 * * * *" } },
      async ({ sandboxes }) => {
        // @ts-expect-error this agent declares no sandboxes
        sandboxes.work;

        return null;
      },
    );
  });

  test("a record typed as the wide record is not narrowed: names are plain strings", () => {
    const wide: Record<string, SandboxDefinition> = { work: workbench };

    agents.agent(
      { id: "typed-9", triggers: { cron: "0 * * * *" }, sandboxes: wide },
      async ({ sandboxes }) => {
        // Known limitation: nothing says which names exist, so any compiles.
        sandboxes.anything;

        return null;
      },
    );
  });
});

describe("sandbox: the model's tool names come from the sandbox", () => {
  test("each tool is <sandbox>_<tool>, from what the definition brings", () => {
    type Names = keyof SandboxToolsOf<{
      work: "run";
      view: "read" | "search";
    }>;

    expectTypeOf<Names>().toEqualTypeOf<
      "work_run" | "view_read" | "view_search"
    >();
  });
});

describe("sandbox: the code tools are run, run_code, read, search and edit", () => {
  test("the default is run, and run_code appears only with tools to call", () => {
    expectTypeOf(workbench).toEqualTypeOf<SandboxDefinition<"run">>();
    expectTypeOf(reader).toEqualTypeOf<SandboxDefinition<"read" | "search">>();
    expectTypeOf(coder).toEqualTypeOf<
      SandboxDefinition<"run" | "read" | "search" | "edit">
    >();
    expectTypeOf(
      sandbox({ id: "c", tools: sandbox.tools.code({ tools: {} }) }),
    ).toEqualTypeOf<SandboxDefinition<"run" | "run_code">>();
    expectTypeOf(bare).toEqualTypeOf<SandboxDefinition<never>>();
  });

  test("write is not a code tool", () => {
    // @ts-expect-error write was deleted: a heredoc in run writes a file
    sandbox.tools.code({ only: ["write"] });
  });
});

describe("sandbox: a definition takes id, image, size, tools and setup", () => {
  test("the options", () => {
    sandbox({
      id: "full",
      image: sandbox.image.custom("py:v1"),
      vcpu: 2,
      memoryMb: 1024,
      tools: sandbox.tools.code(),
      setup: async () => {},
    });
  });
});

describe("sandbox: the deleted exports are gone", () => {
  test("the public entry does not export them", () => {
    expectTypeOf(agentsEntry).not.toHaveProperty("sandboxTools");
    expectTypeOf(agentsEntry).not.toHaveProperty("resolveSandboxes");
    expectTypeOf(agentsEntry).not.toHaveProperty("getSandbox");
    expectTypeOf(agentsEntry).not.toHaveProperty("openSandboxes");
    expectTypeOf(agentsEntry).not.toHaveProperty("SandboxToolsOf");
    expectTypeOf(agentsEntry).not.toHaveProperty("LazySandbox");
  });
});
