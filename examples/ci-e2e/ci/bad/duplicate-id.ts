import { ci } from "../client.ts";

ci.job("dup-job", async () => {});

/** The same job ID twice on one client: expect an error when the app boots. */
ci.job("dup-job", async () => {});
