import { eventType } from "inngest/experimental";
import { z } from "zod";

export const event1 = eventType("event-1");
export const event2 = eventType("event-2");
export const event3 = eventType("event-3", z.object({ message: z.string() }));
