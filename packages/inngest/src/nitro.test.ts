import { createEvent } from "h3";
import * as NitroHandler from "./nitro.ts";
import { testFramework } from "./test/helpers.ts";

testFramework("Nitro", NitroHandler, {
  transformReq(req, res) {
    return [createEvent(req, res)];
  },
});
