/**
 * What the CLI says when Sandboxes can't be used: the Dev Server isn't logged
 * in, the login has no single environment, or the account hasn't been given
 * Sandbox access. Every job runs on a Sandbox, so these are the first errors a
 * new user can hit, and each gets one exact message.
 *
 * @module
 */

import { SetupError } from "./setupError.ts";

const docsUrl = "https://www.inngest.com/docs/sandboxes/overview";
const limitsUrl = "https://www.inngest.com/docs/sandboxes/limits";

/**
 * Each problem with the error `code` the Dev Server or Cloud answers with, the
 * short reason a failed run carries for it (see `shortReason`), and the fix.
 */
const problems = {
  login: {
    code: "cloud_login_required",
    reason: "not logged in to Inngest",
    message:
      "Inngest CI needs your Inngest account. Every job runs on an Inngest Sandbox, and the local Dev Server isn't logged in.",
    steps: ["Run  npx inngest-cli@latest login"],
    link: `Sandboxes: ${docsUrl}`,
  },
  environment: {
    code: "environment_required",
    reason: "no Inngest environment selected",
    message:
      "Inngest CI needs one Inngest environment. Every job runs on an Inngest Sandbox, and your login isn't tied to a single environment.",
    steps: [
      "Run  npx inngest-cli@latest login --force  and select a single development environment",
    ],
    link: `Sandboxes: ${docsUrl}`,
  },
  plan: {
    code: "access_denied",
    reason: "Sandboxes not enabled for your account",
    message:
      "Your Inngest account can't use Sandboxes yet. Every job runs on an Inngest Sandbox, and Sandboxes are only available to environments with access enabled.",
    steps: ["Ask Inngest to enable Sandbox access for your environment"],
    link: `Access and limits: ${limitsUrl}`,
  },
};

export type SandboxAccessProblem = keyof typeof problems;

/**
 * Whether an error `code`, or the short reason of a failed run, says
 * Sandboxes can't be used.
 */
export const sandboxAccessProblem = (
  text: string | undefined,
): SandboxAccessProblem | undefined => {
  return (Object.keys(problems) as SandboxAccessProblem[]).find((name) => {
    return text === problems[name].code || text === problems[name].reason;
  });
};

/** The error that tells a person how to get Sandbox access. */
export const sandboxAccessError = (
  problem: SandboxAccessProblem,
): SetupError => {
  const { message, steps, link } = problems[problem];

  const fix = [
    ...steps.map((step, index) => {
      return `${index + 1}. ${step}`;
    }),
    `${steps.length + 1}. Run  inngest-ci  again`,
    "",
    link,
  ].join("\n");

  return new SetupError(message, { fix });
};
