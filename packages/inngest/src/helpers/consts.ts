import chalk from "chalk";

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
  DeployId = "deployId",
}

export enum envKeys {
  InngestSigningKey = "INNGEST_SIGNING_KEY",
  InngestEventKey = "INNGEST_EVENT_KEY",

  /**
   * @deprecated Removed in v3. Use {@link InngestBaseUrl} instead.
   */
  InngestDevServerUrl = "INNGEST_DEVSERVER_URL",
  InngestEnvironment = "INNGEST_ENV",
  InngestBaseUrl = "INNGEST_BASE_URL",
  InngestEventApiBaseUrl = "INNGEST_EVENT_API_BASE_URL",
  InngestApiBaseUrl = "INNGEST_API_BASE_URL",
  InngestServeHost = "INNGEST_SERVE_HOST",
  InngestServePath = "INNGEST_SERVE_PATH",
  InngestLogLevel = "INNGEST_LOG_LEVEL",
  InngestStreaming = "INNGEST_STREAMING",
  InngestDevMode = "INNGEST_DEV",

  BranchName = "BRANCH_NAME",

  /**
   * The git branch of the commit the deployment was triggered by. Example:
   * `improve-about-page`.
   *
   * {@link https://vercel.com/docs/concepts/projects/environment-variables/system-environment-variables#system-environment-variables}
   */
  VercelBranch = "VERCEL_GIT_COMMIT_REF",

  /**
   * Expected to be `"1"` if defined.
   */
  IsVercel = "VERCEL",

  /**
   * The branch name of the current deployment. May only be accessible at build
   * time, but included here just in case.
   *
   * {@link https://developers.cloudflare.com/pages/platform/build-configuration/#environment-variables}
   */
  CloudflarePagesBranch = "CF_PAGES_BRANCH",

  /**
   * Expected to be `"1"` if defined.
   */
  IsCloudflarePages = "CF_PAGES",

  /**
   * The branch name of the deployment from Git to Netlify, if available.
   *
   * {@link https://docs.netlify.com/configure-builds/environment-variables/#git-metadata}
   */
  NetlifyBranch = "BRANCH",

  /**
   * Expected to be `"true"` if defined.
   */
  IsNetlify = "NETLIFY",

  /**
   * The Git branch for a service or deploy.
   *
   * {@link https://render.com/docs/environment-variables#all-services}
   */
  RenderBranch = "RENDER_GIT_BRANCH",

  /**
   * Expected to be `"true"` if defined.
   */
  IsRender = "RENDER",

  /**
   * The branch that triggered the deployment. Example: `main`
   *
   * {@link https://docs.railway.app/develop/variables#railway-provided-variables}
   */
  RailwayBranch = "RAILWAY_GIT_BRANCH",

  /**
   * The railway environment for the deployment. Example: `production`
   *
   * {@link https://docs.railway.app/develop/variables#railway-provided-variables}
   */
  RailwayEnvironment = "RAILWAY_ENVIRONMENT",

  VercelEnvKey = "VERCEL_ENV",
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
  Platform = "x-inngest-platform",
  Framework = "x-inngest-framework",
  NoRetry = "x-inngest-no-retry",
  RequestVersion = "x-inngest-req-version",
  RetryAfter = "retry-after",
  InngestServerKind = "x-inngest-server-kind",
  InngestExpectedServerKind = "x-inngest-expected-server-kind",
}

export const defaultInngestApiBaseUrl = "https://api.inngest.com/";
export const defaultInngestEventBaseUrl = "https://inn.gs/";
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
  FunctionInvoked = "inngest/function.invoked",
  FunctionFinished = "inngest/function.finished",
}

/**
 * Accessing enum values as literals in some TypeScript types can be difficult,
 * so we also manually create the string values here.
 */
export const FnFailedEventName = `${internalEvents.FunctionFailed}`;
export const FnInvokedEventName = `${internalEvents.FunctionInvoked}`;
export const FnFinishedEventName = `${internalEvents.FunctionFinished}`;

export const logPrefix = chalk.magenta.bold("[Inngest]");

export const debugPrefix = "inngest";

export const dummyEventKey = "NO_EVENT_KEY_SET";

export enum serverKind {
  Dev = "dev",
  Cloud = "cloud",
}
