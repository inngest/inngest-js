/* eslint-disable @typescript-eslint/no-unsafe-assignment */
import { checkIntrospection } from "@local/test/helpers";

checkIntrospection({
  name: "Polling",
  triggers: [{ event: "demo/polling" }],
});
