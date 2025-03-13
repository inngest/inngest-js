import { checkIntrospection } from "./test/helpers";

checkIntrospection({
  name: "polling",
  triggers: [{ event: "demo/polling" }],
});
