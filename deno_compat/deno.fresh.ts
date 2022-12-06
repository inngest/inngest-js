import { createRequire } from "https://deno.land/std@0.167.0/node/module.ts";

const require = createRequire(import.meta.url);

export const serve = require("../dist/deno/fresh").serve;
