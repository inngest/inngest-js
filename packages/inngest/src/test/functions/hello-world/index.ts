import { inngest } from "../client";

export default inngest.createFunction(
  { id: "hello-world" },
  { event: "demo/hello.world" },
  () => "Hello, Inngest!",
);
