import { Inngest } from "inngest";
import { aiMiddleware } from "inngest/experimental";
import { HelloWorldMiddleware } from "./middleware/helloWorld";

export const inngest = new Inngest({
  id: "example-ai-app",
  middleware: [...aiMiddleware(), HelloWorldMiddleware],
});
