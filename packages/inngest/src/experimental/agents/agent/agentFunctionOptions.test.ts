/**
 * @module
 * Type tests for the options of an agent function and the inbox wait: every
 * option of `AgentFunctionOptions` is taken or refused (so a new one cannot
 * be dropped), and `inbox.next()` is `null` at the end and `undefined` when a
 * timeout expires.
 */
import { z } from "zod";
import { Inngest } from "../../../components/Inngest.ts";
import { eventType } from "../../../components/triggers/triggers.ts";
import { testClientId } from "../../../test/helpers.ts";
import { createAgents } from "./agents.ts";
import {
  type AgentFunctionOptions,
  refusedOptions,
  takenOptions,
} from "./options.ts";

const order = eventType("shop/order.created", {
  schema: z.object({ id: z.string() }),
});
const agents = createAgents(new Inngest({ id: testClientId }));

type Listed = (typeof takenOptions)[number] | (typeof refusedOptions)[number];

describe("AgentFunctionOptions", () => {
  test("every option is taken or refused, and none is both", () => {
    expectTypeOf<Exclude<keyof AgentFunctionOptions, Listed>>().toBeNever();
    expectTypeOf<Exclude<Listed, keyof AgentFunctionOptions>>().toBeNever();

    const both = takenOptions.filter((key) => {
      return (refusedOptions as readonly string[]).includes(key);
    });

    expect(both).toEqual([]);
  });
});

describe("inbox.next", () => {
  test("undefined ends the inbox and null is an expired timeout", () => {
    const check = () => {
      agents.agent({ id: "waiter", triggers: order }, async ({ inbox }) => {
        const ended = await inbox.next();

        expectTypeOf(ended).toEqualTypeOf<
          Awaited<ReturnType<typeof inbox.drain>>[number] | undefined
        >();

        const waited = await inbox.next({ timeout: "1m" });

        expectTypeOf(waited).toEqualTypeOf<typeof ended | null>();

        if (waited === null) {
          return "expired";
        }

        if (waited === undefined) {
          return "closed";
        }

        expectTypeOf(waited.name).toBeString();

        return "message";
      });
    };

    expect(check).toBeTypeOf("function");
  });
});
