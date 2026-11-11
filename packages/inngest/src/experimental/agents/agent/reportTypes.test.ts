/**
 * @module
 * Type tests for the documented way to read an arriving REPORT.
 *
 * The limitation and the workaround are written on `AgentMessage` in
 * `types.ts`, and that comment is the primary documentation for them, so the
 * form it tells people to write is compiled here. A doc snippet nobody
 * compiles is a snippet that tells users to write code that does not build.
 */

import { z } from "zod";
import { eventType } from "../../../components/triggers/triggers.ts";
import { agents, created, typesOnly } from "./typeFixtures.ts";

const findingSchema = z.object({ severity: z.string(), note: z.string() });
const finding = eventType("review/finding", { schema: findingSchema });

describe("reading an arriving report", () => {
  test("the documented form compiles: widen to name and data, then parse", () => {
    typesOnly(() => {
      agents.agent(
        { id: "reports-1", triggers: [created] },
        async ({ inbox }) => {
          for await (const message of inbox) {
            // What the comment on `AgentMessage` tells a user to write. No cast:
            // the message is widened to the two fields the check needs, and the
            // data is parsed with the report type's own schema, so it is typed
            // AND checked rather than typed and trusted.
            const named: { name: string; data: unknown } = message;

            if (named.name === finding.name) {
              const found = findingSchema.parse(named.data);

              expectTypeOf(found).toEqualTypeOf<{
                severity: string;
                note: string;
              }>();
            }
          }

          return null;
        },
      );
    });
  });

  test("narrowing the agent's own events still works beside it", () => {
    typesOnly(() => {
      agents.agent(
        { id: "reports-2", triggers: [created] },
        async ({ inbox }) => {
          for await (const message of inbox) {
            const named: { name: string; data: unknown } = message;

            if (named.name === finding.name) {
              findingSchema.parse(named.data);

              continue;
            }

            // The widening is a local alias, so `message` itself is untouched
            // and narrows as it always did.
            if (message.is(created)) {
              expectTypeOf(message.data).toEqualTypeOf<{
                id: string;
                total: number;
              }>();
            }
          }

          return null;
        },
      );
    });
  });
});
