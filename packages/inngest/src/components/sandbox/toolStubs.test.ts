/**
 * @module
 * Runs the wrapper, the stub and the waiter for real, with the local `node`,
 * against a host that answers calls the way the tool runner does.
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
      command: [
        "node",
        "-e",
        `const { tools } = require("inngest_tools");
Promise.all([tools.add(1, 2), tools.add(3, 4), tools.big()]).then((r) => console.log(r[0], r[1], r[2].length));`,
      ],
    },
  ])("$name code gets its replies, parallel and large", async ({ command }) => {
    expect(await converse(command)).toBe("3 7 100000\n");
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
