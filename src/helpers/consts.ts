/**
 * Keys for accessing query parameters included in requests from Inngest to run
 * functions.
 *
 * Used internally to create handlers using `InngestCommHandler`, but can be
 * imported to be used if creating a custom handler outside of the package.
 *
 * @public
 */
export enum queryKeys {
  FnId = "fnId",
  StepId = "stepId",
  Introspect = "introspect",
  DeployId = "deployId",
}

export enum envKeys {
  SigningKey = "INNGEST_SIGNING_KEY",
  EventKey = "INNGEST_EVENT_KEY",
  LandingPage = "INNGEST_LANDING_PAGE",
  DevServerUrl = "INNGEST_DEVSERVER_URL",
  Environment = "INNGEST_ENV",
  BranchName = "BRANCH_NAME",

  /**
   * The git branch of the commit the deployment was triggered by. Example:
   * `improve-about-page`.
   *
   * {@link https://vercel.com/docs/concepts/projects/environment-variables/system-environment-variables#system-environment-variables}
   */
  VercelGitCommitRef = "VERCEL_GIT_COMMIT_REF",
}

export enum prodEnvKeys {
  NodeEnvKey = "NODE_ENV",
  VercelEnvKey = "VERCEL_ENV",
  NetlifyEnvKey = "CONTEXT",
}

/**
 * Keys for accessing headers included in requests from Inngest to run
 * functions.
 *
 * Used internally to create handlers using `InngestCommHandler`, but can be
 * imported to be used if creating a custom handler outside of the package.
 *
 * @public
 */
export enum headerKeys {
  Signature = "x-inngest-signature",
  SdkVersion = "x-inngest-sdk",
  Environment = "x-inngest-env",
}

export const defaultDevServerHost = "http://127.0.0.1:8288/";

/**
 * Events that Inngest may send internally that can be used to trigger
 * functions.
 *
 * @public
 */
export enum internalEvents {
  /**
   * A function has failed after exhausting all available retries. This event
   * will contain the original event and the error that caused the failure.
   */
  FunctionFailed = "inngest/function.failed",
}
