/**
 * @module
 * Type tests for an agent's sandboxes: the body knows the names of the
 * sandboxes, each has the core sandbox's commands and files, and the model's
 * tool names come from the sandbox.
 */
import { expectTypeOf } from "vitest";
import { Inngest } from "../../../components/Inngest.ts";
import type { GitPush } from "../../../components/sandbox/gitPush.ts";
import type { SandboxHandle } from "../../../components/sandbox/types.ts";
import { testClientId } from "../../../test/helpers.ts";
import { createAgents } from "../agent/agents.ts";
import * as agentsEntry from "../index.ts";
import {
  type AgentSandbox,
  type AgentSandboxWithRepo,
  type SandboxDefinition,
  type SandboxToolsOf,
  sandbox,
} from "./defs.ts";
import type { PushResult, Repo } from "./repo.ts";

const client = new Inngest({ id: testClientId });
const agents = createAgents(client);

const workbench = sandbox({ id: "workbench", tools: sandbox.tools.defaults });
const reader = sandbox({
  id: "reader",
  tools: { read: sandbox.tools.read, search: sandbox.tools.search },
});
const coder = sandbox({
  id: "coder",
  tools: {
    run: sandbox.tools.run,
    read: sandbox.tools.read,
    search: sandbox.tools.search,
    edit: sandbox.tools.edit,
  },
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

        // The tools are public, to lend to a child.
        expectTypeOf(sandboxes.work.tools).toBeObject();

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
      work: { run: typeof sandbox.tools.run };
      view: {
        read: typeof sandbox.tools.read;
        search: typeof sandbox.tools.search;
      };
    }>;

    expectTypeOf<Names>().toEqualTypeOf<
      "work_run" | "view_read" | "view_search"
    >();
  });
});

describe("sandbox: the code tools are run, run_code, read, search and edit", () => {
  test("the default is run, and run_code appears only with tools to call", () => {
    type ToolNames<T> = T extends SandboxDefinition<infer R> ? keyof R : never;

    expectTypeOf<ToolNames<typeof workbench>>().toEqualTypeOf<"run">();
    expectTypeOf<ToolNames<typeof reader>>().toEqualTypeOf<"read" | "search">();
    expectTypeOf<ToolNames<typeof coder>>().toEqualTypeOf<
      "run" | "read" | "search" | "edit"
    >();
    const withCode = sandbox({
      id: "c",
      tools: { run: sandbox.tools.run, runCode: sandbox.tools.runCode },
    });
    expectTypeOf<ToolNames<typeof withCode>>().toEqualTypeOf<
      "run" | "runCode"
    >();
    expectTypeOf<ToolNames<typeof bare>>().toEqualTypeOf<"run">();
  });

  test("write is a built-in tool, not a default", () => {
    expectTypeOf(sandbox.tools.write).not.toBeAny();
    expectTypeOf(sandbox.tools.defaults).toEqualTypeOf<{
      run: typeof sandbox.tools.run;
    }>();
  });
});

describe("sandbox: a definition takes id, image, size, tools, repo and setup", () => {
  test("the options", () => {
    sandbox({
      id: "full",
      image: sandbox.image.custom("py:v1"),
      vcpu: 2,
      memoryMb: 1024,
      tools: sandbox.tools.defaults,
      repo: { url: "acme/app", ref: "main", path: "/src" },
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

  test("the git names are gone", () => {
    expectTypeOf(agentsEntry).not.toHaveProperty("repo");
    expectTypeOf(agentsEntry).not.toHaveProperty("gitPushTool");
    expectTypeOf(agentsEntry).not.toHaveProperty("pushBranch");
    expectTypeOf(agentsEntry).not.toHaveProperty("commitFiles");
    expectTypeOf(agentsEntry).not.toHaveProperty("PushBranchResult");
    expectTypeOf(agentsEntry).not.toHaveProperty("CommitFilesOptions");

    // @ts-expect-error sandbox.tools.git() was deleted
    sandbox.tools.git;
  });
});

const withRepo = sandbox({
  id: "with-repo",
  tools: sandbox.tools.defaults,
  repo: { url: "acme/app", auth: { read: () => "r", write: () => "w" } },
});
const readOnly = sandbox({
  id: "read-only",
  tools: sandbox.tools.defaults,
  repo: { url: "acme/app", push: false },
});

describe("sandbox: sandboxes.work.repo exists only when the definition has a repo", () => {
  test("repo is on the handle of a sandbox with one", () => {
    agents.agent(
      {
        id: "typed-repo-1",
        triggers: { cron: "0 * * * *" },
        sandboxes: { code: withRepo, ro: readOnly, plain: workbench },
      },
      async ({ sandboxes }) => {
        expectTypeOf(sandboxes.code).toEqualTypeOf<AgentSandboxWithRepo>();
        expectTypeOf(sandboxes.ro).toEqualTypeOf<AgentSandboxWithRepo>();
        expectTypeOf(sandboxes.code.repo).toEqualTypeOf<Repo>();

        // @ts-expect-error a sandbox without a repo has no repo
        sandboxes.plain.repo;

        return null;
      },
    );
  });

  test("a function-valued repo counts as a repo", () => {
    const reviewer = sandbox({
      id: "reviewer",
      repo: ({ event }) => {
        return { url: `acme/${event.name}` };
      },
    });

    agents.agent(
      {
        id: "typed-repo-2",
        triggers: { cron: "0 * * * *" },
        sandboxes: { code: reviewer },
      },
      async ({ sandboxes }) => {
        expectTypeOf(sandboxes.code.repo).toEqualTypeOf<Repo>();

        return null;
      },
    );
  });
});

describe("sandbox: repo.push returns one success result", () => {
  test("PushResult is the branch, the sha and the notes", () => {
    expectTypeOf<Repo["push"]>().toEqualTypeOf<
      (branch: string) => Promise<PushResult>
    >();
    expectTypeOf<PushResult>().toEqualTypeOf<{
      branch: string;
      sha: string;
      notes: string[];
    }>();
  });
});

describe("sandbox: work_push takes a branch and gives a push result", () => {
  test("the push tool is named after the sandbox, unless push is false", () => {
    type Names = keyof SandboxToolsOf<{
      code: typeof withRepo extends SandboxDefinition<infer T> ? T : never;
      ro: typeof readOnly extends SandboxDefinition<infer T> ? T : never;
    }>;

    expectTypeOf<Names>().toEqualTypeOf<"code_run" | "code_push" | "ro_run">();
  });
});

describe("sandbox: a repo policy gets the push and may refuse", () => {
  test("policy sees branch, commits and paths", () => {
    sandbox({
      id: "policed",
      repo: {
        url: "acme/app",
        policy: (push) => {
          expectTypeOf(push).toEqualTypeOf<GitPush>();
          expectTypeOf(push.branch).toEqualTypeOf<string | undefined>();
          expectTypeOf(push.commits).toBeArray();
          expectTypeOf(push.paths).toBeArray();

          return push.branch?.startsWith("agent/")
            ? { notes: ["ok"] }
            : { refuse: "name it agent/..." };
        },
      },
    });
  });

  test("repo takes no sync", () => {
    // @ts-expect-error the existing checkout is left alone; there is no sync
    sandbox({
      id: "synced",
      repo: { url: "acme/app", sync: "keep" },
    });
  });
});
