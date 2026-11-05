/**
 * @module
 * Type tests for the model's agent tools: in the result of a handler's loop,
 * a call narrows by the tool's name to its typed input and output.
 */

import type { Json } from "../json.ts";
import { type AgentModelResponse, agentModel } from "../loop/loop.ts";
import { agents, created, typesOnly } from "./typeFixtures.ts";

const model = agentModel(async (): Promise<AgentModelResponse> => {
  return { message: { role: "assistant", content: [] }, toolCalls: [] };
});

describe("messaging types", () => {
  test("messaging: the agent tools narrow in a loop result with typed input and output", () => {
    typesOnly(() => {
      agents.agent(
        { id: "tools-1", triggers: [created], model },
        async ({ inbox, loop }) => {
          const result = await loop(await inbox.drain());

          for (const call of result.toolCalls) {
            if (call.isError) {
              continue;
            }

            if (call.name === "start_agent") {
              expectTypeOf(call.call.input).toEqualTypeOf<{
                address: string;
                input?: Json;
                group?: string;
                attach?: boolean;
              }>();
              expectTypeOf(call.output).toEqualTypeOf<{ thread: string }>();
            }

            if (call.name === "message_agent") {
              expectTypeOf(call.call.input).toEqualTypeOf<{
                thread: string;
                content: Json;
              }>();
              expectTypeOf(call.output).toEqualTypeOf<{ ok: true }>();
            }

            if (call.name === "ask_agent") {
              expectTypeOf(call.call.input).toEqualTypeOf<{
                thread: string;
                question: string;
              }>();
              expectTypeOf(call.output).toEqualTypeOf<{ id: string }>();
            }

            if (call.name === "reply") {
              expectTypeOf(call.call.input).toEqualTypeOf<{
                to: string;
                text: string;
              }>();
              expectTypeOf(call.output).toEqualTypeOf<{ ok: true }>();
            }

            if (call.name === "stop_agent") {
              expectTypeOf(call.call.input).toEqualTypeOf<{ thread: string }>();
              expectTypeOf(call.output).toEqualTypeOf<{ ok: true }>();
            }
          }

          return null;
        },
      );
    });
  });
});
