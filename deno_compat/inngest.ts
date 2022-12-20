import { createRequire } from "https://deno.land/std@0.167.0/node/module.ts";

const require = createRequire(import.meta.url);

const inngest = require("../dist");

export const Inngest = inngest.Inngest;
export const InngestCommHandler = inngest.InngestCommHandler;
export const createFunction = inngest.createFunction;
export const createScheduledFunction = inngest.createScheduledFunction;
export const createStepFunction = inngest.createStepFunction;
