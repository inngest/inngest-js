import type { RequestEvent } from "@sveltejs/kit";
import { fromPartial } from "@total-typescript/shoehorn";
import fetch, { Headers, Response } from "cross-fetch";
import { envKeys } from "./helpers/consts.ts";
import * as SvelteKitHandler from "./sveltekit.ts";
import { createClient, testFramework } from "./test/helpers.ts";

const originalFetch = globalThis.fetch;
const originalResponse = globalThis.Response;
const originalHeaders = globalThis.Headers;

const createRequestEvent = ({
  body,
  headers,
  method,
  url = "https://localhost:3000/api/inngest",
}: {
  body?: unknown;
  headers?: Record<string, string>;
  method: "GET" | "POST" | "PUT";
  url?: string;
}): RequestEvent => {
  const RequestHeaders = globalThis.Headers ?? Headers;
  const requestHeaders = new RequestHeaders();

  // biome-ignore lint/complexity/noForEach: intentional
  Object.entries(headers ?? {}).forEach(([key, value]) => {
    requestHeaders.set(key, value);
  });

  return fromPartial<RequestEvent>({
    request: fromPartial({
      method,
      url,
      headers: requestHeaders,
      text: () =>
        Promise.resolve(body === undefined ? "" : JSON.stringify(body)),
    }),
  });
};

const runHandler = async (
  serveOptions: Parameters<typeof SvelteKitHandler.serve>[0],
  event: RequestEvent,
  method: "GET" | "POST" | "PUT",
  env?: Record<string, string>,
) => {
  const previousEnv = process.env;
  process.env = { ...previousEnv, ...env };

  try {
    return await SvelteKitHandler.serve(serveOptions)[method](event);
  } finally {
    process.env = previousEnv;
  }
};

testFramework("SvelteKit", SvelteKitHandler, {
  lifecycleChanges: () => {
    beforeEach(() => {
      vi.resetModules();

      Object.defineProperties(globalThis, {
        fetch: { value: fetch, configurable: true },
        Response: { value: Response, configurable: true },
        Headers: { value: Headers, configurable: true },
      });
    });

    afterEach(() => {
      /**
       * Reset all changes made to the global scope
       */
      Object.defineProperties(globalThis, {
        fetch: { value: originalFetch, configurable: true },
        Response: { value: originalResponse, configurable: true },
        Headers: { value: originalHeaders, configurable: true },
      });
    });
  },
  transformReq: (req, _res, _env) => {
    const headers = new Headers();
    // biome-ignore lint/complexity/noForEach: intentional
    Object.entries(req.headers).forEach(([k, v]) => {
      headers.set(k, v as string);
    });

    const svelteKitReq: Partial<RequestEvent> = {
      request: fromPartial({
        method: req.method,
        url: req.url,
        headers,
        text: () =>
          Promise.resolve(
            req.body === undefined ? "" : JSON.stringify(req.body),
          ),
      }),
    };

    return [svelteKitReq];
  },
  transformRes: async (_args, ret: Response) => {
    const headers: Record<string, string> = {};

    ret.headers.forEach((v, k) => {
      headers[k] = v;
    });

    return {
      status: ret.status,
      body: await ret.text(),
      headers,
    };
  },
});

describe("SvelteKit streaming", () => {
  beforeEach(() => {
    Object.defineProperties(globalThis, {
      fetch: { value: originalFetch, configurable: true },
      Response: { value: originalResponse, configurable: true },
      Headers: { value: originalHeaders, configurable: true },
    });
  });

  afterEach(() => {
    Object.defineProperties(globalThis, {
      fetch: { value: originalFetch, configurable: true },
      Response: { value: originalResponse, configurable: true },
      Headers: { value: originalHeaders, configurable: true },
    });
  });

  test('uses a streamed response for `streaming: "force"`', async () => {
    const client = createClient({ id: "test", isDev: true });
    const fn = client.createFunction(
      { name: "Test", id: "test" },
      { event: "demo/event.sent" },
      () => "fn",
    );
    const event = {
      data: {},
      id: "",
      name: "inngest/scheduled.timer",
      ts: 1674082830001,
      user: {},
      v: "1",
    };

    const response = await runHandler(
      {
        client,
        functions: [fn],
        streaming: "force",
      },
      createRequestEvent({
        method: "POST",
        url: "https://localhost:3000/api/inngest?fnId=test-test&stepId=step",
        body: {
          ctx: {
            fn_id: "local-testing-local-cron",
            run_id: "01GQ3HTEZ01M7R8Z9PR1DMHDN1",
            step_id: "step",
          },
          event,
          events: [event],
          steps: {},
          use_api: false,
        },
      }),
      "POST",
      {
        [envKeys.InngestDevMode]: "1",
      },
    );

    expect(response.status).toEqual(201);
    const streamedBody = JSON.parse((await response.text()).trimStart());

    expect(streamedBody).toMatchObject({
      status: 200,
      body: JSON.stringify("fn"),
    });
  });

  test('uses a streamed response for `streaming: "allow"` on supported platforms', async () => {
    const client = createClient({ id: "test", isDev: true });
    const fn = client.createFunction(
      { name: "Test", id: "test" },
      { event: "demo/event.sent" },
      () => "fn",
    );
    const event = {
      data: {},
      id: "",
      name: "inngest/scheduled.timer",
      ts: 1674082830001,
      user: {},
      v: "1",
    };

    const response = await runHandler(
      {
        client,
        functions: [fn],
        streaming: "allow",
      },
      createRequestEvent({
        method: "POST",
        url: "https://localhost:3000/api/inngest?fnId=test-test&stepId=step",
        body: {
          ctx: {
            fn_id: "local-testing-local-cron",
            run_id: "01GQ3HTEZ01M7R8Z9PR1DMHDN1",
            step_id: "step",
          },
          event,
          events: [event],
          steps: {},
          use_api: false,
        },
      }),
      "POST",
      {
        [envKeys.InngestDevMode]: "1",
        [envKeys.IsCloudflarePages]: "1",
      },
    );

    expect(response.status).toEqual(201);
    const streamedBody = JSON.parse((await response.text()).trimStart());

    expect(streamedBody).toMatchObject({
      status: 200,
      body: JSON.stringify("fn"),
    });
  });
});
