/**
 * @module
 * Proves a thread's sandbox is paused, not torn down, when its run is done
 * with it, and resumed by the thread's next run. Run 1 writes a file and ends:
 * its sandbox is paused (no snapshot, no destroy). Run 2 resumes that same
 * sandbox (no new one is created) and reads the file. A recycle in the middle
 * of a run pauses and resumes the same sandbox too. A run cancelled while it
 * holds the sandbox is paused by its cleanup defer, and the next run reads
 * the file again. A different thread gets a fresh sandbox.
 */
import { Inngest } from "inngest";
import {
  createAgents,
  createKv,
  getThread,
  kv,
  kvKey,
  redisKvAdapter,
  sandbox,
} from "inngest/experimental/agents";
import { scenario } from "../kit/driver.ts";
import { textOf } from "../kit/text.ts";

const agentId = "thread-sandboxes-pause-agent";
const ref = `agents-e2e/${agentId}`;
const box = sandbox({ id: "pause-box" });

export const threadSandboxesPause = scenario({
  id: "thread-sandboxes-pause",
  owner: "agents-git-batch",
  needs: { oss: "jack/step-subscribe-clean" },
  sandbox: "fake",
  functions: ({ client }) => {
    const agents = createAgents(client);

    agents.agent(
      { id: agentId, sandboxes: { work: box } },
      async ({ inbox, sandboxes }) => {
        const first = await inbox.next();
        const [command, text] = (textOf(first) ?? "").split(":") as [
          string,
          string | undefined,
        ];
        const read = async () => {
          const work = await sandboxes.work?.get();
          const bytes = await work?.files.read("notes", "/work/notes.txt");

          return new TextDecoder().decode(bytes);
        };

        if (command === "write" || command === "hold") {
          const work = await sandboxes.work?.get();

          await work?.files.write("notes", {
            path: "/work/notes.txt",
            data: text ?? "",
          });
        }

        if (command === "hold") {
          // Waits for a message that never comes, until the run is cancelled.
          await inbox.next();
        }

        if (command === "read") {
          await kv.thread.set(kvKey<string>("read"), await read());
        }

        if (command === "recycle") {
          await sandboxes.work?.get();
          await sandboxes.work?.recycle();
          await kv.thread.set(kvKey<string>("afterRecycle"), await read());
        }

        return command;
      },
    );

    return agents.functions();
  },
  run: async (ctx) => {
    const client = new Inngest({
      id: "agents-e2e",
      baseUrl: ctx.devUrl,
      isDev: true,
    });
    const store = createKv({ adapter: redisKvAdapter(ctx.redisUrl) });
    const stamp = Date.now();
    const alpha = getThread(client, ref, `alpha-${stamp}`, { kv: store });
    const beta = getThread(client, ref, `beta-${stamp}`, { kv: store });
    const calls = (method: string) => {
      return ctx.fakes.posts({ channel: "sandbox", method });
    };
    const waitFor = async (method: string, count: number) => {
      await ctx.until(
        async () => {
          return calls(method).length;
        },
        (seen) => {
          return seen >= count;
        },
        90_000,
      );
    };

    await alpha.send("write:remember the milk");
    await waitFor("sandbox.pause", 1);
    ctx.check(
      "run 1 paused its sandbox: no snapshot, no destroy",
      calls("sandbox.create").length === 1 &&
        calls("snapshot.create").length === 0 &&
        calls("sandbox.destroy").length === 0,
      { created: calls("sandbox.create").length },
    );

    await alpha.send("read");
    await ctx.eventually(
      "run 2 read the file written by run 1",
      async () => {
        return (await alpha.state()).keys.read;
      },
      (read) => {
        return read === "remember the milk";
      },
    );
    ctx.check(
      "run 2 resumed the same sandbox instead of creating one",
      calls("sandbox.create").length === 1 &&
        calls("sandbox.resume").length === 1,
      { created: calls("sandbox.create").length },
    );
    await waitFor("sandbox.pause", 2);

    await alpha.send("recycle");
    await ctx.eventually(
      "a recycle brought the same file back",
      async () => {
        return (await alpha.state()).keys.afterRecycle;
      },
      (read) => {
        return read === "remember the milk";
      },
    );
    await waitFor("sandbox.pause", 4);
    ctx.check(
      "the recycle paused and resumed the same sandbox, still creating no other",
      calls("sandbox.create").length === 1 &&
        calls("sandbox.resume").length === 3 &&
        calls("snapshot.create").length === 0 &&
        calls("sandbox.destroy").length === 0,
      {
        created: calls("sandbox.create").length,
        resumed: calls("sandbox.resume").length,
      },
    );

    await beta.send("write:beta");
    await waitFor("sandbox.create", 2);
    ctx.check(
      "and got a fresh sandbox",
      calls("sandbox.create").length === 2 &&
        calls("sandbox.create")[1]?.body.snapshotId === undefined,
    );
    await waitFor("sandbox.pause", 5);

    const gamma = getThread(client, ref, `gamma-${stamp}`, { kv: store });

    await gamma.send("hold:kept through a cancel");
    await ctx.eventually(
      "the held run wrote its file",
      async () => {
        return calls("sandbox.upload").length;
      },
      (count) => {
        return count >= 3;
      },
    );

    const stopped = await gamma.stop({ when: "now" });

    ctx.check("stop now found the live run", stopped.stopped === true, stopped);
    // The cleanup defer of the cancelled run pauses the sandbox.
    await waitFor("sandbox.pause", 6);
    ctx.check(
      "the cancelled run's sandbox was paused, not destroyed",
      calls("sandbox.destroy").length === 0,
    );

    await gamma.send("read");
    await ctx.eventually(
      "the run after a cancel read the file",
      async () => {
        return (await gamma.state()).keys.read;
      },
      (read) => {
        return read === "kept through a cancel";
      },
    );
    await waitFor("sandbox.pause", 7);
  },
});
