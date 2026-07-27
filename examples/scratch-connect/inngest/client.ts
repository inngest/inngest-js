// import { extendedTracesMiddleware } from "../../../packages/inngest/src/experimental.ts";
import { Inngest } from "../../../packages/inngest/src/index.ts";

export const inngest = new Inngest({
  id: "scratch-connect",
  //   middleware: [extendedTracesMiddleware()],
  //   aiMetadata: false,
});
