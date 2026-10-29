/**
 * Tests of a job's shell state: `cd` and `export` in one command apply to the
 * commands called after it, the way they do in a terminal, and a command's
 * own `cwd` and `env` apply to it alone. Commands run for real on this
 * machine, through the same report script a sandbox would run.
 *
 * @module
 */

import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, realpathSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, test } from "vitest";
import { consoleReporter } from "../github/auth.ts";
import { createCi } from "../pipeline/createCi.ts";
import { createCiTestClient } from "../testing/client.ts";
import { prEvent, prTrigger } from "../testing/events.ts";
import { createFakeSandboxApi } from "../testing/fakeSandbox.ts";
import { runFunction } from "../testing/runFunction.ts";
import { $ } from "./command.ts";

const root = realpathSync(mkdtempSync(join(tmpdir(), "ci-session-")));

mkdirSync(join(root, "app", "pkg"), { recursive: true });

const setup = () => {
  const api = createFakeSandboxApi();
  const ci = createCi(createCiTestClient(api), {
    github: consoleReporter(),
    runUrl: ({ runId }) => {
      return `http://localhost:8288/run?runID=${runId}`;
    },
  });

  api.script([
    {
      match: "",
      respond: ({ command, cwd, environment }) => {
        // Only a job's own commands run for real, not the machine's setup
        if (!command[2]?.includes("__INGEST_SHELL_")) {
          return {};
        }

        const ran = spawnSync(command[0] ?? "", command.slice(1), {
          cwd: !cwd || cwd === "/work" ? root : cwd,
          env: {
            PATH: process.env.PATH ?? "",
            NODE_ENV: "test",
            ...environment,
          },
          encoding: "utf8",
        });

        return {
          stdout: ran.stdout,
          stderr: ran.stderr,
          exitCode: ran.status ?? 1,
        };
      },
    },
  ]);

  return { api, ci };
};

const runJob = async (body: () => Promise<void>) => {
  const { ci } = setup();
  const job = ci.job("session", async () => {
    await body();
  });
  const pipeline = ci.pipeline({ id: "pr", on: prTrigger }, async () => {
    return job();
  });

  return runFunction(pipeline, { event: prEvent });
};

describe("a job's shell state", () => {
  test("a cd carries to the commands after it, and so does an export", async () => {
    const seen: string[] = [];

    const result = await runJob(async () => {
      seen.length = 0;

      await $`cd ${join(root, "app")}`;
      await $.sh`export STAGE=test`;

      seen.push(await $.sh`pwd`.text());
      seen.push(await $.sh`echo "$STAGE"`.text());

      await $`cd pkg`;

      seen.push(await $.sh`pwd`.text());
    });

    expect(result.type).toBe("function-resolved");
    expect(seen).toEqual([join(root, "app"), "test", join(root, "app", "pkg")]);
  });

  test("a command's own cwd and env apply to it alone", async () => {
    const seen: string[] = [];

    await runJob(async () => {
      seen.length = 0;

      seen.push(
        await $.sh`pwd; echo "$ONLY"`
          .cwd(join(root, "app"))
          .env({ ONLY: "1" })
          .text(),
      );
      seen.push(await $.sh`pwd; echo "[$ONLY]"`.text());
    });

    expect(seen).toEqual([`${join(root, "app")}\n1`, `${root}\n[]`]);
  });

  test("a command that fails and is let through still moves the job, but a failed one does not", async () => {
    const seen: string[] = [];

    await runJob(async () => {
      seen.length = 0;

      const failed = await $.sh`cd app; exit 3`.nothrow();

      seen.push(String(failed.exitCode));
      seen.push(await $.sh`pwd`.text());
    });

    expect(seen).toEqual(["3", join(root, "app")]);
  });

  test("a command's output shows none of the report", async () => {
    let stdout = "";

    await runJob(async () => {
      stdout = (await $.sh`printf 'hello'`).stdout;
    });

    expect(stdout).toBe("hello");
  });

  test("a timed captured command moves the job the same way", async () => {
    const seen: string[] = [];

    await runJob(async () => {
      seen.length = 0;

      await $.sh`cd app`.timeout("1m");

      seen.push(await $.sh`pwd`.timeout("1m").text());
    });

    expect(seen).toEqual([join(root, "app")]);
  });

  test("a failed command does not move the job, and a relative cwd option does not either", async () => {
    const seen: string[] = [];

    await runJob(async () => {
      seen.length = 0;

      await $.sh`cd app; exit 1`.then(
        () => {},
        () => {},
      );

      seen.push(await $.sh`pwd`.text());

      await $.sh`true`.cwd(`${join(root, "app")}/`);

      seen.push(await $.sh`pwd`.text());
    });

    expect(seen).toEqual([root, root]);
  });
});
