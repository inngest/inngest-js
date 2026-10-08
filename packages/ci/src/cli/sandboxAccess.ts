/**
 * What the CLI says when Sandboxes can't be used: the Dev Server isn't logged
 * in, the login has no single environment, or the account hasn't been given
 * Sandbox access. Every job runs on a Sandbox, so these are the first errors a
 * new user can hit, and they get one friendly, exact message each.
 *
 * @module
 */

import { SetupError } from "./setupError.ts";

const docsUrl = "https://www.inngest.com/docs/sandboxes/overview";
const limitsUrl = "https://www.inngest.com/docs/sandboxes/limits";

/** Why Sandboxes can't be used, as the Dev Server and Cloud report it. */
export type SandboxAccessProblem = "login" | "environment" | "plan";

/** The short reason each problem gets from `shortReason`. */
const accessReasons: Record<SandboxAccessProblem, string> = {
  login: "not logged in to Inngest",
  environment: "no Inngest environment selected",
  plan: "Sandboxes not enabled for your account",
};

/**
 * Whether an error, or the short reason made from one, says Sandboxes can't
 * be used. The Dev Server answers `cloud_login_required` (401) when it isn't
 * logged in and `environment_required` (400) when the login has no single
 * environment; Cloud answers `access_denied` (403) when the account hasn't
 * been given Sandbox access.
 */
export const sandboxAccessProblem = (
  error: unknown,
): SandboxAccessProblem | undefined => {
  const { code, message } = readError(error);

  if (code === "cloud_login_required" || message === accessReasons.login) {
    return "login";
  }

  if (
    code === "environment_required" ||
    message === accessReasons.environment
  ) {
    return "environment";
  }

  if (code === "access_denied" || message === accessReasons.plan) {
    return "plan";
  }

  return undefined;
};

const readError = (error: unknown): { code?: string; message: string } => {
  if (typeof error === "string") {
    return { message: error };
  }

  if (typeof error !== "object" || error === null) {
    return { message: "" };
  }

  const { code, message, cause } = error as {
    code?: unknown;
    message?: unknown;
    cause?: { code?: unknown };
  };
  const found = typeof code === "string" ? code : cause?.code;

  return {
    ...(typeof found === "string" ? { code: found } : {}),
    message: typeof message === "string" ? message : "",
  };
};

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
