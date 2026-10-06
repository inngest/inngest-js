import { github } from "@inngest/ci";
import { step } from "inngest";

import { ci } from "../client.ts";

export const release = ci.job("release", async () => {
  const { sha, number } = github.repo();

  const approval = await step.waitForEvent("approval", {
    event: "release/approved",
    if: `async.data.sha == "${sha}"`,
    timeout: "24h",
  });

  if (!approval) {
    return { released: false, reason: "not approved in 24h" };
  }

  const created = await github.rest.repos.createRelease({
    tag_name: `v0.0.0-ci-${sha.slice(0, 7)}`,
    generate_release_notes: true,
  });

  await github.forcePushRef("heads/ci-example-next", sha);

  if (number) {
    await github.stickyComment("release", `Released ${created.html_url}`);
  }

  return { released: true, url: created.html_url };
});
