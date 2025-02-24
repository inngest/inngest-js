import { z } from "zod";
import { createApp } from "./components/app.js";
import { cron, event, invoke, withType } from "./components/trigger.js";

const sentEvent = event("event.sent");
const sentEvent2 = event("event.sent/2", {
  schema: z.object({ foo: z.boolean() }),
});
const sentEvent3 = event("event.sent/3", {
  schema: withType<{ bam: "wham" }>(),
});
const bigCron = cron("* * 0 0 0");
const blankInvoke = invoke();
const typedInvoke = invoke({
  schema: withType<{ bar: string; baz: boolean }>(),
});
const schemaInvoke = invoke({ schema: z.object({ bar: z.boolean() }) });

const inngest = createApp({
  appId: "test",
});

// events are just JSON, but can be created easily
const lol = sentEvent2({ foo: true });

// we use these helpers to send events
inngest.sendEvent(sentEvent2({ foo: false }));
// or create one immediately
inngest.sendEvent(event("yerp")({ foo: "bar" }));
// but just JSON is always supported
inngest.sendEvents([{ name: "yep lol" }]);

inngest.createFunction({
  id: "test",
  triggers: [
    sentEvent,
    sentEvent2.if("event.data.userId == 1"),
    bigCron,
    schemaInvoke,
    typedInvoke,
  ],
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

import { adapter } from "inngest/next";
export default inngest.serve({ adapter });

inngest.connect({ adapter });
