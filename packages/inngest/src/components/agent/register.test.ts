import { describe, expect, test } from "vitest";
import { createDefer } from "../DeferredFunction.ts";
import { Inngest } from "../Inngest.ts";
import { withMiddlewareFunctions } from "../InngestCommHandler.ts";
import { registeredFunctions, registerFunctions } from "./register.ts";

const ids = (
  client: Inngest.Any,
  fns: readonly { id: (p?: string) => string }[],
) => {
  return fns.map((fn) => {
    return fn.id(client.id);
  });
};

const setup = () => {
  const client = new Inngest({ id: "app" });
  const cleanup = (id: string) => {
    return createDefer(client, { id }, async () => {});
  };
  const agent = (id: string) => {
    return client.createFunction(
      { id, triggers: [{ event: `${id}/go` }] },
      async () => {},
    );
  };

  return { client, cleanup, agent };
};

describe("registerFunctions", () => {
  test("serving adds registered functions after the given ones", () => {
    const { client, cleanup, agent } = setup();
    const a = agent("a");
    registerFunctions(client, [a, cleanup("a-cleanup")]);

    expect(ids(client, withMiddlewareFunctions(client, [a]))).toEqual([
      "app-a",
      "app-a-cleanup",
    ]);
  });

  test("a client with nothing registered serves what it is given", () => {
    const { client, agent } = setup();
    const a = agent("a");

    expect(withMiddlewareFunctions(client, [a])).toEqual([a]);
  });

  test("registering the same ID twice keeps one function, the latest", () => {
    const { client, cleanup } = setup();
    const first = cleanup("shared");
    const second = cleanup("shared");
    registerFunctions(client, [first]);
    registerFunctions(client, [cleanup("other"), second]);
    registerFunctions(client, [second]);

    const registered = registeredFunctions(client);

    expect(ids(client, registered)).toEqual(["app-shared", "app-other"]);
    expect(registered[0]).toBe(second);
  });

  test("two agents sharing a function serve it once", () => {
    const { client, cleanup, agent } = setup();
    const shared = cleanup("sandbox-cleanup");
    registerFunctions(client, [agent("a"), cleanup("a-cleanup"), shared]);
    registerFunctions(client, [agent("b"), cleanup("b-cleanup"), shared]);

    expect(ids(client, withMiddlewareFunctions(client, []))).toEqual([
      "app-a",
      "app-a-cleanup",
      "app-sandbox-cleanup",
      "app-b",
      "app-b-cleanup",
    ]);
  });

  test("a function the app already lists is not served twice", () => {
    const { client, agent } = setup();
    const a = agent("a");
    registerFunctions(client, [a]);

    expect(withMiddlewareFunctions(client, [a])).toEqual([a]);
  });

  test("registries are per client", () => {
    const one = setup();
    const two = setup();
    registerFunctions(one.client, [one.agent("a")]);

    expect(withMiddlewareFunctions(two.client, [])).toEqual([]);
  });
});
