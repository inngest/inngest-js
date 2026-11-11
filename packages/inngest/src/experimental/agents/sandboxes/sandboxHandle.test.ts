/**
 * @module
 * Tests for what a listed sandbox gives the model (its tools) and the handler
 * (its handle): created lazily, shared, and left out of the model's list by
 * `model: false`.
 */
import { describe, expect, test, vi } from "vitest";
import type {
  DurableSandbox,
  DurableSandboxTools,
} from "../../../components/sandbox/types.ts";
import { openSandboxes, sandbox, sandboxTools } from "./defs.ts";

const fakeEnvironment = () => {
  const runs: string[] = [];
  const created = vi.fn(async (_id: unknown, _options: unknown) => {
    return {
      commands: {
        run: async (_id: unknown, command: unknown) => {
          runs.push(String(command));

          return { stdout: "ok", stderr: "", exitCode: 0 };
        },
      },
      files: {
        read: async () => {
          return new Uint8Array();
        },
        write: async () => {},
      },
      destroy: async () => {},
    } as unknown as DurableSandbox;
  });

  return {
    runs,
    created,
    sandboxes: { create: created } as unknown as DurableSandboxTools,
  };
};

const work = sandbox({ id: "work", tools: sandbox.tools.defaults });

describe("a listed sandbox gives the model its tools", () => {
  test("every listed sandbox adds <sandbox>_<tool> tools and starts nothing", () => {
    const env = fakeEnvironment();
    const opened = openSandboxes({ work }, env.sandboxes);

    expect(Object.keys(sandboxTools(opened))).toEqual(["work_run"]);
    expect(env.created).not.toHaveBeenCalled();
  });

  test("model: false keeps the sandbox for code only", () => {
    const env = fakeEnvironment();
    const opened = openSandboxes(
      { work: { sandbox: work, model: false } },
      env.sandboxes,
    );

    expect(sandboxTools(opened)).toEqual({});
    expect(opened.work).toBeDefined();
  });
});

describe("the handler's handle", () => {
  test("commands and files open the sandbox on first use, once", async () => {
    const env = fakeEnvironment();
    const opened = openSandboxes({ work }, env.sandboxes);
    const handle = opened.work;

    expect(env.created).not.toHaveBeenCalled();

    await Promise.all([
      handle?.commands.run("a", ["echo", "1"]),
      handle?.commands.run("b", ["echo", "2"]),
    ]);
    await handle?.files.read("r", "/work/a");

    expect(env.created).toHaveBeenCalledTimes(1);
    expect(env.runs).toEqual(["echo,1", "echo,2"]);
  });
});

describe("the default cwd", () => {
  const start = (definition: Record<string, unknown>) => {
    const env = fakeEnvironment();
    const made = sandbox(definition as { id: string; repo: { url: string } });

    return openSandboxes({ s: made }, env.sandboxes).s;
  };

  test("a sandbox with no repo and no cwd starts in /tmp, which every image has", () => {
    expect(start({ id: "s" })?.cwd).toBe("/tmp");
  });

  test("a sandbox with a repo starts in /work", () => {
    expect(start({ id: "s", repo: { url: "acme/app" } })?.cwd).toBe("/work");
  });

  test("a repo's own path is where the sandbox starts", () => {
    expect(
      start({ id: "s", repo: { url: "acme/app", path: "/src/app" } })?.cwd,
    ).toBe("/src/app");
  });

  test("an explicit cwd wins without a repo", () => {
    expect(start({ id: "s", cwd: "/srv" })?.cwd).toBe("/srv");
  });
});
