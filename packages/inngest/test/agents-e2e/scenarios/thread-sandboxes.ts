/**
 * @module
 * Proves thread-owned sandboxes on the fake Sandboxes API. Run 1 of a thread
 * writes a file; the run ends and its sandbox is snapshotted. Run 2 of the
 * same thread restores from that snapshot on first use and reads the file
 * back. A run that never touches the sandbox restores nothing and saves
 * nothing, and the run after it still restores. A different thread gets a
 * fresh sandbox. A run that is cancelled while it holds the sandbox is saved
 * and destroyed by its cleanup defer, and the thread's next run restores it.
 */
import { Inngest } from "inngest";
import {
  createAgents,
  createKv,
  getThread,
  kv,
  redisKvAdapter,
  sandbox,
} from "inngest/experimental/agents";
import { scenario } from "../kit/driver.ts";

const agentId = "thread-sandboxes-agent";
const ref = `agents-e2e/${agentId}`;
const box = sandbox({ id: "notes-box" });

export const threadSandboxes = scenario({
  id: "thread-sandboxes",
  owner: "agents-thread-sandboxes",
  needs: { oss: "jack/step-subscribe-clean" },
  sandbox: "fake",
  functions: ({ client }) => {
    const agents = createAgents(client);

    agents.agent(
      { id: agentId, sandboxes: { work: { sandbox: box, idle: "snapshot" } } },
      async ({ inbox, sandboxes }) => {
        const first = await inbox.next();
        const [command, text] = (first?.content ?? "").split(":") as [
          string,
          string | undefined,
        ];

        if (command === "idle") {
          await kv.thread.set("idled", true);
        }

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
          const work = await sandboxes.work?.get();
          const bytes = await work?.files.read("notes", "/work/notes.txt");

          await kv.thread.set("read", new TextDecoder().decode(bytes));
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
    const runEnded = async (destroyed: number) => {
      // A cancelled run is finalized and cleaned up by the executor: give that
      // more than the default wait when the machine is busy.
      await ctx.until(
        async () => {
          return calls("sandbox.destroy").length;
        },
        (count) => {
          return count >= destroyed;
        },
        90_000,
      );
      ctx.check(
        `${destroyed} sandboxes destroyed`,
        calls("sandbox.destroy").length >= destroyed,
        calls("sandbox.destroy").length,
      );
    };

    await alpha.send("write:remember the milk");
    await runEnded(1);
    await ctx.expect
      .posts({ channel: "sandbox", method: "snapshot.create" })
      .toHaveCount(1);
    ctx.check(
      "the snapshot is named under the thread scope",
      String(calls("snapshot.create")[0]?.body.name).startsWith(
        `thread/${ref}/work/`,
      ),
    );

    await alpha.send("idle");
    await ctx.eventually(
      "the idle run ended",
      async () => {
        return (await alpha.state()).keys.idled;
      },
      (idled) => {
        return idled === true;
      },
    );
    await ctx.expect
      .posts({ channel: "sandbox", method: "snapshot.create" })
      .toHaveCount(1);
    ctx.check(
      "a run that never used the sandbox creates none",
      calls("sandbox.create").length === 1,
    );

    await alpha.send("read");
    await runEnded(2);
    ctx.check(
      "the next run restored from the snapshot",
      calls("sandbox.create")[1]?.body.snapshotId ===
        calls("snapshot.create")[0]?.body.id,
    );
    await ctx.eventually(
      "run 2 read the file written by run 1",
      async () => {
        return (await alpha.state()).keys.read;
      },
      (read) => {
        return read === "remember the milk";
      },
    );
    await ctx.expect
      .posts({ channel: "sandbox", method: "snapshot.create" })
      .toHaveCount(2);
    // The previous generation stays as a spare.
    await ctx.expect
      .posts({ channel: "sandbox", method: "snapshot.delete" })
      .toHaveCount(0);

    await beta.send("read");
    await runEnded(3);
    ctx.check(
      "a different thread gets a fresh sandbox",
      calls("sandbox.create")[2]?.body.snapshotId === undefined,
    );
    await ctx.eventually(
      "the fresh sandbox has no file",
      async () => {
        return (await beta.state()).status;
      },
      (status) => {
        return status === "idle" || status === "waiting";
      },
    );
    ctx.check(
      "and read nothing back",
      (await beta.state()).keys.read === undefined,
    );
    const gamma = getThread(client, ref, `gamma-${stamp}`, { kv: store });

    await gamma.send("hold:kept through a cancel");
    // The file is written only once the sandbox exists, its cleanup defer is
    // registered and it is marked ready; a cancel before that leaves the
    // sandbox to its own timeout by design.
    await ctx.eventually(
      "the held run wrote its file",
      async () => {
        return calls("sandbox.upload").length;
      },
      (count) => {
        return count >= 2;
      },
    );
    const gammaStop = await gamma.stop({ when: "now" });
    ctx.check(
      "stop now found the live run",
      gammaStop.stopped === true,
      gammaStop,
    );
    await runEnded(4);
    await ctx.expect
      .posts({ channel: "sandbox", method: "snapshot.create" })
      .toHaveCount(4);

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

    // A third save by alpha deletes its first generation, not the spare.
    await alpha.send("read");
    await ctx.eventually(
      "the third generation deletes the first",
      async () => {
        return calls("snapshot.delete").length;
      },
      (count) => {
        return count === 1;
      },
    );
  },
});
