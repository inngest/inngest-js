/**
 * @module
 * Runs the wrapper, the stubs and the waiter for real, with the local `node`
 * and `python3` (the Python cases are skipped when there is none), against a
 * host that answers calls the way the tool runner does.
 */
import { spawn, spawnSync } from "node:child_process";
import {
  appendFileSync,
  mkdtempSync,
  readFileSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, test } from "vitest";
import { toolsRoot, waiterScript, wrapperScript } from "./toolStubs.ts";
import { parseToolEvent } from "./tools.ts";

const root = mkdtempSync(join(tmpdir(), "tool-stubs-"));
let count = 0;

const hasPython = spawnSync("python3", ["--version"]).status === 0;

const sh = (
  script: string,
  args: string[],
  env: Record<string, string> = {},
) => {
  return spawnSync("/bin/sh", ["-c", script, "sh", ...args], {
    encoding: "utf8",
    env: { ...process.env, ...env },
  });
};

const reply = (id: number, result: unknown, tool?: string): string => {
  return JSON.stringify({ op: "reply", id, result, ...(tool && { tool }) });
};

/**
 * Runs `command` under the wrapper, answering each call (`big` returns 100 KB,
 * the rest add their arguments) until the waiter reports the exit.
 */
const converse = async (command: string[]) => {
  const dir = join(root, `run-${count++}`);
  const wrapper = wrapperScript.replaceAll(toolsRoot, root);
  const child = spawn("/bin/sh", ["-c", wrapper, "sh", dir, ...command]);
  let lines = 0;
  let replies: string[] = [];

  for (let round = 0; round < 20; round++) {
    const waited = sh(waiterScript, [dir, `${lines}`, "10", ...replies]);
    const log = waited.stdout.split("\n").slice(0, -1);
    lines += log.length;
    replies = [];

    for (const line of log) {
      const event = parseToolEvent(line);
      if (event?.op === "exit") {
        child.kill();

        return Buffer.from(event.stdout, "base64").toString();
      }

      if (event?.op === "call") {
        if (event.tool === "big") {
          const file = join(dir, `reply.${event.id}`);
          writeFileSync(file, `${reply(event.id, "x".repeat(100_000))}\n`);
          replies.push(`@${file}`);
        } else {
          const sum = (event.args as number[]).reduce((a, b) => a + b, 0);
          replies.push(reply(event.id, sum));
        }
      }
    }
  }

  throw new Error("the command never exited");
};

describe("the stubs, wrapper and waiter", () => {
  test.each([
    {
      name: "node",
      runnable: true,
      command: [
        "node",
        "-e",
        `const { tools } = require("inngest_tools");
Promise.all([tools.add(1, 2), tools.add(3, 4), tools.big()]).then((r) => console.log(r[0], r[1], r[2].length));`,
      ],
    },
    {
      name: "python",
      runnable: hasPython,
      command: [
        "python3",
        "-c",
        `import asyncio
from inngest_tools import tools


async def main():
    a, b, c = await asyncio.gather(tools.add(1, 2), tools.add(3, 4), tools.big())
    print(a, b, len(c))


asyncio.run(main())`,
      ],
    },
  ])(
    "$name code gets its replies, parallel and large",
    async ({ runnable, command }) => {
      if (!runnable) {
        return;
      }

      expect(await converse(command)).toBe("3 7 100000\n");
    },
  );
});

/**
 * Runs one segment of `command` as the tool runner does for tools that wait:
 * `pause` is answered with a yield, `add` with the sum. Returns the exit
 * code, the stdout and the reply to every call that was answered, in order.
 */
const segment = async (command: string[], journal: string[]) => {
  const dir = join(root, `run-${count++}`);
  const path = `${dir}.journal`;
  const wrapper = wrapperScript.replaceAll(toolsRoot, root);

  writeFileSync(path, journal.map((line) => `${line}\n`).join(""));

  const child = spawn("/bin/sh", ["-c", wrapper, "sh", dir, ...command], {
    env: { ...process.env, INNGEST_TOOLS_JOURNAL: path },
  });
  const answered: string[] = [];
  let lines = 0;
  let replies: string[] = [];

  for (let round = 0; round < 20; round++) {
    const waited = sh(waiterScript, [dir, `${lines}`, "10", ...replies]);
    const log = waited.stdout.split("\n").slice(0, -1);
    lines += log.length;
    replies = [];

    for (const line of log) {
      const event = parseToolEvent(line);
      if (event?.op === "exit") {
        child.kill();

        return {
          code: event.code,
          stdout: Buffer.from(event.stdout, "base64").toString(),
          answered,
        };
      }

      if (event?.op === "call" && event.tool === "pause") {
        replies.push(
          JSON.stringify({ op: "reply", id: event.id, yield: true }),
        );
      } else if (event?.op === "call") {
        const sum = (event.args as number[]).reduce((a, b) => a + b, 0);
        answered.push(reply(event.id, sum, "add"));
        replies.push(reply(event.id, sum));
      }
    }
  }

  throw new Error("the command never exited");
};

describe("a tool that waits", () => {
  test.each([
    {
      name: "node",
      runnable: true,
      command: [
        "node",
        "-e",
        `const { tools } = require("inngest_tools");
(async () => {
  const a = await tools.add(1, 2);
  console.log("before", a);
  await tools.pause();
  const b = await tools.add(a, 4);
  console.log("after", b);
})();`,
      ],
    },
    {
      name: "python",
      runnable: hasPython,
      command: [
        "python3",
        "-c",
        `import asyncio
from inngest_tools import tools


async def main():
    a = await tools.add(1, 2)
    print("before", a)
    await tools.pause()
    b = await tools.add(a, 4)
    print("after", b)


asyncio.run(main())`,
      ],
    },
  ])(
    "$name code exits 75 at the call, then replays the journal",
    async ({ runnable, command }) => {
      if (!runnable) {
        return;
      }

      const first = await segment(command, []);

      expect(first.code).toBe(75);
      expect(first.stdout).toBe("before 3\n");

      // The host runs pause and journals its result
      const journal = [...first.answered, reply(2, "rested", "pause")];
      const second = await segment(command, journal);

      expect(second.code).toBe(0);
      expect(second.stdout).toBe("before 3\nafter 7\n");
      // Only the call after the journal went home
      expect(second.answered).toEqual([reply(1, 7, "add")]);
    },
  );
});

describe("a replay that makes a different call", () => {
  test("fails with a ToolError instead of taking another call's reply", async () => {
    const run = await segment(
      [
        "node",
        "-e",
        `require("inngest_tools").tools.add(1, 2).catch((error) => console.log(error.name));`,
      ],
      [reply(1, 99, "other")],
    );

    expect(run.stdout).toBe("ToolError\n");
  });
});

describe("the wrapper", () => {
  test("a repeated start exits at once and runs the command only once", () => {
    const dir = join(root, `run-${count++}`);
    const wrapper = wrapperScript.replaceAll(toolsRoot, root);
    const marks = join(root, `marks-${count++}`);
    const start = () => {
      return spawnSync(
        "/bin/sh",
        ["-c", wrapper, "sh", dir, "/bin/sh", "-c", `echo ran >> ${marks}`],
        { encoding: "utf8" },
      );
    };

    expect(start().status).toBe(0);
    expect(start().status).toBe(0);
    expect(readFileSync(marks, "utf8")).toBe("ran\n");
    expect(readFileSync(join(dir, "ops.log"), "utf8").split("\n")).toEqual([
      '{"op":"exit","code":0,"stdout":"","stderr":""}',
      "",
    ]);
  });
});

describe("the waiter", () => {
  const call = '{"op":"call","id":1,"tool":"t","args":[]}';

  test.each([
    {
      name: "ends soon after a request lands",
      append: `${call}\n`,
      seconds: 10,
      ends: (ms: number) => ms < 5000,
      printed: call,
    },
    {
      name: "keeps waiting past the replies it appended itself",
      append: undefined,
      seconds: 1,
      ends: (ms: number) => ms >= 900,
      printed: reply(1, 2),
    },
  ])("$name", async ({ append, seconds, ends, printed }) => {
    const dir = join(root, `waiter-${count++}`);
    const inline = append === undefined ? [reply(1, 2)] : [];
    const start = Date.now();
    const waiter = spawn(
      "/bin/sh",
      ["-c", waiterScript, "sh", dir, "0", `${seconds}`, ...inline],
      { stdio: ["ignore", "pipe", "ignore"] },
    );
    let stdout = "";
    waiter.stdout.on("data", (chunk) => {
      stdout += chunk;
    });

    if (append) {
      await new Promise((resolve) => setTimeout(resolve, 300));
      appendFileSync(join(dir, "ops.log"), append);
    }

    await new Promise((resolve) => waiter.on("close", resolve));

    expect(ends(Date.now() - start)).toBe(true);
    expect(stdout.trim().split("\n")).toContain(printed);
  });
});

describe("request ids", () => {
  test("two interpreters in one command never share an id", async () => {
    const dir = join(root, `run-${count++}`);
    const wrapper = wrapperScript.replaceAll(toolsRoot, root);
    const worker = `const { tools } = require("inngest_tools"); tools.t().then(() => {});`;
    const child = spawn("/bin/sh", [
      "-c",
      wrapper,
      "sh",
      dir,
      "/bin/sh",
      "-c",
      `node -e '${worker}' & node -e '${worker}' & wait`,
    ]);
    const ids = new Set<number>();

    for (let tries = 0; tries < 100 && ids.size < 2; tries++) {
      await new Promise((resolve) => setTimeout(resolve, 50));

      try {
        for (const line of readFileSync(join(dir, "ops.log"), "utf8").split(
          "\n",
        )) {
          const event = parseToolEvent(line);
          if (event?.op === "call") {
            ids.add(event.id);
          }
        }
      } catch {}
    }

    child.kill();

    expect(ids.size).toBe(2);
  });
});
