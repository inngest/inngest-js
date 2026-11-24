/**
 * @module
 * Tests for what a model reads about a tool: a string description as it is,
 * the parts of an object description in a fixed order, the `Returns:` line
 * made from an `output` schema, and `context`, which never reaches the
 * description.
 */
import { z } from "zod/v4";
import {
  renderToolDescription,
  returnsShape,
  shapeOf,
  toolContextOf,
  toolDescriptionText,
  withNote,
} from "./toolDescription.ts";
import {
  bindSandbox,
  type SandboxTool,
  tool,
  toolDefinitions,
} from "./tools.ts";
import type { SandboxHandle } from "./types.ts";

describe("a string description", () => {
  test("is used as it is", () => {
    expect(renderToolDescription("Looks up an order")).toBe(
      "Looks up an order",
    );
    expect(toolContextOf("Looks up an order")).toBeUndefined();
  });
});

describe("an object description", () => {
  test("renders does, use and avoid in that order, as one paragraph", () => {
    expect(
      toolDescriptionText({
        avoid: "for refunds",
        use: "when the user names an order",
        does: "Looks up an order",
      }),
    ).toBe(
      "Looks up an order. Use it when the user names an order. Don't use it for refunds.",
    );
  });

  test("keeps a use or avoid that is already a whole sentence", () => {
    expect(
      toolDescriptionText({
        does: "Answers a question.",
        use: "Only for a question that has an ID.",
        avoid: "Never to send results.",
      }),
    ).toBe(
      "Answers a question. Only for a question that has an ID. Never to send results.",
    );
  });

  test("does alone is enough", () => {
    expect(toolDescriptionText({ does: "pings the host" })).toBe(
      "Pings the host.",
    );
  });

  test("its context is not in the description, but can be read", () => {
    const description = {
      does: "Sends a message to the person.",
      context: "Only messages sent with `chat` reach the person",
    };

    expect(renderToolDescription(description)).toBe(
      "Sends a message to the person.",
    );
    expect(toolContextOf(description)).toBe(
      "Only messages sent with `chat` reach the person.",
    );
  });

  test("a note goes after what the tool does and keeps the context", () => {
    expect(
      withNote(
        { does: "Runs a command.", use: "to test", context: "Fact." },
        "Works on the `box` sandbox.",
      ),
    ).toEqual({
      does: "Runs a command. Works on the `box` sandbox.",
      use: "to test",
      context: "Fact.",
    });
    expect(withNote("Runs a command.", "Works on it.")).toBe(
      "Runs a command. Works on it.",
    );
  });

  test("a tool listed on a sandbox keeps its context", () => {
    const bound = bindSandbox(
      tool.group({
        description: { does: "Runs.", context: "Commands are logged." },
        run: async () => {
          return null;
        },
      }),
      {} as SandboxHandle,
      "box",
    ) as SandboxTool;

    expect(toolContextOf(bound.description)).toBe("Commands are logged.");
    expect(toolDefinitions({ run: bound })[0]?.description).toBe(
      "Runs. Works on the `box` sandbox.",
    );
  });
});

describe("the Returns line", () => {
  test("comes from the output schema, after the description", () => {
    expect(
      renderToolDescription(
        { does: "Starts an agent", use: "to hand off work" },
        z.object({ thread: z.string(), note: z.string().optional() }),
      ),
    ).toBe(
      "Starts an agent. Use it to hand off work. Returns: { thread: string, note?: string }",
    );
  });

  test("is there for a string description too", () => {
    expect(
      renderToolDescription("Counts", z.object({ n: z.number().int() })),
    ).toBe("Counts. Returns: { n: number }");
  });

  test("toolDefinitions shows it, so the model reads what the code returns", () => {
    const [definition] = toolDefinitions({
      ask: tool({
        description: { does: "Asks a question." },
        output: z.object({ id: z.string() }),
        run: async () => {
          return { id: "q1" };
        },
      }),
    });

    expect(definition?.description).toBe(
      "Asks a question. Returns: { id: string }",
    );
  });

  test("shapes: literals, unions, arrays, records and nesting", () => {
    expect(
      returnsShape(
        z.union([
          z.object({ outcome: z.literal("completed"), output: z.any() }),
          z.object({ outcome: z.literal("failed"), error: z.string() }),
        ]),
      ),
    ).toBe(
      '{ outcome: "completed", output: any } | { outcome: "failed", error: string }',
    );
    expect(
      returnsShape(
        z.object({
          agents: z.array(
            z.object({
              effects: z.enum(["read", "write"]),
              tags: z.array(z.string()),
            }),
          ),
          counts: z.record(z.string(), z.number()),
          maybe: z.string().nullable(),
        }),
      ),
    ).toBe(
      '{ agents: { effects: "read" | "write", tags: string[] }[], counts: Record<string, number>, maybe: string | null }',
    );
    expect(
      shapeOf({
        type: "array",
        items: { anyOf: [{ type: "string" }, { type: "number" }] },
      }),
    ).toBe("(string | number)[]");
  });

  test("a schema that can't be shown gives no Returns line", () => {
    const opaque = {
      "~standard": {
        version: 1,
        vendor: "opaque",
        validate: (value: unknown) => {
          return { value };
        },
      },
    } as const;

    expect(renderToolDescription("Counts", opaque)).toBe("Counts");
  });
});
