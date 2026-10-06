/**
 * What the CLI says when Sandboxes can't be used: the Dev Server isn't logged
 * in, the login has no single environment, or the account hasn't been given
 * Sandbox access. Every job runs on a Sandbox, so these are the first errors a
 * new user can hit, and they get one friendly, exact message each.
 *
 * @module
 */

import type { SandboxAccessProblem } from "../util.ts";
import { SetupError } from "./setupError.ts";

const docsUrl = "https://www.inngest.com/docs/sandboxes/overview";
const limitsUrl = "https://www.inngest.com/docs/sandboxes/limits";

const details: Record<
  SandboxAccessProblem,
  { message: string; steps: string[]; link: string }
> = {
  login: {
    message:
      "Inngest CI needs your Inngest account. Every job runs on an Inngest Sandbox, and the local Dev Server isn't logged in.",
    steps: ["Run  npx inngest-cli@latest login", "Run  inngest-ci  again"],
    link: `Sandboxes: ${docsUrl}`,
  },
  environment: {
    message:
      "Inngest CI needs one Inngest environment. Every job runs on an Inngest Sandbox, and your login isn't tied to a single environment.",
    steps: [
      "Run  npx inngest-cli@latest login --force  and select a single development environment",
      "Run  inngest-ci  again",
    ],
    link: `Sandboxes: ${docsUrl}`,
  },
  plan: {
    message:
      "Your Inngest account can't use Sandboxes yet. Every job runs on an Inngest Sandbox, and Sandboxes are only available to environments with access enabled.",
    steps: [
      "Ask Inngest to enable Sandbox access for your environment",
      "Run  inngest-ci  again",
    ],
    link: `Access and limits: ${limitsUrl}`,
  },
};

/** The setup error that tells a person how to get Sandbox access. */
export const sandboxAccessError = (
  problem: SandboxAccessProblem,
): SetupError => {
  const { message, steps, link } = details[problem];

  return new SetupError(message, {
    fix: [
      ...steps.map((step, index) => {
        return `${index + 1}. ${step}`;
      }),
      "",
      link,
    ].join("\n"),
  });
};
