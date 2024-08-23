import * as h3Handler from "@local/h3";
import { createEvent } from "h3";
import { testFramework } from "./__test__/helpers";

testFramework("h3", h3Handler, {
  transformReq(req, res) {
    return [createEvent(req, res)];
  },
});
