import { createCi } from "@inngest/ci";
import { Inngest } from "inngest";
import { z } from "zod";

export const inngest = new Inngest({ id: process.env.E2E_APP_ID ?? "ci-e2e" });

export const ci = createCi(inngest, { machine: { vcpu: 1 } });

/** A manual trigger for one pipeline: run it with `--event ci/manual.<id>`. */
export const trigger = (pipelineId: string) => {
  return ci.manual({ pipelineId, schema: z.object({}) });
};
