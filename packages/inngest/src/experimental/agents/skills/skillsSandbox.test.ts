/**
 * @module
 * Tests for where a skill's files go: the first sandbox the model can use,
 * after the repo checkout and before `setup`.
 */
import { vi } from "vitest";
import type {
  DurableSandbox,
  DurableSandboxTools,
} from "../../../components/sandbox/types.ts";

vi.mock("../sandboxes/gitPush.ts", () => {
  return { pushBranch: vi.fn() };
});

import {
  openSandboxes,
  type SandboxRuntime,
  sandbox,
} from "../sandboxes/defs.ts";
import type { Skill } from "./skills.ts";

const text = (value: string) => {
  return new TextEncoder().encode(value);
};

const refund: Skill = {
  name: "refund-policy",
  description: "How to decide a refund",
  body: "30 days.",
  files: [
    { path: "SKILL.md", data: text("---\n---\n30 days.") },
    { path: "check.py", data: text("print('ok')") },
  ],
};

const fakeEnvironment = () => {
  const order: string[] = [];
  const written: Record<string, string> = {};
  const idOf = (id: unknown) => {
    return typeof id === "string" ? id : (id as { id: string }).id;
  };
  const make = vi.fn(async () => {
    return {
      commands: {
        run: async (id: unknown, command: unknown) => {
          const key = idOf(id);

          order.push(key);

          return key.endsWith("repo:checkout")
            ? { stdout: "repo:cloned:abc123\n", stderr: "", exitCode: 0 }
            : { stdout: String(command), stderr: "", exitCode: 0 };
        },
      },
      files: {
        write: async (
          id: unknown,
          options: { path: string; data: string | Uint8Array },
        ) => {
          order.push(idOf(id));
          written[options.path] =
            typeof options.data === "string"
              ? options.data
              : new TextDecoder().decode(options.data);
        },
      },
      destroy: async () => {},
    } as unknown as DurableSandbox;
  });
  const runtime = {
    run: async (_id: string, fn: () => Promise<unknown>) => {
      return fn();
    },
  } as SandboxRuntime;

  return {
    order,
    written,
    runtime,
    created: make,
    sandboxes: { create: make } as unknown as DurableSandboxTools,
  };
};

describe("skill files in a sandbox", () => {
  test("a fresh sandbox gets checkout, then the skill files, then setup, and setup can read both", async () => {
    const env = fakeEnvironment();
    const work = sandbox({
      id: "work",
      repo: { url: "acme/app" },
      setup: async ({ sandbox: box }) => {
        await box.commands.run("after", ["ls", "/skills/refund-policy"]);
      },
    });
    const opened = openSandboxes(
      { work },
      env.sandboxes,
      env.runtime,
      undefined,
      [refund],
    );

    await opened.work?.commands.run("first", ["ls"]);

    const skillWrites = env.order.filter((id) => {
      return id.includes("skills");
    });

    expect(skillWrites).toHaveLength(2);
    expect(env.order.indexOf("work:repo:checkout")).toBeLessThan(
      env.order.indexOf(skillWrites[0] as string),
    );
    expect(env.order.indexOf(skillWrites[1] as string)).toBeLessThan(
      env.order.indexOf("work:setup:sandbox:after"),
    );
    expect(env.written["/skills/refund-policy/check.py"]).toBe("print('ok')");
  });

  test("files go only to the first sandbox the model can use", async () => {
    const env = fakeEnvironment();
    const hidden = sandbox({ id: "hidden" });
    const shown = sandbox({ id: "shown" });
    const other = sandbox({ id: "other" });
    const opened = openSandboxes(
      {
        hidden: { sandbox: hidden, model: false },
        shown,
        other,
      },
      env.sandboxes,
      env.runtime,
      undefined,
      [refund],
    );

    await opened.hidden?.commands.run("a", ["ls"]);
    await opened.shown?.commands.run("b", ["ls"]);
    await opened.other?.commands.run("c", ["ls"]);

    expect(env.order.filter((id) => id.includes("skills"))).toHaveLength(2);
    expect(
      env.order.every((id) => {
        return !id.includes("skills") || id.startsWith("shown:");
      }),
    ).toBe(true);
  });

  test("with no skills nothing is written", async () => {
    const env = fakeEnvironment();
    const opened = openSandboxes(
      { work: sandbox({ id: "work" }) },
      env.sandboxes,
      env.runtime,
    );

    await opened.work?.commands.run("a", ["ls"]);

    expect(Object.keys(env.written)).toEqual([]);
  });
});
