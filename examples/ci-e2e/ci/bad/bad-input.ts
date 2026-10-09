import { z } from "zod";

import { ci } from "../client.ts";

const build = ci.job(
  { id: "bad-input-build", input: z.object({ target: z.enum(["web", "api"]) }) },
  async () => {},
);

/** `.with()` an input the parent's schema rejects: expect an error when the app boots. */
ci.job(
  {
    id: "bad-input-child",
    from: build.with({ target: "mobile" as unknown as "web" }),
  },
  async () => {},
);
