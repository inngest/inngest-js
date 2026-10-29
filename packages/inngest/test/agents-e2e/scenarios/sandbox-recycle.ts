/**
 * @module
 * Proves a thread's sandbox can be recycled in the middle of a run. The agent
 * writes a file, recycles the sandbox (saved and destroyed while the run goes
 * on), and reads the file back: the sandbox it gets is a new one restored from
 * the snapshot. The run's end then saves and destroys the second sandbox, and
 * the thread's next run restores the file again.
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

const agentId = "sandbox-recycle-agent";
const ref = `agents-e2e/${agentId}`;
const box = sandbox({ id: "recycle-box" });

export const sandboxRecycle = scenario({
  id: "sandbox-recycle",
  owner: "agents-sandbox-recycle",
  needs: { oss: "jack/step-subscribe-clean" },
  sandbox: "fake",
  functions: ({ client }) => {
    const agents = createAgents(client);

    agents.agent(
      { id: agentId, sandboxes: { work: { sandbox: box, idle: "snapshot" } } },
      async ({ inbox, sandboxes }) => {
        const first = await inbox.next();
        const command = first?.content ?? "";
        const read = async () => {
          const work = await sandboxes.work?.get();
          const bytes = await work?.files.read("notes", "/work/notes.txt");

          return new TextDecoder().decode(bytes);
        };

        if (command === "recycle") {
          const work = await sandboxes.work?.get();

          await work?.files.write("notes", {
            path: "/work/notes.txt",
            data: "survives a recycle",
          });
          await sandboxes.work?.recycle();
          await kv.thread.set(kvKey<string>("afterRecycle"), await read());
          await sandboxes.work?.recycle();
          await kv.thread.set(kvKey<string>("afterSecond"), await read());
        }

        if (command === "next") {
          await kv.thread.set(kvKey<string>("nextRun"), await read());
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
    const thread = getThread(client, ref, `recycle-${Date.now()}`, {
      kv: store,
    });
    const calls = (method: string) => {
      return ctx.fakes.posts({ channel: "sandbox", method });
    };

    await thread.send("recycle");
    await ctx.eventually(
      "both reads came back after a recycle",
      async () => {
        return (await thread.state()).keys;
      },
      (keys) => {
        return (
          keys.afterRecycle === "survives a recycle" &&
          keys.afterSecond === "survives a recycle"
        );
      },
    );
    await ctx.until(
      async () => {
        return calls("sandbox.destroy").length;
      },
      (count) => {
        return count >= 3;
      },
      90_000,
    );

    // Three sandboxes, one per recycle and one for the end of the run; each
    // was snapshotted before it was destroyed, and each later one was
    // restored from the snapshot before it.
    ctx.check(
      "three sandboxes were created and destroyed",
      calls("sandbox.create").length === 3 &&
        calls("sandbox.destroy").length === 3,
      { created: calls("sandbox.create").length },
    );
    const names = calls("snapshot.create").map((call) => {
      return String(call.body.name);
    });
    ctx.check(
      "each snapshot is a later generation of the same run",
      names.length === 3 &&
        names[1] === `${names[0]}.000001` &&
        names[2] === `${names[0]}.000002`,
      names,
    );
    ctx.check(
      "the second sandbox was restored from the first snapshot",
      calls("sandbox.create")[1]?.body.snapshotId ===
        calls("snapshot.create")[0]?.body.id,
    );

    await thread.send("next");
    await ctx.eventually(
      "the next run read the file",
      async () => {
        return (await thread.state()).keys.nextRun;
      },
      (read) => {
        return read === "survives a recycle";
      },
    );
    ctx.check(
      "and restored the newest generation",
      calls("sandbox.create")[3]?.body.snapshotId ===
        calls("snapshot.create")[2]?.body.id,
    );

    // The scenario ends only once its last run has saved, destroyed and pruned,
    // so none of it lands in the next scenario's window.
    await ctx.until(
      async () => {
        return [
          calls("sandbox.destroy").length,
          calls("snapshot.delete").length,
        ];
      },
      ([destroyed, deleted]) => {
        return (destroyed ?? 0) >= 4 && (deleted ?? 0) >= 2;
      },
      90_000,
    );
    ctx.check(
      "older generations of the run were pruned, the newest kept",
      calls("snapshot.create").length === 4 &&
        calls("snapshot.delete").length === 2,
      {
        created: calls("snapshot.create").length,
        deleted: calls("snapshot.delete").length,
      },
    );
  },
});
