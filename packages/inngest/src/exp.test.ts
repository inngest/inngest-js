import { z } from "zod";
import { createInngest, cron, event, invoke } from "./exp.js";

const ev = event("event.sent");
const ev2 = event("event.sent/2", z.object({ foo: z.boolean() }));
const cr = cron("* * 0 0 0");
const iv = invoke();
const iv2 = invoke<{ bar: string; baz: boolean }>();
const inv3 = invoke(z.object({ bar: z.boolean() }));

// optionless by default, does not require an `appId`, but optional
const inngest = createInngest({
  events: [ev2, ev],
});

inngest.sendEvent("event.sent/2", { foo: true });

inngest.createFunction({
  id: "test",
  triggers: [ev, ev2, cr, inv3, iv2],
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
