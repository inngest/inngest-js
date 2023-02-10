import * as NuxtHandler from "./nuxt";
import { testFramework } from "./test/helpers";
import { createEvent } from "h3";

testFramework("Nuxt", NuxtHandler, {
  transformReq(req, res) {
    return [createEvent(req, res)];
  },
});
