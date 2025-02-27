import { z } from "zod";
import { createApp } from "./components/app.js";
import { cron, event, invoke } from "./components/trigger.js";

const sentEvent = event("event.sent");
const sentEvent2 = event("event.sent/2").schema(z.object({ foo: z.boolean() }));
const sentEvent3 = event("event.sent/3").type<{ foo: number }>();

const bigCron = cron("* * 0 0 0");
const blankInvoke = invoke();
const typedInvoke = invoke().type<{ bar: string; baz: boolean }>();
const schemaInvoke = invoke().schema(z.object({ bar: z.boolean() }));

const inngest = createApp({
  appId: "test",
});

// events are just JSON, but can be created easily
const lol = sentEvent2.create({ foo: true });

// we use these helpers to send events
inngest.sendEvent(sentEvent2.create({ foo: false }));
// or create one immediately
inngest.sendEvent(event("yerp").create({ foo: "bar" }));
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

await inngest.connect({ adapter });
