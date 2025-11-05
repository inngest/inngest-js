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
  DeployId = "deployId",
  FnId = "fnId",
  Probe = "probe",
  StepId = "stepId",
}

export enum probe {
  Trust = "trust",
}

export enum envKeys {
  InngestSigningKey = "INNGEST_SIGNING_KEY",
  InngestSigningKeyFallback = "INNGEST_SIGNING_KEY_FALLBACK",
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
  InngestAllowInBandSync = "INNGEST_ALLOW_IN_BAND_SYNC",

  /**
   * @deprecated It's unknown what this env var was used for, but we do not
   * provide explicit support for it. Prefer using `INNGEST_ENV` instead.
   */
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

  OpenAiApiKey = "OPENAI_API_KEY",
  GeminiApiKey = "GEMINI_API_KEY",
  AnthropicApiKey = "ANTHROPIC_API_KEY",
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
  ContentType = "content-type",
  Host = "host",
  ForwardedFor = "x-forwarded-for",
  RealIp = "x-real-ip",
  Location = "location",
  ContentLength = "content-length",
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
  InngestSyncKind = "x-inngest-sync-kind",
  EventIdSeed = "x-inngest-event-id-seed",
  TraceParent = "traceparent",
  TraceState = "tracestate",
  InngestRunId = "x-run-id",
}

/**
 * Headers that are forwarded from the original request when an Inngest function
 * is invoked.
 */
export const forwardedHeaders = [headerKeys.TraceParent, headerKeys.TraceState];

export const defaultInngestApiBaseUrl = "https://api.inngest.com/";
export const defaultInngestEventBaseUrl = "https://inn.gs/";
export const defaultDevServerHost = "http://localhost:8288/";

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
  FunctionCancelled = "inngest/function.cancelled",
  ScheduledTimer = "inngest/scheduled.timer",
}

/**
 * Events that are known globally by the Inngest platform.
 */
export enum knownEvents {
  /**
   * An HTTP request has been received to trigger a function execution.
   */
  HttpRunStarted = "http/run.started",
}

export const logPrefix: string = chalk.magenta.bold("[Inngest]");

export const debugPrefix = "inngest";

export const dummyEventKey = "NO_EVENT_KEY_SET";

export enum serverKind {
  Dev = "dev",
  Cloud = "cloud",
}

export enum syncKind {
  InBand = "in_band",
  OutOfBand = "out_of_band",
}

/**
 * The execution models the SDK is aware of.
 *
 * This is used in a number of places to ensure all execution versions are
 * accounted for for a given operation.
 */
export enum ExecutionVersion {
  /**
   * Very legacy, initial version of the executor. Uses hashed op objects and
   * `pos` to determine the order of execution and which ops to run.
   *
   * Very stubborn about determinism.
   */
  V0 = 0,

  /**
   * Uses a more flexible approach to execution and is more lenient about
   * determinism, allowing non-step async actions and non-determinism.
   *
   * Nowhere near as stubborn about determinism and so can silently migrate
   * between versions after bug fixes.
   */
  V1 = 1,

  /**
   * Identical to V1, but allows the Executor to optimize parallel calls, hugely
   * reducing traffic going to/from the SDK.
   */
  V2 = 2,
}
