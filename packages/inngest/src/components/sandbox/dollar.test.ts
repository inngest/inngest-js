/**
 * @module
 * Tests for the `$` spike: a bare `$` bound to its `group.sandbox()`, and the
 * step IDs of commands that repeat.
 */

import { runFnWithStack } from "../../test/helpers.ts";
import type { OutgoingOp } from "../../types.ts";
import type { InngestFunction } from "../InngestFunction.ts";
import { $ } from "./dollar.ts";
import { createClient, sandboxResource } from "./test-helpers.ts";

const ids = {
  one: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
  two: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb",
};

type Exec = { sandbox: string; command: string[] };

/**
 * A client with two sandboxes, named for the order they are created in. Every
 * command prints its own text and how many times that exact command has run,
 * so a result can only come from the command (and the order) that made it.
 */
const createFakeClient = () => {
  const execs: Exec[] = [];
  const counts = new Map<string, number>();
  const creates: string[] = [];

  const client = createClient((path, method, { body }) => {
    if (path === "/v2/sandboxes" && method === "POST") {
      const { name } = JSON.parse(String(body)) as { name: string };
      const id = creates.length === 0 ? ids.one : ids.two;

      creates.push(name);

      return Response.json(
        { data: { ...sandboxResource, id, name } },
        { status: 201 },
      );
    }

    const exec = /^\/v2\/sandboxes\/([^/]+)\/exec$/.exec(path);

    if (exec) {
      const { command } = JSON.parse(String(body)) as { command: string[] };
      const key = `${exec[1]}:${command.join(" ")}`;
      const count = (counts.get(key) ?? 0) + 1;

      counts.set(key, count);
      execs.push({ sandbox: exec[1]!, command });

      return Response.json({
        data: {
          stdout: btoa(`${command.join(" ")}#${count}`),
          stderr: "",
          encoding: "base64",
          exitCode: 0,
        },
      });
    }

    if (method === "DELETE") {
      return new Response(null, { status: 204 });
    }

    const get = /^\/v2\/sandboxes\/([^/]+)$/.exec(path);

    if (get && method === "GET") {
      return Response.json({ data: { ...sandboxResource, id: get[1] } });
    }

    return undefined;
  });

  return { client, execs };
};

/**
 * Run `fn` request by request, running whatever steps each request finds, and
 * return the IDs that ran in order with how the function ended.
 */
const runAll = async (fn: InngestFunction.Any) => {
  const ran: string[] = [];
  const hashed: string[] = [];
  let stepState: Parameters<typeof runFnWithStack>[1] = {};

  const memoize = (step: OutgoingOp) => {
    ran.push(step.userland?.id ?? step.id);
    hashed.push(step.id);
    stepState = {
      ...stepState,
      [step.id]: step.error
        ? { id: step.id, error: step.error }
        : { id: step.id, data: step.data },
    };
  };

  for (let request = 0; request < 40; request++) {
    const result = await runFnWithStack(fn, stepState);

    if (result.type === "step-ran") {
      memoize(result.step);
    } else if (result.type === "steps-found") {
      for (const found of result.steps) {
        const ran = await runFnWithStack(fn, stepState, {
          runStep: found.id,
        });

        if (ran.type === "step-ran") {
          memoize(ran.step);
        }
      }
    } else {
      return { ran, hashed, result };
    }
  }

  throw new Error("The function did not finish");
};

describe("$", () => {
  test("a bare $ runs in the sandbox of its group, and sb.$ in its own", async () => {
    const { client, execs } = createFakeClient();
    const fn = client.createFunction(
      { id: "dollar-bare", triggers: [{ event: "dollar/run" }] },
      async ({ group }) => {
        return group.sandbox("box", async (sandbox) => {
          const bare = await $`echo bare`.text();
          const bound = await sandbox.$`echo bound`.text();
          const sh = await $.sh`echo ${"it's"} | cat`.text();
          const configured = await $({ cwd: "/work", env: { A: "1" } })`pwd`;

          return [bare, bound, sh, configured.stdout];
        });
      },
    );

    const { result } = await runAll(fn);

    expect(result.type).toBe("function-resolved");
    expect(result).toMatchObject({
      data: [
        "echo bare#1",
        "echo bound#1",
        "/bin/sh -c echo 'it'\\''s' | cat#1",
        "pwd#1",
      ],
    });
    expect(execs.every((exec) => exec.sandbox === ids.one)).toBe(true);
  });

  test("parallel groups each bind their own sandbox", async () => {
    const { client, execs } = createFakeClient();
    const fn = client.createFunction(
      { id: "dollar-parallel-groups", triggers: [{ event: "dollar/run" }] },
      async ({ group }) => {
        return Promise.all([
          group.sandbox("one", () => {
            return $`echo same`.text();
          }),
          group.sandbox("two", () => {
            return $`echo same`.text();
          }),
        ]);
      },
    );

    const { result } = await runAll(fn);

    expect(result).toMatchObject({ type: "function-resolved" });
    // Each sandbox ran the command once, so each got its own `#1`.
    expect(result).toMatchObject({ data: ["echo same#1", "echo same#1"] });
    expect(execs.map((exec) => exec.sandbox).sort()).toEqual(
      [ids.one, ids.two].sort(),
    );
  });

  test("commands planned together get stable IDs, and each result is its own", async () => {
    const { client } = createFakeClient();
    const fn = client.createFunction(
      { id: "dollar-repeats", triggers: [{ event: "dollar/run" }] },
      async ({ group }) => {
        return group.sandbox("box", async () => {
          return Promise.all([
            $`echo a`.text(),
            $`echo a`.text(),
            $`echo b`.text(),
            $({ id: "named" })`echo a`.text(),
          ]);
        });
      },
    );

    const { ran, hashed, result } = await runAll(fn);

    expect(result).toMatchObject({
      type: "function-resolved",
      data: ["echo a#1", "echo a#2", "echo b#1", "echo a#3"],
    });
    expect(ran.slice().sort()).toEqual(
      ["box", "box:destroy", "echo a", "echo a", "echo b", "named"].sort(),
    );
    expect(new Set(hashed).size).toBe(hashed.length);
  });

  test("repeats in order get the same IDs on replay", async () => {
    const build = () => {
      return createFakeClient().client.createFunction(
        { id: "dollar-sequential", triggers: [{ event: "dollar/run" }] },
        async ({ group }) => {
          return group.sandbox("box", async () => {
            return [await $`echo a`.text(), await $`echo a`.text()];
          });
        },
      );
    };

    const first = await runAll(build());
    const again = await runAll(build());

    expect(first.result).toMatchObject({ data: ["echo a#1", "echo a#2"] });
    expect(first.ran).toEqual(["box", "echo a", "echo a", "box:destroy"]);
    expect(new Set(first.hashed).size).toBe(4);
    expect(again.hashed).toEqual(first.hashed);
  });

  test("throws a clear error outside a group", () => {
    expect(() => {
      return $`echo hi`;
    }).toThrow(/outside `group.sandbox\(\)`/);
  });
});
