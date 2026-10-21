/**
 * @module
 * Fakes shared by the sandbox tests: a sandbox reference and an `Inngest`
 * client whose sandbox REST API is served by a callback.
 */

import { runFnWithStack, testClientId } from "../../test/helpers.ts";
import type { OutgoingOp } from "../../types.ts";
import { Inngest } from "../Inngest.ts";
import type { InngestFunction } from "../InngestFunction.ts";
import { sandboxMiddleware } from "./middleware.ts";

export const sandboxId = "22222222-2222-4222-8222-222222222222";
export const now = "2026-07-28T00:00:00Z";

export const sandboxRef = {
  kind: "inngest/sandbox" as const,
  version: 1 as const,
  id: sandboxId,
  name: "ci-box",
  status: "RUNNING" as const,
  vpcId: "11111111-1111-4111-8111-111111111111",
  imageRef: "default",
  resources: { vcpu: 2, memoryMb: 2048 },
  createdAt: now,
  startedAt: now,
};

const { kind: _kind, version: _version, ...resource } = sandboxRef;

/**
 * The sandbox as the REST API returns it.
 */
export const sandboxResource = resource;

/**
 * A client whose sandbox API returns `sandboxRef` for a `get`, answers other
 * paths with `route` (given the request's query and body too), and 404s the
 * rest.
 */
export const createClient = (
  route: (
    path: string,
    method: string,
    request: { query: URLSearchParams; body: unknown },
  ) => Response | undefined,
) => {
  return new Inngest({
    id: testClientId,
    signingKey: "signkey-test",
    baseUrl: "https://api.example.test",
    fetch: async (input, init) => {
      const { pathname, searchParams } = new URL(
        input instanceof Request ? input.url : input,
      );

      if (
        pathname === `/v2/sandboxes/${sandboxId}` &&
        (init?.method ?? "GET") === "GET"
      ) {
        return Response.json({ data: sandboxResource });
      }

      return (
        route(pathname, init?.method ?? "GET", {
          query: searchParams,
          body: init?.body,
        }) ??
        Response.json(
          { errors: [{ code: "missing", message: "missing" }] },
          { status: 404 },
        )
      );
    },
    middleware: [sandboxMiddleware()],
  });
};

/**
 * A client whose sandbox API creates, execs in and destroys sandboxes, with
 * the number of destroys it has served and the files uploaded to it. Every
 * command prints `stdout`, and exits with `exitCode`; downloads serve `file`.
 */
export const createScopeClient = (
  destroy: () => Response = () => new Response(null, { status: 204 }),
  { stdout = "", stderr = "", exitCode = 0, file = "" } = {},
) => {
  const calls = {
    destroys: 0,
    uploads: [] as { path: string; body: string }[],
  };

  const client = createClient((path, method, { query, body }) => {
    if (path.endsWith("/files")) {
      if (method === "PUT") {
        const upload = {
          path: query.get("path") ?? "",
          body: new TextDecoder().decode(body as Uint8Array),
        };
        calls.uploads.push(upload);

        return Response.json({
          data: { path: upload.path, bytesWritten: upload.body.length },
        });
      }

      return new Response(file);
    }

    if (path === "/v2/sandboxes" && method === "POST") {
      return Response.json({ data: sandboxResource }, { status: 201 });
    }

    if (path.endsWith("/exec")) {
      return Response.json({
        data: {
          stdout: btoa(stdout),
          stderr: btoa(stderr),
          encoding: "base64",
          exitCode,
        },
      });
    }

    if (path === `/v2/sandboxes/${sandboxId}` && method === "DELETE") {
      calls.destroys++;

      return destroy();
    }

    return undefined;
  });

  return { client, calls };
};

/**
 * Run `fn` request by request until it finishes, memoizing each step, and
 * return how it finished and the steps that ran.
 */
export const runToEnd = async (
  fn: InngestFunction.Any,
  opts?: { attempt?: number; maxAttempts?: number },
) => {
  const ran: string[] = [];
  const steps: OutgoingOp[] = [];
  let stepState: Parameters<typeof runFnWithStack>[1] = {};

  for (let request = 0; request < 20; request++) {
    const result = await runFnWithStack(fn, stepState, opts);

    if (result.type !== "step-ran") {
      return {
        type: result.type,
        ran,
        steps,
        retriable: result.type === "function-rejected" && result.retriable,
      };
    }

    const { id, data, error } = result.step;
    steps.push(result.step);
    ran.push(result.step.userland?.id ?? id);
    stepState = { ...stepState, [id]: error ? { id, error } : { id, data } };
  }

  throw new Error("The function did not finish");
};
