import { Inngest } from "inngest";
import { endpointAdapter } from "inngest/next";

export const inngest = new Inngest({
  id: "deepresearch",
  endpointAdapter,
});
