import { Buffer } from "node:buffer";
import http from "node:http";
import { Socket } from "node:net";
import { PassThrough } from "node:stream";
import httpMocks from "node-mocks-http";
import { Inngest } from "./components/Inngest.ts";
import * as NodeHandler from "./node.ts";
import { testFramework } from "./test/helpers.ts";

testFramework("Node", NodeHandler, {
  transformReq: (req, res) => {
    const socket = new Socket();
    const nodeReq = new http.IncomingMessage(socket);

    // Set the method and URL
    nodeReq.method = req.method;
    nodeReq.url = req.url;

    if (req.protocol === "https") {
      nodeReq.headers["x-forwarded-proto"] = req.protocol;
    }

    // Set headers
    for (const [key, value] of Object.entries(req.headers)) {
      nodeReq.headers[key.toLowerCase()] = value;
    }

    // Mock the body data
    const bodyString = req.body === undefined ? "" : JSON.stringify(req.body);
    const bodyData = Buffer.from(bodyString);

    // Override the read methods to return the body data
    nodeReq.push(bodyData);
    nodeReq.push(null); // Signals the end of the stream

    return [nodeReq, res];
  },
});

/**
 * Mimics `@vercel/node`'s `restoreBody()`: after Vercel drains the original
 * request stream to populate `req.body`, it patches `req.on('data'|'end')` and
 * `req.read` to replay the bytes from a `PassThrough` — but does NOT patch
 * `Symbol.asyncIterator` or the `readable` event.
 *
 * Regression guard for EXE-1666: body readers that consume the stream via the
 * async-iterator path (e.g. `node:stream/consumers.text`) read from the
 * already-drained original stream and see an empty body.
 *
 * https://github.com/vercel/vercel/blob/main/packages/node/src/serverless-functions/helpers.ts
 */
function restoreBodyLikeVercel(req: http.IncomingMessage, body: Buffer) {
  const replicate = new PassThrough();
  const originalOn = req.on.bind(req);
  const patched: typeof req.on = (name, cb) => {
    if (name === "data" || name === "end") {
      replicate.on(name, cb);
    } else {
      originalOn(name, cb);
    }
    return req;
  };
  req.on = patched;
  req.addListener = patched;
  req.read = replicate.read.bind(replicate);
  replicate.write(body);
  replicate.end();
}

describe("Node serve() under @vercel/node restoreBody()", () => {
  test("reads the request body via the replayed event listeners", async () => {
    const client = new Inngest({ id: "test", isDev: true });
    const fn = client.createFunction(
      { id: "test", triggers: [{ event: "demo/event.sent" }] },
      () => "ok",
    );
    const handler = NodeHandler.serve({ client, functions: [fn] });

    const socket = new Socket();
    const req = new http.IncomingMessage(socket);
    req.method = "POST";
    req.url = "/api/inngest?fnId=test-test&stepId=step";
    req.headers.host = "localhost:3000";
    req.headers["content-type"] = "application/json";

    const body = Buffer.from(JSON.stringify({ event: {}, events: [{}] }));
    req.push(body);
    req.push(null);

    // @vercel/node drains the underlying stream via `stream.on('data', ...)`
    // (see build-utils `streamToBuffer`) before calling `restoreBody()`.
    await new Promise<void>((resolve, reject) => {
      req.on("data", () => {
        /* drain */
      });
      req.on("end", resolve);
      req.on("error", reject);
    });

    // Then it replays the bytes via the monkey-patched event listeners only.
    restoreBodyLikeVercel(req, body);

    const res = httpMocks.createResponse({ req });
    await handler(req, res);

    // Proof-positive that the body was read: the handler advances past the
    // body-missing guard (which would 500 with "Missing request body when
    // executing") into event validation, which fails with a 400 on our
    // minimal fixture.
    expect(res.statusCode).toBe(400);
  });
});

describe("readRequestBody", () => {
  test("decodes multi-byte UTF-8 chars split across chunks", async () => {
    const req = new http.IncomingMessage(new Socket());
    const bytes = Buffer.from("é", "utf8");
    req.push(bytes.subarray(0, 1));
    req.push(bytes.subarray(1));
    req.push(null);
    expect(await NodeHandler.readRequestBody(req)).toBe("é");
  });
});
