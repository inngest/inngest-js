import { createEvent } from "h3";
import * as NuxtHandler from "./nuxt.ts";
import { testFramework } from "./test/helpers.ts";

testFramework("Nuxt", NuxtHandler, {
  transformReq(req, res) {
    return [createEvent(req, res)];
  },
});
