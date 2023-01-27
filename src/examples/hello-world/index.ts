import { inngest } from "../client";

export default inngest.createFunction(
  { name: "Hello World" },
  { event: "demo/hello.world" },
  () => "Hello, Inngest!"
);
