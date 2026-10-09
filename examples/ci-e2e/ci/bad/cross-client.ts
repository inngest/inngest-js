import { createCi } from "@inngest/ci";
import { Inngest } from "inngest";

import { ci } from "../client.ts";

const other = createCi(new Inngest({ id: "ci-e2e-other" }));

const foreign = other.job("foreign", async () => {});

/** `from` a job of another client: expect an error when the app boots. */
ci.job({ id: "cross-client-child", from: foreign }, async () => {});
