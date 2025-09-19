import { createEvent } from "h3";
import * as h3Handler from "./h3.ts";
import { testFramework } from "./test/helpers.ts";

testFramework("h3", h3Handler, {
  transformReq(req, res) {
    return [createEvent(req, res)];
  },
});
