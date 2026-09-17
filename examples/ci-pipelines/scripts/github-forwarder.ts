/**
 * Forward real GitHub webhooks to the Dev Server.
 *
 * ```bash
 * pnpm ci:forward
 * gh webhook forward --repo=owner/name --events='*' --url=http://localhost:3940
 * ```
 *
 * It applies the same transform as `githubWebhookTransform`, so events look
 * exactly like they do in production, and verifies `X-Hub-Signature-256` when
 * `GITHUB_WEBHOOK_SECRET` is set.
 */

import { createServer } from "node:http";

import { verify } from "@octokit/webhooks-methods";
import { githubEventName } from "inngest/ci";

import { inngest } from "../ci/client.ts";

const port = Number(process.env.FORWARDER_PORT ?? 3940);
const secret = process.env.GITHUB_WEBHOOK_SECRET;

const readBody = (req: import("node:http").IncomingMessage): Promise<string> =>
  new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    req.on("data", (chunk: Buffer) => chunks.push(chunk));
    req.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
    req.on("error", reject);
  });

createServer(async (req, res) => {
  if (req.method !== "POST") {
    res.writeHead(405).end();
    return;
  }

  const body = await readBody(req);
  const signature = req.headers["x-hub-signature-256"];

  if (secret) {
    const ok =
      typeof signature === "string" && (await verify(secret, body, signature));

    if (!ok) {
      console.warn({ signature }, "Rejected a webhook with a bad signature");
      res.writeHead(401).end();
      return;
    }
  }

  const event = String(req.headers["x-github-event"] ?? "unknown");
  const delivery = req.headers["x-github-delivery"];
  const payload = JSON.parse(body) as {
    action?: string;
    installation?: { id?: number };
  };

  const name = githubEventName(event, payload);

  await inngest.send({
    name,
    data: {
      ...payload,
      _github: {
        event,
        delivery: typeof delivery === "string" ? delivery : undefined,
        installationId: payload.installation?.id,
      },
    },
  });

  console.log({ name, delivery }, "Forwarded a GitHub webhook");
  res.writeHead(202).end();
}).listen(port, () => {
  console.log(
    { port, verifying: Boolean(secret) },
    `Forwarding GitHub webhooks to the Dev Server from http://localhost:${port}`,
  );
});
