import { z } from "zod";
import { createInngest, cron, event, invoke, withType } from "./exp.js";

const sentEvent = event("event.sent");
const sentEvent2 = event("event.sent/2", z.object({ foo: z.boolean() }));
const sentEvent3 = event("event.sent/3", withType<{ bam: "wham" }>());
const bigCron = cron("* * 0 0 0");
const blankInvoke = invoke();
const typedInvoke = invoke<{ bar: string; baz: boolean }>();
const schemaInvoke = invoke(z.object({ bar: z.boolean() }));

// optionless by default, does not require an `appId`, but optional
const inngest = createInngest({
  events: [sentEvent2, sentEvent],
});

// events are just JSON, but can be created easily
const lol = sentEvent2({ foo: true }, { id: "123" });

// we use these helpers to send events
inngest.sendEvent(sentEvent2({ foo: "true" }));
// or include exttas
inngest.sendEvent(event("yerp")({ foo: "bar" }));
// but just JSON is always supported
inngest.sendEvents([{ name: "yep lol" }]);

inngest.createFunction({
  id: "test",
  triggers: [sentEvent, sentEvent2, bigCron, schemaInvoke, typedInvoke],
  handler: async ({ event }) => {
    if (event.name === "event.sent") {
      event.data;
    } else if (event.name === "event.sent/2") {
      event.data.foo;
    } else if (event.name === "inngest/scheduled.timer") {
      event.data.cron;
    } else if (event.name === "inngest/function.invoked") {
      event.data.bar;
    }
  },
});

// Fails if no appId present at runtime? 🤔
export default inngest.serve({
  appId: "",
  adapter,
});
