/**
 * @module
 * Type tests for the public types of the agents entry: no member of a data
 * type, of the KV object or of a scope is `any`, and the default type
 * arguments of a result and a tool run are not `any`.
 */

import type {
  AgentCard,
  AgentLoopResult,
  AgentModelResponse,
  AgentToolCall,
  AgentToolRun,
  AgentTurn,
  AgentUsage,
  AnthropicOptions,
} from "../index.ts";
import type { kv } from "../kv/kv.ts";
import type { AnyMembers } from "./typeFixtures.ts";

describe("public types hold no any", () => {
  test("no any: no member of a data type is any", () => {
    expectTypeOf<AnyMembers<AgentCard>>().toBeNever();
    expectTypeOf<AnyMembers<AgentUsage>>().toBeNever();
    expectTypeOf<AnyMembers<AgentTurn>>().toBeNever();
    expectTypeOf<AnyMembers<AgentToolCall>>().toBeNever();
    expectTypeOf<AnyMembers<AgentModelResponse>>().toBeNever();
    expectTypeOf<AnyMembers<AnthropicOptions>>().toBeNever();
  });

  test("no any: no member of the kv object or of a scope is any", () => {
    expectTypeOf<AnyMembers<typeof kv>>().toBeNever();
    expectTypeOf<AnyMembers<typeof kv.thread>>().toBeNever();
  });

  test("no any: the default type arguments of a result and a tool run are not any", () => {
    expectTypeOf<AnyMembers<AgentLoopResult>>().toBeNever();
    expectTypeOf<AgentToolRun["call"]["input"]>().not.toBeAny();
    expectTypeOf<AgentToolRun["output"]>().not.toBeAny();
  });
});
