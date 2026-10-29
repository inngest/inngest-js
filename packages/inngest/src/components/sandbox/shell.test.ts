/**
 * @module
 * Tests for `sandbox.shell()`. Commands run for real on this machine through
 * `/bin/sh`, so the script that carries a session's directory and environment
 * between commands is the one a sandbox would run.
 */

import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, realpathSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { getCommandError } from "./commandError.ts";
import { createFakeClient, groupFunction, runAll } from "./dollar-fixtures.ts";
import type { DurableSandbox } from "./types.ts";

const root = realpathSync(mkdtempSync(path.join(tmpdir(), "ingest-shell-")));

mkdirSync(path.join(root, "app", "pkg"), { recursive: true });

/**
 * A client whose commands run on this machine, in the directory and with the
 * environment the request names.
 */
const realClient = () => {
  return createFakeClient((text, _count, request) => {
    const ran = spawnSync("/bin/sh", ["-c", text], {
      cwd: request.cwd ?? root,
      env: {
        PATH: process.env.PATH ?? "",
        NODE_ENV: "test",
        ...request.environment,
      },
      encoding: "utf8",
    });

    return {
      stdout: ran.stdout,
      stderr: ran.stderr,
      exitCode: ran.status ?? 1,
    };
  });
};

const app = path.join(root, "app");

describe("sandbox.shell()", () => {
  test("cd carries to the commands called after it", async () => {
    const { client } = realClient();
    const fn = groupFunction(client, async (sandbox) => {
      const sh = sandbox.shell({ cwd: root });

      await sh.$`cd app`;
      await sh.$`cd pkg`;

      return [await sh.$`pwd`.text(), sh.cwd];
    });

    const { result } = await runAll(fn);
    const pkg = path.join(app, "pkg");

    expect(result).toMatchObject({ data: [pkg, pkg] });
  });

  test("exports carry, and an unset removes a variable", async () => {
    const { client } = realClient();
    const fn = groupFunction(client, async (sandbox) => {
      const sh = sandbox.shell({ cwd: root, env: { KEPT: "1" } });

      await sh.$.sh`export A="two words"`;
      await sh.$.sh`export B=2`;

      const seen = await sh.$.sh`echo "$A|$B|$KEPT"`.text();

      await sh.$.sh`unset A`;

      return [seen, await sh.$.sh`echo "[$A]"`.text(), sh.env];
    });

    const { result } = await runAll(fn);

    expect(result).toMatchObject({
      data: ["two words|2|1", "[]", { KEPT: "1", B: "2" }],
    });
  });

  test("unexported variables stay in their command, and output is clean", async () => {
    const { client } = realClient();
    const fn = groupFunction(client, async (sandbox) => {
      const sh = sandbox.shell({ cwd: root });

      await sh.$.sh`LOCAL=1`;

      return [
        await sh.$.sh`echo "[$LOCAL]"`.text(),
        (await sh.$.sh`printf 'no newline'`).stdout,
      ];
    });

    const { result } = await runAll(fn);

    expect(result).toMatchObject({ data: ["[]", "no newline"] });
  });

  test("a call's options override one command and do not move the session", async () => {
    const { client } = realClient();
    const fn = groupFunction(client, async (sandbox) => {
      const sh = sandbox.shell({ cwd: root });

      const own = await sh.$({ cwd: app, env: { X: "1" } })
        .sh`echo "$X"; pwd`.text();

      return [own, await sh.$`pwd`.text(), sh.cwd, sh.env];
    });

    const { result } = await runAll(fn);

    expect(result).toMatchObject({
      data: [`1\n${app}`, root, root, {}],
    });
  });

  test("commands called together start from the same state and run in parallel", async () => {
    const { client } = realClient();
    const fn = groupFunction(client, async (sandbox) => {
      const sh = sandbox.shell({ cwd: root });

      const [one, two] = await Promise.all([
        sh.$.sh`cd app; export A=1; pwd`.text(),
        sh.$.sh`export B=2; pwd`.text(),
      ]);

      return [one, two, sh.cwd, sh.env];
    });

    const { result } = await runAll(fn);

    expect(result).toMatchObject({
      data: [app, root, app, { A: "1", B: "2" }],
    });
  });

  test("a failed command throws without its report, and leaves the state", async () => {
    const { client } = realClient();
    const fn = groupFunction(client, async (sandbox) => {
      const sh = sandbox.shell({ cwd: root });

      const error = await sh.$.sh`cd app; echo out; echo err >&2; exit 3`.catch(
        (caught: unknown) => {
          return getCommandError(caught);
        },
      );

      return [error, sh.cwd];
    });

    const { result } = await runAll(fn);
    const [error, cwd] = (result as { data: [Record<string, unknown>, string] })
      .data;

    expect(error).toMatchObject({
      type: "failed",
      exitCode: 3,
      stdoutTail: "out\n",
      stderrTail: "err\n",
    });
    expect(String(error.command)).toBe(
      "cd app; echo out; echo err >&2; exit 3",
    );
    expect(cwd).toBe(root);
  });

  test("exit inside an allowed command still reports where it ended", async () => {
    const { client } = realClient();
    const fn = groupFunction(client, async (sandbox) => {
      const sh = sandbox.shell({ cwd: root });

      await sh.$({ exitCodes: [0, 2] }).sh`cd app; exit 2`;

      return sh.cwd;
    });

    const { result } = await runAll(fn);

    expect(result).toMatchObject({ data: app });
  });

  test("a replay rebuilds the state from memoized results", async () => {
    const { client, execs } = realClient();
    const fn = groupFunction(client, async (sandbox) => {
      const sh = sandbox.shell({ cwd: root });

      await sh.$`cd app`;
      await sh.$.sh`export A=1`;

      return sh.$.sh`echo "$A"; pwd`.text();
    });

    const { result } = await runAll(fn);

    expect(result).toMatchObject({ data: `1\n${app}` });

    // The function ran in several requests, each replaying the earlier
    // commands; each command still ran on the sandbox exactly once.
    expect(execs).toHaveLength(3);
  });

  test("a cwd option that the shell reports differently does not move the session", async () => {
    const { client } = realClient();
    const fn = groupFunction(client, async (sandbox) => {
      const sh = sandbox.shell({ cwd: root });

      await sh.$({ cwd: `${app}/` }).sh`true`;

      return [sh.cwd, sh.env];
    });

    const { result } = await runAll(fn);

    expect(result).toMatchObject({ data: [root, {}] });
  });

  test("the environment is never in a command's output", async () => {
    const { client } = realClient();
    const fn = groupFunction(client, async (sandbox) => {
      const sh = sandbox.shell({ cwd: root, env: { SECRET_TOKEN: "hunter2" } });

      return (await sh.$.sh`echo hi`).stdout;
    });

    const { result, steps } = await runAll(fn);

    expect(result).toMatchObject({ data: "hi\n" });
    expect(JSON.stringify(steps)).not.toContain("hunter2");
  });

  test("a value with newlines, a changed PATH, set -a all report cleanly", async () => {
    const { client } = realClient();
    const fn = groupFunction(client, async (sandbox) => {
      const sh = sandbox.shell({ cwd: root });

      await sh.$.sh`export A="l1
B=evil
l3"`;
      await sh.$.sh`set -a; echo hi`;

      await sh.$.sh`cd app`;
      await sh.$.sh`export PATH=/nonexistent`;

      return [sh.env.A, "B" in sh.env, Object.keys(sh.env).sort(), sh.cwd];
    });

    const { result } = await runAll(fn);

    expect(result).toMatchObject({
      data: ["l1\nB=evil\nl3", false, ["A", "PATH"], app],
    });
  });

  test("of commands called together, the one called last wins, whichever finishes last", async () => {
    const { client } = realClient();
    const fn = groupFunction(client, async (sandbox) => {
      const sh = sandbox.shell({ cwd: root });

      await Promise.all([
        sh.$.sh`export X=1; cd app`,
        sh.$.sh`export X=2`,
        sh.$.sh`export X=3; cd app/pkg`,
      ]);

      return [sh.env.X, sh.cwd];
    });

    const { result } = await runAll(fn);

    expect(result).toMatchObject({ data: ["3", path.join(app, "pkg")] });
  });

  test("the commands a session runs are named after what was written", async () => {
    const { client } = realClient();
    const fn = groupFunction(client, async (sandbox) => {
      const sh = sandbox.shell({ cwd: root });

      await sh.$`cd app`;
    });

    const { ran } = await runAll(fn);

    expect(ran).toContain("cd app");
  });
});

describe("sandbox.tools.code() run", () => {
  const call = (tools: ReturnType<DurableSandbox["tools"]["code"]>) => {
    const ctx = { signal: new AbortController().signal, idempotencyKey: "k" };
    const run = tools.run.run as (
      input: unknown,
      ctx: unknown,
    ) => Promise<string>;

    return (command: string) => {
      return run({ command }, ctx);
    };
  };

  test("keeps cd and export between calls, and says where it moved", async () => {
    const { client } = realClient();
    const fn = groupFunction(client, async (sandbox) => {
      const run = call(sandbox.tools.code({ cwd: root }));

      return [
        await run("cd app"),
        await run("export A=1"),
        await run('echo "$A"; pwd'),
        await run("pwd"),
      ];
    });

    const { result } = await runAll(fn);

    expect(result).toMatchObject({
      data: [
        `exit 0\n\ncwd: ${app}`,
        "exit 0\n",
        `exit 0\n1\n${app}\n`,
        `exit 0\n${app}\n`,
      ],
    });
  });

  test("session: false starts every command fresh", async () => {
    const { client } = realClient();
    const fn = groupFunction(client, async (sandbox) => {
      const run = call(sandbox.tools.code({ cwd: root, session: false }));

      await run("cd app");

      return run("pwd");
    });

    const { result } = await runAll(fn);

    expect(result).toMatchObject({ data: `exit 0\n${root}\n` });
  });

  test("a failing command is a result the model sees, and still moves the session", async () => {
    const { client } = realClient();
    const fn = groupFunction(client, async (sandbox) => {
      const run = call(sandbox.tools.code({ cwd: root }));

      return [await run("cd app && false"), await run("pwd")];
    });

    const { result } = await runAll(fn);

    expect(result).toMatchObject({
      data: [`exit 1\n\ncwd: ${app}`, `exit 0\n${app}\n`],
    });
  });
});
