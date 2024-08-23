/* eslint-disable @typescript-eslint/no-unsafe-assignment */
import { checkIntrospection } from "@local/__test__/helpers";

checkIntrospection({
  name: "polling",
  triggers: [{ event: "demo/polling" }],
});
