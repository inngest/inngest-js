/**
 * @module
 * Type tests for the model's inbox tools: `source` is typed from the names in
 * `listen`, `match` is a record of scalars keyed by paths under `data`, and
 * the tools exist only for a non-empty `listen`.
 */
import { z } from "zod";
import { eventType } from "../../../components/triggers/triggers.ts";
import type { InputOf } from "../agent/typeFixtures.ts";
import { createListenTools } from "./inboxTools.ts";

const pullRequest = eventType("github/pull_request", {
  schema: z.object({ pull_request: z.object({ number: z.number() }) }),
});
const status = eventType("ci/status", { schema: z.object({ n: z.number() }) });
const open = async () => {
  return { close: async () => [] };
};

describe("tools: inbox_listen", () => {
  test("tools: inbox_listen takes a source from listen and gives a name", () => {
    const check = () => {
      const tools = createListenTools({ open }, [pullRequest, status]);

      type Listen = InputOf<typeof tools.inbox_listen>;

      expectTypeOf<Listen["source"]>().toEqualTypeOf<
        "github/pull_request" | "ci/status"
      >();
      expectTypeOf<Listen["match"]>().toEqualTypeOf<
        Record<string, string | number | boolean> | undefined
      >();
      expectTypeOf<Listen["as"]>().toBeString();
      expectTypeOf<InputOf<typeof tools.inbox_close>["as"]>().toBeString();

      // @ts-expect-error a plain name is not an event type
      createListenTools({ open }, ["ci/status"]);
    };

    expect(check).toBeTypeOf("function");
  });

  test("tools: an empty listen has neither tool", () => {
    const check = () => {
      const tools = createListenTools({ open }, []);

      expectTypeOf(tools).not.toHaveProperty("inbox_listen");
      expectTypeOf(tools).not.toHaveProperty("inbox_close");
    };

    expect(check).toBeTypeOf("function");
  });
});
