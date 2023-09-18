/* eslint-disable @typescript-eslint/no-unsafe-assignment */
import { checkIntrospection } from "@local/test/helpers";

checkIntrospection({
  name: "polling",
  triggers: [{ event: "demo/polling" }],
});
