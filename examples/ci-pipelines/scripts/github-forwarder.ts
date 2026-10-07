/**
 * Forward real GitHub webhooks to the Dev Server.
 *
 * ```bash
 * pnpm ci:forward
 * gh extension install cli/gh-webhook
 * gh webhook forward --repo=owner/name --events='*' --url=http://localhost:3950 --secret="$GITHUB_WEBHOOK_SECRET"
 * ```
 *
 * It applies the same transform as `githubWebhookTransform`, so events look
 * exactly like they do in production, and verifies `X-Hub-Signature-256`. It
 * refuses to start without `GITHUB_WEBHOOK_SECRET`, listens on 127.0.0.1 only,
 * and defaults to port 3950 so it doesn't clash with the e2e runner on 3940.
 */

import { createServer } from "node:http";

import { verify } from "@octokit/webhooks-methods";
import { githubEventName } from "@inngest/ci";

import { inngest } from "../ci/client.ts";

const port = Number(process.env.FORWARDER_PORT ?? 3950);
const secret = process.env.GITHUB_WEBHOOK_SECRET;

if (!secret) {
  console.error("Set GITHUB_WEBHOOK_SECRET to the secret GitHub signs with.");
  process.exit(1);
}

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

  const ok =
    typeof signature === "string" && (await verify(secret, body, signature));

  if (!ok) {
    console.warn({ signature }, "Rejected a webhook with a bad signature");

    res.writeHead(401).end();

    return;
  }

  const event = String(req.headers["x-github-event"] ?? "unknown");
  const delivery = req.headers["x-github-delivery"];

  let payload: { action?: string; installation?: { id?: number } };

  try {
    payload = JSON.parse(body);
  } catch {
    res.writeHead(400).end();

    return;
  }

  const name = githubEventName(event, payload);

  try {
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
  } catch (err) {
    console.error({ err, name, delivery }, "Failed to forward a webhook");

    res.writeHead(500).end();

    return;
  }

  console.log({ name, delivery }, "Forwarded a GitHub webhook");

  res.writeHead(202).end();
}).listen(port, "127.0.0.1", () => {
  console.log(
    { port },
    `Forwarding GitHub webhooks to the Dev Server from http://127.0.0.1:${port}`,
  );
});
