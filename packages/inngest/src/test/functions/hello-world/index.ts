import { inngest } from "../client";

export default inngest.createFunction(
  { id: "hello-world", triggers: [{ event: "demo/hello.world" }] },
  () => "Hello, Inngest!",
);
