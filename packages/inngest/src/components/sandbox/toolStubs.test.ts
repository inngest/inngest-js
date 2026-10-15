/**
 * @module
 * Runs the wrapper, the stubs and the waiter for real, with the local `node`
 * and `python3` (the Python cases are skipped when there is none), against a
 * host that answers calls the way the tool runner does.
 */
import { spawn, spawnSync } from "node:child_process";
import { mkdtempSync, writeFileSync } from "node:fs";
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

const reply = (id: number, result: unknown): string => {
  return JSON.stringify({ op: "reply", id, result });
};

/**
 * Runs `command` under the wrapper, answering each call (`big` returns 100 KB,
 * the rest add their arguments) until the waiter reports the exit.
 */
const converse = async (command: string[]) => {
  const dir = join(root, `run-${count++}`);
  const wrapper = wrapperScript.replaceAll(toolsRoot, root);
  const child = spawn("/bin/sh", ["-c", wrapper, "sh", ...command], {
    env: { ...process.env, INNGEST_TOOLS_DIR: dir },
  });
  let lines = 0;
  let replies: string[] = [];

  for (let round = 0; round < 20; round++) {
    const waited = sh(waiterScript, [dir, `${lines}`, "10", ...replies]);
    const log = waited.stdout.split("\n").slice(0, -1);
    lines += log.length;
    replies = [];

    for (const line of log) {
      const event = parseToolEvent(line);
      if (event?.op === "output") {
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
