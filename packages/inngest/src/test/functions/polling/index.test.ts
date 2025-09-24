import { checkIntrospection } from "../../helpers";

checkIntrospection({
  name: "polling",
  triggers: [{ event: "demo/polling" }],
});
