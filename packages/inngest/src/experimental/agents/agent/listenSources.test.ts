/**
 * @module
 * Tests for an agent's `listen` list: what a definition may say, and what a
 * thread subscribes with for one request of the model.
 */
import { Inngest } from "../../../components/Inngest.ts";
import { eventType } from "../../../components/triggers/triggers.ts";
import { testClientId } from "../../../test/helpers.ts";
import type {
  AgentModelResponse,
  AgentToolCall,
  ModelMessage,
} from "../loop/loop.ts";
import { model } from "../loop/loopKit.ts";
import { createAgentFunction } from "./agentFunction.ts";
import {
  compileListenSources,
  type ListenSource,
  listenSourcesText,
  resolveListen,
} from "./listenSources.ts";
import { freshKv, run } from "./test-helpers.ts";

const context = {
  event: {
    name: "app/user.message",
    data: {
      org: "acme",
    },
  },
  thread: {
    key: "acme/api",
  },
};

const resolve = (
  sources: readonly ListenSource[],
  asked: Parameters<typeof resolveListen>[2],
) => {
  return resolveListen(compileListenSources("bot", sources), context, asked);
};

const reviewed: ListenSource = {
  event: "github/pull_request.review",
  scope: ({ thread }) => {
    return { "data.repo": thread.key };
  },
};

describe("a listen list, when the agent is defined", () => {
  test("an event may be a name, an event type or a list of them", () => {
    const paid = eventType("billing/invoice.paid");
    const compiled = compileListenSources("bot", [
      {
        event: [paid, "billing/invoice.failed"],
        description: "An invoice changed.",
        scope: { "data.org": "acme" },
      },
      {
        event: "billing/*",
        scope: "any",
      },
    ]);

    expect(
      compiled.map((source) => {
        return [source.name, source.pattern, source.description];
      }),
    ).toEqual([
      ["billing/invoice.paid", false, "An invoice changed."],
      ["billing/invoice.failed", false, "An invoice changed."],
      ["billing/", true, undefined],
    ]);
  });

  test.each([
    ["agent/thread.write"],
    ["agent/*"],
    ["inngest/function.finished"],
    ["inngest/*"],
  ])("a reserved name is refused: %s", (event) => {
    expect(() => {
      return compileListenSources("bot", [{ event, scope: "any" }]);
    }).toThrow(/is reserved/);
  });

  test.each([["*"], [""], ["billing/*/paid"], ["*/paid"]])(
    "a name that is not an event name or a pattern is refused: %j",
    (event) => {
      expect(() => {
        return compileListenSources("bot", [{ event, scope: "any" }]);
      }).toThrow(/is not an event name/);
    },
  );

  test("an empty scope is refused, so an unfiltered watch is always written as any", () => {
    expect(() => {
      return compileListenSources("bot", [{ event: "ci/status", scope: {} }]);
    }).toThrow(/empty `scope`/);
  });

  test("a missing scope is refused", () => {
    expect(() => {
      return compileListenSources("bot", [
        { event: "ci/status" } as unknown as ListenSource,
      ]);
    }).toThrow(/has no `scope`/);
  });

  test("a scope path that is not a path into an event is refused", () => {
    expect(() => {
      return compileListenSources("bot", [
        { event: "ci/status", scope: { 'data.x == 1 || async.name != ""': 1 } },
      ]);
    }).toThrow(/is not a path into an event/);
  });

  test("an event listed twice is refused", () => {
    expect(() => {
      return compileListenSources("bot", [
        { event: "ci/status", scope: "any" },
        { event: ["ci/status"], scope: "any" },
      ]);
    }).toThrow(/is there twice/);
  });

  test("a bad list fails the definition of the agent", () => {
    expect(() => {
      return createAgentFunction(new Inngest({ id: testClientId }), {
        id: "bot",
        listen: [{ event: "agent/thread.forward", scope: "any" }],
      });
    }).toThrow(/is reserved/);
  });
});

describe("what a thread subscribes with", () => {
  test("the scope alone, when the model gives no where", () => {
    expect(
      resolve([reviewed], { event: "github/pull_request.review" }),
    ).toEqual({
      event: "github/pull_request.review",
      if: 'async.data.repo == "acme/api"',
      where: "",
    });
  });

  test("the scope first and the model's where after it", () => {
    expect(
      resolve([reviewed], {
        event: "github/pull_request.review",
        where: { "data.number": 412 },
      }),
    ).toEqual({
      event: "github/pull_request.review",
      if: 'async.data.repo == "acme/api" && async.data.number == 412',
      where: "async.data.number == 412",
    });
  });

  test("a where that repeats the scope's value adds nothing", () => {
    expect(
      resolve([reviewed], {
        event: "github/pull_request.review",
        where: { "data.repo": "acme/api" },
      }).if,
    ).toBe('async.data.repo == "acme/api"');
  });

  test("a where that changes a path the scope sets is refused", () => {
    expect(() => {
      return resolve([reviewed], {
        event: "github/pull_request.review",
        where: { "data.repo": "other/repo" },
      });
    }).toThrow(/You cannot set "data.repo"/);
  });

  test("an event that is not in the list is refused, and the model is told what is", () => {
    expect(() => {
      return resolve([reviewed], { event: "app/user.message" });
    }).toThrow(
      'Your thread cannot watch "app/user.message". It can watch: `github/pull_request.review`.',
    );
  });

  test.each([
    ["agent/thread.write"],
    ["agent/thread.forward"],
    ["inngest/function.finished"],
  ])("a reserved name is refused whatever the list says: %s", (event) => {
    // a pattern this wide cannot be written for `agent/`, and a short one such
    // as `a*` still must not reach it.
    expect(() => {
      return resolve([{ event: ["a*", "i*"], scope: "any" }], { event });
    }).toThrow(/cannot watch/);
  });

  test("a value from an event is quoted, so it cannot change the filter", () => {
    const hostile = 'x" || true || "';

    expect(
      resolve(
        [
          {
            event: "billing/invoice.paid",
            scope: () => {
              return { "data.org": hostile };
            },
          },
        ],
        { event: "billing/invoice.paid" },
      ).if,
    ).toBe(`async.data.org == ${JSON.stringify(hostile)}`);
  });

  test("the scope function gets the start event, the thread and what was asked", () => {
    const seen: unknown[] = [];

    resolve(
      [
        {
          event: "billing/invoice.paid",
          scope: (given) => {
            seen.push(given);

            return "any";
          },
        },
      ],
      {
        event: "billing/invoice.paid",
        where: { "data.invoice": "inv_9" },
        reason: "the customer asked",
      },
    );

    expect(seen).toEqual([
      {
        ...context,
        asked: {
          event: "billing/invoice.paid",
          where: { "data.invoice": "inv_9" },
          reason: "the customer asked",
        },
      },
    ]);
  });

  test("a scope that returns false refuses the request", () => {
    const sources: ListenSource[] = [
      {
        event: "billing/invoice.paid",
        scope: ({ asked }) => {
          return asked.where?.["data.invoice"] === undefined
            ? false
            : { "data.org": "acme" };
        },
      },
    ];

    expect(() => {
      return resolve(sources, { event: "billing/invoice.paid" });
    }).toThrow(/does not watch "billing\/invoice.paid" as you asked/);
    expect(
      resolve(sources, {
        event: "billing/invoice.paid",
        where: { "data.invoice": "inv_9" },
      }).if,
    ).toBe('async.data.org == "acme" && async.data.invoice == "inv_9"');
  });

  test("a scope that returns nothing refuses the request", () => {
    expect(() => {
      return resolve(
        [
          {
            event: "ci/status",
            scope: (() => {
              return undefined;
            }) as unknown as ListenSource["scope"],
          },
        ],
        { event: "ci/status" },
      );
    }).toThrow(/does not watch/);
  });

  test("a scope function that returns no paths is refused", () => {
    expect(() => {
      return resolve(
        [
          {
            event: "ci/status",
            scope: () => {
              return {};
            },
          },
        ],
        { event: "ci/status" },
      );
    }).toThrow(/returned no paths/);
  });

  test("any gives a watch with only the model's where", () => {
    const sources: ListenSource[] = [
      { event: "status/incident.opened", scope: "any" },
    ];

    expect(resolve(sources, { event: "status/incident.opened" })).toEqual({
      event: "status/incident.opened",
      where: "",
    });
    expect(
      resolve(sources, {
        event: "status/incident.opened",
        where: { "data.severity": "high" },
      }),
    ).toEqual({
      event: "status/incident.opened",
      if: 'async.data.severity == "high"',
      where: 'async.data.severity == "high"',
    });
  });
});

describe("a pattern in the list", () => {
  const sources: ListenSource[] = [
    {
      event: "billing/*",
      scope: ({ asked }) => {
        return { "data.via": `pattern:${asked.event}` };
      },
    },
    {
      event: "billing/invoice/*",
      scope: { "data.via": "longer" },
    },
    {
      event: "billing/invoice/paid",
      scope: { "data.via": "exact" },
    },
  ];

  test("lets the model name any one event that starts with it", () => {
    expect(resolve(sources, { event: "billing/card.updated" })).toEqual({
      event: "billing/card.updated",
      if: 'async.data.via == "pattern:billing/card.updated"',
      where: "",
    });
  });

  test("the longer pattern is used before the shorter, and the exact name before both", () => {
    expect(resolve(sources, { event: "billing/invoice/failed" }).if).toBe(
      'async.data.via == "longer"',
    );
    expect(resolve(sources, { event: "billing/invoice/paid" }).if).toBe(
      'async.data.via == "exact"',
    );
  });

  test("the model cannot ask for the pattern itself", () => {
    expect(() => {
      return resolve(sources, { event: "billing/*" });
    }).toThrow(/name the event itself/);
  });

  test("a name outside the pattern is refused", () => {
    expect(() => {
      return resolve(sources, { event: "app/user.message" });
    }).toThrow(/cannot watch "app\/user.message"/);
  });
});

const say = (text: string): AgentModelResponse => {
  return {
    message: {
      role: "assistant",
      content: [{ type: "text", text }],
    },
    text,
    toolCalls: [],
  };
};

const calling = (...calls: AgentToolCall[]): AgentModelResponse => {
  return {
    message: {
      role: "assistant",
      content: calls.map((call) => {
        return {
          type: "tool_use",
          id: call.id,
          name: call.name,
          input: call.input,
        };
      }),
    } as never,
    toolCalls: calls,
  };
};

/**
 * An agent whose model plays `script` in one `loop()` call. `requests` has
 * the tools and the messages of each model call.
 */
const make = (script: AgentModelResponse[], listen?: ListenSource[]) => {
  freshKv();

  const requests: { tools: string[]; messages: ModelMessage[] }[] = [];
  const { fn } = createAgentFunction(
    new Inngest({ id: testClientId }),
    {
      id: "bot",
      discovery: false,
      ...(listen && { listen }),
      model: model(async (request) => {
        requests.push({
          tools: (request.tools ?? []).map((one) => {
            return one.name;
          }),
          messages: structuredClone(request.messages),
        });

        return script[requests.length - 1] ?? say("done");
      }),
    },
    async ({ inbox, loop }) => {
      await inbox.next();
      await loop("go");

      return "ok";
    },
  );

  return { fn, requests };
};

const start = {
  name: "agent/message",
  data: {
    agent: `${testClientId}/bot`,
    thread: "acme/api",
    content: "go",
  },
};

const toolResults = (messages: ModelMessage[]) => {
  return messages.flatMap((message) => {
    return message.role === "tool" ? message.results : [];
  });
};

describe("the model's listen tool", () => {
  test("an agent with no list gets neither listen nor unlisten", async () => {
    const { fn, requests } = make([say("done")]);

    await run(fn, { event: start });

    expect(requests[0]?.tools).toEqual(["wait"]);
  });

  test("an agent with a list gets both, and the tool names the events", async () => {
    const { fn, requests } = make([say("done")], [reviewed]);

    await run(fn, { event: start });

    expect(requests[0]?.tools).toEqual(["wait", "listen", "unlisten"]);
  });

  test("the list reads as one sentence, with each event's description", () => {
    expect(
      listenSourcesText(
        compileListenSources("bot", [
          {
            event: "github/pull_request.review",
            description: "A review was submitted.",
            scope: "any",
          },
          {
            event: "billing/*",
            scope: "any",
          },
        ]),
      ),
    ).toBe(
      "`github/pull_request.review`: A review was submitted; `billing/*` (any one event whose name starts with `billing/`; name the event itself)",
    );
  });

  test("a listed event reaches the thread with the scope in its filter", async () => {
    const { fn, requests } = make(
      [
        calling({
          id: "l1",
          name: "listen",
          input: {
            event: "github/pull_request.review",
            where: { "data.number": 412 },
            reason: "watch PR 412",
          },
        }),
        say("done"),
      ],
      [reviewed],
    );
    const { sent } = await run(fn, { event: start });
    const asked = sent.filter((event) => {
      return event.name === "agent/thread.listen";
    });

    expect(asked).toHaveLength(1);
    expect((asked[0]?.data as { listen?: unknown }).listen).toEqual({
      event: "github/pull_request.review",
      if: 'async.data.repo == "acme/api" && async.data.number == 412',
      where: "async.data.number == 412",
      asked: "watch PR 412",
    });
    expect(JSON.stringify(toolResults(requests[1]?.messages ?? []))).toContain(
      "Your thread is watching for github/pull_request.review",
    );
  });

  test.each([
    ["app/user.message"],
    ["agent/thread.forward"],
    ["agent/thread.write"],
    ["inngest/function.finished"],
  ])(
    "an event that is not listed never reaches the thread: %s",
    async (event) => {
      const { fn, requests } = make(
        [
          calling({
            id: "l1",
            name: "listen",
            input: { event },
          }),
          say("done"),
        ],
        [reviewed],
      );
      const { sent } = await run(fn, { event: start });
      const results = toolResults(requests[1]?.messages ?? []);

      expect(
        sent.filter((one) => {
          return one.name === "agent/thread.listen";
        }),
      ).toEqual([]);
      expect(results).toHaveLength(1);
      expect((results[0] as { isError?: boolean }).isError).toBe(true);
      expect(JSON.stringify(results[0])).toContain(
        `Your thread cannot watch \\"${event}\\"`,
      );
    },
  );

  test("unlisten names the watch by the event and the model's where, not by the scope", async () => {
    const { fn } = make(
      [
        calling({
          id: "u1",
          name: "unlisten",
          input: {
            event: "github/pull_request.review",
            where: { "data.number": 412 },
          },
        }),
        say("done"),
      ],
      [reviewed],
    );
    const { sent } = await run(fn, { event: start });
    const asked = sent.find((event) => {
      return event.name === "agent/thread.listen";
    });

    expect(asked?.data).toMatchObject({
      remove: true,
      listen: {
        event: "github/pull_request.review",
        where: "async.data.number == 412",
      },
    });
  });
});

describe("the handler's thread.listen()", () => {
  test.each([
    ["agent/thread.write"],
    ["inngest/function.finished"],
    ["billing/*"],
  ])("refuses a reserved name: %s", async (event) => {
    freshKv();

    const { fn } = createAgentFunction(
      new Inngest({ id: testClientId }),
      { id: "bot" },
      async ({ inbox, thread }) => {
        await inbox.next();

        return thread.listen(event);
      },
    );
    const { error, sent } = await run(fn, { event: start });

    expect(String((error as { message?: string })?.message ?? error)).toContain(
      `A thread cannot watch "${event}"`,
    );
    expect(
      sent.filter((one) => {
        return one.name === "agent/thread.listen";
      }),
    ).toEqual([]);
  });

  test("is not limited by the agent's list", async () => {
    freshKv();

    const { fn } = createAgentFunction(
      new Inngest({ id: testClientId }),
      {
        id: "bot",
        listen: [reviewed],
      },
      async ({ inbox, thread }) => {
        await inbox.next();

        return thread.listen("ci/status", { "data.state": "red" });
      },
    );
    const { output, sent } = await run(fn, { event: start });
    const asked = sent.find((one) => {
      return one.name === "agent/thread.listen";
    });

    expect(output).toBe(true);
    expect((asked?.data as { listen?: unknown }).listen).toEqual({
      event: "ci/status",
      if: 'async.data.state == "red"',
    });
  });
});
