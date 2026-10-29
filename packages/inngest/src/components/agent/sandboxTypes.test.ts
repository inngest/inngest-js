/**
 * @module
 * Type tests for an agent's sandboxes: the body knows the names of the
 * sandboxes and of their tools, so a typo fails to compile.
 */
import { expectTypeOf } from "vitest";
import { testClientId } from "../../test/helpers.ts";
import { Inngest } from "../Inngest.ts";
import { createAgents } from "./agents.ts";
import { type SandboxDefinition, sandbox } from "./defs.ts";

const client = new Inngest({ id: testClientId });
const agents = createAgents(client);

const workbench = sandbox({ id: "workbench", tools: sandbox.tools.code() });
const reader = sandbox({
  id: "reader",
  tools: sandbox.tools.code({ only: ["read", "search"] }),
});
const repo = sandbox({
  id: "repo",
  tools: sandbox.tools.git({ allow: () => ({ ok: true }) } as never),
});
const bare = sandbox({ id: "bare" });

describe("sandbox names and tool names", () => {
  test("sandboxes and sandboxTools are keyed by what the config names", () => {
    agents.agent(
      {
        id: "typed-1",
        on: { cron: "0 * * * *" },
        sandboxes: {
          work: workbench,
          view: { sandbox: reader, start: "eager" },
          repo,
          bare,
        },
      },
      async ({ sandboxes, sandboxTools }) => {
        expectTypeOf(sandboxes).toHaveProperty("work");
        expectTypeOf(sandboxes).toHaveProperty("view");
        expectTypeOf(sandboxes).toHaveProperty("bare");
        expectTypeOf(sandboxTools).toHaveProperty("work_run");
        expectTypeOf(sandboxTools).toHaveProperty("work_edit");
        expectTypeOf(sandboxTools).toHaveProperty("view_read");
        expectTypeOf(sandboxTools).toHaveProperty("view_search");
        expectTypeOf(sandboxTools).toHaveProperty("repo_git_push");

        // @ts-expect-error there is no sandbox named typo
        sandboxes.typo;

        // @ts-expect-error there is no tool named typo_run
        sandboxTools.typo_run;

        // @ts-expect-error the reader brings read and search only
        sandboxTools.view_run;

        // @ts-expect-error the code tools have no tool called nope
        sandboxTools.work_nope;

        // @ts-expect-error a sandbox without tools brings none
        sandboxTools.bare_run;

        return null;
      },
    );
  });

  test("a function-valued config gives the same names", () => {
    agents.agent(
      {
        id: "typed-2",
        on: { cron: "0 * * * *" },
        sandboxes: ({ event }) => {
          return event.name ? { work: workbench } : { work: workbench };
        },
      },
      async ({ sandboxes, sandboxTools }) => {
        expectTypeOf(sandboxes).toHaveProperty("work");
        expectTypeOf(sandboxTools).toHaveProperty("work_run");

        // @ts-expect-error there is no sandbox named typo
        sandboxes.typo;

        // @ts-expect-error there is no tool named typo_run
        sandboxTools.typo_run;

        return null;
      },
    );
  });

  test("a start that is a function still sees the event and keeps its literal", () => {
    agents.agent(
      {
        id: "typed-3",
        on: { cron: "0 * * * *" },
        sandboxes: {
          work: {
            sandbox: workbench,
            start: ({ event }) => {
              return event.name === "x" ? "eager" : "lazy";
            },
          },
        },
      },
      async ({ sandboxTools }) => {
        expectTypeOf(sandboxTools).toHaveProperty("work_run");

        return null;
      },
    );
  });

  test("an agent without sandboxes has none", () => {
    agents.agent(
      { id: "typed-4", on: { cron: "0 * * * *" } },
      async ({ sandboxes, sandboxTools }) => {
        // @ts-expect-error this agent declares no sandboxes
        sandboxes.work;

        // @ts-expect-error this agent declares no sandboxes
        sandboxTools.work_run;

        return null;
      },
    );
  });

  test("run_code is typed only when the code tools are given tools to call", () => {
    const withCode = sandbox({
      id: "with-code",
      tools: sandbox.tools.code({ tools: {} }),
    });

    agents.agent(
      {
        id: "typed-5",
        on: { cron: "0 * * * *" },
        sandboxes: { work: withCode, plain: workbench },
      },
      async ({ sandboxTools }) => {
        expectTypeOf(sandboxTools).toHaveProperty("work_run_code");

        // @ts-expect-error run_code needs tools to call
        sandboxTools.plain_run_code;

        return null;
      },
    );
  });

  test("spread configs, a record in a variable and an async function infer the same", () => {
    const base = { work: workbench };
    const held = { work: workbench, view: reader };

    agents.agent(
      {
        id: "typed-6",
        on: { cron: "0 * * * *" },
        sandboxes: { ...base, view: reader },
      },
      async ({ sandboxTools }) => {
        expectTypeOf(sandboxTools).toHaveProperty("work_run");
        expectTypeOf(sandboxTools).toHaveProperty("view_read");

        // @ts-expect-error there is no tool named typo_run
        sandboxTools.typo_run;

        return null;
      },
    );
    agents.agent(
      { id: "typed-7", on: { cron: "0 * * * *" }, sandboxes: held },
      async ({ sandboxTools }) => {
        expectTypeOf(sandboxTools).toHaveProperty("view_search");

        // @ts-expect-error the reader brings read and search only
        sandboxTools.view_run;

        return null;
      },
    );
    agents.agent(
      {
        id: "typed-8",
        on: { cron: "0 * * * *" },
        sandboxes: async () => {
          return { work: workbench };
        },
      },
      async ({ sandboxTools }) => {
        expectTypeOf(sandboxTools).toHaveProperty("work_run");

        // @ts-expect-error there is no tool named typo_run
        sandboxTools.typo_run;

        return null;
      },
    );
  });

  test("a record typed as the wide record is not narrowed: names are plain strings", () => {
    const wide: Record<string, SandboxDefinition> = { work: workbench };

    agents.agent(
      { id: "typed-9", on: { cron: "0 * * * *" }, sandboxes: wide },
      async ({ sandboxes }) => {
        // Known limitation: nothing says which names exist, so any compiles.
        sandboxes.anything;

        return null;
      },
    );
  });
});
