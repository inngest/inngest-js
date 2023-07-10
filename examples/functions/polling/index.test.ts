/* eslint-disable @typescript-eslint/no-unsafe-assignment */
import { checkIntrospection } from "../../test/helpers";

checkIntrospection({
  name: "Polling",
  triggers: [{ event: "demo/polling" }],
});
