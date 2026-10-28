/**
 * @module
 * Playground script: `tsx play.ts <go|msg|burst|runs> ...`. Reads the Dev
 * Server URL from `DEV_URL` (devstack prints it). The thread of a run is its
 * `t`; `go` prints it.
 */
import { Inngest } from "inngest";

const devUrl = process.env.DEV_URL;

if (!devUrl) {
  throw new Error("Set DEV_URL to the Dev Server URL from `devstack status`.");
}

const client = new Inngest({
  id: "park-playground-script",
  baseUrl: devUrl,
  isDev: true,
});

const [command, ...args] = process.argv.slice(2);

if (command === "go") {
  const t = args[0] ?? `t${Date.now()}`;

  await client.send({ name: "park/go", data: { t } });
  console.log(`started run for t=${t}`);
} else if (command === "msg") {
  const [t, text = "hello"] = args;

  await client.send({ name: "park/msg", data: { t, text } });
  console.log(`sent "${text}" to ${t}`);
} else if (command === "burst") {
  const [t, count = "3"] = args;

  await client.send(
    Array.from({ length: Number(count) }, (_, n) => {
      return { name: "park/msg", data: { t, text: `m${n + 1}` } };
    }),
  );
  console.log(`sent ${count} messages to ${t} in one request`);
} else if (command === "runs") {
  const res = await fetch(`${devUrl}/v1/runs?limit=5`);
  const body = (await res.json()) as {
    data?: { run_id: string; status: string }[];
  };

  for (const run of body.data ?? []) {
    console.log(run.run_id, run.status);
  }
} else {
  console.log("usage: play.ts go [t] | msg <t> [text] | burst <t> [n] | runs");
}
