import { createCi } from "@inngest/ci";
import { Inngest } from "inngest";

export const inngest = new Inngest({ id: "ci-e2e" });

export const ci = createCi(inngest);
