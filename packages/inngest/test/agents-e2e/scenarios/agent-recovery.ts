/**
 * @module
 * No run of an agent ends silently. Every ending is kept on the thread
 * (`state().lastRun`) and the next run is told (`previousRun`). With `recovery`
 * on, a turn that throws is resent to a fresh run; a turn that fails twice the
 * same way is recorded as stuck and not resent a third time; a cancelled run
 * is recorded and left alone.
 */
import { appendFileSync, existsSync, readFileSync, unlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Inngest } from "inngest";
import {
  createAgents,
  getThread,
  kv,
  kvKey,
  type LastRun,
  redisKvAdapter,
} from "inngest/experimental/agents";
import { scenario } from "../kit/driver.ts";
import { createKv } from "../kit/kv.ts";
import { textOf } from "../kit/text.ts";

const agentId = "recovery-agent";
const ref = `agents-e2e/${agentId}`;
// The worker and the CLI share these files, and several stacks can run on one
// machine, so both name them by their stack's Redis URL, which they both have.
const fileFor = (redisUrl: string | undefined, kind: string) => {
  return join(
    tmpdir(),
    `agent-recovery-${kind}-${(redisUrl ?? "local").replace(/\W+/g, "-")}.log`,
  );
};

const sleep = (ms: number) => {
  return new Promise<void>((resolve) => {
    setTimeout(resolve, ms);
  });
};

const lines = (file: string) => {
  return existsSync(file)
    ? readFileSync(file, "utf8").trim().split("\n").filter(Boolean)
    : [];
};

export const agentRecovery = scenario({
  id: "agent-recovery",
  owner: "agents-recovery",
  needs: { oss: "jack/step-subscribe-clean" },
  functions: ({ client, redisUrl }) => {
    const attemptsFile = fileFor(redisUrl, "attempts");

    if (existsSync(attemptsFile)) {
      unlinkSync(attemptsFile);
    }

    const agents = createAgents(client);

    agents.agent(
      {
        id: agentId,
        retries: 0,
        recovery: true,
      },
      async ({ inbox, step, previousRun }) => {
        await kv.thread.update(
          kvKey<(string | null)[]>("previous"),
          function (seen) {
            return [...(seen ?? []), previousRun?.status ?? null];
          },
        );

        for await (const message of inbox) {
          const text = textOf(message) ?? "";

          if (text.startsWith("explode")) {
            throw new Error(`exploded on ${text} at ${Date.now()}`);
          }

          if (text.startsWith("flaky")) {
            // The first try fails, the one after a recovery succeeds.
            const tries = await step.run("flaky-tries", () => {
              appendFileSync(attemptsFile, `${text}\n`);

              return lines(attemptsFile).filter((line) => {
                return line === text;
              }).length;
            });

            if (tries === 1) {
              throw new Error(`flaky failure for ${text}`);
            }
          }

          if (text === "finish") {
            return "done";
          }

          await kv.thread.update(kvKey<string[]>("done"), function (done) {
            return [...(done ?? []), text];
          });
        }

        return "closed";
      },
    );

    return agents.functions();
  },
  run: async (ctx) => {
    const store = createKv({ adapter: redisKvAdapter(ctx.redisUrl) });
    const client = new Inngest({
      id: "agents-e2e",
      baseUrl: ctx.devUrl,
      isDev: true,
    });
    const handle = (name: string) => {
      return getThread(client, ref, `${name}-${Date.now()}`, { kv: store });
    };
    const last = async (thread: ReturnType<typeof handle>) => {
      return (await thread.state()).lastRun as LastRun | undefined;
    };
    const keys = async (thread: ReturnType<typeof handle>) => {
      return (await thread.state()).keys as {
        done?: string[];
        previous?: (string | null)[];
      };
    };

    // A turn that throws once: resent, answered by a fresh run that
    // is told how the one before it ended.
    const flaky = handle("flaky");
    await flaky.send("flaky one");
    await ctx.eventually(
      "the resent turn is handled by a fresh run",
      () => keys(flaky),
      (state) => {
        return (state.done ?? []).includes("flaky one");
      },
    );
    const afterFlaky = await last(flaky);
    ctx.check(
      "the failure is recorded with what recovery did",
      afterFlaky?.status === "failed" &&
        afterFlaky.recovery === "resumed" &&
        afterFlaky.error?.includes("flaky failure") === true,
      afterFlaky,
    );
    ctx.check(
      "the fresh run was told its previous run failed",
      (await keys(flaky)).previous?.[1] === "failed",
      await keys(flaky),
    );

    // A cancelled run is recorded and nothing is resumed.
    await flaky.stop();
    const cancelled = await ctx.eventually(
      "the cancelled run is recorded",
      () => last(flaky),
      (run) => {
        return run?.status === "cancelled";
      },
    );
    await sleep(2000);
    ctx.check(
      "a cancelled run is not resumed",
      cancelled?.recovery === undefined,
      cancelled,
    );

    // A run that finishes is recorded as completed.
    const finish = handle("finish");
    await finish.send("finish");
    await ctx.eventually(
      "a completed run is recorded",
      () => last(finish),
      (run) => {
        return run?.status === "completed";
      },
    );

    // A turn that fails the same way twice is stuck: resent once.
    const explode = handle("explode");
    await explode.send("explode now");
    const stuck = await ctx.eventually(
      "the second identical failure is stuck",
      () => last(explode),
      (run) => {
        return run?.recovery === "stuck";
      },
    );
    await sleep(4000);
    ctx.check(
      "no third run was started",
      (await keys(explode)).previous?.length === 2,
      { stuck, keys: await keys(explode) },
    );
  },
});
