import * as NuxtHandler from "@local/nuxt";
import { createEvent } from "h3";
import { testFramework } from "./test/helpers";

testFramework("Nuxt", NuxtHandler, {
  transformReq(req, res) {
    return [createEvent(req, res)];
  },
});
