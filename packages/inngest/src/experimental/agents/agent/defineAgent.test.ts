/**
 * @module
 * Tests for defining an agent: the optional handler, `idle`, the value or
 * function fields and the run's end.
 */
import { Inngest } from "../../../components/Inngest.ts";
import { testClientId } from "../../../test/helpers.ts";
import { createKv, memoryKvAdapter } from "../kv/kv.ts";
import { createAgentFunction } from "./agentFunction.ts";
import { createAgents } from "./agents.ts";
import { run } from "./test-helpers.ts";

const makeClient = () => {
  return new Inngest({ id: testClientId });
};

describe("an agent with no handler", () => {
  test("runs, posts nothing and ends with output undefined", async () => {
    const agents = createAgents(makeClient(), { store: memoryKvAdapter() });
    const defined = agents.agent({
      id: "plain",
      triggers: [{ event: "shop/order", thread: "event.data.id" }],
    });

    const { output, error, waiting } = await run(defined.fn, {
      event: { name: "shop/order", data: { id: "o1" } },
    });

    expect(error).toBeUndefined();
    expect(waiting).toBe(false);
    // The executor stores a missing output as null.
    expect(output ?? undefined).toBeUndefined();
  });

  test("createAgentFunction takes no body", async () => {
    const { fn } = createAgentFunction(makeClient(), {
      id: "plain",
      kv: createKv({ adapter: memoryKvAdapter() }),
      triggers: { event: "shop/order", thread: "event.data.id" },
    });

    const { output, error, waiting } = await run(fn, {
      event: { name: "shop/order", data: { id: "o1" } },
    });

    expect(error).toBeUndefined();
    expect(waiting).toBe(false);
    // The executor stores a missing output as null.
    expect(output ?? undefined).toBeUndefined();
  });
});
