/**
 * @module
 * Type tests for discovery: the card, the `card` and `discovery` fields of
 * a definition, and a summary.
 */

import { agents, created, typesOnly } from "../agent/typeFixtures.ts";
import type { AgentCard, AgentSummary, Json, JsonSchema } from "../index.ts";
import { type AgentModelResponse, agentModel } from "../loop/loop.ts";

const model = agentModel(async (): Promise<AgentModelResponse> => {
  return { message: { role: "assistant", content: [] }, toolCalls: [] };
});

describe("discovery types", () => {
  test("discovery: a card has the documented fields and no others", () => {
    expectTypeOf<AgentCard>().toEqualTypeOf<{
      kind?: "tool";
      address: string;
      description?: string;
      input?: JsonSchema;
      skills?: { name: string; description: string }[];
      tags?: string[];
      source?: { file: string; line: number; column?: number };
      tools?: {
        name: string;
        description?: string;
        source?: { file: string; line: number; column?: number };
      }[];
      explicit?: boolean;
      share: "private" | "team";
      owner?: string;
      effects: "read" | "write";
      speed?: "seconds" | "minutes";
      paused?: boolean;
    }>();
  });

  test("discovery: the deleted card fields are gone", () => {
    expectTypeOf<AgentCard>().not.toHaveProperty("agentId");
    expectTypeOf<AgentCard>().not.toHaveProperty("app");
    expectTypeOf<AgentCard>().not.toHaveProperty("functionId");
    expectTypeOf<AgentCard>().not.toHaveProperty("mode");
    expectTypeOf<AgentCard>().not.toHaveProperty("output");
    expectTypeOf<AgentCard>().not.toHaveProperty("version");
    expectTypeOf<AgentCard>().not.toHaveProperty("triggers");
    expectTypeOf<AgentCard>().not.toHaveProperty("message");
    expectTypeOf<AgentCard>().not.toHaveProperty("does");
    expectTypeOf<AgentCard>().not.toHaveProperty("call");
  });

  test("discovery: the card field on the definition is optional and its share is private or team", () => {
    typesOnly(() => {
      agents.agent({ id: "card-1", triggers: [created] });

      agents.agent({
        id: "card-2",
        triggers: [created],
        card: { description: "Orders", share: "private" },
      });

      agents.agent({
        id: "card-3",
        triggers: [created],
        // @ts-expect-error share is private or team
        card: { share: "public" },
      });

      agents.agent({
        id: "card-4",
        triggers: [created],
        // @ts-expect-error effects are read or write
        card: { effects: "any" },
      });

      agents.agent({
        id: "card-5",
        triggers: [created],
        // @ts-expect-error needs-approval is not a value until approvals ship
        card: { effects: "needs-approval" },
      });

      // @ts-expect-error the flat card fields are gone
      agents.agent({ id: "card-6", triggers: [created], share: "team" });
    });
  });

  test("discovery: a card's input is a JSON Schema", () => {
    expectTypeOf<AgentCard["input"]>().toEqualTypeOf<JsonSchema | undefined>();
    expectTypeOf<JsonSchema>().toExtend<{ [key: string]: Json }>();
  });

  test("discovery: list_agents takes a query and refresh and gives summaries", () => {
    typesOnly(() => {
      agents.agent(
        { id: "list-1", triggers: [created], model },
        async ({ inbox, loop }) => {
          const result = await loop(await inbox.drain());

          for (const call of result.toolCalls) {
            if (!call.isError && call.name === "list_agents") {
              expectTypeOf(call.call.input).toEqualTypeOf<{
                query?: string;
                refresh?: boolean;
              }>();
              expectTypeOf(call.output).toEqualTypeOf<{
                agents: AgentSummary[];
              }>();
            }
          }

          return null;
        },
      );
    });
  });

  test("discovery: describe_agent takes an address and gives the whole card", () => {
    typesOnly(() => {
      agents.agent(
        { id: "describe-1", triggers: [created], model },
        async ({ inbox, loop }) => {
          const result = await loop(await inbox.drain());

          for (const call of result.toolCalls) {
            if (!call.isError && call.name === "describe_agent") {
              expectTypeOf(call.call.input).toEqualTypeOf<{
                address: string;
              }>();
              expectTypeOf(call.output).toEqualTypeOf<AgentCard>();
            }
          }

          return null;
        },
      );
    });
  });

  test("discovery: a summary is a part of a card", () => {
    expectTypeOf<AgentSummary>().toEqualTypeOf<
      Pick<
        AgentCard,
        "address" | "description" | "skills" | "tags" | "effects" | "paused"
      >
    >();
  });

  test("discovery: discovery is false or an object with prepare", () => {
    typesOnly(() => {
      agents.agent({ id: "disc-1", triggers: [created], discovery: false });

      agents.agent({
        id: "disc-2",
        triggers: [created],
        discovery: {
          prepare: ({ card, input, event, thread }) => {
            expectTypeOf(card).toEqualTypeOf<AgentCard>();
            expectTypeOf(input).toEqualTypeOf<Record<string, Json>>();
            expectTypeOf(event.name).toBeString();
            expectTypeOf(thread.key).toBeString();

            return { ...input, origin: "web" };
          },
        },
      });

      // @ts-expect-error discovery is false or an object
      agents.agent({ id: "disc-3", triggers: [created], discovery: "off" });
    });
  });
});
