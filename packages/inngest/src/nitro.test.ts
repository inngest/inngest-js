import * as NitroHandler from "@local/nitro";
import { createEvent } from "h3";
import { testFramework } from "./test/helpers";

testFramework("Nitro", NitroHandler, {
  transformReq(req, res) {
    return [createEvent(req, res)];
  },
});
