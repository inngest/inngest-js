// biome-ignore-all lint/suspicious/noExplicitAny: test utility, mirrors test-harness

import http from "node:http";
import type { AddressInfo } from "node:net";
import { registerApp } from "@inngest/test-harness";
import { onTestFinished } from "vitest";
import { createServer } from "../../../node.ts";

const SERVE_PATH = "/api/inngest";

export interface RecordedOp {
  op: string;
  name?: string;
  displayName?: string;
}

export interface RecordedRequest {
  method: string;
  requestReqVersion: string | null;
  /** `ctx.disable_immediate_execution` from the request body. */
  disableImmediateExecution: boolean | null;
  responseReqVersion: string | null;
  responseOps: RecordedOp[];
}

function safeJsonParse(raw: string): unknown {
  try {
    return JSON.parse(raw);
  } catch {
    return undefined;
  }
}

function isOpLike(value: unknown): value is RecordedOp {
  return typeof (value as RecordedOp | null)?.op === "string";
}

function extractOps(body: unknown): RecordedOp[] {
  const list = Array.isArray(body) ? body : [body];
  return list.filter(isOpLike);
}

function extractDisableImmediateExecution(body: unknown): boolean | null {
  const die = (body as { ctx?: { disable_immediate_execution?: unknown } })?.ctx
    ?.disable_immediate_execution;
  return typeof die === "boolean" ? die : null;
}

function listen(server: http.Server): Promise<void> {
  return new Promise((resolve, reject) => {
    server.on("error", reject);
    server.listen(0, () => {
      server.removeListener("error", reject);
      resolve();
    });
  });
}

/**
 * Serve a test app behind a buffer-and-forward proxy so tests can assert on
 * the executor↔SDK protocol. The app advertises the proxy's origin during
 * sync (`serveOrigin`), so the Dev Server routes all run traffic through it.
 */
export async function createRecordedTestApp(options: {
  client: any;
  functions: any[];
}): Promise<{ requests: RecordedRequest[] }> {
  const requests: RecordedRequest[] = [];

  let targetOrigin: string | undefined;

  async function forward(
    req: http.IncomingMessage,
    res: http.ServerResponse,
  ): Promise<void> {
    if (!targetOrigin) {
      throw new Error("recording proxy has no target yet");
    }

    // The comm handler reads bodies lazily, so buffer fully rather than
    // tapping streams mid-flight.
    const chunks: Buffer[] = [];
    for await (const chunk of req) {
      chunks.push(chunk as Buffer);
    }
    const reqBody = Buffer.concat(chunks);
    const method = req.method ?? "GET";

    const headers: Record<string, string> = {};
    for (const [key, value] of Object.entries(req.headers)) {
      if (["host", "connection", "content-length"].includes(key)) {
        continue;
      }
      if (typeof value === "string") {
        headers[key] = value;
      }
    }

    const upstreamRes = await fetch(`${targetOrigin}${req.url ?? "/"}`, {
      method,
      headers,
      body: ["GET", "HEAD"].includes(method) ? undefined : reqBody,
    });
    const resBody = Buffer.from(await upstreamRes.arrayBuffer());

    requests.push({
      method,
      requestReqVersion:
        req.headers["x-inngest-req-version"]?.toString() ?? null,
      disableImmediateExecution: extractDisableImmediateExecution(
        safeJsonParse(reqBody.toString("utf8")),
      ),
      responseReqVersion: upstreamRes.headers.get("x-inngest-req-version"),
      responseOps: extractOps(safeJsonParse(resBody.toString("utf8"))),
    });

    res.statusCode = upstreamRes.status;
    upstreamRes.headers.forEach((value, key) => {
      // fetch already decoded the body, so these no longer describe it.
      if (
        ["content-length", "content-encoding", "transfer-encoding"].includes(
          key,
        )
      ) {
        return;
      }
      res.setHeader(key, value);
    });
    res.setHeader("content-length", resBody.length);
    res.end(resBody);
  }

  const proxy = http.createServer((req, res) => {
    forward(req, res).catch((err) => {
      res.statusCode = 502;
      res.end(`recording proxy error: ${err}`);
    });
  });
  await listen(proxy);
  const proxyBaseUrl = `http://localhost:${(proxy.address() as AddressInfo).port}`;

  const innerServer = createServer({
    client: options.client,
    functions: options.functions,
    servePath: SERVE_PATH,
    serveOrigin: proxyBaseUrl,
  });
  await listen(innerServer);
  targetOrigin = `http://localhost:${(innerServer.address() as AddressInfo).port}`;

  await registerApp(`${proxyBaseUrl}${SERVE_PATH}`);

  onTestFinished(async () => {
    await new Promise<void>((resolve) => innerServer.close(() => resolve()));
    await new Promise<void>((resolve) => proxy.close(() => resolve()));
  });

  return { requests };
}
